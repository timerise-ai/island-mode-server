# island-mode-server

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-open_format-059669)](https://agentskills.io)
[![skills.sh](https://img.shields.io/badge/skills.sh-npx_skills_add-059669)](https://www.skills.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-059669)](https://docs.claude.com/en/docs/claude-code/skills)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-compatible-059669)](https://developers.openai.com/codex/skills)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-compatible-059669)](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md)

An [Agent Skill](https://agentskills.io) that teaches an agent to build an **on-premise fallback server**: a
Node box at a physical site holding a live two-way replica of that site's slice of Firestore, which takes over
serving LAN terminals when the internet drops and flushes offline work back on reconnect. The local server is
Node/NestJS + RxDB; the cloud is Firestore with Next.js route handlers as the reference API, both stated as
substitutable.

While the internet is up the box is invisible: it replicates in the background and heartbeats so the cloud
knows it is alive. When the cloud stops answering, kiosk and staff PWAs on the LAN switch their API base URL
to it and the site keeps taking bookings, moving stock and toggling hardware from the replica.

The insight that shapes the whole skill: **sync is two systems, not one.** Document-level RxDB replication
keeps state current but cannot run the cloud's business logic; an HTTP flush of business events on reconnect
runs that logic, such as atomic stock increments and audit ingestion, but keeps nothing current. Neither path
alone is sufficient, and both are keyed on client-generated IDs so their overlap converges instead of
double-counting.

The skill was written by the engineers who built and ran such a server at a live site. The templates are
**hardened, not faithful**: ten defects the audit found in that earlier implementation are fixed in the code
shown, and every deviation, including what was designed but never run in production, is recorded in
[`references/provenance.md`](references/provenance.md).

## Install

One command, via the [skills.sh](https://www.skills.sh) CLI, which installs the skill into every
skills-compatible agent it detects, including Claude Code, Codex CLI and Gemini CLI:

```bash
npx skills add timerise-ai/island-mode-server
```

Name the agents instead with `-a`, for example `npx skills add timerise-ai/island-mode-server -a claude-code -a codex`.

Or clone it yourself. Nothing here is Claude-specific: the skill is a plain [Agent
Skills](https://agentskills.io) folder, `SKILL.md` plus markdown references with no file that calls a model,
so cloning it into an agent's skills directory is all an install is. For Claude Code:

```bash
git clone https://github.com/timerise-ai/island-mode-server.git ~/.claude/skills/island-mode-server
```

To scope it to a single project instead, clone it into that project's `.claude/skills/` directory. For another
agent, clone into that agent's skills directory, or symlink the Claude Code copy so one `git pull` updates
every agent:

```bash
mkdir -p ~/.agents/skills
ln -s ~/.claude/skills/island-mode-server ~/.agents/skills/island-mode-server
```

Update the skill with `git pull` in its directory. The current release is **0.1.3**. See
[`CHANGELOG.md`](CHANGELOG.md). The [skills index](https://github.com/timerise-ai/skills) lists the other
Timerise Skills and how to install them all at once.

## Activation

The skill activates automatically when a task matches its description: a physical site that must keep
operating through an internet outage, a PWA terminal that must switch between a cloud and a local API, a
reconnect flush that double-counts stock; also on the vocabulary: "island mode", "offline fallback server",
"LAN failover", "on-prem replica", `replicateFirestore`, `serverTimestamp` checkpoints, `_offlineCreated`,
heartbeat crons, HMAC device auth, *"the site keeps working when the internet is down"*. Invoke it explicitly
with `/island-mode-server` in Claude Code, `$island-mode-server` in Codex CLI, or from `/skills` in Gemini
CLI.

Each host matches a task against the description its own way, so invoke the skill explicitly on a first run
rather than assuming it fired. Only `SKILL.md` is read up front; the `references/` files load on demand, so
the skill stays cheap in context until a topic is actually needed.

## What's inside

| File | Contents |
|---|---|
| `SKILL.md` | Entry point: the architecture diagram, six critical facts, four hard rules, the quick start, and the reference directory |
| `references/architecture.md` | Modes, the two sync paths, replication tiers, tenant scope, the seams table |
| `references/replication.md` | RxDB setup, schemas, custom-token auth, security rules, the checkpoint trap |
| `references/sync-flush.md` | Reconnect flush, per-ID stock deltas, idempotent cloud ingestion, retries |
| `references/network-failover.md` | Heartbeat/status chain, outage detection, terminal API switching, rescan |
| `references/auth.md` | Local API guards: staff tokens, kiosk key, hardware HMAC, offline gating |
| `references/local-api.md` | The offline endpoints: availability, booking mutex, check-in, pricing |
| `references/operations.md` | On-site deployment: systemd, nginx TLS, mDNS, env vars, runbook |
| `references/provenance.md` | What was fixed vs. the earlier implementation, what was kept, what is unverified |
| `assets/behavior.test.ts` | The vitest suite carried into the target project as regression cover |

The skill is server-side and infrastructure-side only; the local server has no UI at all, and its operator
surface is `/health`, `/status` and journald. It assumes Firestore is the cloud source of truth and stays that
way, and that the topology is hub-and-spoke with last-write-wins conflicts. The seams table in
`references/architecture.md` is the full boundary with the host; nothing else crosses it.

## The four non-negotiables

These travel with the module and are never optional (they are the hard rules in `SKILL.md`, and each one is a
live defect found in the earlier system, and they map to fixes 1 to 4 in `references/provenance.md`):

1. **Never expose the cloud sync-ingestion endpoints without auth.** They apply stock increments and inject
   orders. The earlier implementation's `/api/sync/*` routes took unauthenticated POSTs on the public
   internet; a shared-secret header is the minimum.
2. **Never verify offline staff tokens leniently while online.** Decoding without verification is an
   accepted LAN-only trade-off, but ungated it is a bypass of signature verification for anyone, anywhere.
3. **Never reset local stock deltas for transactions not acknowledged as synced.** A wholesale reset after a
   flush whose errors were swallowed reverts `effectiveStock` to a stale snapshot, which is an oversell
   window.
4. **Never let the local server invent business rules the cloud owns** (opening hours, pricing). Replicate
   the config and compute from it, or island-mode behaviour diverges from the website.

Everything else is the host app's: vocabulary, IdP, HTTP framework, UI, i18n.

## Adaptation

The host supplies the other half of each seam:

| Seam | The skill ships | The host supplies |
|---|---|---|
| Domain entities | `location/booking/inventory/lock/staff/pricing` + a rename table | Its vocabulary |
| Tenant scope | `locationId`, env-derived, one per server | Its field name; array variant for directories |
| Cloud API | Next.js route handlers as reference | Any framework, via plain JSON-over-POST contracts |
| Staff identity | Firebase Auth ID tokens + role hierarchy | Its IdP; keep the online-verify/offline-lookup split |
| Hardware auth | HMAC-SHA256 shared secret | Its device fleet's capabilities |
| Local runtime | NestJS (DI + guards) | Any Node HTTP framework; services are plain classes |
| UI status surface | State shape only (`mode`, `apiBaseUrl`) | Its own banner/indicator components |
| Strings | English literals, keys suggested | Its i18n system |

## Not this

| Not this | Use instead |
|---|---|
| Cached reads, or a PWA that only needs offline persistence | The Firebase SDK's built-in offline mode, no server needed |
| Supabase, Postgres or another cloud database | The tier concept travels; every template here is Firestore-specific |
| Multi-master sync between peer sites | This design is strictly hub-and-spoke, cloud as source of truth |
| The kiosk terminal itself | The sibling [`booking-kiosk`](https://github.com/timerise-ai/booking-kiosk) skill, which defines the client-side failover contract against this server |

## Verification

Every TypeScript template compiles under `strict` and `--noUncheckedIndexedAccess`, Node-side against rxdb
16.11 / firebase 12 / firebase-admin 13 / @nestjs 11, Next-side against Next 16 / React 19. The trust-critical
logic passes [`assets/behavior.test.ts`](assets/behavior.test.ts) (12 tests: HMAC accept/tamper/replay,
offline-token expiry, delta fold-out on a real RxDB memory instance including partial and duplicate acks,
failover threshold and offline rescan). Carry that file into the target project as regression cover. It cannot
run in this repository: it imports templates that exist only once they have been copied into a host project.

Not verified by execution, and marked as such: the Firestore rules, the replication plugin against a live
Firestore, and the nginx/systemd/avahi configs, which were reviewed against the earlier deployment only.

## Contributing

Issues and pull requests are welcome here. Pure markdown and TypeScript templates, with no build, lint or dev
server in this repository. Claims in this skill are meant to be verifiable: if you change a factual claim, say
how you verified it, whether against the library, the docs, or a reproduction.

Adding, removing or renaming a file in `references/` means updating the quick start and the reference
directory table in `SKILL.md`, the file table above, and any relative cross-links. The odd-looking parts of
the templates encode documented defects, and `references/provenance.md` is the ledger that must stay truthful:
read it before simplifying anything, and add an entry for anything you change. Commits follow Conventional
Commits and releases follow [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) in the
index; `CLAUDE.md` carries the full editing conventions.
## Part of the Timerise Skills

This is one of the [Timerise Skills](https://github.com/timerise-ai/skills): modules written by our own senior
engineers from the modules they have shipped, not synthetic, each published as its own repository and indexed
there. They share one layout, so an agent that has read one knows how to read the next: a `SKILL.md` entry
point, `references/` loaded on demand, and a seam contract carrying the module's non-negotiables. Most of them
target **Next.js App Router** apps; this one is the on-premise counterpart, a Node service and its deployment,
for when those apps must survive losing the internet.

## Author

Built and maintained by [Timerise](https://timerise.ai).

## License

MIT. See [LICENSE](LICENSE).