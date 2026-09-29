# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] - 2026-09-29

Fix release, from scoring the prompt-1 agent eval runs against 0.1.9.

### Fixed

- `local-server/package.json` pins `rxdb` to exactly 16.11.0 and `firebase` to 11.6.0,
  the exact version that rxdb release depends on. The earlier `firebase` pin, 11.10.0,
  installed a second copy under rxdb, and the replication plugin's copy threw on the
  host's Firestore instance, so no push succeeded. Apps built from earlier versions
  should align the pin and check that `npm ls firebase` shows one copy.

### Changed

- `SKILL.md`: documented variants (persistent storage, per-site tokens) and extra
  hardening go in new files around a template, never inside one.
- `references/replication.md` explains the pin and names `npm ls firebase` as the check;
  the stated firebase version is 11.6.

## [0.1.9] - 2026-09-29

Fix release, from scoring the prompt-1 agent eval runs against 0.1.8.

### Fixed

- Offline availability keys occupancy on the start time inside `dateTimeFrom`. 0.1.8
  keyed it on the raw `slot.time`, so a booking sent as `'10:00-11:00'` left its
  `'10:00'` slot looking free and the last station could be sold twice. Apps built
  from earlier versions should copy in `getAvailableSlots()`.
- `initFirebase()` no longer waits for sign-in: it retries in the background and
  returns `signedIn`, and replication starts when that resolves. A server booted
  during an outage previously never started replicating.
- `AuthGuard` takes its dependencies through the `GUARD_DEPS` provider token, since
  NestJS cannot inject an interface by type.

### Added

- A test for occupancy with a time sent as a range: 17 tests in 6 describe blocks.

### Changed

- `SKILL.md`: the deploy step says `GOOGLE_APPLICATION_CREDENTIALS` is a path read
  from the environment and is not to be inlined; the guard and local API steps merge
  into one.
- `references/replication.md`: the startup order rebuilds the stock overlay first and
  starts replication from `signedIn`.

## [0.1.8] - 2026-09-29

Fix release, from scoring the prompt-1 agent eval runs against 0.1.7.

### Fixed

- The `locations` pull filters by document ID. 0.1.7 passed `pull: {}`, which makes
  the plugin query the whole collection, so every local server replicated every
  site's configuration. Apps built from earlier versions should copy in the new
  `startAll()` in `replication.service.ts`.
- The replica's Firestore client sets `ignoreUndefinedProperties`: RxDB keeps
  optional fields as `undefined` keys, which the client SDK rejects in a write, so a
  stock transaction without a `reason` never pushed. Copy in the new
  `firebase-client.ts`.
- The bookings ingestion stores `_offlineCreated: false` and `_locallyModified:
  false`. Stored with the site's flags, the booking was pulled back and resent every
  minute.

### Added

- `StockService.rebuildDeltas()`, called once at boot, and `StockService.adjust()`.
- A test for the rebuild after a restart: 16 tests in 6 describe blocks.

### Changed

- `references/operations.md`: `GOOGLE_APPLICATION_CREDENTIALS`,
  `NEXT_PUBLIC_LOCAL_SERVER_URL` and the `HEARTBEAT_*` pair are kept by name in both
  `.env.example` files, with the reason for each.
- The rename table in `references/architecture.md` names the booking's `ammunition`
  add-ons.

## [0.1.7] - 2026-09-29

Fix release, from scoring the prompt-1 agent eval runs against 0.1.6.

### Fixed

- Stock ingestion skipped the increment when push replication had already written the
  transaction document, which is the usual order on reconnect; the site then folded its
  delta out, so cloud stock never moved and the site oversold. The receipt is now the
  `inventoryLogs` entry only the ingestion writes, the apply lives in
  `lib/sync/apply-stock-transaction.ts`, and the route never writes the replicated
  document. Apps built from 0.1.6 or earlier should copy in `applyStockTransaction()`
  and the new route.
- Firestore rules: push-only collections grant `read`, which the RxDB push handler
  needs before it writes; the `lock_logs` rule matches its collection name; `pricing`
  has a rule. Apps built from earlier versions should redeploy the rules.
- Availability offers no slots on a day the site config has no hours for, instead of
  inventing 10:00 to 20:00.
- The suite type-checks under `--noUncheckedIndexedAccess`; the flush and booking
  blocks carry their imports; `lib/island/api-fetch.ts` is a complete wrapper.
- The status cron answers 401 when `CRON_SECRET` is unset.

### Added

- `CORS_ORIGINS`, the cloud env list and a *Handover* section in
  `references/operations.md`; `LOCATION_ID` is required, with no default.
