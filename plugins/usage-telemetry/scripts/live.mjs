/**
 * Live data: the published page reads claude_usage.events when it is opened,
 * through the viewer's own Supabase connector (the artifact `mcp`
 * capability), and turns the rows into the same compact shape the build
 * inlines as DATA. When the read fails, the page keeps the inlined snapshot
 * and says why, with the snapshot's "as of" time.
 *
 * The same source runs in two places: `node --test` imports it, and
 * dashboard.mjs inlines it into the page after checks.mjs and turns.mjs (it
 * strips `import` and `export`). Keep its imports to those two files.
 *
 * What it reads, and nothing else: the columns in LIVE_COLUMNS, `data` only
 * for the kinds in DATA_KINDS, the last LIVE.days days. Prompt text is never
 * recorded, and this never asks for it.
 */
import { DAY, attribute, confidenceOf } from './checks.mjs'
import { turnsFrom } from './turns.mjs'

export const LIVE = {
  server: 'Supabase',
  tool: 'execute_sql',
  project: 'toohsvdpofzfwrgwlaxz',
  days: 180,
  pageSize: 1000,
  // 200k events. Pages are read newest first, so a cap drops the oldest days, never today.
  maxPages: 200,
}

export const LIVE_COLUMNS = ['id', 'kind', 'ts', 'session', 'host', 'project', 'agent', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'tool', 'skill', 'mcp_server', 'ok']
/** The only kinds whose `data` payload is read. */
export const DATA_KINDS = ['jev.decision', 'jev.miss', 'router.call', 'openrouter.key', 'tool']

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`

/**
 * One page of events, newest first. `after` is the last row of the previous
 * page ({ts, id} as Supabase returned them); its ts must look like a
 * timestamp, so nothing but a time and an escaped id reaches the SQL.
 */
export function liveQuery({ days = LIVE.days, after = null, limit = LIVE.pageSize } = {}) {
  const where = [`ts > now() - interval '${Math.max(1, Math.floor(Number(days)) || LIVE.days)} days'`]
  if (after) {
    if (!/^[0-9TZ:.+\- ]{10,40}$/.test(String(after.ts))) throw new Error(`unexpected timestamp from Supabase: ${String(after.ts).slice(0, 40)}`)
    where.push(`(ts, id) < (${sqlText(after.ts)}::timestamptz, ${sqlText(after.id)})`)
  }
  const kinds = DATA_KINDS.map(sqlText).join(',')
  return `select ${LIVE_COLUMNS.join(',')}, case when kind in (${kinds}) then data end as data from claude_usage.events where ${where.join(' and ')} order by ts desc, id desc limit ${Math.max(1, Math.floor(limit))}`
}

/**
 * The rows in an execute_sql result. The connector answers with text that
 * wraps a JSON array in <untrusted-data-…> tags, as `{result: "…"}`, as the
 * bare text, or (a newer connector) as the array itself. Throws when there is
 * no array to read.
 */
export function rowsFromResult(result) {
  let v = result && typeof result === 'object' && 'payload' in result ? result.payload : result
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.result === 'string') v = v.result
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') throw new Error('Supabase answered with something other than rows')
  const tagged = /<untrusted-data-([\w-]+)>\s*([\s\S]*?)\s*<\/untrusted-data-\1>/.exec(v)
  const body = tagged ? tagged[2] : v.trim()
  let rows
  try {
    rows = JSON.parse(body)
  } catch {
    throw new Error(`Supabase's answer did not parse as rows: ${body.slice(0, 120)}`)
  }
  if (!Array.isArray(rows)) throw new Error('Supabase answered with something other than rows')
  return rows
}

