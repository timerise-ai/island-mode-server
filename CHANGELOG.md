# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-09-02

Wording release. Templates and technical content are unchanged from 0.1.3.

### Changed
- The front door (`README.md`, `SKILL.md`, `CLAUDE.md`) describes the module by the
  properties the templates hold and the vitest suite verifies; the record of what the
  audit changed stays in `references/provenance.md`.

## [0.1.3] - 2026-09-02

Wording release. Templates and technical content are unchanged in behaviour from 0.1.2.

### Changed
- `references/local-api.md`: the availability and booking templates use the neutral
  identifiers `slotType` and `station` for the slot kind and the bookable unit, and
  the mutex comment speaks of the last station. Rename to the host app's own
  vocabulary as `adaptation.md` already says.
- `SKILL.md`: the list of example site types in the description no longer names a
  specific venue kind.

## [0.1.2] - 2026-09-02

Wording release. The origin and audit statements across the skill follow section 2 of
the skill standard; templates and technical content are unchanged from 0.1.1. The
repository history starts at this release.

### Changed
- Origin and audit wording across `SKILL.md`, `CLAUDE.md` and `references/` now
  follows the skill standard: the reference point is the earlier implementation,
  stated in the standard's own words. The provenance
  ledger's "Added" heading and its closing section are renamed to match.
- README footer: the modules are written from the modules our engineers have
  shipped.

## [0.1.1] - 2026-09-02

Documentation-only release. The skill itself, `SKILL.md` and `references/`, is
unchanged from 0.1.0.

### Changed
- README: the skill's origin is reworded. It was written by the engineers who built the
  module it describes; the reference point for `provenance.md` is the earlier
  implementation rather than "the source"; the index is called Timerise Skills.
- README: every em-dash, arrow and en-dash in the prose is rewritten as a comma, colon,
  full stop or conjunction.

## [0.1.0] - 2026-09-01

Initial release of the island-mode-server skill: a NestJS + RxDB local server
replicating Firestore collections for a Next.js cloud app, with kiosk/staff PWA
terminals and HMAC-authenticated lock hardware.

### Added
- `SKILL.md` entry point: the frontmatter trigger, when to use and when not to,
  the architecture diagram, six critical facts, four hard rules, a seven-step
  quick start, and the reference directory table.
- `references/architecture.md` — modes (online / island / reconnect), why both
  sync paths exist, the three replication tiers, one-site tenant scope, the
  last-write-wins conflict policy, ID conventions, the meta-field table, and the
  adaptation contract that bounds what a host must supply.
- `references/replication.md` — RxDB setup, per-tier schemas and filters,
  custom-token auth, Firestore security rules, the storage trade-off, and the
  `serverTimestamp` checkpoint trap.
- `references/sync-flush.md` — the reconnect flush, per-ID stock deltas,
  idempotent cloud ingestion keyed on client-generated IDs, and the retry timer.
- `references/network-failover.md` — heartbeat and cron status chain, outage
  detection thresholds, terminal API switching, and the offline rescan.
- `references/auth.md` — local API guards for staff tokens, the kiosk key, and
  HMAC-SHA256 hardware auth with a replay window, plus the offline-gated token
  fallback.
- `references/local-api.md` — the cloud endpoints the terminals need mirrored:
  availability from replicated opening hours, the booking mutex, check-in, and
  the pricing stock filter.
- `references/operations.md` — on-site deployment (systemd, nginx TLS, mDNS),
  the canonical env var list, monitoring and the rollback runbook.
- `references/provenance.md` — the audit ledger: ten source defects fixed in the
  templates, six choices kept deliberately with the reason each is safe, what
  was designed here but never run in production, the verification status, and a
  fix order for anyone porting the original instead.
- `assets/behavior.test.ts` — a vitest suite (12 tests across 4 describe blocks)
  covering HMAC accept/tamper/replay, offline-token expiry, delta fold-out on a
  real RxDB memory instance including partial and duplicate acks, and the
  failover threshold with offline rescan. Shipped into the target project as
  regression cover; it cannot run in this repository.
- `README.md`, `CHANGELOG.md`, `LICENSE` (MIT) and `.gitignore`, matching the
  layout the other Timerise skills use.

### Fixed
Ten defects from the source module, each documented in
`references/provenance.md`. The four that became hard rules:
- Cloud `/api/sync/*` ingestion endpoints accepted unauthenticated POSTs on the
  public internet — anyone could inject confirmed bookings, apply arbitrary
  stock increments, or forge audit logs. Now a shared-secret header check.
- Staff auth fell back to decode-without-verification whenever `verifyIdToken`
  threw, including for forged tokens while fully online, and never checked
  expiry. Now gated on the network monitor reporting offline, with an `exp`
  check on the offline path.
- Stock ingestion applied `FieldValue.increment()` with no already-applied
  check, so a retried flush double-decremented. Now a Firestore transaction
  doing existence-check, increment and log atomically, keyed on the
  client-generated transaction ID.
- `flushAll` cleared the entire local stock-delta map even when a flush had
  failed silently, reverting `effectiveStock` to a stale snapshot. Now per-ID
  fold-out on acknowledged `syncedIds` only.

Also fixed: the flush now retries while unsynced work remains instead of
waiting for the next outage cycle; terminals rescan for the local server on
every offline tick; island availability derives hours from the replicated site
document and the day boundary from the site's timezone rather than hardcoded
10:00–20:00 UTC; `_locallyModified` is declared in the schemas and the unused
`_syncConflict` is dropped; the dead `RXDB_STORAGE_PATH` config that made
operators believe offline data survived restarts is removed and the memory
storage trade-off stated loudly; and replication errors clear once a cycle
completes cleanly, so `/status` stops showing a healed replica as erroring.
