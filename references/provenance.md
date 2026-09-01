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
lock-logs) accepted unauthenticated POSTs on the public internet — anyone
could inject confirmed bookings, apply arbitrary stock increments, or forge
audit logs.
**Shipped:** `x-sync-secret` shared-secret check on every ingestion endpoint
([sync-flush.md](sync-flush.md)).

### 2. Offline JWT fallback reachable while online
Staff auth fell back to decode-without-verification whenever `verifyIdToken`
threw — including for forged tokens while fully online, making signature
verification unenforceable. Expiry was never checked.
**Shipped:** fallback gated on the network monitor reporting offline, plus an
`exp` check on the offline path ([auth.md](auth.md)).

### 3. Non-idempotent stock apply under at-least-once delivery
The ingestion route applied `FieldValue.increment()` per transaction with no
already-applied check; a retried flush (lost ack, crash between apply and
mark-synced) double-decremented stock and duplicated logs.
**Shipped:** Firestore transaction doing existence-check + increment + log
atomically, keyed on the client-generated transaction ID
([sync-flush.md](sync-flush.md)).

### 4. Wholesale delta reset after a possibly-failed flush
`flushAll` cleared the entire local stock-delta map after flushing, but the
per-collection flush methods swallowed their own errors — so a failed flush
still wiped the deltas and `effectiveStock` reverted to the stale snapshot
(oversell window).
**Shipped:** per-ID delta fold-out on acknowledged `syncedIds` only; no
wholesale reset ([sync-flush.md](sync-flush.md)).

### 5. Flush only ran on the offline→online transition
A flush that failed right after reconnect was not retried until the *next*
outage cycle; unsynced work could sit indefinitely while online.
**Shipped:** a 60 s retry timer that flushes whenever unsynced work remains
([sync-flush.md](sync-flush.md)).

### 6. Client never rescanned for the local server while offline
The terminal-side manager searched for the local server once, at the
online→offline transition. A local server that booted after that moment was
never found until the cloud recovered and failed again.
**Shipped:** rescan on every offline tick
([network-failover.md](network-failover.md)).

### 7. Island availability ignored site config
Slot generation hardcoded 10:00–20:00 and derived "today" from UTC ISO
strings, diverging from the cloud's opening-hours-driven availability (and
shifting the day boundary for non-UTC sites).
**Shipped:** hours derived from the replicated site document; site-timezone
`todayAtSite()` helper ([local-api.md](local-api.md)).

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
unconditionally used memory storage — operators believed offline data
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
- **Dual-path sync** (RxDB replication + HTTP flush) — looks redundant, is
  not: replication moves documents, the flush runs cloud-side business logic.
  Both are keyed on client IDs so the overlap converges.
- **Last-write-wins conflicts on bidirectional collections** — safe here
  because the status chain blocks cloud writes to an offline site's bookings;
  documented as a precondition, not an accident.
- **Unverified-signature staff auth while offline** — unavoidable without the
  IdP; bounded by the replicated staff allow-list, role checks, expiry check,
  TLS-only LAN, and the offline gate.
- **Fleet-wide HMAC secret for hardware** — matches real controller
  capabilities; per-device keys noted as the upgrade path.
- **Cloud-first failover with `apiBaseUrl: ''` when nothing is reachable** —
  failing visibly against the cloud beats routing to a wrong/stale server.

## Added (not in the earlier implementation: designed, never run in production)

- The flush **retry timer** (fix 5) and **per-ID delta fold-out** (fix 4)
  as implemented here.
- Replication **error clearing via `active$`** (fix 10).
- `todayAtSite()` timezone helper and config-driven `openHours()` (fix 7).
- Delta-map **rebuild-on-boot** guidance ([sync-flush.md](sync-flush.md)).
- The JSONL journaling option for offline writes (listed as an option only).
- Per-site custom-token scoping suggestion in the rules section.

## Verification status

Every TypeScript template compiles under `strict` and
`--noUncheckedIndexedAccess` (Node-side against rxdb 16.11 / firebase 12 /
firebase-admin 13 / @nestjs 11; Next-side against Next 16 / React 19). The
trust-critical logic passes the behavioural suite in
`assets/behavior.test.ts` (12 tests: HMAC accept/tamper/replay, offline-token
expiry, delta fold-out on a real RxDB memory instance including partial-ack
and duplicate-ack, failover threshold + offline rescan). Not verified by
execution: Firestore rules, the replication plugin against a live Firestore,
nginx/systemd/avahi configs, reviewed against the earlier deployment only.

## If you are fixing an existing implementation instead

Fix order, most damaging first: (1) authenticate the sync endpoints — live
remote hole; (2) gate the offline JWT fallback on offline mode — live auth
bypass; (3) make stock ingestion idempotent and (4) stop the wholesale delta
reset — silent money/stock corruption; (5) decide the storage story and delete
the dead config — operator-visible data loss; then 5–10 as convenient.
