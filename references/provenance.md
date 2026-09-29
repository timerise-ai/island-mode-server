# Provenance

Written by the engineers who have shipped this module. The earlier
implementation it was audited against is a NestJS + RxDB local server
replicating Firestore collections for a Next.js cloud app, with kiosk/staff PWA
terminals and HMAC-authenticated lock hardware. Templates are **hardened**:
they are that design with the audit findings below fixed in place. Everything
not listed under "Added" ran in production in the earlier implementation.

## Fixed in the templates

### 1. Cloud sync-ingestion endpoints had no authentication
The earlier implementation's `/api/sync/*` routes (bookings,
inventory-transactions,
lock-logs) accepted unauthenticated POSTs on the public internet; anyone
could inject confirmed bookings, apply arbitrary stock increments, or forge
audit logs.
**Shipped:** `x-sync-secret` shared-secret check on every ingestion endpoint
([sync-flush.md](sync-flush.md)).

### 2. Offline JWT fallback reachable while online
Staff auth fell back to decode-without-verification whenever `verifyIdToken`
threw, including for forged tokens while fully online, making signature
verification unenforceable. Expiry was never checked.
**Shipped:** fallback gated on the network monitor reporting offline, plus an
`exp` check on the offline path ([auth.md](auth.md)).

### 3. Non-idempotent stock apply under at-least-once delivery
The ingestion route applied `FieldValue.increment()` per transaction with no
already-applied check; a retried flush (lost ack, crash between apply and
mark-synced) double-decremented stock and duplicated logs.
**Shipped:** Firestore transaction doing receipt check + increment + log
atomically, keyed on the client-generated transaction ID. The receipt is the
`inventoryLogs` entry only the ingestion writes, not the
`inventory_transactions` document push replication also writes
([sync-flush.md](sync-flush.md)); see *Added*.

### 4. Wholesale delta reset after a possibly-failed flush
`flushAll` cleared the entire local stock-delta map after flushing, but the
per-collection flush methods swallowed their own errors, so a failed flush
still wiped the deltas and `effectiveStock` reverted to the stale snapshot
(oversell window).
**Shipped:** per-ID delta fold-out on acknowledged `syncedIds` only; no
wholesale reset ([sync-flush.md](sync-flush.md)).

### 5. Flush only ran on the offline-to-online transition
A flush that failed right after reconnect was not retried until the *next*
outage cycle; unsynced work could sit indefinitely while online.
**Shipped:** a 60 s retry timer that flushes whenever unsynced work remains
([sync-flush.md](sync-flush.md)).

### 6. Client never rescanned for the local server while offline
The terminal-side manager searched for the local server once, at the
online-to-offline transition. A local server that booted after that moment was
never found until the cloud recovered and failed again.
**Shipped:** rescan on every offline tick
([network-failover.md](network-failover.md)).

### 7. Island availability ignored site config
Slot generation hardcoded 10:00 to 20:00 and derived "today" from UTC ISO
strings, diverging from the cloud's opening-hours-driven availability (and
shifting the day boundary for non-UTC sites).
**Shipped:** hours derived from the replicated site document, a day without
hours offering no slots; site-timezone `todayAtSite()` helper
([local-api.md](local-api.md)).

### 8. Undeclared and dead meta-fields
`_locallyModified` was patched but absent from every RxDB schema (worked only
because schema validation was off); `_syncConflict` was written once at
creation and never used by anything.
**Shipped:** `_locallyModified` declared in schemas; `_syncConflict` dropped,
with conflict handling documented as an explicit LWW decision
([architecture.md](architecture.md), [replication.md](replication.md)).

### 9. Dead persistence configuration
`RXDB_STORAGE_PATH` existed in config, env examples, and the deployment guide
(which instructed operators to provision a data directory) while the code
unconditionally used memory storage; operators believed offline data
survived restarts; it did not.
**Shipped:** the config removed; the memory-vs-persistent trade-off stated
loudly with options ([replication.md](replication.md)), and the
`Restart=always` interaction called out ([operations.md](operations.md)).

### 10. Sticky replication errors
`lastError` was never cleared after recovery, so `/status` showed a replica as
erroring long after it had healed.
**Shipped:** error timestamping + clearing once replication cycles cleanly
([replication.md](replication.md)).

## Kept deliberately

- **Memory storage as the shipped default**: the earlier implementation's
  choice; the replica self-heals from the cloud and persistent RxDB storage is
  a paid add-on. Kept, but with the loss window documented instead of hidden
  (finding 9).
- **Dual-path sync** (RxDB replication + HTTP flush): looks redundant, is
  not: replication moves documents, the flush runs cloud-side business logic.
  Both are keyed on client IDs so the overlap converges.
- **Last-write-wins conflicts on bidirectional collections**: safe here
  because the status chain blocks cloud writes to an offline site's bookings;
  documented as a precondition, not an accident.
- **Unverified-signature staff auth while offline**: unavoidable without the
  IdP; bounded by the replicated staff allow-list, role checks, expiry check,
  TLS-only LAN, and the offline gate.
