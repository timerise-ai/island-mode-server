# Reconnect flush and idempotent ingestion

When connectivity returns, the local server pushes its offline business events
to cloud HTTP endpoints. Delivery is **at-least-once** (the POST can succeed
while the acknowledgment is lost, the process can crash between apply and
mark-synced, the same batch can be retried), so the cloud side must be
idempotent per event ID. That property is what also makes the overlap with
RxDB's own push replication harmless.

## The stock-delta overlay (why it exists)

While offline, the replica's `stockLevel` is a frozen cloud snapshot: the
local server must not mutate it, or replication would push a value the cloud
later recomputes differently. Instead, offline stock movements are recorded as
append-only transactions plus an **in-memory delta map** overlaid at read time:
`effectiveStock(item) = replicaSnapshot.stockLevel + localDelta(item)`.

When the cloud confirms a transaction batch, those transactions' deltas fold
out of the overlay: the cloud has applied the increments, and the updated
`stockLevel` flows back down via pull replication.

```ts
// local-server/src/stock.ts
import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';
import type { RxCollection } from 'rxdb';

export interface StockTransaction {
  id: string;
  inventoryItemId: string;
  locationId: string;
  action: 'ITEM_OUT' | 'ITEM_IN' | 'ADJUSTMENT';
  quantityChange: number;       // signed
  reason?: string;
  relatedBookingId?: string;
  performedBy: string;
  performedByName: string;
  _synced: boolean;
  createdAt: string;
}

export class StockService {
  private readonly mutex = new Mutex();
  private localDeltaMap = new Map<string, number>();

  constructor(
    private transactions: RxCollection<StockTransaction>,
    private inventory: RxCollection<any>,
    private locationId: string,
  ) {}

  private delta(itemId: string): number {
    return this.localDeltaMap.get(itemId) ?? 0;
  }

  async effectiveStock(itemId: string): Promise<number | null> {
    const doc = await this.inventory.findOne(itemId).exec();
    if (!doc) return null;
    return (doc.toJSON() as any).stockLevel + this.delta(itemId);
  }

  async itemOut(itemId: string, quantity: number, by: { uid: string; name: string }, reason?: string, relatedBookingId?: string): Promise<StockTransaction> {
    // Mutex: two kiosk requests must not both pass the stock check.
    return this.mutex.runExclusive(async () => {
      const stock = await this.effectiveStock(itemId);
      if (stock === null) throw new Error(`Inventory item ${itemId} not found`);
      if (stock < quantity) throw new Error(`Insufficient stock: ${stock} available, ${quantity} requested`);
      return this.record(itemId, 'ITEM_OUT', -quantity, by, reason, relatedBookingId);
    });
  }

  async itemIn(itemId: string, quantity: number, by: { uid: string; name: string }, reason?: string): Promise<StockTransaction> {
    return this.mutex.runExclusive(() => this.record(itemId, 'ITEM_IN', quantity, by, reason));
  }

  /** Signed correction after a count; the cloud applies it like any other movement. */
  async adjust(itemId: string, quantityChange: number, by: { uid: string; name: string }, reason: string): Promise<StockTransaction> {
    return this.mutex.runExclusive(() => this.record(itemId, 'ADJUSTMENT', quantityChange, by, reason));
  }

  private async record(itemId: string, action: StockTransaction['action'], quantityChange: number, by: { uid: string; name: string }, reason?: string, relatedBookingId?: string): Promise<StockTransaction> {
    const tx: StockTransaction = {
      id: randomUUID(),
      inventoryItemId: itemId,
      locationId: this.locationId,
      action,
      quantityChange,
      reason,
      relatedBookingId,
      performedBy: by.uid,
      performedByName: by.name,
      _synced: false,
      createdAt: new Date().toISOString(),
    };
    await this.transactions.insert(tx);
    this.localDeltaMap.set(itemId, this.delta(itemId) + quantityChange);
    return tx;
  }

  /** Boot: the overlay is memory-only, so replay every unsynced transaction into it. */
  async rebuildDeltas(): Promise<void> {
    this.localDeltaMap.clear();
    for (const tx of await this.getUnsynced()) {
      this.localDeltaMap.set(tx.inventoryItemId, this.delta(tx.inventoryItemId) + tx.quantityChange);
    }
  }

  async getUnsynced(): Promise<StockTransaction[]> {
    const docs = await this.transactions.find({ selector: { _synced: false }, sort: [{ createdAt: 'asc' }] }).exec();
    return docs.map((d) => d.toJSON() as StockTransaction);
  }

  /**
   * Fold ONLY the acknowledged transactions out of the overlay.
   * Never clear the whole map on "flush finished"; a partially failed flush
   * would erase deltas for transactions the cloud never applied, and
   * effectiveStock would silently revert to the stale snapshot (oversell).
   */
  async markSynced(syncedIds: string[]): Promise<void> {
    for (const id of syncedIds) {
      const doc = await this.transactions.findOne(id).exec();
      if (!doc || doc.toJSON()._synced) continue;
      const tx = doc.toJSON() as StockTransaction;
      await doc.incrementalPatch({ _synced: true });
      const remaining = this.delta(tx.inventoryItemId) - tx.quantityChange;
      if (remaining === 0) this.localDeltaMap.delete(tx.inventoryItemId);
      else this.localDeltaMap.set(tx.inventoryItemId, remaining);
    }
  }
}
```

