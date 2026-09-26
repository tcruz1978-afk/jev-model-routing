---
name: usage-dashboard
description: Refresh or show the Claude usage dashboard — which models served which requests, what they cost, which skills, plugins, MCP connectors, subagents and Jev decisions ran, OpenRouter spend and key health. Use when the user asks to see, refresh, update or check the dashboard, usage, spend, what the models or agents are doing, or whether skills, Jev or the model router are working.
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
   `select coalesce(json_agg(e order by ts), '[]') from (select id,kind,ts,session,host,project,agent,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,tool,skill,mcp_server,ok, case when kind in ('jev.decision','router.call','openrouter.key','tool') then data else '{}'::jsonb end as data from claude_usage.events where ts > now() - interval '90 days') e`
   and save the array to a file. Without the MCP, use the local
   `events.jsonl` and say the page shows this machine only.
4. Build: `node <plugin>/scripts/dashboard.mjs --input <file> --out <scratchpad>/dashboard.html`
5. Publish it with the Artifact tool, passing
   `url: https://claude.ai/artifact/CaF6aJ2boKvZEkEs8r5Lyd` (the owner's
   "Claude Usage Monitor"; read it first, as the tool requires) so the link
   stays the same. Someone else's session publishes a new one instead.

## Reading it for the user

Lead with the "Is everything working?" cards: red and amber ones first,
with what to do. A refused skill means Claude was blocked from loading it
(`skillOverrides` or disabled bundled skills). Jev falling back means its
OpenRouter key or network failed. Only one host reporting means the other
has not run a session with the plugin, or cannot reach Supabase.