- Three tests: the ingestion receipt against a replicated transaction document, a
  redelivery, and config-driven opening hours. 15 tests in 6 describe blocks.

### Changed

- `SKILL.md`: copy the templates as written and report a suspected defect in the
  handover; the quick start names both env files, the suite's two imports and its count,
  and ends with the handover.
- The stated firebase version is 11.10, the version `references/replication.md` pins.

## [0.1.6] - 2026-09-29

Wording and layout release. The templates are unchanged in behaviour from 0.1.5.

### Added

- Every TypeScript, TSX and JSON block in `references/` names its destination file on
  the first line: `local-server/src/` for the local server, `lib/island/` for the
  terminal client, `app/api/` for the cloud routes. The suggested layout is recorded
  under *Added* in `references/provenance.md`.
- The quick start in `SKILL.md` ends with carrying `assets/behavior.test.ts` into
  `local-server/src/`, and the reference directory lists it.

### Changed

- `SKILL.md`: the frontmatter description follows the index's standard order, each
  critical fact is one bold sentence followed by the reason, and the body says the seam
  contract lives in `references/architecture.md`.
- `README.md`: a three-paragraph intro, a file table row for every file in the
  repository including the eval workflow, and Verification before Not this.
- `CLAUDE.md`: rewritten into the three standard sections (what the repository is,
  structure, editing conventions), keeping every existing rule.
- Plain punctuation throughout: em-dashes, en-dashes and arrows in the references,
  `SKILL.md` and this changelog are rewritten as commas, colons or words.

## [0.1.5] - 2026-09-21

Wording release. The skill content is unchanged from 0.1.4.

### Added

- `SKILL.md` closes with a line linking the
  [Timerise Skills](https://github.com/timerise-ai/skills) index, so an agent that
  has the skill loaded can find the sibling skills for neighbouring modules without
  leaving the entry point.

### Changed

- `CLAUDE.md` records the closing line in the `SKILL.md` layout.

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
  implementation rather than the older wording; the index is called Timerise Skills.
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
- `references/architecture.md`: modes (online / island / reconnect), why both
  sync paths exist, the three replication tiers, one-site tenant scope, the
  last-write-wins conflict policy, ID conventions, the meta-field table, and the
  adaptation contract that bounds what a host must supply.
- `references/replication.md`: RxDB setup, per-tier schemas and filters,
  custom-token auth, Firestore security rules, the storage trade-off, and the
  `serverTimestamp` checkpoint trap.
- `references/sync-flush.md`: the reconnect flush, per-ID stock deltas,
  idempotent cloud ingestion keyed on client-generated IDs, and the retry timer.
- `references/network-failover.md`: heartbeat and cron status chain, outage
  detection thresholds, terminal API switching, and the offline rescan.
- `references/auth.md`: local API guards for staff tokens, the kiosk key, and
  HMAC-SHA256 hardware auth with a replay window, plus the offline-gated token
  fallback.
- `references/local-api.md`: the cloud endpoints the terminals need mirrored:
  availability from replicated opening hours, the booking mutex, check-in, and
  the pricing stock filter.
- `references/operations.md`: on-site deployment (systemd, nginx TLS, mDNS),
  the canonical env var list, monitoring and the rollback runbook.
- `references/provenance.md`: the audit ledger: ten defects of the earlier implementation fixed in the
  templates, six choices kept deliberately with the reason each is safe, what
  was designed here but never run in production, the verification status, and a
  fix order for anyone porting the original instead.
- `assets/behavior.test.ts`: a vitest suite (12 tests across 4 describe blocks)
  covering HMAC accept/tamper/replay, offline-token expiry, delta fold-out on a
  real RxDB memory instance including partial and duplicate acks, and the
  failover threshold with offline rescan. Shipped into the target project as
  regression cover; it cannot run in this repository.
- `README.md`, `CHANGELOG.md`, `LICENSE` (MIT) and `.gitignore`, matching the
  layout the other Timerise skills use.

### Fixed
Ten defects of the earlier implementation, each documented in
`references/provenance.md`. The four that became hard rules:
- Cloud `/api/sync/*` ingestion endpoints accepted unauthenticated POSTs on the
  public internet, so anyone could inject confirmed bookings, apply arbitrary
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
10:00 to 20:00 UTC; `_locallyModified` is declared in the schemas and the unused
`_syncConflict` is dropped; the dead `RXDB_STORAGE_PATH` config that made
operators believe offline data survived restarts is removed and the memory
storage trade-off stated loudly; and replication errors clear once a cycle
completes cleanly, so `/status` stops showing a healed replica as erroring.