Restart caveat: the delta map is memory-only. Call `rebuildDeltas()` once at
boot, before the local API listens, to replay the unsynced transactions into
it. With memory storage the transactions themselves are gone too; see
the storage decision in [replication.md](replication.md).

## The flush service

Triggered by the network monitor's `online` event
([network-failover.md](network-failover.md), and, because a flush attempt
can fail while the network stays up, also by a slow retry timer whenever
unsynced work remains.

```ts
// local-server/src/sync-flush.service.ts
import type { RxCollection } from 'rxdb';
import type { StockService } from './stock';

export class SyncFlushService {
  private isFlushing = false;
  private retryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private cloudApiUrl: string,
    private syncSecret: string,               // shared secret for the ingestion endpoints
    private stock: StockService,
    private bookings: RxCollection<any>,
    private lockLogs: RxCollection<any>,
  ) {}

  attach(network: { on(event: 'online', cb: () => void): void }): void {
    network.on('online', () => void this.flushAll());
    // Retry loop: a failed flush must not wait for the next outage cycle.
    this.retryTimer = setInterval(() => void this.flushIfPending(), 60_000);
  }

  stop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private async flushIfPending(): Promise<void> {
    const pendingTx = await this.stock.getUnsynced();
    const pendingBookings = await this.bookings.find({ selector: { _offlineCreated: true } }).exec();
    if (pendingTx.length || pendingBookings.length) await this.flushAll();
  }

  async flushAll(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      await this.flushStockTransactions();
      await this.flushOfflineBookings();
      await this.flushLockLogs();
    } finally {
      this.isFlushing = false;
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.cloudApiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': this.syncSecret },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Cloud responded with ${res.status}`);
    return res.json();
  }

  private async flushStockTransactions(): Promise<void> {
    const transactions = await this.stock.getUnsynced();
    if (!transactions.length) return;
    try {
      const result = await this.post('/api/sync/inventory-transactions', { transactions });
      // Trust ONLY the acknowledged IDs; never assume the whole batch landed.
      await this.stock.markSynced(result.syncedIds ?? []);
    } catch (err) {
      console.error('flushStockTransactions failed; will retry', err);
    }
  }

  private async flushOfflineBookings(): Promise<void> {
    const docs = await this.bookings.find({ selector: { _offlineCreated: true } }).exec();
    if (!docs.length) return;
    try {
      const result = await this.post('/api/sync/bookings', { bookings: docs.map((d) => d.toJSON()) });
      const synced = new Set<string>(result.syncedIds ?? []);
      for (const doc of docs) {
        if (synced.has(doc.toJSON().id)) {
          await doc.incrementalPatch({ _offlineCreated: false } as any);
        }
      }
    } catch (err) {
      console.error('flushOfflineBookings failed; will retry', err);
    }
  }

  private async flushLockLogs(): Promise<void> {
    const docs = await this.lockLogs.find({ selector: { _synced: false }, sort: [{ createdAt: 'asc' }] }).exec();
    if (!docs.length) return;
    try {
      const result = await this.post('/api/sync/lock-logs', { logs: docs.map((d) => d.toJSON()) });
      const synced = new Set<string>(result.syncedIds ?? []);
      for (const doc of docs) {
        if (synced.has(doc.toJSON().id)) await doc.incrementalPatch({ _synced: true } as any);
      }
    } catch (err) {
      console.error('flushLockLogs failed; will retry', err);
    }
  }
}
```

Note the bookings flush overlaps RxDB's bidirectional push (both deliver the
document, keyed on the same ID, so they converge). The flush exists because the
cloud may need to run follow-up logic on offline bookings (notifications,
player linking); if yours doesn't, bidirectional replication alone suffices
and you can drop that flush.

## Cloud ingestion endpoints

Reference implementation as Next.js route handlers; the contract is plain
JSON-over-POST; port freely. Three rules, all load-bearing:

1. **Authenticate.** These endpoints inject orders and move stock. A shared
   secret header (`x-sync-secret`, same env on both sides) is the minimum.
2. **Idempotent per event ID, on a receipt only the ingestion writes.** Check
   whether the event was already applied *inside a transaction with the
   apply*: a duplicate flush must be a no-op. Never key the check on the
   `inventory_transactions` document: push replication writes that document
   too, usually before the flush arrives, and the increment would be skipped
   while the site folds its delta out. The receipt is the `inventoryLogs`
   entry, which nothing but this route writes.
3. **Stamp replication fields** on every write to a replicated collection.

The two paths own different documents for stock: replication writes the
transaction document, the flush writes the increment and the log entry. The
apply lives in a plain function so the suite can run it against a fake
Firestore:

```ts
// lib/sync/apply-stock-transaction.ts
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export interface IncomingTx {
  id: string;
  inventoryItemId: string;
  locationId: string;
  action: string;
  quantityChange: number;
  reason?: string;
  relatedBookingId?: string;
  performedBy: string;
  performedByName: string;
  createdAt: string;
}

