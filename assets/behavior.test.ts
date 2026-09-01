import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import { generateHmac, verifyHmac } from './hmac.util';
import { decodeOfflineToken } from './auth-guard';
import { StockService } from './stock';
import { NetworkManager } from '../next/network-manager';

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
    await db.addCollections({
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
    await db.collections.inventory.insert({ id: 'ammo-9mm', locationId: 'loc1', stockLevel: 100 });
    const svc = new StockService(db.collections.inventory_transactions as any, db.collections.inventory as any, 'loc1');
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
