---
name: usage-dashboard
description: Refresh or show the Claude usage dashboard ("Claude Usage Monitor") — a tabbed master dashboard like OpenRouter's Activity page. Overview (spend, requests, model calls, tokens, cache hit rate, cost per million tokens, tool failures, OpenRouter credit, each with a sparkline and change; spend by model; top models, skills, connectors, subagents, chats), Explore (any metric split by up to two dimensions over time or ranked, saved views), Logs (every event, filterable, CSV), Jev paid against free, the model router, and Health (seven checks). Use when the user asks to see, refresh, update or check the dashboard, usage, spend, what the models are doing, or whether skills, Jev or the model router are working.
---

# Usage dashboard

The dashboard is one page built from usage events. Events come from the
usage-telemetry plugin's Stop hook (`scripts/collect.mjs`), kept in
`~/.claude/usage-telemetry/events.jsonl` and shipped to Supabase
(`claude_usage.events` in project `toohsvdpofzfwrgwlaxz`) when
`USAGE_INGEST_URL` is set and the host is reachable.

Scripts are in this skill's plugin: `../../scripts/` from this file.

## Refresh it

1. Collect what this session has done so far:
   `node <plugin>/scripts/collect.mjs --flush`
   It prints how many events it kept and whether shipping worked.
2. If it says `ship failed` or `waiting` (a cloud environment whose network
   does not allow `*.supabase.co`) and the Supabase MCP is connected, ship
   `~/.claude/usage-telemetry/outbox.jsonl` yourself: insert it in batches of
   about 150 with `execute_sql`, using
   `insert into claude_usage.events (id,kind,ts,session,host,project,agent,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,tool,skill,mcp_server,ok,data) select ...,coalesce(data,'{}') from jsonb_populate_recordset(null::claude_usage.events, '<json array>'::jsonb) on conflict (id) do update set output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, ok=excluded.ok, data=excluded.data`,
   then delete the outbox file. Escape `'` in the JSON as `''`.
3. Get every host's events, not just this machine's: with the Supabase MCP,
   `select coalesce(json_agg(e order by ts), '[]') from (select id,kind,ts,session,host,project,agent,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,tool,skill,mcp_server,ok, case when kind in ('jev.decision','jev.miss','router.call','openrouter.key','tool','jq.decision','jq.outcome','jev.arm','delegate.run') then data when kind = 'prompt' then jsonb_build_object('category', data->'category', 'slash', data->'slash', 'correction', data->'correction') else '{}'::jsonb end as data from claude_usage.events where ts > now() - interval '180 days') e`
   (180 days: the page's longest range is 90, compared with the 90 before)
   and save the array to a file. For a large result, run the query in a
   subagent that writes the file and returns only the row count. Without the
   MCP, use the local `events.jsonl` with `--source local`; the page header
   then says "local file (this machine only)".
4. Read the published page first (Artifact `read` on the URL below) and
   save its HTML as `<scratchpad>/dashboard.html`: the build snapshots the
   DATA of the page it replaces, and that snapshot is what the guards and
   tomorrow's comparisons use. If the page cannot be read, stop and say so;
   do not rebuild from nothing.
5. Build:
   `node <plugin>/scripts/dashboard.mjs --input <file> --source supabase|local --out <scratchpad>/dashboard.html`
   Every run snapshots the previous DATA to
   `~/.claude/usage-telemetry/snapshots/YYYY-MM-DDTHH.json` (30 kept) and
   appends one line to `~/.claude/usage-telemetry/runs.log`. It exits 2
   without writing the page when a guard trips, naming each one:
   - `source-unusable`: the input is empty, unparseable, or a Supabase
     export without id/kind;
   - `previous-page-unreadable`: the page being replaced has no readable DATA;
   - `missing-key`: DATA lacks a key the page reads;
   - `headline-zero`: prompts, decisions, model calls or turns (7 days) came
     back 0 when the previous build had them, or there were model calls but
     Claude cost came back $0 or missing (a broken price table);
   - `cost-5x`: Claude cost for the last 24 h moved more than 5x.
   A trip means a broken pull, not a bad week: find the cause (usually an
   empty or truncated export) and rebuild. Only add `--force` when the owner
   confirms the change is real. Never publish the old numbers as today's.
6. Publish it with the Artifact tool, passing
   `url: https://claude.ai/artifact/CaF6aJ2boKvZEkEs8r5Lyd` (the owner's
   "Claude Usage Monitor"; read it first, as the tool requires) so the link
   stays the same. Someone else's session publishes a new one instead.
   Replace the page only; the design, CSS and markup stay as they are.
   Pass `capabilities: {"mcp": {"servers": [{"server": "Supabase", "tools": ["execute_sql"]}]}, "downloads": true}`
   so the page can read live data (see below) and save the Logs CSV (the
   viewer blocks a page's own downloads; the page asks the viewer to save it
   instead). A redeploy that omits `capabilities` keeps what the page
   already has; one that passes it must list both.

## Live data

Opened inside Claude, the page reads `claude_usage.events` itself through
the viewer's Supabase connector (`scripts/live.mjs`, inlined like
`checks.mjs`): the last 180 days, newest first in pages of 1000, only the
columns in `LIVE_COLUMNS` and `data` only for `jev.decision`, `jev.miss`,
`router.call`, `openrouter.key` and `tool`. It turns the rows into the same
compact rows the build makes and runs the same arithmetic on them. A line
under the header says "Live: read from Supabase …" with the newest event's
time, or why it couldn't (Supabase not connected, needs reconnecting,
turned off for this page, the query refused, not opened inside Claude) and
that it is showing the saved copy "as of" the build time.

