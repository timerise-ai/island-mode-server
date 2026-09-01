# Architecture

The system is three cooperating parts. Each can be reasoned about alone, but
the guarantees only hold together.

| Part | Runs | Job |
|---|---|---|
| Cloud | Managed hosting (e.g. Vercel) + Firestore | Source of truth, public API, marks sites offline via cron |
| Local server | Node box at the site, LAN only | Live replica + fallback API + hardware gateway |
| Terminals | Browser PWAs (kiosk, staff) + hardware controllers | Talk to cloud; fail over to local server on outage |

## Modes

**ONLINE** — terminals call the cloud API. The local server is passive: it
replicates in the background and heartbeats so the cloud knows it's alive.

**OFFLINE (island mode)** — terminals detect the cloud is unreachable and
switch their API base URL to the local server. Bookings, stock movements, and
hardware locks work autonomously from the replica. Customer-facing *cloud*
booking for this site is blocked (the cron marks the site `status: 'offline'`
and the website disables the flow), so the island cannot double-book against
the internet.

**RECONNECT** — the local server's heartbeat succeeds again; it flushes
offline work to the cloud ([sync-flush.md](sync-flush.md)) while live
replication resumes on its own.

## The two sync paths — why both exist

| Path | Granularity | Direction | Good at | Cannot do |
|---|---|---|---|---|
| RxDB Firestore replication | whole documents, live | per-tier | keeping the replica current; pushing offline-created docs | running server-side business logic |
| HTTP flush on reconnect | business events, batched | local → cloud | atomic stock increments, audit ingestion, dedup | keeping state current |

Replication is document-level last-write-wins: it can copy an offline booking
document to Firestore, but it cannot *apply* an inventory transaction — that
requires `FieldValue.increment()` and log writes the cloud must perform
transactionally. Hence the flush endpoints. Both paths may deliver the same
document (they converge because everything is keyed on client-generated IDs);
the flush endpoints are what make the overlap safe — see
[sync-flush.md](sync-flush.md).

## Replication tiers

Classify every collection before writing code. The tier decides the pull
filter, the push filter, and the security rule.

| Tier | Flow | Use for | Example collections (source domain) |
|---|---|---|---|
| Pull-only | cloud → local | Config the site consumes but never edits | `locations` (own doc), `inventory`, `pricing`, `staff` |
| Bidirectional | both | Operational state the site mutates offline | `bookings`, `locks` |
| Push-only | local → cloud | Append-only logs the site produces | `lock_logs`, `inventory_transactions` |

Tier rules of thumb:

- If the site edits it offline and the cloud also edits it, it is
  bidirectional — and you have accepted last-write-wins conflicts on it (see
  below).
- If it is append-only with client-generated IDs, push-only is safe and
  conflict-free. Prefer restructuring state changes into append-only events
  where you can.
- Staff/user directories are pull-only even though they feel like "auth data":
  the site only ever reads them (offline login checks).

## Scope: one site, one server

Everything replicated is filtered by one tenant field (`locationId` in the
source; rename to yours). The local server holds **only its own site's data** —
that is the security boundary that makes a stolen on-site box a bounded loss,
and it is enforced twice: in the pull filters and in Firestore security rules
([replication.md](replication.md)). The site's own identity comes from env
(`LOCATION_ID`), never from request input.

Special cases seen in practice:

- The site's own config document is pulled by **document ID**, not by tenant
  field (the doc *is* the tenant).
- Directory collections may use an array field: `where('locationIds',
  'array-contains', locationId)` for staff assigned to multiple sites.

## Conflict policy (decided, not discovered)

Bidirectional replication here is **last-write-wins by design**. This is
acceptable because the windows are disjoint in practice: while the site is
offline, the cloud blocks customer bookings for that site (status chain, see
[network-failover.md](network-failover.md)), so cloud and island rarely edit
the same document. If your domain cannot block cloud writes during outages, do
not use bidirectional for that collection — restructure to push-only events
and let the cloud fold them in.

Note: the earlier implementation carried a `_syncConflict` field that nothing
ever set,
a reminder that a conflict *detector* was planned. If you need one, RxDB
accepts a custom `conflictHandler`; wire it to flag the losing revision into an
ops queue rather than silently dropping it.

## ID conventions

- Offline-created documents get a recognizable prefix: `offline-<uuid>`. This
  makes provenance visible in the cloud DB and lets support answer "was this
  made during the outage?" instantly.
- All event/log IDs are client-generated UUIDs — that is what makes cloud
  ingestion idempotent.

## Document meta-fields

| Field | Set by | Meaning |
|---|---|---|
| `_offlineCreated` | local server on offline insert | Push this doc; flush it on reconnect; provenance marker |
| `_locallyModified` | local server on offline patch | Push this doc (echo prevention) |
| `_synced` | local server / cloud ingestion | Event has been applied by the cloud |
| `serverTimestamp` | cloud, on every write | Replication checkpoint field — see the trap in [replication.md](replication.md) |
| `_deleted` | cloud | Soft-delete flag the plugin requires |

Declare every one of these in the RxDB schemas. The earlier implementation
patched
`_locallyModified` without declaring it — it worked only because schema
validation was off, and would break the day a validation plugin is added.

## Adaptation contract (the seams)

| Seam | This skill ships | The host supplies |
|---|---|---|
| Domain entities | `location/booking/inventory/lock/staff/pricing` + this rename table | Its vocabulary — e.g. location→store/clinic/site, booking→order/appointment, lock→door/device |
| Tenant scope | `locationId` (env-derived, one per server) | Its field name; array variant for directories |
| Cloud API | Next.js route handlers as reference | Any framework — the contracts are plain JSON-over-POST |
| Staff identity | Firebase Auth ID tokens + role hierarchy | Its IdP; keep the online-verify/offline-lookup split |
| Hardware auth | HMAC-SHA256 shared secret | Its device fleet's capabilities |
| Local runtime | NestJS (DI + guards) | Any Node HTTP framework; services are plain classes |
| UI status surface | State shape only (`mode`, `apiBaseUrl`) | Its own banner/indicator components |
| Strings | English literals in code, keys suggested | Its i18n system |

Nothing else crosses the boundary. Notably **the local server has no UI** —
its operator surface is `/health`, `/status`, and journald
([operations.md](operations.md)).
