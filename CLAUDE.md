# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

An [Agent Skill](https://agentskills.io) package: markdown only, plus one test file carried into the target
project. There is no `package.json` here and nothing in this repository executes. It teaches an agent to build
an island-mode server in someone else's codebase: a Node/NestJS box at a physical site holding a live RxDB
replica of the site's slice of Firestore, taking over the LAN when the internet drops and flushing offline
work back on reconnect. The cloud side is Next.js route handlers as the reference API.

The commands and code in `references/` describe the app the agent will generate, not this repository.
`assets/behavior.test.ts` **cannot run here**: it imports `./hmac.util`, `./auth-guard`, `./stock` and
`../next/network-manager`, which exist only once the templates have been copied into a host project. Do not
add a `package.json` or a vitest config to make it runnable; verify it by reading it against the templates in
`references/`, or by running it in a target project after adaptation.

The skill was written by the engineers who have shipped this module, and audited against the earlier
implementation, the on-premise fallback of a multi-location venue booking system. `references/provenance.md`
is the rationale layer and the audit ledger: the only place that distinguishes what the audit changed, what
was kept deliberately, and what was designed here and has never run in production. Read it before
"simplifying" anything.

Sibling directories under `../` (`booking-kiosk`, `help-center-markdown` and the others) are other skills,
not dependencies.

## Structure

- `SKILL.md`: the router, loaded whole on every activation, so it stays between 130 and 160 lines, the
  closing index line aside. It carries only what an agent must know before choosing a reference: the
  frontmatter trigger, the architecture diagram and where the seam lives, the six critical facts, the four
  hard rules, the quick start and the reference directory, then the line linking the skills index. Deep
  material belongs in `references/`.
- `README.md`: the human-facing front door, in the section order every Timerise skill shares: the pitch,
  install for every skills-compatible host, the file table, the four non-negotiables, the seams table,
  verification. Never routing detail or template code.
- `CHANGELOG.md`: Keep a Changelog, newest release first. The version lives here, in the README's
  current-release line and in the git tag, and the three agree; there is no version in the `SKILL.md`
  frontmatter.
- `references/*.md`: seven topic files plus `provenance.md`, loaded on demand. `architecture.md` holds the
  modes, the tiers, the meta-fields and the seam contract (*Adaptation contract*), which stands in for an
  `adaptation.md`.
- `assets/behavior.test.ts`: the vitest suite carried into the target project, **16 tests across 6
  describe blocks**.
- `evals/`: `prompts.md` holds what an operator types after installing, in their words; the first prompt is
  the agent eval run before every release. Every other file there is one eval run: measured frontmatter that
  is never edited, then the notes of the person who ran it. Add a prompt rather than rewording one that has
  results. The procedure is section 10 of the index's STANDARD.md.
- `.github/workflows/agent-eval.yml`: the caller of the index's reusable eval workflow, copied verbatim from
  STANDARD.md and the same in every skill. Do not edit it, and never add a trigger on `push` or
  `pull_request`.

## Editing conventions

- **Code blocks name their destination on the first line** as a comment: `// local-server/src/stock.ts` for
  the local server, `// lib/island/network-manager.ts` for the terminal client, `// app/api/...` for the cloud
  routes. A block that continues a file already introduced omits it.
- **Templates compile** under `strict` and `--noUncheckedIndexedAccess` against the library versions named in
  the *Verification status* of `provenance.md`. Changing the suite means changing its count there and in the
  README; do not let the claim drift from the file.
- **Identifiers are shared across files.** `AuthGuard`, `decodeOfflineToken`, `generateHmac`, `verifyHmac`,
  `StockService`, `SyncFlushService`, `ReplicationService`, `NetworkManager`, `replicationStamp`,
  `todayAtSite`, `effectiveStock`, `syncedIds`. Rename in all files or none.
- **Two kinds of name.** The domain vocabulary the host renames is the rename table in `architecture.md`:
  `location / booking / inventory / lock / staff / pricing`, scoped by `locationId`. Never rename inside the
  skill to match one product. The identifiers above, the meta-fields and the env var names are the authoring
  contract of this repository and stay consistent here.
- **Keep the indexes in sync.** Adding, renaming or splitting a file in `references/` or `assets/` means
  updating the quick start and the reference directory in `SKILL.md` (with its trigger keywords), the file
  table in `README.md`, and any cross-links. Links between references are sibling-style
  (`[sync-flush.md](sync-flush.md)`); links from `SKILL.md` are `references/`-prefixed; links from the README
  are `references/`-prefixed and wrapped in backticks.
- **The non-negotiables are never presented as optional.** The four hard rules in `SKILL.md` and the four
  non-negotiables in `README.md` are one list in one order: auth on cloud ingestion, the offline-gated token
  fallback, per-ID delta reset, no locally invented business rules. They are entries 1 to 4 of the ledger,
  which records why each holds. Changing one is a MAJOR release. The ledger has ten entries under *Fixed in
  the templates*, and that count lives there only.
- **The ledger stays truthful.** Any change to a template updates `provenance.md`: a new defect of the earlier
  implementation fixed is a numbered entry under *Fixed in the templates*; a questionable earlier choice kept
  is an entry under *Kept deliberately* with the reason it is safe; anything the earlier implementation never
  ran is an entry under *Added*.
- **Do not remove the odd-looking parts.** The dual sync path, last-write-wins on bidirectional collections,
  the per-ID fold-out, the offline gate on the token fallback, the fleet-wide HMAC secret, `apiBaseUrl: ''`
  when nothing answers. Each is a ledger entry; check
  `provenance.md` before touching one.
- **Measured numbers are load-bearing.** The 30 s HMAC replay window, the 5 s health cadence, the three
  consecutive failures, the stale threshold at twice the cron cadence and the test count are design
  parameters or facts this repository verifies. Do not restate one loosely and do not invent new ones.
- **Content invariants.** These recur across references, and changing one means sweeping all of them.
  - The meta-fields (`_offlineCreated`, `_locallyModified`, `_synced`, `serverTimestamp`, `_deleted`) are
    declared in `architecture.md` and appear in every RxDB schema in `replication.md`. An undeclared
    meta-field is itself a ledger entry.
  - Every cloud write to a replicated collection stamps `serverTimestamp` and `_deleted: false`; omitting it
    makes the document permanently invisible to replication.
  - The seams table in `architecture.md` is the full boundary with the host. A template that needs something
    new from the host adds it there or does not belong.
  - The env var names in `operations.md` are the canonical list (`SYNC_SECRET`, `TERMINAL_SECRET`,
    `LOCK_ACCESS_TOKEN`, `KIOSK_API_KEY` and the rest), referenced by the same names in `auth.md`,
    `sync-flush.md` and `local-api.md`.
  - The local server is NestJS and the cloud examples are Next.js route handlers, both stated as
    substitutable; keep a new template's framework-specific surface thin enough that the claim holds.
- **The front door describes properties, not failures.** The README intro, the `SKILL.md` framing and the
  frontmatter description say what the templates hold and the suite verifies, never what the earlier
  implementation got wrong. Every factual claim in the README (library versions, the test count) restates
  `provenance.md`.
- **Plain punctuation.** No em-dashes, en-dashes, arrows, middle dots or smart quotes anywhere in this
  repository's markdown, code blocks included. Prose wraps at 110 columns; table rows and commands stay on one
  line.
- **Claims are verifiable.** A changed factual claim says how it was verified: against RxDB, the Firebase
  SDKs, NestJS, the Firestore documentation, or a reproduction. Never from memory.
- **Evals are not skill content.** A new prompt or an eval result is committed as `chore(evals): ...`, never
  causes a version bump and never rides in a release commit. A failing run stays committed; the fix is the
  next release.
- **Commits follow Conventional Commits**, releases follow section 9 of the index's STANDARD.md, and no file
  or commit message names a tool or a model as author.