/** A Postgres timestamptz as text ("2026-09-26 14:01:29.706+00") → ISO, which every browser parses. */
export function isoTime(ts) {
  if (typeof ts !== 'string') return null
  const t = Date.parse(ts.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** One Supabase row → the collector's event shape (only the columns read, never prompt text). */
export function eventFromRow(row) {
  const event = {}
  for (const key of LIVE_COLUMNS) event[key] = row[key] ?? null
  event.ts = isoTime(row.ts)
  event.data = DATA_KINDS.includes(row.kind) && row.data && typeof row.data === 'object' ? row.data : {}
  return event
}

/**
 * The compact rows the page carries: short keys, sessions as indexes, the
 * `data` payload only where a view reads it. Turns (one prompt and all the
 * work until the next one, see turns.mjs) are computed here, once.
 */
export function compact(events, { days = 180, now = Date.now() } = {}) {
  const since = now - days * DAY
  const sessions = []
  const sessionIndex = new Map()
  const rows = []
  // The same event sent twice keeps its last copy.
  const byId = new Map()
  for (const event of events) byId.set(event.id, event)
  for (const event of byId.values()) {
    const t = event.ts ? Date.parse(event.ts) : NaN
    if (!Number.isFinite(t) || t < since || t > now) continue
    let s = -1
    if (event.session) {
      if (!sessionIndex.has(event.session)) {
        sessionIndex.set(event.session, sessions.length)
        sessions.push(event.session)
      }
      s = sessionIndex.get(event.session)
    }
    const row = { k: event.kind, t, s, h: event.host ?? '' }
    if (event.project) row.p = event.project
    if (event.agent) row.a = event.agent
    if (event.model) row.m = event.model
    if (event.output_tokens) row.o = Number(event.output_tokens)
    // Everything the model read: fresh input plus cache reads and writes.
    const tokensIn = Number(event.input_tokens ?? 0) + Number(event.cache_read_tokens ?? 0) + Number(event.cache_write_tokens ?? 0)
    if (tokensIn > 0) row.i = tokensIn
    if (event.cost_usd !== null && event.cost_usd !== undefined) row.c = Number(event.cost_usd)
    if (event.tool) row.tl = event.tool
    if (event.skill) row.sk = event.skill
    if (event.mcp_server) row.mc = event.mcp_server
    if (event.ok !== null && event.ok !== undefined) row.ok = event.ok
    const data = event.data ?? {}
    if (event.kind === 'jev.decision') {
      row.d = { decidedBy: data.decidedBy ?? null, conf: confidenceOf(event.skill ?? null, data), wideMs: data.wideMs ?? null, rerankMs: data.rerankMs ?? null }
      if (data.injected) row.d.injected = true
    } else if (event.kind === 'router.call') {
      row.d = { category: data.category ?? null, fallbackFrom: data.fallbackFrom ?? null, error: data.error ?? null, requested: data.requested ?? null, ms: data.ms ?? null }
    } else if (event.kind === 'tool') {
      if (Number.isFinite(data.ms)) row.ms = data.ms
      if (data.subagent_type) row.st = data.subagent_type
      // A background subagent's tool call returns at once: its time is not how long it ran.
      if (data.subagent_type && data.background) row.bg = 1
    } else if (event.kind === 'openrouter.key' || event.kind === 'jev.miss') {
      row.d = data
    } else if (event.kind === 'prompt') {
      if (data.slash) row.sl = 1
      if (data.category) row.cat = data.category
      if (data.correction) row.cx = 1
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.t - b.t)
  // Which skill each model call worked for, and which reply asked for each tool (checks.mjs).
  attribute(rows)
  return { sessions, rows, turns: turnsFrom(rows) }
}

/**
 * The page's DATA from live events: what the build would make from the same
 * rows, as of `now`. Prices and the Jev benchmark are not in the table, so
 * they come from the snapshot.
 */
export function livePayload(events, snapshot, { now = Date.now(), days = LIVE.days, pages = null, capped = false } = {}) {
  const payload = compact(events, { days, now })
  const first = payload.rows[0], last = payload.rows[payload.rows.length - 1]
  return {
    ...(snapshot ?? {}),
    source: 'supabase',
    generatedAt: new Date(now).toISOString(),
    firstEventAt: first ? new Date(first.t).toISOString() : null,
    lastEventAt: last ? new Date(last.t).toISOString() : null,
    prices: snapshot?.prices ?? {},
    jevTiers: snapshot?.jevTiers ?? null,
    ...payload,
    live: { at: new Date(now).toISOString(), events: events.length, pages, capped, snapshotAt: snapshot?.generatedAt ?? null },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Every event of the last `days` days, newest page first, through
 * `mcp.callTool`. A retryable failure is retried once, after a short random
 * wait; anything else rejects with the connector's error.
 */
export async function loadLive(mcp, { days = LIVE.days, pageSize = LIVE.pageSize, maxPages = LIVE.maxPages, onPage = () => {}, wait = sleep } = {}) {
  const events = []
  let after = null, pages = 0, retried = false
  while (pages < maxPages) {
    const input = { project_id: LIVE.project, query: liveQuery({ days, after, limit: pageSize }) }
    let result
    try {
      result = await mcp.callTool(LIVE.server, LIVE.tool, input, { cache: false })
    } catch (error) {
      if (!error?.retryable || retried) throw error
      retried = true
      await wait(Math.min(Number(error.retryAfterMs) || 0, 60000) + 500 + Math.random() * 1500)
      continue
    }
    const rows = rowsFromResult(result)
    pages++
    for (const row of rows) events.push(eventFromRow(row))
    onPage({ pages, events: events.length })
    if (rows.length < pageSize) return { events, pages, capped: false }
    const lastRow = rows[rows.length - 1]
    after = { ts: lastRow.ts, id: lastRow.id }
  }
  return { events, pages, capped: true }
}

/** What went wrong, in words the owner can act on. */
export function liveErrorText(error) {
  const server = LIVE.server
  switch (error?.code) {
    case 'no_runtime':
      return 'this copy of the page is not open inside Claude, so it cannot read connected data'
    case 'no_mcp':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return 'this view of the page is not allowed to read connected data'
    case 'server_not_connected':
    case 'server_not_found':
      return `${server} is not connected for you. Add it in claude.ai Settings → Connectors, then reload`
    case 'needs_reauth':
      return `${server} needs reconnecting in claude.ai Settings → Connectors, then reload`
    case 'selection_required':
      return `you have more than one ${server} connection. Pick one when Claude asks, then reload`
    case 'not_in_manifest':
    case 'consent_required':
      return `${server} access is turned off for this page. Allow it, then reload`
    case 'blocked_by_policy':
    case 'approval_required':
      return `your organization's policy stops this page from reading ${server}`
    case 'tool_error':
      return `${server} refused the query (${String(error.message ?? '').slice(0, 200)})`
    case 'server_unavailable':
    case 'rate_limited':
      return `${server} did not answer in time. Reload to try again`
    default:
      return String(error?.message ?? error ?? 'unknown error').slice(0, 240)
  }
}

/** The one line under the header that says where the numbers came from. */
function liveStatus(text, state) {
  if (typeof document === 'undefined') return
  let el = document.getElementById('live-status')
  if (!el) {
    el = document.createElement('p')
    el.id = 'live-status'
    el.setAttribute('role', 'status')
    el.style.cssText = 'margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:13px;border:1px solid var(--line);'
    const header = document.querySelector('main > header')
    if (header) header.after(el)
    else (document.querySelector('main') ?? document.body).prepend(el)
  }
  el.dataset.state = state
  el.style.background = state === 'error' ? 'var(--bad-bg)' : state === 'live' ? 'var(--good-bg)' : 'var(--soft)'
  el.style.color = state === 'error' ? 'var(--bad)' : 'var(--ink)'
  el.textContent = text
}

const when = (iso) => (typeof fmtTime === 'function' ? fmtTime(Date.parse(iso)) : new Date(iso).toLocaleString())

/**
 * The page's DATA: live rows when the viewer's Supabase connector answers,
 * else the inlined snapshot, with a status line saying which and why.
 */
export async function liveData(snapshot, { claude = globalThis.claude, now = () => Date.now(), status = liveStatus } = {}) {
  const asOf = snapshot?.generatedAt ? `as of ${when(snapshot.generatedAt)}` : 'with no time recorded'
  status('Loading live data from Supabase…', 'loading')
  try {
    if (!claude || typeof claude.use !== 'function') throw { code: 'no_runtime' }
    const mcp = await claude.use('mcp')
    if (!mcp) throw { code: 'no_mcp' }
    const loaded = await loadLive(mcp, { onPage: ({ events }) => status(`Loading live data from Supabase… ${events} events so far`, 'loading') })
    const data = livePayload(loaded.events, snapshot, { now: now(), pages: loaded.pages, capped: loaded.capped })
    status(`Live: read from Supabase ${when(data.generatedAt)} · ${data.rows.length} events${data.lastEventAt ? `, newest ${when(data.lastEventAt)}` : ''}${loaded.capped ? ` · only the newest ${loaded.events.length} events were read` : ''}.`, 'live')
    return data
  } catch (error) {
    status(`Couldn't load live data: ${liveErrorText(error)}. Showing the saved copy ${asOf}.`, 'error')
    return snapshot
  }
}