The build still matters: its DATA is that saved copy (inlined as
`SNAPSHOT`), the fallback every viewer without the connector sees, and what
the guards and snapshots compare. The first viewer to open it is asked once
to allow Supabase for the page.

## Rankings and Compare models

The page opens on **Rankings**, laid out like OpenRouter's model rankings
(the arithmetic is in `scripts/rankings.mjs`, inlined and tested like
`checks.mjs`):

1. **What you paid, and what it bought**: the plan in `scripts/plan.json`
   (name and monthly price) spread over the hours with data, plus what
   OpenRouter billed on the key; set beside Claude's work at pay-as-you-go
   prices, paid per request, and OpenRouter credit left.
2. **Top models**: spend, tokens or model calls by model over time, with a
   leaderboard, filtered by kind of request (the collector's category label
   per prompt: fix, build, review, ship, setup, design, data, writing,
   research, command, reply, other; never the prompt's words).
3. **Top models by task**: each kind of request's models ranked by landed rate.
4. **Performance ranking**: models best first by landed rate, speed, typical
   cost per request, failure rate, cache hits or spend; under 10 is too few
   to judge and goes unranked.
5. **Contribution**: each part's KPIs and the three together. Jev:
   coverage (target 95%), accuracy (target 90%), cost as OpenRouter reported
   it per decision (`costUsd` in the decision log, from this release), and
   requests with a decision against without (not a fair test until an on/off
   comparison). Router: offload share, savings against the same tokens at
   Claude's list price, answered without an error or backup, cost. JQ: kept,
   overruled, calibration. Together: measured cost, measured savings, net,
   share of requests touched. OpenRouter spend that neither explains is shown
   apart and never charged to either.
   **On/off comparison**: jev-skill-suggestion (from v0.5.2) puts every
   session in one group, the same one each time (`armOf`: 60% Jev and the
   router, 20% Jev without the router, 20% neither; set `compareOff` and
   `compareNoRouter` in the mod's options, 0 and 0 to stop it) and logs it as
   `jev.arm`. Jev = "Jev, no router" against "Neither"; router = "Jev and the
   router" against "Jev, no router"; all together = "Jev and the router"
   against "Neither": landed, typical cost per request (Claude, routed calls
   and Jev's decision) and typical time, judged from 10 requests with an
   outcome a side. Once it can judge, it replaces the unfair "with against
   without" figures and gives the net contribution.

**Compare models** puts up to 5 models side by side (table, small charts,
spend over time). Change `plan.json` when the plan changes.

## What the page computes

All arithmetic is in `scripts/checks.mjs` and `scripts/explore.mjs`, and
the health words in `scripts/present.mjs`; all three are inlined into the
page and tested by `tests/*.test.mjs`.

The page has six tabs (the URL hash keeps the tab and every choice); the
period (24h, 7d, 30d, 90d, custom from–to) and machines sit in the header
with a health badge:

1. Overview: metric cards with sparklines and the change on the previous
   period (Claude work, OpenRouter spend, requests, model calls, tokens with
   the fresh / cache / out split, cache hit rate, blended cost per million
   tokens, tool failures, OpenRouter credit and how long it lasts), spend by
   model over time, and top models, skills, connectors, subagents, chats.
2. Explore: one metric split by up to two dimensions (`DIMS` in
   `scripts/explore.mjs`), by hour, day or week or ranked, as bars, lines or
   dots; filters, saved views (localStorage) and "Copy link".
3. Logs: every event newest first, filter chips, search, row details, CSV.
4. Jev: decisions over time by tier, paid against free, picks, confidence,
   and the benchmark from `~/.claude/usage-telemetry/jev-tiers.json`
   (`--tiers FILE`) when it exists.
5. Router: by task kind, asked-for against answered, spend and calls over time.
6. Health: the seven checks full size with "What to do", and failing tools.

Any bar, slice, point, legend entry or table row opens Logs filtered to the
events behind it.

The page carries every row inlined (about 170 bytes each): past roughly
90,000 rows it passes the Artifact tool's 16 MB page limit, so build with a
shorter `--days` then.

Coverage: the window line prints "Data since <first event>". A range longer
than the data says how much it holds ("only 72 min of data") and its button
is dotted-underlined. A previous window that starts before the first event
is "not tracked (collection began …)", never "none", in the checks and in
every table.

The Health tab ("Is anything broken?") holds seven checks, each Pass, Needs
attention, Not tracked (no data, never green), Too few to judge (a rate over
fewer than 10) or Partial (its data stopped early). The owner's targets,
approved 2026-09-26, are the only source of colour:

1. Jev is deciding: ≥ 95% of your prompts get a logged `jev.decision`
   within 2 min. The last decision's lag behind the last prompt and
   `jev.suggested` with no matching decision are stated as facts.
2. Jev is picking right: `jev.miss` over every logged `jev.decision`
   (including ones not tied to a prompt) ≤ 10%. It states the span the
   decisions cover and goes Partial when prompts came after the last one.
3. Skills load: no refused Skill tool calls.
4. Answers land: ≥ 80% of turns with an outcome.
5. Model router: ≤ 10% of routed calls error or fall back.
6. OpenRouter credit: attention under 10% of credit or key limit left
   (account-wide; left out of the verdict under a host filter). Its spend
   line is the key's own usage for the range's UTC day, week or month, with
   `key usage = routed calls (logged) + unattributed`; Jev's decision calls
   are stated separately as not logged. A key period that began before
   collection is "not reconcilable". The routed calls' logged cost is never
   shown as OpenRouter spend.
7. Reporting: every host that reported in the previous window reports in
   this one; not tracked when the previous window has no hosts.

Plus the tools table: no tool fails more than 10% of its calls (coloured
from 10 calls).

Claude cost is API-equivalent (list prices in `scripts/prices.json`, dated
in its `_source`), not a bill, and is never added to OpenRouter spend. Turns
whose model calls had no price have no cost and stay out of the median.

## Reporting back

The owner reads the page, not the message. Report only what the page cannot
tell them, from the build's output and the new `runs.log` line:

- What moved since the last build (the `moved:` lines; rates in percentage
  points). If nothing moved and no guard tripped, say so in one line.
- Anything not tracked, and why (`untracked=` in runs.log).
- Any guard that tripped, and what happened instead.
- Anything that looks like a data problem rather than a change in use: a
  host gone quiet, the Jev decision log behind the prompts, a source that
  answered with less than usual.

Do not restate the numbers on the page.
