# Reconnect flush and idempotent ingestion

When connectivity returns, the local server pushes its offline business events
to cloud HTTP endpoints. Delivery is **at-least-once** (the POST can succeed
while the acknowledgment is lost, the process can crash between apply and
mark-synced, the same batch can be retried), so the cloud side must be
idempotent per event ID. That property is what also makes the overlap with
RxDB's own push replication harmless.

## The stock-delta overlay (why it exists)

While offline, the replica's `stockLevel` is a frozen cloud snapshot — the
local server must not mutate it, or replication would push a value the cloud
later recomputes differently. Instead, offline stock movements are recorded as
append-only transactions plus an **in-memory delta map** overlaid at read time:

```
effectiveStock(item) = replicaSnapshot.stockLevel + localDelta(item)
```

When the cloud confirms a transaction batch, those transactions' deltas fold
out of the overlay — the cloud has applied the increments, and the updated
`stockLevel` flows back down via pull replication.

```ts
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

  async getUnsynced(): Promise<StockTransaction[]> {
    const docs = await this.transactions.find({ selector: { _synced: false }, sort: [{ createdAt: 'asc' }] }).exec();
    return docs.map((d) => d.toJSON() as StockTransaction);
  }

  /**
   * Fold ONLY the acknowledged transactions out of the overlay.
   * Never clear the whole map on "flush finished" — a partially failed flush
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

Restart caveat: the delta map is memory-only. On restart it is rebuilt by
replaying unsynced transactions (`getUnsynced()` → re-add deltas) — do that in
boot code. With memory storage the transactions themselves are gone too; see
the storage decision in [replication.md](replication.md).

## The flush service

Triggered by the network monitor's `online` event
([network-failover.md](network-failover.md)) — and, because a flush attempt
can fail while the network stays up, also by a slow retry timer whenever
unsynced work remains.

```ts
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
      // Trust ONLY the acknowledged IDs — never assume the whole batch landed.
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
document, keyed on the same ID — they converge). The flush exists because the
cloud may need to run follow-up logic on offline bookings (notifications,
player linking); if yours doesn't, bidirectional replication alone suffices
and you can drop that flush.

## Cloud ingestion endpoints

Reference implementation as Next.js route handlers; the contract is plain
JSON-over-POST — port freely. Three rules, all load-bearing:

1. **Authenticate.** These endpoints inject orders and move stock. A shared
   secret header (`x-sync-secret`, same env on both sides) is the minimum.
2. **Idempotent per event ID.** Check whether the event was already applied
   *inside a transaction with the apply* — a duplicate flush must be a no-op.
3. **Stamp replication fields** on every write to a replicated collection.

```ts
// app/api/sync/inventory-transactions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';   // host's admin-SDK accessor
import { FieldValue } from 'firebase-admin/firestore';

interface IncomingTx {
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
      // Transaction = idempotency check + increment + logs, atomically.
      await db.runTransaction(async (t) => {
        const txRef = db.collection('inventory_transactions').doc(tx.id);
        const existing = await t.get(txRef);
        if (existing.exists) return;   // already applied — at-least-once made harmless

        const itemRef = db.collection('inventory').doc(tx.inventoryItemId);
        t.update(itemRef, {
          stockLevel: FieldValue.increment(tx.quantityChange),
          updatedAt: FieldValue.serverTimestamp(),
          serverTimestamp: FieldValue.serverTimestamp(),
        });
        t.set(db.collection('inventoryLogs').doc(tx.id), {
          ...tx,
          reason: tx.reason ?? `Offline sync: ${tx.action}`,
          createdAt: new Date(tx.createdAt),
          syncedFromOffline: true,
        });
        t.set(txRef, {
          ...tx,
          _synced: true,
          syncedAt: FieldValue.serverTimestamp(),
          serverTimestamp: FieldValue.serverTimestamp(),
          _deleted: false,
        });
      });
      syncedIds.push(tx.id);
    } catch (err) {
      errors.push({ id: tx.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ syncedIds, errors: errors.length ? errors : undefined });
}
```

Bookings and lock-logs ingestion follow the same skeleton, simpler because a
`doc(id).set(...)` is naturally idempotent — auth check, strip RxDB internals
(`_rev`, `_attachments`, `_meta`), convert date strings to `Date`, stamp
`serverTimestamp` + `_deleted: false` + `syncedFromOffline: true`, and return
`syncedIds`. One wrinkle worth keeping: mark offline bookings with a
`syncedFromOffline: true` field so support can filter them, and be aware the
set() gives them `Date`-typed `createdAt` while replicated docs may carry
ISO strings — normalize in one place if your queries sort on it.

## Checklist

- [ ] Ingestion endpoints authenticated (shared secret at minimum)
- [ ] Stock apply is idempotent inside a Firestore transaction
- [ ] Local delta overlay resets per acknowledged ID, never wholesale
- [ ] Flush retries while online, not only on the next reconnect
- [ ] Delta map rebuilt from unsynced transactions on boot
- [ ] Flushed collections use client-generated UUIDs as document IDs
