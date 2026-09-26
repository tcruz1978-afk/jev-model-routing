# usage-telemetry

Shows what the models are doing behind your Claude Code sessions: which model
served each request and what it cost, every tool, skill, MCP connector and
subagent call, Jev's skill decisions, and the model router's OpenRouter calls.
One page, tabbed like OpenRouter's Activity page: overview, explore, logs, Jev,
the router and health.

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
| JQ log (`JQ_LOG_FILE`, the shared project folder, or `~/.jq/decisions.jsonl`) | `jq.decision` (tool, answer, stated confidence), `jq.outcome` (kept, overruled, asked); never the question |

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

Works like OpenRouter's Activity page. Opened inside Claude, the page reads
the events live from Supabase through your Supabase connector
(`scripts/live.mjs`) each time it opens, and falls back to the copy saved at
the last build, with its "as of" time, when it can't. Filtering and grouping
run in the browser. Tabs across the top, and in the header on every tab: the
period (24h, 7d, 30d, 90d, or custom from–to UTC days), the machines (all,
cloud, your PC) and a health badge ("2 need attention") that opens Health.

1. **Overview**: metric cards, each with a sparkline and its change on the
   previous period ("not collected yet" when that period predates
   collection): Claude work at pay-as-you-go prices, OpenRouter spend (the
   key's running total), requests, model calls, tokens (fresh in / from
   cache / out), cache hit rate (cache-read tokens over all input tokens),
   blended cost per million tokens, tool failures, and OpenRouter credit
   left with how long it lasts. Click a card to explore it. Then spend over
   time stacked by model, and top models, skills, connectors and plugins,
   subagents and chats.
2. **Explore**: pick a metric (spend, Claude or OpenRouter alone, requests,
   model calls, tokens in / out / from cache, cache hit rate, cost per
   million, tool calls, failures, failure rate, time p50 / p90, Jev
   decisions, Jev misroute rate, events), split it by up to two of model,
   provider, skill, connector, tool, subagent type, event type, machine,
   chat, Jev tier, router task and outcome, as stacked bars, lines or dots
   by hour, day or week, or with no time axis as a ranked list. The ranked
   table sits under the chart. Filters, saved views (kept in this browser)
   and "Copy link".
3. **Logs**: every event, newest first, 100 a page: time, machine, chat,
   type, name, model, tokens, cost, time taken, result. Filter chips for any
   dimension, search over names, click a row for every field, download the
   filtered rows as CSV. No prompt text exists in the data.
4. **Jev**: decisions over time by who made them, paid against free (`jev`
   and `backup <model>` are paid; `backup openrouter/free`, `backup …:free`
   and `built-in classifier` are free) with flagged misroutes, landed rate and
   typical time, picks per skill, how sure Jev was, and the optional
   benchmark `~/.claude/usage-telemetry/jev-tiers.json`
   (`{"ranAt", "cases", "tiers": {"jev"|"paid"|"free": {"right", "of"}}}`,
   `--tiers FILE`), shown as "not run yet" when absent.
5. **Router**: calls, failures or backups and cost per task kind; model
   asked for against model that answered; spend and calls over time by task.
6. **Health**: the seven checks full size (Jev deciding, Jev picking right,
   skills loading, answers landing, the model router, OpenRouter credit,
   machines reporting) against the owner's targets (approved 2026-09-26),
   with "What to do", plus tools failing more than 1 in 10 times.

**Click a chart, land in the logs**: a bar, a slice, a point, a legend
entry or a table row opens Logs filtered to exactly the events behind it
(its group, its time bucket, and the event types the metric counts).

A Claude model call is charged to the skill active in its turn (typed
`/command`, Jev's pick, or the last skill Claude loaded); tool calls,
routed calls and prompts carry the active skill too, so anything can be
split by skill. Calls with none show as "no skill", never dropped.

The arithmetic lives in `scripts/checks.mjs` (checks and panels) and
`scripts/explore.mjs` (the grouping engine: an index of every row's key per
dimension, so filters and group-bys stay fast at 100,000 rows; metrics;
filters; the URL hash; CSV), the words in `scripts/present.mjs`. All three
are inlined into the page and imported by the tests.

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