- **Fleet-wide HMAC secret for hardware**: matches real controller
  capabilities; per-device keys noted as the upgrade path.
- **Cloud-first failover with `apiBaseUrl: ''` when nothing is reachable**:
  failing visibly against the cloud beats routing to a wrong/stale server.

## Added (not in the earlier implementation: designed, never run in production)

- The flush **retry timer** (fix 5) and **per-ID delta fold-out** (fix 4)
  as implemented here.
- Replication **error clearing via `active$`** (fix 10).
- `todayAtSite()` timezone helper and config-driven `openHours()` (fix 7).
- Found by the 0.1.6 agent eval, where two agents independently patched the
  same template, and fixed in 0.1.7:
  - The stock ingestion receipt (fix 3). 0.1.6 checked the
    `inventory_transactions` document, which the push-only replication writes,
    usually before the flush arrives; the increment was skipped while the site
    folded its delta out, so cloud stock never moved (reproduced in the suite).
    The apply moved to `applyStockTransaction()` so the suite can cover it.
  - Push-only rules granting `read` (the rxdb 16.11 push handler reads before
    writing, checked in its source), the `lock_logs` rule name matching the
    collection, and a `pricing` rule, which 0.1.6 lacked.
  - No default opening hours (fix 7): 0.1.6 fell back to 10:00 to 20:00, a
    locally invented rule.
  - `CORS_ORIGINS` and the cloud env list ([operations.md](operations.md)):
    without CORS headers a browser rejects every failover ping to the box
    (the Fetch standard's CORS check, per MDN). The status cron fails closed
    when `CRON_SECRET` is unset, like the sync endpoints.
- Found by the 0.1.7 agent eval and fixed in 0.1.8, each reproduced by a probe
  or read in the library source:
  - The `locations` pull filtered by document ID. 0.1.7 passed `pull: {}`, and
    the plugin then queries the whole collection, so every box replicated every
    site's config (rxdb 16.11 source; the filter passes the client SDK's query
    validation, live Firestore not run).
  - `ignoreUndefinedProperties` on the replica's Firestore client. RxDB keeps
    optional fields as `undefined` keys and the client SDK rejects `undefined`
    in a batched write, so pushing a stock transaction without a `reason`
    threw (probe against firebase 11.10).
  - The bookings ingestion stores `_offlineCreated: false` and
    `_locallyModified: false`; stored with the site's flags, the copy was pulled
    back and the retry timer resent the booking every minute.
  - `StockService.adjust()` for the adjust endpoint the local API lists.
- Found by the 0.1.8 agent eval and fixed in 0.1.9:
  - Occupancy keyed on the start time inside `dateTimeFrom`. 0.1.8 keyed it on
    the raw `slot.time`, so a booking sent as `'10:00-11:00'` never counted
    against the `'10:00'` slot and the last station sold twice (reproduced; the
    suite covers it).
  - `initFirebase()` returns before sign-in and retries it in the background,
    and replication starts when `signedIn` resolves. 0.1.8 awaited sign-in,
    which needs the network, so a box booted during an outage never started
    replicating. `createCustomToken` signs locally with a service-account
    credential (firebase-admin 13 source).
  - The `GUARD_DEPS` provider token on `AuthGuard`: NestJS cannot inject an
    interface by type (resolved by a NestJS 11 application context).
- Delta-map **rebuild on boot**, as `StockService.rebuildDeltas()` since 0.1.8
  ([sync-flush.md](sync-flush.md)).
- The JSONL journaling option for offline writes (listed as an option only).
- Per-site custom-token scoping suggestion in the rules section.
- The destination paths named on the first line of each code block
  (`local-server/src/` for the local server, `lib/island/` for the terminal
  client), and the instruction to point the suite's `../next/network-manager`
  import at `lib/island/network-manager.ts`. A suggested layout, not the
  earlier implementation's; the host may move the files.

## Verification status

Every TypeScript template compiles under `strict` and
`--noUncheckedIndexedAccess` (Node-side against rxdb 16.11 / firebase 11.10 /
firebase-admin 13 / @nestjs 11; Next-side against Next 16 / React 19), the
suite included. The trust-critical logic passes the behavioural suite in
`assets/behavior.test.ts` (17 tests: HMAC accept/tamper/replay, offline-token
expiry, delta fold-out on a real RxDB memory instance including partial-ack,
duplicate-ack and a rebuild after restart, the ingestion receipt against a
replicated transaction document and a redelivery, config-driven opening hours
and slot occupancy, failover threshold + offline rescan). Not verified by
execution: Firestore rules, the replication plugin against a live Firestore,
nginx/systemd/avahi configs, reviewed against the earlier deployment only.

## If you are fixing an existing implementation instead

Fix order, most damaging first: (1) authenticate the sync endpoints, a live
remote hole; (2) gate the offline JWT fallback on offline mode, a live auth
bypass; (3) make stock ingestion idempotent and (4) stop the wholesale delta
reset, both silent money and stock corruption; (5) decide the storage story and
delete the dead config, an operator-visible data loss; then 5 to 10 as
convenient.
