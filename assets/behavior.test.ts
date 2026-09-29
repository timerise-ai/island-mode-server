import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { generateHmac, verifyHmac } from './hmac.util';
import { decodeOfflineToken } from './auth-guard';
import { StockService } from './stock';
import { AvailabilityService } from './availability.service';
import { NetworkManager } from '../next/network-manager';
import { applyStockTransaction, type IncomingTx } from '../next/apply-stock-transaction';

addRxPlugin(RxDBQueryBuilderPlugin);

describe('verifyHmac', () => {
  const secret = 's3cret';
  const header = (terminalId: string, ts: number, sig?: string) =>
    `HMAC ${terminalId}:${ts}:${sig ?? generateHmac(`${terminalId}${ts}`, secret)}`;

  it('accepts a fresh, correctly signed request', () => {
    const result = verifyHmac(header('door-1', Date.now()), secret);
    expect(result).toEqual({ valid: true, terminalId: 'door-1' });
  });

  it('rejects a tampered signature (same length)', () => {
    const ts = Date.now();
    const sig = generateHmac(`door-1${ts}`, 'wrong-secret');
    expect(verifyHmac(header('door-1', ts, sig), secret).valid).toBe(false);
  });

  it('rejects outside the 30s replay window, both directions', () => {
    expect(verifyHmac(header('door-1', Date.now() - 31_000), secret).error).toMatch(/expired/);
    expect(verifyHmac(header('door-1', Date.now() + 31_000), secret).error).toMatch(/expired/);
  });

  it('rejects malformed headers without throwing', () => {
    expect(verifyHmac('Bearer abc', secret).valid).toBe(false);
    expect(verifyHmac('HMAC only-one-part', secret).valid).toBe(false);
    expect(verifyHmac('HMAC a:b:zz', secret).valid).toBe(false); // non-hex, wrong length
  });
});

describe('decodeOfflineToken', () => {
  const jwt = (payload: object) =>
    `x.${Buffer.from(JSON.stringify(payload)).toString('base64')}.y`;

  it('extracts uid from user_id or sub', () => {
    expect(decodeOfflineToken(jwt({ user_id: 'u1', exp: Date.now() / 1000 + 3600 }))).toBe('u1');
    expect(decodeOfflineToken(jwt({ sub: 'u2' }))).toBe('u2');
  });

  it('rejects expired tokens even offline', () => {
    expect(() => decodeOfflineToken(jwt({ user_id: 'u1', exp: Date.now() / 1000 - 60 }))).toThrow(/expired/i);
  });

  it('rejects tokens without a uid or malformed tokens', () => {
    expect(() => decodeOfflineToken(jwt({ foo: 'bar' }))).toThrow();
    expect(() => decodeOfflineToken('not-a-jwt')).toThrow();
  });
});

describe('StockService delta overlay', () => {
  async function setup() {
    const db = await createRxDatabase({
      name: 'test-' + Math.random().toString(36).slice(2),
      storage: getRxStorageMemory(),
      multiInstance: false,
    });
    const collections = await db.addCollections({
      inventory: {
        schema: {
          version: 0, primaryKey: 'id', type: 'object',
          properties: {
            id: { type: 'string', maxLength: 100 },
            locationId: { type: 'string' },
            stockLevel: { type: 'number' },
          },
          required: ['id'],
        },
      },
      inventory_transactions: {
        schema: {
          version: 0, primaryKey: 'id', type: 'object',
          properties: {
            id: { type: 'string', maxLength: 100 },
            inventoryItemId: { type: 'string' },
            locationId: { type: 'string' },
            action: { type: 'string' },
            quantityChange: { type: 'number' },
            reason: { type: 'string' },
            relatedBookingId: { type: 'string' },
            performedBy: { type: 'string' },
            performedByName: { type: 'string' },
            _synced: { type: 'boolean' },
            createdAt: { type: 'string' },
          },
          required: ['id'],
        },
      },
    });
    await collections.inventory.insert({ id: 'ammo-9mm', locationId: 'loc1', stockLevel: 100 });
    const svc = new StockService(collections.inventory_transactions as any, collections.inventory as any, 'loc1');
    return { db, svc };
  }

  const staff = { uid: 's1', name: 'Staff One' };

  it('overlays deltas on the replica snapshot', async () => {
    const { db, svc } = await setup();
    await svc.itemOut('ammo-9mm', 30, staff);
    await svc.itemOut('ammo-9mm', 20, staff);
    expect(await svc.effectiveStock('ammo-9mm')).toBe(50);
    await db.close();
  });

  it('blocks selling below effective stock', async () => {
    const { db, svc } = await setup();
    await svc.itemOut('ammo-9mm', 90, staff);
    await expect(svc.itemOut('ammo-9mm', 20, staff)).rejects.toThrow(/Insufficient stock/);
    await db.close();
  });

  it('folds out ONLY acknowledged deltas on partial sync (the oversell fix)', async () => {
    const { db, svc } = await setup();
    const tx1 = await svc.itemOut('ammo-9mm', 30, staff);
    await svc.itemOut('ammo-9mm', 20, staff);   // tx2 stays unacked

    await svc.markSynced([tx1.id]);             // cloud confirmed only tx1

    // tx1's delta folded out (cloud will apply -30 to stockLevel), tx2's kept:
    // effective = 100 (stale snapshot) - 20 (unacked) = 80.
    expect(await svc.effectiveStock('ammo-9mm')).toBe(80);
    // tx2 still queued for the next flush.
    expect((await svc.getUnsynced()).map((t) => t.quantityChange)).toEqual([-20]);
    await db.close();
  });

  it('markSynced is idempotent per id (at-least-once safe)', async () => {
    const { db, svc } = await setup();
    const tx = await svc.itemOut('ammo-9mm', 10, staff);
    await svc.markSynced([tx.id]);
    await svc.markSynced([tx.id]);              // duplicate ack must not double-fold
    expect(await svc.effectiveStock('ammo-9mm')).toBe(100);
    await db.close();
  });
});