/** Apply one offline stock movement exactly once; a repeat delivery is a no-op. */
export async function applyStockTransaction(db: Firestore, tx: IncomingTx): Promise<void> {
  // Transaction = receipt check + increment + receipt, atomically.
  await db.runTransaction(async (t) => {
    // The log entry is the receipt. Not the inventory_transactions document:
    // push replication writes that one, often before this flush arrives.
    const logRef = db.collection('inventoryLogs').doc(tx.id);
    if ((await t.get(logRef)).exists) return;   // already applied: at-least-once made harmless

    t.update(db.collection('inventory').doc(tx.inventoryItemId), {
      stockLevel: FieldValue.increment(tx.quantityChange),
      updatedAt: FieldValue.serverTimestamp(),
      serverTimestamp: FieldValue.serverTimestamp(),
    });
    t.set(logRef, {
      ...tx,
      reason: tx.reason ?? `Offline sync: ${tx.action}`,
      createdAt: new Date(tx.createdAt),
      syncedFromOffline: true,
      appliedAt: FieldValue.serverTimestamp(),
    });
  });
}
```

```ts
// app/api/sync/inventory-transactions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';   // host's admin-SDK accessor
import { applyStockTransaction, type IncomingTx } from '@/lib/sync/apply-stock-transaction';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-sync-secret') !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { transactions } = (await req.json()) as { transactions: IncomingTx[] };
  if (!transactions?.length) return NextResponse.json({ syncedIds: [] });

  const db = getAdminDb();
  const syncedIds: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const tx of transactions) {
    try {
      await applyStockTransaction(db, tx);
      syncedIds.push(tx.id);
    } catch (err) {
      errors.push({ id: tx.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ syncedIds, errors: errors.length ? errors : undefined });
}
```

The route never writes the `inventory_transactions` document. Replication
inserts it, and pushes `_synced: true` once the site folds the delta out; a
route write there would turn that push into a conflict, and RxDB's default
handler would copy the cloud's `_synced: true` onto the local document before
`markSynced` runs, leaving the delta in the overlay for good.

Bookings and lock-logs ingestion follow the same skeleton, simpler because a
`doc(id).set(...)` is naturally idempotent: auth check, strip RxDB internals
(`_rev`, `_attachments`, `_meta`), convert date strings to `Date`, stamp
`serverTimestamp` + `_deleted: false` + `syncedFromOffline: true`, and return
`syncedIds`. The bookings route also writes `_offlineCreated: false` and
`_locallyModified: false`: those flags describe the site's pending work, and
bookings are bidirectional, so the stored copy is pulled straight back down.
Stored with `_offlineCreated: true`, it would overwrite the site's
acknowledgment, and the retry timer would resend the booking every minute;
provenance stays visible in `syncedFromOffline: true` and the `offline-` ID
prefix. One wrinkle worth keeping: mark offline bookings with that
`syncedFromOffline: true` field so support can filter them, and be aware the
set() gives them `Date`-typed `createdAt` while replicated docs may carry
ISO strings; normalize in one place if your queries sort on it.

## Checklist

- [ ] Ingestion endpoints authenticated (shared secret at minimum)
- [ ] Stock apply is idempotent inside a Firestore transaction, keyed on the
      log entry, never on the replicated transaction document
- [ ] Local delta overlay resets per acknowledged ID, never wholesale
- [ ] Flush retries while online, not only on the next reconnect
- [ ] Delta map rebuilt from unsynced transactions on boot (`rebuildDeltas()`)
- [ ] Stored offline bookings carry `_offlineCreated: false`, or they are resent every minute
- [ ] Flushed collections use client-generated UUIDs as document IDs
