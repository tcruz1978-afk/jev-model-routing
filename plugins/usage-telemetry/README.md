# usage-telemetry

Shows what the models are doing behind your Claude Code sessions: which model
served each request and what it cost, every tool, skill, MCP connector and
subagent call, Jev's skill decisions, and the model router's OpenRouter calls.
One page answers "is everything working?".

## What it records

After every turn (a `Stop` hook) and at session end, `scripts/collect.mjs`
reads what the session's files gained since the last run:

| Source | Becomes |
|---|---|
| `~/.claude/projects/**/<session>.jsonl` | `api` (model, tokens, API-list-price cost), `tool` (name, skill, MCP server, failed?, time), `prompt`, `jev.suggested` |
| `…/<session>/subagents/agent-*.jsonl` (+ `.meta.json`) | the same, tagged `subagent:<type>` |
| `~/.claude/jev-log/<session>.jsonl` (jev-skill-suggestion) | `jev.decision`, `jev.skill_load` |
| `~/.claude/jev-log/router.jsonl` (model-router) | `router.call` (model asked / answered, tokens, OpenRouter cost) |
| OpenRouter `/key` and `/credits`, hourly | `openrouter.key` (credit left, key limit, free requests) |

Prompt text, tool inputs and outputs are never recorded. Costs for Claude
models are what the tokens cost at API list prices (`scripts/prices.json`),
which on a subscription is a measure of work, not a bill.

Events go to `~/.claude/usage-telemetry/events.jsonl`, and when
`USAGE_INGEST_URL` is set, to the `claude-usage` Supabase edge function
(`supabase/functions/claude-usage`), which upserts them into
`claude_usage.events`. Every event has a stable id, so a resend only
overwrites. Events that could not be shipped wait in `outbox.jsonl` and go
with the next run.

## Setup

Nothing per chat. The repos' `.claude/settings.json` enable this plugin from
the `jev-model-routing` marketplace and set `USAGE_INGEST_URL`. Two one-time
things per environment:

- **Cloud environment network:** allow `toohsvdpofzfwrgwlaxz.supabase.co`
  (Custom network access), or cloud events stay in the container and are lost
  when it is reclaimed. Until then, asking Claude to "refresh the dashboard"
  ships them through the Supabase connector instead.
- **OpenRouter key** (already needed by Jev): lets the collector read the
  key's balance.

## The dashboard

One question leads the page: **is everything working?** Seven checks (Jev
deciding, Jev picking right, skills loading, answers landing, the model
router, OpenRouter credit, hosts reporting), each with its number, its
population, the previous equal window and the owner's target (approved
2026-09-26). A check with no data reads "not tracked", never green, and a
previous window from before collection began reads "not tracked" too. Under them: the landed % and median
cost per turn trends, where the Claude work went, refused skills, and tools
failing above target, all inside one closed "Details" section. Above the
checks, a plain "What to do" list says what to do, who does it and when it's
done. The arithmetic lives in `scripts/checks.mjs` and the page's words in
`scripts/present.mjs`.

Ask Claude to "refresh my usage dashboard" (the `usage-dashboard` skill), or
build it by hand:

```bash
node scripts/collect.mjs            # collect and ship now
node scripts/dashboard.mjs          # → ~/.claude/usage-telemetry/dashboard.html (this machine, --source local)
node scripts/dashboard.mjs --input export.json --source supabase --out dashboard.html   # every host
```

Each build snapshots the page it replaces to
`~/.claude/usage-telemetry/snapshots/` (30 kept), logs one line to
`runs.log`, and refuses to write the page (exit 2, naming the guard) when the
source is unusable, a key the page reads is missing, a headline count fell to
zero (or model calls came back with $0 Claude cost), or 24 h Claude cost
moved more than 5x. `--force` overrides. `node scripts/dashboard.mjs --help`
lists every option.

## Tests

```bash
node --test tests/lib.test.mjs
```