describe('applyStockTransaction (cloud ingestion)', () => {
  // Just enough of Firestore's transaction surface to see what the apply reads and writes.
  function fakeFirestore(existing: string[]) {
    const docs = new Set(existing);
    const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
    const db = {
      collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
      runTransaction: (fn: (t: unknown) => Promise<void>) => fn({
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path) }),
        update: (ref: { path: string }, data: Record<string, unknown>) => { updates.push({ path: ref.path, data }); },
        set: (ref: { path: string }) => { docs.add(ref.path); },
      }),
    };
    return { db: db as unknown as Firestore, updates };
  }

  const tx: IncomingTx = {
    id: 'tx-1', inventoryItemId: 'ammo-9mm', locationId: 'loc1', action: 'ITEM_OUT', quantityChange: -30,
    performedBy: 's1', performedByName: 'Staff One', createdAt: '2026-01-01T10:00:00.000Z',
  };

  it('applies the increment when push replication already wrote the transaction document', async () => {
    const { db, updates } = fakeFirestore(['inventory_transactions/tx-1']);
    await applyStockTransaction(db, tx);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.path).toBe('inventory/ammo-9mm');
    expect((updates[0]!.data.stockLevel as FieldValue).isEqual(FieldValue.increment(-30))).toBe(true);
  });

  it('applies a redelivered transaction once (at-least-once safe)', async () => {
    const { db, updates } = fakeFirestore([]);
    await applyStockTransaction(db, tx);
    await applyStockTransaction(db, tx);
    expect(updates).toHaveLength(1);
  });
});

describe('AvailabilityService hours', () => {
  it('builds slots from the replicated site hours, and none on a day without hours', async () => {
    const db = await createRxDatabase({
      name: 'test-' + Math.random().toString(36).slice(2),
      storage: getRxStorageMemory(),
      multiInstance: false,
    });
    const doc = (extra: Record<string, unknown>) => ({
      version: 0, primaryKey: 'id', type: 'object' as const,
      properties: { id: { type: 'string', maxLength: 100 }, locationId: { type: 'string' }, ...extra },
      required: ['id'],
    });
    const collections = await db.addCollections({
      locations: { schema: doc({ workingHours: { type: 'object' } }) },
      inventory: { schema: doc({ type: { type: 'string' }, active: { type: 'boolean' }, details: { type: 'object' } }) },
      bookings: { schema: doc({ slotType: { type: 'string' }, status: { type: 'string' }, cart: { type: 'object' } }) },
    });
    // Only Monday has hours; 2026-10-05 is a Monday, 2026-10-06 a Tuesday.
    await collections.locations.insert({ id: 'loc1', workingHours: { monday: { from: '09:00', to: '11:00' } } });
    await collections.inventory.insert({ id: 'wall-1', locationId: 'loc1', type: 'slot', active: true, details: { slotType: 'bouldering', capacity: 4 } });
    const svc = new AvailabilityService({ getCollection: (name: string) => (collections as Record<string, unknown>)[name] }, 'loc1');

    const monday = await svc.getAvailableSlots('2026-10-05', 'bouldering');
    expect(monday.map((slot) => slot.timeFrom)).toEqual(['09:00', '10:00']);
    expect(monday[0]!.availableStations).toBe(4);
    // No invented default range: the cloud owns opening hours (hard rule 4).
    expect(await svc.getAvailableSlots('2026-10-06', 'bouldering')).toEqual([]);
    await db.close();
  });
});

describe('NetworkManager failover', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(handler: (url: string) => boolean) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!handler(String(url))) throw new Error('unreachable');
      return { ok: true } as Response;
    }));
  }

  it('stays online until the failure threshold, then fails over to a found local server', async () => {
    let cloudUp = false;
    let localUp = false;
    stubFetch((url) => (url.includes('/api/health') ? cloudUp : localUp && url.startsWith('https://island.local')));

    const m = new NetworkManager();
    const check = () => (m as any).check() as Promise<void>;

    await check();
    await check();
    expect(m.getState().mode).toBe('online');   // below threshold: no flip
    await check();                              // 3rd failure: flip, local not found yet
    expect(m.getState()).toMatchObject({ mode: 'offline', apiBaseUrl: '' });

    localUp = true;                             // local server boots AFTER the transition
    await check();                              // rescan tick finds it (the hardened behaviour)
    expect(m.getState().apiBaseUrl).toBe('https://island.local');

    cloudUp = true;                             // cloud recovers: back to same-origin
    await check();
    expect(m.getState()).toMatchObject({ mode: 'online', apiBaseUrl: '' });
  });
});
