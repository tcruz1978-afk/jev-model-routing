---
name: usage-dashboard
description: Refresh or show the Claude usage dashboard — one page answering "is everything working?" (Jev deciding and picking right, skills loading, answers landing, the model router, OpenRouter credit, hosts reporting), plus Claude cost by agent and refused skills. Use when the user asks to see, refresh, update or check the dashboard, usage, spend, or whether skills, Jev or the model router are working.
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
   `select coalesce(json_agg(e order by ts), '[]') from (select id,kind,ts,session,host,project,agent,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,tool,skill,mcp_server,ok, case when kind in ('jev.decision','jev.miss','router.call','openrouter.key','tool') then data else '{}'::jsonb end as data from claude_usage.events where ts > now() - interval '180 days') e`
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
     back 0 when the previous build had them;
   - `cost-5x`: Claude cost for the last 24 h moved more than 5x.
   A trip means a broken pull, not a bad week: find the cause (usually an
   empty or truncated export) and rebuild. Only add `--force` when the owner
   confirms the change is real. Never publish the old numbers as today's.
6. Publish it with the Artifact tool, passing
   `url: https://claude.ai/artifact/CaF6aJ2boKvZEkEs8r5Lyd` (the owner's
   "Claude Usage Monitor"; read it first, as the tool requires) so the link
   stays the same. Someone else's session publishes a new one instead.
   Replace the page only; the design, CSS and markup stay as they are.

## What the page computes

All arithmetic is in `scripts/checks.mjs` (inlined into the page, tested by
`tests/lib.test.mjs`). Ranges run back from the build time, never from when
the page is opened; a page opened more than 26 h after its build shows an
"Out of date" banner, greys every section, and turns the verdict grey. The
headline is "Is everything working?": seven checks, each pass, needs
attention, not tracked (no data, never green) or too few to judge (a rate
over fewer than 10):

1. Jev is deciding: prompts with a logged `jev.decision` within 2 min, of
   prompts sent. Attention at more than 2 gaps, or the last decision more
   than 10 min behind the last prompt. Also counts `jev.suggested` with no
   matching decision (the log missed it).
2. Jev is picking right: `jev.miss` over `jev.decision`; target ≤ 10%.
3. Skills load: refused Skill tool calls over Skill tool calls; any refusal
   needs attention.
4. Answers land: landed turns over turns with an outcome; target ≥ 80%.
5. Model router: errors plus fallbacks over routed calls; target ≤ 10%.
6. OpenRouter credit: credit and key limit left from the newest
   `openrouter.key` (account-wide, not filtered), attention under 10%. Its
   spend line is the key's own usage for the range's UTC day, week or month,
   reconciled as: key usage = routed calls (logged cost) + Jev decisions
   (cost not logged: not tracked) + unattributed. The routed calls' logged
   cost is never shown as OpenRouter spend.
7. Reporting: hosts with events in the window; a host that reported in the
   previous window and not this one needs attention.

Claude cost is API-equivalent (list prices in `scripts/prices.json`, dated
in its `_source`), not a bill, and is never added to OpenRouter spend.

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
