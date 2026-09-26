# usage-telemetry

Shows what the models are doing behind your Claude Code sessions: which model
served each request and what it cost, every tool, skill, MCP connector and
subagent call, Jev's skill decisions, and the model router's OpenRouter calls.
One page leads with what the models did and what it cost, and ends with a health strip.

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

The page leads with **what the models did and what it cost**, for the chosen
period (24 hours, 7, 30 or 90 days; all machines, cloud or your PC), top to
bottom:

1. **Headline numbers**, each with its change on the previous period once
   that period is collected: Claude work at pay-as-you-go prices, OpenRouter
   spend (the key's own running total; before the first balance check, the
   router's logged calls plus the key's growth after it), your requests,
   model calls, tool calls with failures, and OpenRouter credit left with how
   long it lasts at the recent spend rate.
2. **Cost by model**, per day (per hour for 24 hours), stacked bars with a
   legend and a table version.
3. **Where the work went**: by skill, by connector or plugin, and by
   subagent, each with uses, cost, failures and typical time. A Claude model
   call is charged to the skill active in its turn (typed `/command`, Jev's
   pick when Jev put its text in the chat, or the last skill Claude loaded);
   calls with none show as "no skill", never dropped. A connector gets its
   share of the Claude reply that asked for it.
4. **Model × work grid**: which model served which skill (Claude) or task
   kind (model router), calls and cost per cell.
5. **Jev**: paid against free by who decided (`jev` and `backup <model>` are
   paid; `backup openrouter/free`, `backup …:free` and `built-in classifier`
   are free), with decisions, share, flagged misroutes (each `jev.miss`
   matched to the decision in the same chat with the same pick, nearest in
   time), landed rate and typical time; under 10 decisions reads "too few to
   judge". Also picks per skill, how sure Jev was, and the optional benchmark
   `~/.claude/usage-telemetry/jev-tiers.json`
   (`{"ranAt", "cases", "tiers": {"jev"|"paid"|"free": {"right", "of"}}}`,
   `--tiers FILE` to point elsewhere), shown as "not run yet" when absent.
6. **Model router**: calls, failures or backups and cost per task kind;
   model asked for against the model that answered.
7. **Top 10 chats by cost**, and 8. **recent activity** (newest 100, filter
   by type): time, machine, type, name, model, tokens, cost, time taken,
   result. No prompt text exists in the data.
9. **Health strip** at the bottom: the seven checks (Jev deciding, Jev
   picking right, skills loading, answers landing, the model router,
   OpenRouter credit, machines reporting) as pills against the owner's
   targets (approved 2026-09-26), each opening to its detail, with "What to
   do" beside any check someone has to act on.

The arithmetic lives in `scripts/checks.mjs` (inlined into the page and
imported by the tests) and the health strip's words in `scripts/present.mjs`.

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
node --test tests/*.test.mjs
```
