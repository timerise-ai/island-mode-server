# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A **Claude Skill package**, not an application. It ships prose + TypeScript
templates that teach another agent how to build an island-mode (offline
fallback) server in *someone else's* codebase. There is no application here to
run — no `package.json`, no build, no lint and no dev server. It is a git
repo, but only so the skill can be cloned and versioned; `git` here tracks
prose, not code.

```
SKILL.md                  entry point: frontmatter trigger + critical facts + routing table
references/*.md           7 topic files + provenance.md, loaded on demand by the routing table
assets/behavior.test.ts   vitest suite shipped INTO the target project
README.md                 human-facing: pitch, install, coverage table, hard rules, seams
CHANGELOG.md              Keep a Changelog + SemVer; git tags are the version of record
LICENSE                   MIT
```

Sibling directories under `../` (`booking-kiosk`, `help-center-markdown`,
…) are other skills, not dependencies.

## Commands

None. `assets/behavior.test.ts` **cannot run here** — it imports
`./hmac.util`, `./auth-guard`, `./stock`, `../next/network-manager`, which
exist only after the templates have been copied into a host project. Do not
add a `package.json` or vitest config to make it runnable locally; verify it
by reading it against the templates in `references/`, or by running it in a
target project after adaptation.

## Editing rules specific to this repo

**SKILL.md is a router, not a tutorial.** It carries only what an agent must
know before choosing a reference: the frontmatter trigger, the architecture
diagram, the 6 critical facts, the 4 hard rules, and the routing table. Deep
material belongs in `references/`. Keep it short — it is loaded on every
trigger; references are not.

**Four places index the references.** Adding, renaming, or splitting a file
in `references/` means updating all of: the *Quick start* numbered list in
SKILL.md, its *Reference directory* table (including the trigger keywords),
the *What it covers* table in `README.md`, and any cross-links in sibling
references. Cross-links between references are relative and sibling-style
(`[sync-flush.md](sync-flush.md)`); links from SKILL.md are
`references/`-prefixed; links from README.md are `references/`-prefixed and
wrapped in backticks.

**README.md is for humans, SKILL.md is for the agent.** The README carries the
pitch, install instructions for every skills-compatible host, the coverage
table, the four hard rules and the seams table — never routing detail or
template code. It describes the module by the properties the templates hold
and the suite verifies, never by what the earlier implementation got wrong.
Every factual claim in it (library versions, the test count) must match
`references/provenance.md`; that file is the record, the README is a
restatement. Releases follow
[SemVer](https://semver.org) and land in `CHANGELOG.md` under a dated heading;
git tags are the version of record — there is no version field in the SKILL.md
frontmatter, and the README's "current release" line must name the newest
CHANGELOG entry.

**`references/provenance.md` is the audit ledger and must stay truthful.** It
is the only place that distinguishes what ran in the earlier implementation
from what was designed here and has never run in production. Any change to a template updates it:
- fixing a new defect of the earlier implementation: a numbered entry under
  *Fixed in the templates*
- keeping a questionable choice of the earlier implementation: an entry under
  *Kept deliberately* with the reason it is safe
- inventing something the earlier implementation never ran: an entry under
  *Added (not in the earlier implementation)*

Its *Verification status* section makes concrete claims — templates compile
under `strict` + `--noUncheckedIndexedAccess` against named library versions,
and `assets/behavior.test.ts` is described as **12 tests across 4 describe
blocks**. Changing the suite means changing that count; do not let the claim
drift from the file.

**Do not weaken the four hard rules** in SKILL.md (auth on cloud ingestion,
offline-gated token fallback, per-ID delta reset, no locally-invented business
rules). They correspond to entries 1 to 4 in the provenance ledger, which
records why each one holds; none is a stylistic preference. The ledger has ten
entries under *Fixed in the templates*, and that count lives there only.

## Content invariants the templates depend on

These recur across references; changing one requires sweeping all of them.

- **Fixed domain vocabulary.** Templates always say
  `location / booking / inventory / lock / staff / pricing` and scope by
  `locationId`. The host renames at adoption time via the rename table — never
  rename inside the skill to match a particular product.
- **The seams table** (`references/architecture.md`, *Adaptation contract*) is
  the full boundary of what a host must supply. If a template starts requiring
  something new from the host, it goes in that table or it does not belong.
- **Meta-fields** (`_offlineCreated`, `_locallyModified`, `_synced`,
  `serverTimestamp`, `_deleted`) are declared in `architecture.md` and must
  appear in every RxDB schema in `replication.md`. An undeclared meta-field is
  itself a ledger entry.
- **Every cloud write to a replicated collection stamps `serverTimestamp` and
  `_deleted: false`.** Any new cloud-side template code must do this; omitting
  it makes the document permanently invisible to replication.
- **Env var names** in `references/operations.md` are the canonical list —
  `SYNC_SECRET`, `TERMINAL_SECRET`, `LOCK_ACCESS_TOKEN`, `KIOSK_API_KEY`, etc.
  Reference them by the same names in `auth.md`, `sync-flush.md`, and
  `local-api.md`.
- **Framework claims.** The local server is NestJS and the cloud examples are
  Next.js route handlers, but both are stated as substitutable; keep new
  templates' framework-specific surface thin enough that the claim holds.
