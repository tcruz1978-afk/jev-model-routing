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

## What the page computes

All arithmetic is in `scripts/checks.mjs`, and every visible word in
`scripts/present.mjs`; both are inlined into the page and tested by
`tests/lib.test.mjs`.

The layout is the owner's approved one, for a busy owner rather than an
engineer: the question "Is everything working?" with a plain verdict ("2 need
attention", "All clear", "Out of date — built 8 days ago"); a numbered "What
to do" list (at most 5: yours first, then Claude's, then ones that clear on
their own, each with when it's done; `actionsFor` in checks.mjs); then one
line per check (icon, plain name, one figure and its target, › to open a
short panel); then "This week Claude $X (at pay-as-you-go prices) ·
OpenRouter $Y". Everything else sits in one closed "Details" section. No code,
paths or internal terms appear in the top block (a test scans for them);
click-by-click steps live only behind "Show me how". Ranges run back from the build time, never from when
the page is opened; a page opened more than 26 h after its build shows an
"Out of date" banner, greys every section, and turns the verdict grey.

Coverage: the window line prints "Data since <first event>". A range longer
than the data says how much it holds ("only 72 min of data") and its button
is dotted-underlined. A previous window that starts before the first event
is "not tracked (collection began …)", never "none", in the checks and in
every table.

The headline is "Is everything working?": seven checks, each Pass, Needs
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
