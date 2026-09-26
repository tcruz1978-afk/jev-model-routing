// claude-usage — receives usage events from the usage-telemetry plugin's
// collector and upserts them into claude_usage.events (by id, so a resend
// only overwrites). Write-only: it never returns stored rows. The dashboard
// reads the table through the Supabase MCP (service role), not through here.
//
// Deployed with verify_jwt off: the collector runs in Stop hooks with no
// Supabase session. What guards it instead: the URL lives only in private
// repos' settings, the body is validated field by field, and a call is
// capped at 1000 events of bounded size.
import postgres from 'npm:postgres@3.4.5'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 3, prepare: false })

const KINDS = new Set(['api', 'tool', 'prompt', 'jev.suggested', 'jev.decision', 'jev.skill_load', 'router.call', 'openrouter.key', 'jev.miss'])
const TEXT = ['session', 'host', 'project', 'agent', 'model', 'tool', 'skill', 'mcp_server'] as const
const INTS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const

type Row = Record<string, unknown>

function clean(event: Row): Row | null {
  if (typeof event.id !== 'string' || !event.id || event.id.length > 300) return null
  if (typeof event.kind !== 'string' || !KINDS.has(event.kind)) return null
  const ts = typeof event.ts === 'string' && !Number.isNaN(Date.parse(event.ts)) ? event.ts : null
  const row: Row = { id: event.id, kind: event.kind, ts }
  for (const key of TEXT) row[key] = typeof event[key] === 'string' ? (event[key] as string).slice(0, 300) : null
  for (const key of INTS) row[key] = Number.isFinite(event[key]) && (event[key] as number) >= 0 ? Math.round(event[key] as number) : null
  row.cost_usd = Number.isFinite(event.cost_usd) ? event.cost_usd : null
  row.ok = typeof event.ok === 'boolean' ? event.ok : null
  const data: Row = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? { ...(event.data as Row) } : {}
  // Prompt wording stays on the user's machine: a miss arrives without it,
  // and any field that could carry it is dropped here as well.
  for (const key of ['prompt', 'previous', 'text']) delete data[key]
  const text = JSON.stringify(data)
  row.data = text.length <= 8000 ? data : { truncated: true }
  return row
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST {"events": [...]}', { status: 405 })
  let body: { events?: unknown }
  try {
    body = await req.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  if (!Array.isArray(body.events) || body.events.length > 1000) return new Response('events: an array of at most 1000', { status: 400 })
  const rows = body.events.map((event) => (event && typeof event === 'object' ? clean(event as Row) : null)).filter((row): row is Row => row !== null)
  // Last copy of an id wins, as the collector means it.
  const byId = new Map(rows.map((row) => [row.id as string, row]))
  const unique = [...byId.values()]
  if (unique.length > 0) {
    const columns = ['id', 'kind', 'ts', ...TEXT, ...INTS, 'cost_usd', 'ok', 'data']
    await sql`
      insert into claude_usage.events ${sql(unique as never[], columns as never)}
      on conflict (id) do update set
        kind = excluded.kind, ts = excluded.ts, session = excluded.session, host = excluded.host,
        project = excluded.project, agent = excluded.agent, model = excluded.model,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
        cost_usd = excluded.cost_usd, tool = excluded.tool, skill = excluded.skill,
        mcp_server = excluded.mcp_server, ok = excluded.ok, data = excluded.data, received_at = now()`
  }
  return Response.json({ stored: unique.length, rejected: body.events.length - rows.length })
})
