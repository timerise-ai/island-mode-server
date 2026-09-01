---
name: island-mode-server
description: >
  Build an on-premise fallback server that keeps a live two-way replica of
  remote Firestore data (RxDB replication) and takes over serving LAN clients
  when the cloud is unreachable, then flushes offline work back on reconnect.
  Use when: (1) a physical site (store, range, gym, clinic, warehouse) must keep
  operating through internet outages, (2) the user mentions: "local server with
  two-way sync to Firestore", "island mode", "offline fallback server", "LAN
  failover", "on-prem replica", "site keeps working when internet is down",
  (3) PWA/kiosk terminals need to switch between a cloud API and a local API
  automatically. Covers replication tiers, reconnect flush, idempotent
  ingestion, heartbeat/status chain, client failover, HMAC hardware auth, and
  on-site ops. Node/NestJS local server + Firestore cloud; cloud API
  framework-agnostic.
---

# Island-Mode Server

A small Node server runs at the physical site holding a live RxDB replica of
the site's slice of Firestore. While the internet is up it is invisible; when
the internet drops, kiosk/staff terminals on the LAN fail over to it and the
site keeps taking orders, moving stock, and toggling hardware. On reconnect,
offline work flushes back to the cloud. The one insight that shapes everything:
**sync is two systems, not one** — document-level RxDB replication for state,
plus an HTTP flush of business events the cloud must apply with its own logic
(stock increments, audit ingestion). Neither alone is sufficient.

## When to use

- A site must survive internet outages with real writes (bookings, stock,
  hardware control), not just cached reads.
- Terminals are browser-based (PWA/kiosk) and must fail over transparently.
- Firestore is the cloud source of truth and stays that way.

## When NOT to use

- Pure read caching or a PWA that only needs Firestore's built-in offline
  persistence — the Firebase SDK already does that; no server needed.
- A different cloud database (Supabase/Postgres): the replication tier concept
  travels, but every template here is Firestore-specific.
- Multi-master sync between peer sites — this design is strictly hub-and-spoke
  with the cloud as source of truth and last-write-wins conflicts.

## Architecture

```
            Internet
               |
      +--------+---------+
      | Cloud (SSoT)     |  Firestore + public API + cron status marker
      +--------+---------+
        |             |
   RxDB replication  HTTP flush (reconnect)
        |             |
      +-+-------------+-+
      | Local server    |  Node/NestJS + RxDB, LAN :443 via nginx TLS
      +--------+--------+
               |
     LAN — kiosk PWA, staff PWA, hardware controllers
```

## Critical facts

1. **Every cloud write to a replicated collection MUST stamp the checkpoint
   field** (`serverTimestamp: FieldValue.serverTimestamp()`) and `_deleted:
   false` — the RxDB Firestore plugin pulls by `serverTimestamp > checkpoint`;
   an unstamped document is invisible to replication, silently and forever.
2. **Three replication tiers, chosen per collection**: pull-only (config the
   site consumes), bidirectional (operational state the site mutates), push-only
   (logs the site produces). Getting a collection's tier wrong is the main
   design error.
3. **In-memory RxDB storage means an offline restart loses all offline work.**
   The replica repopulates from Firestore, but offline-created documents are
   gone. Decide the storage trade-off explicitly — see
   [replication.md](references/replication.md).
4. **The flush is at-least-once, so cloud ingestion must be idempotent** — key
   every apply on the client-generated ID and skip already-applied ones.
5. **Push filters prevent echo**: bidirectional pushes only documents flagged
   `_offlineCreated` / `_locallyModified`, so pulled cloud docs don't bounce
   back.
6. **Terminals prefer cloud** — failover engages only after N consecutive
   health failures, and while offline they must keep rescanning for the local
   server, not just once at the transition.

## Hard rules

> **Never expose the cloud sync-ingestion endpoints without auth.** They apply
> stock increments and inject orders. A shared-secret header is the minimum.

> **Never verify offline staff tokens leniently while online.** The
> decode-without-verification fallback is an accepted LAN-only trade-off; it
> must be gated on the server actually being offline, or it becomes a bypass
> of signature verification.

> **Never reset local stock deltas for transactions that have not confirmed as
> synced.** Reset per-ID on acknowledgment, or offline sales double-count or
> vanish from availability.

> **Never let the local server invent business rules the cloud owns** (opening
> hours, pricing). Replicate the config and compute from it, or island-mode
> behaviour diverges from the website.

## Quick start

1. Model collections into tiers and name the seams —
   [architecture.md](references/architecture.md).
2. Stand up RxDB + replication with custom-token auth and security rules —
   [replication.md](references/replication.md).
3. Add the reconnect flush and idempotent cloud ingestion —
   [sync-flush.md](references/sync-flush.md).
4. Wire the heartbeat/status chain and client failover —
   [network-failover.md](references/network-failover.md).
5. Guard the local API (staff / kiosk / hardware HMAC / static token) —
   [auth.md](references/auth.md).
6. Mirror the cloud endpoints the terminals need —
   [local-api.md](references/local-api.md).
7. Deploy on-site: systemd, nginx TLS, mDNS, monitoring —
   [operations.md](references/operations.md).

## Reference directory

| Scenario | Trigger keywords | Reference |
|---|---|---|
| Topology, tiers, seams, rename table | pull-only, bidirectional, push-only, dual-path, locationId, conflict | [architecture.md](references/architecture.md) |
| Replica setup, schemas, checkpoint trap | RxDB, replicateFirestore, serverTimestamp, custom token, storage-memory, firestore.rules | [replication.md](references/replication.md) |
| Reconnect flush, stock deltas, ingestion | flushAll, idempotent, FieldValue.increment, localDelta, syncedIds | [sync-flush.md](references/sync-flush.md) |
| Outage detection and API switching | heartbeat, lastHeartbeatAt, cron, NetworkManager, apiBaseUrl, failover | [network-failover.md](references/network-failover.md) |
| Local API auth | AuthGuard, HMAC, replay window, offline JWT fallback, kiosk key | [auth.md](references/auth.md) |
| Offline endpoints and writes | availability, mutex, offline booking, check-in, pricing stock filter | [local-api.md](references/local-api.md) |
| On-site deployment and runbook | systemd, nginx, self-signed TLS, mDNS, avahi, journalctl, rollback | [operations.md](references/operations.md) |
| What was fixed vs. the earlier implementation | provenance, audit, deviations, kept deliberately | [provenance.md](references/provenance.md) |

Passing vitest suite for the trust-critical logic (HMAC verify, offline token
decode, delta fold-out on real RxDB, failover rescan):
[assets/behavior.test.ts](assets/behavior.test.ts) — carry it into the target
project as regression cover.
