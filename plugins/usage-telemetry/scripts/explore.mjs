/**
 * The master dashboard's engine: group, filter, rank and export the compact
 * rows (see dashboard.mjs) the way OpenRouter's Activity page does, with no
 * backend. Pure functions, no DOM, no clock.
 *
 *   buildIndex   once per page load: every row's key for every dimension as
 *                an integer code (so a filter or a group-by is an array
 *                lookup), rows sorted by time (so a period is a binary
 *                search), and each Jev decision's misroute flag.
 *   groupRows    one metric, split by up to two dimensions and a time grain
 *                (hour, day, week) or none (a ranked table).
 *   logIndices   the rows a filter matches, newest first, for the logs.
 *   encodeView / decodeView   the page's state in the URL hash.
 *   toCsv        CSV with every cell escaped.
 *
 * Like checks.mjs and present.mjs it runs in node (tests) and in the page:
 * dashboard.mjs inlines it after them, dropping imports and `export`, so its
 * top-level names must not repeat theirs.
 */
import { DAY, JEV_TIERS, feedEntry, feedType, hostMatch, jevOutcomes, modelName, n0, pct, periodStart, tierOf } from './checks.mjs'
import { usdTop } from './present.mjs'
import { categoryLabel } from './rankings.mjs'

export const HOUR = 3600000
export const GRAIN_MS = { hour: HOUR, day: DAY, week: 7 * DAY }
const fin = (x) => typeof x === 'number' && Number.isFinite(x)

// ---------- time buckets ----------

/** Start of the bucket holding `t`: the UTC hour, the UTC day, or the UTC week from Monday. */
export function bucketStart(t, grain) {
  if (grain === 'hour') return Math.floor(t / HOUR) * HOUR
  if (grain === 'day') return Math.floor(t / DAY) * DAY
  return periodStart(t, 'weekly')
}

/** Bucket starts covering the half-open period (from, to]. */
export function bucketsFor(from, to, grain) {
  const out = []
  const last = bucketStart(to, grain)
  for (let b = bucketStart(from + 1, grain); b <= last; b += GRAIN_MS[grain]) out.push(b)
  return out
}

/** The grain a chart uses when the reader has not picked one: hours up to 2 days, days up to 45, weeks beyond. */
export const autoGrain = (days) => (days <= 2 ? 'hour' : days <= 45 ? 'day' : 'week')

/** "2 PM", "Sep 26", "Week of Sep 21". Days and weeks are UTC, like the buckets. */
export function bucketLabel(t, grain, long = false) {
  const d = new Date(t)
  if (grain === 'hour') {
    const h = d.toLocaleTimeString('en-US', { hour: 'numeric' })
    return long ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${h}` : h
  }
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return grain === 'week' ? `Week of ${day}` : day
}

// ---------- what each row is ----------

/** How long a row took: a tool call (not a background run's), a routed call, or a Jev decision. */
export function durationOf(r) {
  if (r.k === 'tool') return r.bg ? null : fin(r.ms) ? r.ms : null
  if (r.k === 'router.call') return fin(r.d?.ms) ? r.d.ms : null
  if (r.k === 'jev.decision') {
    const w = r.d?.wideMs, rr = r.d?.rerankMs
    return fin(w) || fin(rr) ? (fin(w) ? w : 0) + (fin(rr) ? rr : 0) : null
  }
  return null
}

export const TYPE_LABEL = {
  model: 'Model call', router: 'Routed call', jev: 'Jev decision', prompt: 'Your request', subagent: 'Subagent run', connector: 'Connector call',
  tool: 'Tool call', miss: 'Jev pick flagged wrong', suggested: 'Jev suggestion', balance: 'Balance check', other: 'Other',
}

/** The row's type for the logs and the "event type" dimension. */
export function eventType(r) {
  const ft = feedType(r)
  if (ft) return ft
  return r.k === 'prompt' ? 'prompt' : r.k === 'jev.miss' ? 'miss' : r.k === 'jev.suggested' ? 'suggested' : r.k === 'openrouter.key' ? 'balance' : 'other'
}

/** The dimensions a metric can be split and filtered by. `none` names the empty key. */
export const DIMS = [
  { id: 'model', label: 'Model', none: 'no model' },
  { id: 'provider', label: 'Provider', none: 'no provider' },
  { id: 'skill', label: 'Skill', none: 'no skill' },
  { id: 'connector', label: 'Connector', none: 'no connector' },
  { id: 'tool', label: 'Tool', none: 'not a tool call' },
  { id: 'subagent', label: 'Subagent type', none: 'main chat' },
  { id: 'type', label: 'Event type', none: 'other' },
  { id: 'machine', label: 'Machine', none: 'unknown machine' },
  { id: 'chat', label: 'Chat', none: 'no chat' },
  { id: 'tier', label: 'Jev tier', none: 'not a Jev decision' },
  { id: 'category', label: 'Router task', none: 'not routed' },
  { id: 'task', label: 'Kind of request', none: 'not recorded' },
  { id: 'outcome', label: 'Outcome', none: 'no outcome' },
]
export const DIM_IDS = DIMS.map((d) => d.id)
export const dimById = (id) => DIMS.find((d) => d.id === id) ?? null

/**
 * A row's key in one dimension ('' when it has none):
 *   model     the model ("or:" in front for a routed call); a tool call carries the model that asked for it
 *   provider  Anthropic for Claude models; "OpenRouter: <vendor>" for routed calls
 *   skill     the skill active when it ran (attribute in checks.mjs); a Jev decision's pick; a flagged miss's pick; a Skill load's skill
 *   subagent  the subagent type a model or tool call ran in, or the type an Agent call started
 *   chat      the session id; tier: who made a Jev decision (tierOf); category: a routed call's task
 *   outcome   ok / failed for tool and routed calls; model calls that were logged answered (ok)
 */
export function dimKey(id, r, sessions = []) {
  switch (id) {
    case 'model': return r.m ? (r.k === 'router.call' ? 'or:' : '') + r.m : ''
    case 'provider':
      if (r.k === 'router.call') return 'OpenRouter: ' + (String(r.m ?? '').includes('/') ? String(r.m).split('/')[0] : 'unknown')
      return /^claude-/.test(r.m ?? '') ? 'Anthropic' : ''
    case 'skill':
      if (r.k === 'jev.miss') return r.d?.jevPick ?? ''
      if (r.k === 'jev.decision' || r.k === 'jev.suggested' || (r.k === 'tool' && r.tl === 'Skill')) return r.sk ?? ''
      if (r.k === 'prompt') return r.as ?? r.sk ?? ''
      return r.as ?? ''
    case 'connector': return r.mc ?? ''
    case 'tool': return r.k === 'tool' ? r.tl ?? '' : ''
    case 'subagent':
      if (r.k === 'tool' && (r.tl === 'Agent' || r.tl === 'Task')) return r.st ?? 'general-purpose'
      return String(r.a ?? '').startsWith('subagent:') ? r.a.slice(9) : ''
    case 'type': return eventType(r)
    case 'machine': return r.h ?? ''
    case 'chat': return r.s >= 0 ? sessions[r.s] ?? String(r.s) : ''
    case 'tier': return r.k === 'jev.decision' ? tierOf(r.d?.decidedBy) : ''
    case 'category': return r.k === 'router.call' ? r.d?.category ?? 'not given' : ''
    // A prompt's own kind; buildIndex gives every other row its request's kind.
    case 'task': return r.k === 'prompt' ? r.cat ?? '' : ''
    case 'outcome':
      if (r.k === 'tool' || r.k === 'router.call') return r.ok === false ? 'failed' : r.ok === true ? 'ok' : ''
      return r.k === 'api' ? 'ok' : ''
    default: return ''
  }
}

const shortWhen = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** A key in words. `ix` (optional) gives chats their start time. */
export function dimLabel(id, key, ix = null) {
  if (key === '' || key === null || key === undefined) return dimById(id)?.none ?? 'none'
  switch (id) {
    case 'model': return key.startsWith('or:') ? `${modelName(key.slice(3))} (OpenRouter)` : modelName(key)
    case 'connector': return key.replace(/_/g, ' ')
    case 'tool': return key.startsWith('mcp__') ? `${key.split('__')[1].replace(/_/g, ' ')} · ${key.split('__').slice(2).join('__')}` : key
    case 'type': return TYPE_LABEL[key] ?? key
    case 'machine': return key === 'cloud' ? 'Cloud' : key.startsWith('local:') ? `Your PC (${key.slice(6)})` : key.startsWith('local') ? 'Your PC' : key
    case 'chat': {
      const start = ix?.chatStart?.get(key)
      return `${start ? shortWhen(start) + ' · ' : ''}${key.slice(0, 8)}`
    }
    case 'tier': {
      const t = JEV_TIERS.find((x) => x.id === key)
      return t ? `${t.label}${t.paid === true ? ' · paid' : t.paid === false ? ' · free' : ''}` : key
    }
    case 'outcome': return key === 'ok' ? 'OK' : key === 'failed' ? 'Failed' : key
    case 'task': return categoryLabel(key)
    default: return key
  }
}

// ---------- metrics ----------

/** Running totals for one group of rows; every metric reads from these. */
export function newAcc() {
  return { ev: 0, prompts: 0, api: 0, routed: 0, claude: 0, or: 0, unpriced: 0, tin: 0, tout: 0, tcache: 0, ptok: 0, tools: 0, toolFails: 0, judged: 0, fails: 0, jev: 0, miss: 0, dur: [] }
}

/** Adds one row. `missed`: a Jev decision flagged as a misroute (see buildIndex). */
export function addTo(a, r, missed = false) {
  a.ev++
  if (r.k === 'prompt' && (!r.a || r.a === 'main')) a.prompts++
  else if (r.k === 'api' || r.k === 'router.call') {
    if (r.k === 'api') a.api++
    else a.routed++
    const tin = fin(r.i) ? r.i : 0, tout = fin(r.o) ? r.o : 0
    a.tin += tin
    a.tout += tout
    if (fin(r.cr)) a.tcache += r.cr
    if (fin(r.c)) {
      if (r.k === 'api') a.claude += r.c
      else a.or += r.c
      a.ptok += tin + tout
    } else a.unpriced++
  } else if (r.k === 'tool') {
    a.tools++
    if (r.ok === false) a.toolFails++
  } else if (r.k === 'jev.decision') {
    a.jev++
    if (missed) a.miss++
  }
  if ((r.k === 'tool' || r.k === 'router.call') && (r.ok === true || r.ok === false)) {
    a.judged++
    if (r.ok === false) a.fails++
  }
  const ms = durationOf(r)
  if (ms !== null) a.dur.push(ms)
  return a
}

export function mergeAcc(into, b) {
  for (const k of Object.keys(into)) {
    if (Array.isArray(into[k])) for (const x of b[k]) into[k].push(x)
    else into[k] += b[k]
  }
  return into
}

/** The q-th quantile (0..1), linear between the two nearest values; null for no values. */
export function quantile(xs, q) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  if (!v.length) return null
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return v[lo] + (v[hi] - v[lo]) * (pos - lo)
}

/**
 * Everything a card or a tooltip says about one group:
 *   cacheRate  cache-read tokens over all input tokens (fresh + cache reads + cache writes)
 *   costPerM   logged cost over the tokens (in + out) of the calls that had a price, per million
 */
export function accFigures(a) {
  const cost = a.claude + a.or
  return {
    cost, claude: a.claude, openrouter: a.or, unpriced: a.unpriced,
    prompts: a.prompts, calls: a.api + a.routed, api: a.api, routed: a.routed,
    tokens: a.tin + a.tout, tokensIn: a.tin, tokensOut: a.tout, tokensCache: a.tcache, tokensFresh: a.tin - a.tcache,
    cacheRate: a.tin ? a.tcache / a.tin : null,
    costPerM: a.ptok ? (cost / a.ptok) * 1e6 : null,
    tools: a.tools, toolFails: a.toolFails, toolFailRate: a.tools ? a.toolFails / a.tools : null,
    failures: a.fails, judged: a.judged, failRate: a.judged ? a.fails / a.judged : null,
    p50: quantile(a.dur, 0.5), p90: quantile(a.dur, 0.9), timed: a.dur.length,
    jev: a.jev, misses: a.miss, missRate: a.jev ? a.miss / a.jev : null, events: a.ev,
  }
}

/**
 * The metrics Explore offers. `add`: sums across groups and stacks in a bar
 * chart; rates and times do not. Rates carry num/den so every percentage is
 * shown with its count.
 */
export const METRICS = [
  { id: 'spend', label: 'Spend (Claude + OpenRouter)', unit: 'usd', add: true, of: (a) => a.claude + a.or },
  { id: 'claude', label: 'Claude work at pay-as-you-go prices', unit: 'usd', add: true, of: (a) => a.claude },
  { id: 'openrouter', label: 'OpenRouter spend (routed calls)', unit: 'usd', add: true, of: (a) => a.or },
  { id: 'requests', label: 'Requests (your prompts)', unit: 'count', add: true, of: (a) => a.prompts },
  { id: 'calls', label: 'Model calls', unit: 'count', add: true, of: (a) => a.api + a.routed },
  { id: 'tokens', label: 'Tokens (in and out)', unit: 'tokens', add: true, of: (a) => a.tin + a.tout },
  { id: 'tokensIn', label: 'Tokens in', unit: 'tokens', add: true, of: (a) => a.tin },
  { id: 'tokensOut', label: 'Tokens out', unit: 'tokens', add: true, of: (a) => a.tout },
  { id: 'tokensCache', label: 'Tokens read from cache', unit: 'tokens', add: true, of: (a) => a.tcache },
  { id: 'cacheRate', label: 'Cache hit rate', unit: 'rate', add: false, of: (a) => (a.tin ? a.tcache / a.tin : null), num: (a) => a.tcache, den: (a) => a.tin, noun: 'input tokens' },
  { id: 'costPerM', label: 'Blended cost per million tokens', unit: 'usd', add: false, of: (a) => (a.ptok ? ((a.claude + a.or) / a.ptok) * 1e6 : null) },
  { id: 'tools', label: 'Tool calls', unit: 'count', add: true, of: (a) => a.tools },
  { id: 'failures', label: 'Failures (tools and routed calls)', unit: 'count', add: true, of: (a) => a.fails },
  { id: 'failRate', label: 'Failure rate', unit: 'rate', add: false, of: (a) => (a.judged ? a.fails / a.judged : null), num: (a) => a.fails, den: (a) => a.judged, noun: 'calls' },
  { id: 'p50', label: 'Time taken, typical (p50)', unit: 'ms', add: false, of: (a) => quantile(a.dur, 0.5) },
  { id: 'p90', label: 'Time taken, slowest 10% (p90)', unit: 'ms', add: false, of: (a) => quantile(a.dur, 0.9) },
  { id: 'jev', label: 'Jev decisions', unit: 'count', add: true, of: (a) => a.jev },
  { id: 'missRate', label: 'Jev misroute rate', unit: 'rate', add: false, of: (a) => (a.jev ? a.miss / a.jev : null), num: (a) => a.miss, den: (a) => a.jev, noun: 'decisions' },
  { id: 'events', label: 'Events (everything logged)', unit: 'count', add: true, of: (a) => a.ev },
]
export const metricById = (id) => METRICS.find((m) => m.id === id) ?? METRICS[0]

/** The event types each metric is made of: a click-through shows exactly these rows. */
const MODEL_TYPES = ['model', 'router']
const TIMED_TYPES = ['tool', 'connector', 'subagent', 'router', 'jev']
export const METRIC_TYPES = {
  spend: MODEL_TYPES, claude: ['model'], openrouter: ['router'], requests: ['prompt'], calls: MODEL_TYPES, tokens: MODEL_TYPES, tokensIn: MODEL_TYPES, tokensOut: MODEL_TYPES,
  tokensCache: MODEL_TYPES, cacheRate: MODEL_TYPES, costPerM: MODEL_TYPES, tools: ['tool', 'connector', 'subagent'], failures: ['tool', 'connector', 'subagent', 'router'],
  failRate: ['tool', 'connector', 'subagent', 'router'], p50: TIMED_TYPES, p90: TIMED_TYPES, jev: ['jev'], missRate: ['jev'],
}

/**
 * The filters a click-through lands on: the clicked group's filters plus the
 * event types the metric counts, unless a type filter is already set (then
 * only the types both allow, or the set one when they share none).
 */
export function drillFilters(metric, filters = {}) {
  const types = METRIC_TYPES[metric]
  if (!types) return { ...filters }
  const set = filters.type
  if (!set || !set.length) return { ...filters, type: [...types] }
  const both = set.filter((t) => types.includes(t))
  return { ...filters, type: both.length ? both : [...set] }
}

/** 950, 12.3k, 1.2M. */
export function tokText(x) {
  if (!fin(x)) return '—'
  if (Math.abs(x) < 1000) return String(Math.round(x))
  if (Math.abs(x) < 1e6) return (x / 1000).toFixed(Math.abs(x) < 1e4 ? 1 : 0) + 'k'
  if (Math.abs(x) < 1e9) return (x / 1e6).toFixed(Math.abs(x) < 1e7 ? 1 : 0) + 'M'
  return (x / 1e9).toFixed(1) + 'B'
}

/** "0.4 s", "12 s", "3 min", "1.5 h". */
export function durText(ms) {
  if (!fin(ms)) return '—'
  if (ms < 10000) return (ms / 1000).toFixed(1) + ' s'
  if (ms < 120000) return Math.round(ms / 1000) + ' s'
  if (ms < 7200000) return Math.round(ms / 60000) + ' min'
  return (ms / 3600000).toFixed(1) + ' h'
}

/** A metric value in words: money, a count, tokens, a time or a rate. */
export function fmtValue(unit, v) {
  if (!fin(v)) return '—'
  if (unit === 'usd') return usdTop(v)
  if (unit === 'tokens') return tokText(v)
  if (unit === 'ms') return durText(v)
  if (unit === 'rate') return pct(v)
  return n0(Math.round(v))
}

/** A metric for one group, with the count next to any percentage: "12% (3 of 25 calls)". */
export function metricText(M, a) {
  const v = M.of(a)
  if (M.unit === 'rate') return v === null ? `— (none of 0 ${M.noun})` : `${pct(v)} (${n0(M.num(a))} of ${n0(M.den(a))} ${M.noun})`
  if (M.unit === 'ms' && v !== null) return `${durText(v)} (${n0(a.dur.length)} timed)`
  return fmtValue(M.unit, v)
}

// ---------- the index ----------

/** Rows sorted by time, a code per dimension per row, each chat's start, and each Jev decision's misroute flag. */
export function buildIndex(input, sessions = []) {
  let rows = input
  for (let i = 1; i < input.length; i++) if (input[i].t < input[i - 1].t) { rows = [...input].sort((a, b) => a.t - b.t); break }
  const n = rows.length
  const t = new Float64Array(n)
  const dims = {}
  for (const d of DIMS) dims[d.id] = { codes: new Int32Array(n), values: [], lookup: new Map() }
  // A decision is flagged when a jev.miss matches it (same chat, same pick, nearest), as the Jev panel counts it.
  const flagged = new Set(jevOutcomes(rows, []).decisions.filter((d) => d.miss).map((d) => d.r))
  const miss = new Uint8Array(n)
  const chatStart = new Map()
  // The kind of request each row worked for: the latest main prompt in its chat.
  const taskNow = new Map()
  for (let i = 0; i < n; i++) {
    const r = rows[i]
    t[i] = r.t
    if (r.k === 'prompt' && (!r.a || r.a === 'main')) taskNow.set(r.s, r.cat ?? '')
    for (const d of DIMS) {
      const key = d.id === 'task' ? (r.k === 'prompt' ? r.cat ?? '' : r.s >= 0 ? taskNow.get(r.s) ?? '' : '') : dimKey(d.id, r, sessions)
      const D = dims[d.id]
      let c = D.lookup.get(key)
      if (c === undefined) {
        c = D.values.length
        D.values.push(key)
        D.lookup.set(key, c)
      }
      D.codes[i] = c
    }
    if (flagged.has(r)) miss[i] = 1
    const chat = dims.chat.values[dims.chat.codes[i]]
    if (chat && !chatStart.has(chat)) chatStart.set(chat, r.t)
  }
  return { n, rows, sessions, t, dims, miss, chatStart, text: new Array(n) }
}

function upper(t, x) {
  let lo = 0, hi = t.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (t[m] <= x) lo = m + 1
    else hi = m
  }
  return lo
}

/** [first, end) row positions inside (from, to]. */
export const rangeOf = (ix, from, to) => [upper(ix.t, from), Math.max(upper(ix.t, from), upper(ix.t, to))]

/** What the text search looks through: the row's name, type, model, tool, skill, connector, subagent and router task. */
export function searchText(ix, i) {
  if (ix.text[i] !== undefined) return ix.text[i]
  const r = ix.rows[i]
  const e = logEntry(r)
  const parts = [e.name, TYPE_LABEL[e.type], r.m, r.m ? modelName(r.m) : '', r.tl, r.sk, r.as, r.mc, r.st, r.a, r.k === 'router.call' ? r.d?.category : '', r.k === 'jev.miss' ? r.d?.jevPick : '']
  return (ix.text[i] = parts.filter(Boolean).join(' ').toLowerCase())
}

/**
 * The filter model: `filters` is { dimension: [keys] } — a row matches when,
 * for every dimension listed, its key is one of the keys (AND across
 * dimensions, OR within one). `host` is all / cloud / local; `q` is words
 * that must all appear in the row's searchable names.
 */
export function matcher(ix, { host = 'all', filters = {}, q = '' } = {}) {
  const tests = []
  if (host && host !== 'all') tests.push([ix.dims.machine.codes, ix.dims.machine.values.map((v) => hostMatch(v, host))])
  for (const [id, vals] of Object.entries(filters ?? {})) {
    const D = ix.dims[id]
    if (!D || !Array.isArray(vals) || !vals.length) continue
    const set = new Set(vals.map(String))
    tests.push([D.codes, D.values.map((v) => set.has(v))])
  }
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return (i) => {
    for (const [codes, allow] of tests) if (!allow[codes[i]]) return false
    if (words.length) {
      const s = searchText(ix, i)
      for (const w of words) if (!s.includes(w)) return false
    }
    return true
  }
}

// ---------- grouping ----------

/**
 * One metric over (from, to], split by up to two dimensions and a time grain.
 * Returns { metric, dims, grain, times (bucket starts, or null for 'none'),
 * groups: [{ keys, acc, value, cells (one acc or null per bucket) }] ranked
 * by value, total: { acc, value, cells }, matched }.
 */
export function groupRows(ix, { from, to, host = 'all', filters = {}, q = '', dims = [], grain = 'none', metric = 'spend' } = {}) {
  const M = metricById(metric)
  const D = dims.filter((d) => ix.dims[d]).slice(0, 2)
  const [lo, hi] = rangeOf(ix, from, to)
  const ok = matcher(ix, { host, filters, q })
  const times = GRAIN_MS[grain] ? bucketsFor(from, to, grain) : null
  const size = times ? GRAIN_MS[grain] : 0
  const A = D[0] ? ix.dims[D[0]] : null, B = D[1] ? ix.dims[D[1]] : null
  const width = B ? B.values.length : 1
  const groups = new Map()
  const total = newAcc()
  const totalCells = times ? times.map(() => null) : null
  let matched = 0
  for (let i = lo; i < hi; i++) {
    if (!ok(i)) continue
    matched++
    const r = ix.rows[i], missed = ix.miss[i] === 1
    const key = (A ? A.codes[i] : 0) * width + (B ? B.codes[i] : 0)
    let g = groups.get(key)
    if (!g) {
      g = { keys: [A ? A.values[A.codes[i]] : null, B ? B.values[B.codes[i]] : null].slice(0, D.length), acc: newAcc(), cells: times ? times.map(() => null) : null }
      groups.set(key, g)
    }
    addTo(g.acc, r, missed)
    addTo(total, r, missed)
    if (times) {
      const b = Math.min(times.length - 1, Math.max(0, Math.round((bucketStart(r.t, grain) - times[0]) / size)))
      addTo(g.cells[b] ?? (g.cells[b] = newAcc()), r, missed)
      addTo(totalCells[b] ?? (totalCells[b] = newAcc()), r, missed)
    }
  }
  const rank = (x) => (x.value === null || x.value === undefined ? -Infinity : x.value)
  const list = [...groups.values()].map((g) => ({ ...g, value: M.of(g.acc) }))
  list.sort((x, y) => (rank(y) === rank(x) ? y.acc.ev - x.acc.ev : rank(y) > rank(x) ? 1 : -1))
  return { metric: M.id, dims: D, grain: times ? grain : 'none', times, groups: list, total: { acc: total, value: M.of(total), cells: totalCells }, matched }
}

/**
 * Chart series from a grouping: the top `top` groups, the rest merged as
 * "other" (with the keys it holds). Each series has `values`, one per bucket
 * (0 for an empty bucket of an additive metric, null otherwise).
 */
export function seriesFrom(res, top = 8) {
  const M = metricById(res.metric)
  const out = res.groups.slice(0, top).map((g) => ({ keys: g.keys, acc: g.acc, value: g.value, cells: g.cells, other: false }))
  const rest = res.groups.slice(top)
  if (rest.length) {
    const acc = newAcc()
    const cells = res.times ? res.times.map(() => null) : null
    for (const g of rest) {
      mergeAcc(acc, g.acc)
      if (cells) g.cells.forEach((c, b) => c && mergeAcc(cells[b] ?? (cells[b] = newAcc()), c))
    }
    out.push({ keys: null, acc, value: M.of(acc), cells, other: true, count: rest.length, members: rest.map((g) => g.keys) })
  }
  for (const s of out) s.values = s.cells ? s.cells.map((c) => (c ? M.of(c) : M.add ? 0 : null)) : null
  return out
}

/** The filters that select one group (merged over `base`): each of its dimensions pinned to its key. */
export function filtersFor(dims, keys, base = {}) {
  const f = { ...base }
  dims.forEach((d, i) => {
    if (keys && keys[i] !== null && keys[i] !== undefined) f[d] = [keys[i]]
  })
  return f
}

// ---------- the logs ----------

/** Row positions matching the filters inside (from, to], newest first. */
export function logIndices(ix, { from, to, host = 'all', filters = {}, q = '' } = {}) {
  const [lo, hi] = rangeOf(ix, from, to)
  const ok = matcher(ix, { host, filters, q })
  const out = []
  for (let i = hi - 1; i >= lo; i--) if (ok(i)) out.push(i)
  return out
}

/** One log line: { t, h, type, name, model, tokensIn, tokensOut, cost, costKind, ms, ok }. No text anyone typed. */
export function logEntry(r) {
  const ft = feedType(r)
  if (ft) return feedEntry(r, ft)
  const type = eventType(r)
  const name = type === 'prompt' ? (r.sk ? `request, typed /${r.sk}` : 'request') + (r.a && r.a !== 'main' ? ` (${String(r.a).replace(/^subagent:/, '')})` : '')
    : type === 'miss' ? `flagged: Jev picked ${r.d?.jevPick ?? 'nothing'}`
      : type === 'suggested' ? `Jev suggested ${r.sk ?? 'a skill'}`
        : type === 'balance' ? 'OpenRouter balance check' : String(r.k)
  return { t: r.t, h: r.h, type, name, model: null, tokensIn: null, tokensOut: null, cost: null, costKind: 'own', ms: null, ok: null }
}

const FIELD_NAMES = {
  k: 'Kind', t: 'Time (UTC)', s: 'Chat', h: 'Machine', p: 'Project', a: 'Agent', m: 'Model', i: 'Tokens in (fresh + cache)', cr: 'Tokens read from cache',
  cw: 'Tokens written to cache', o: 'Tokens out', c: 'Cost (USD)', xc: 'Share of the reply that asked for it (USD)', tl: 'Tool', sk: 'Skill', as: 'Skill active',
  mc: 'Connector', ok: 'Result', ms: 'Took (ms)', st: 'Subagent type', bg: 'Ran in the background', sl: 'Typed a command', cat: 'Kind of request', cx: 'Pushed back on the answer before',
}

/** Every field of a row, in words, for the expanded log line. Rows carry no text anyone typed. */
export function eventFields(r, sessions = []) {
  const out = []
  for (const [k, v] of Object.entries(r)) {
    if (k === 'd' || v === null || v === undefined) continue
    const val = k === 't' ? new Date(v).toISOString() : k === 's' ? (v >= 0 ? sessions[v] ?? String(v) : 'none') : k === 'ok' ? (v === false ? 'failed' : 'ok') : k === 'k' ? `${v} (${TYPE_LABEL[eventType(r)]})` : String(v)
    out.push([FIELD_NAMES[k] ?? k, val])
  }
  if (r.d && typeof r.d === 'object') {
    for (const [k, v] of Object.entries(r.d)) if (v !== null && v !== undefined) out.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
  }
  return out
}

// ---------- CSV ----------

/** One CSV cell: quoted when it holds a comma, quote, line break or edge space; a leading = + - @ is defused so a spreadsheet never runs it. */
export function csvCell(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

export const LOG_CSV_HEADER = ['time_utc', 'machine', 'chat', 'type', 'name', 'model', 'tokens_in', 'tokens_from_cache', 'tokens_out', 'cost_usd', 'cost_is_share_of_reply', 'duration_ms', 'result', 'skill', 'connector', 'tool', 'subagent', 'router_task', 'jev_tier']

/** The filtered log rows as CSV, in the order given. */
export function logsCsv(ix, indices) {
  const key = (id, i) => ix.dims[id].values[ix.dims[id].codes[i]]
  return toCsv(LOG_CSV_HEADER, indices.map((i) => {
    const r = ix.rows[i], e = logEntry(r)
    return [new Date(r.t).toISOString(), r.h ?? '', key('chat', i), TYPE_LABEL[e.type] ?? e.type, e.name, r.m ?? '', e.tokensIn, fin(r.cr) ? r.cr : null, e.tokensOut, e.cost,
      e.cost === null ? '' : e.costKind === 'reply', e.ms, e.ok === false ? 'failed' : e.ok === true ? 'ok' : '', key('skill', i), key('connector', i), key('tool', i), key('subagent', i), key('category', i), key('tier', i)]
  }))
}

/** The log CSV's file name: the build day and how many events it holds. */
export const logsCsvName = (end, n) => `claude-usage-${new Date(end).toISOString().slice(0, 10)}-${n}-events.csv`

/**
 * Hands a file to the viewer through the artifact `downloads` capability
 * (the viewer's frame blocks a page's own downloads), and says in words what
 * happened: { text, hide } — hide when saving cannot work in this view.
 */
export async function saveFile(downloads, filename, data) {
  if (!downloads) return { text: "Saving files isn't available here.", hide: true }
  try {
    await downloads.save({ filename, data })
    return { text: 'Saved.', hide: false }
  } catch (error) {
    switch (error?.code) {
      case 'declined':
        return { text: 'Not saved.', hide: false }
      case 'rate_limited':
        return { text: 'A save is already waiting for your answer.', hide: false }
      case 'too_large':
        return { text: 'Too many events to save at once. Filter the list down and try again.', hide: false }
      case 'bad_request':
      case 'transform_error':
        return { text: `Couldn't save: ${String(error.message ?? 'the file was not accepted').slice(0, 160)}.`, hide: false }
      case 'rejected_extension':
      case 'extension_not_enabled':
        return { text: "CSV files can't be saved here.", hide: true }
      default:
        return { text: "Saving files isn't available here.", hide: true }
    }
  }
}

// ---------- the view in the URL hash ----------

export const TABS = ['rankings', 'compare', 'overview', 'explore', 'logs', 'jev', 'router', 'health']
/** Rankings: what the top-models chart shows, and what the performance ranking ranks by. */
export const SHOWS = ['spend', 'tokens', 'calls']
export const RANK_BY = ['landed', 'speed', 'cost', 'failures', 'cache', 'spend']
export const PERIODS = ['1', '7', '30', '90', 'custom']
export const CHARTS = ['bar', 'line', 'dot']
export const GRAINS = ['hour', 'day', 'week', 'none']
export const DEFAULT_VIEW = { tab: 'rankings', sh: 'spend', rk: 'landed', cat: '', cm: [], p: '7', from: '', to: '', h: 'all', m: 'spend', g: ['model'], c: 'bar', t: 'day', f: {}, q: '', pg: 0, lf: null, lt: null }
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && Number.isFinite(Date.parse(s + 'T00:00:00Z'))

/** The view as a hash (without '#'): the tab, then only what differs from the defaults. */
export function encodeView(v) {
  const d = DEFAULT_VIEW
  const p = new URLSearchParams()
  if (v.p !== d.p) p.set('p', v.p)
  if (v.p === 'custom') {
    if (v.from) p.set('from', v.from)
    if (v.to) p.set('to', v.to)
  }
  if (v.h !== d.h) p.set('h', v.h)
  if (v.sh && v.sh !== d.sh) p.set('sh', v.sh)
  if (v.rk && v.rk !== d.rk) p.set('rk', v.rk)
  if (v.cat) p.set('cat', v.cat)
  if ((v.cm ?? []).length) p.set('cm', v.cm.join('~'))
  if (v.m !== d.m) p.set('m', v.m)
  if ((v.g ?? []).join(',') !== d.g.join(',')) p.set('g', (v.g ?? []).join(',') || 'none')
  if (v.c !== d.c) p.set('c', v.c)
  if (v.t !== d.t) p.set('t', v.t)
  for (const k of Object.keys(v.f ?? {}).sort()) for (const x of v.f[k]) p.append('f.' + k, x)
  if (v.q) p.set('q', v.q)
  if (v.pg) p.set('pg', String(v.pg))
  if (fin(v.lf) && fin(v.lt)) {
    p.set('lf', String(v.lf))
    p.set('lt', String(v.lt))
  }
  const s = p.toString()
  return (TABS.includes(v.tab) ? v.tab : d.tab) + (s ? '?' + s : '')
}

/** A hash back to a full view; anything unknown or malformed falls back to its default. */
export function decodeView(hash) {
  const raw = String(hash ?? '').replace(/^#/, '')
  const at = raw.indexOf('?')
  const tab = at < 0 ? raw : raw.slice(0, at)
  let p
  try {
    p = new URLSearchParams(at < 0 ? '' : raw.slice(at + 1))
  } catch {
    p = new URLSearchParams()
  }
  const d = DEFAULT_VIEW
  const pick = (k, list, fallback) => (list.includes(p.get(k)) ? p.get(k) : fallback)
  const g = p.has('g') ? [...new Set(String(p.get('g')).split(',').filter((x) => DIM_IDS.includes(x)))].slice(0, 2) : [...d.g]
  const f = {}
  for (const [k, val] of p.entries()) {
    if (!k.startsWith('f.') || !DIM_IDS.includes(k.slice(2))) continue
    ;(f[k.slice(2)] ??= []).includes(val) || f[k.slice(2)].push(val)
  }
  const num = (k) => (p.has(k) && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null)
  const lf = num('lf'), lt = num('lt')
  const period = pick('p', PERIODS, d.p)
  return {
    tab: TABS.includes(tab) ? tab : d.tab,
    p: period,
    from: period === 'custom' && isDay(p.get('from')) ? p.get('from') : '',
    to: period === 'custom' && isDay(p.get('to')) ? p.get('to') : '',
    h: pick('h', ['all', 'cloud', 'local'], d.h),
    sh: pick('sh', SHOWS, d.sh),
    rk: pick('rk', RANK_BY, d.rk),
    cat: /^[a-z][a-z-]{0,30}$/.test(p.get('cat') ?? '') ? p.get('cat') : '',
    cm: p.has('cm') ? [...new Set(String(p.get('cm')).split('~').filter((k) => /^[cr]:[\w.:@/-]{1,120}$/.test(k)))].slice(0, 5) : [],
    m: METRICS.some((m) => m.id === p.get('m')) ? p.get('m') : d.m,
    g,
    c: pick('c', CHARTS, d.c),
    t: pick('t', GRAINS, d.t),
    f,
    q: (p.get('q') ?? '').slice(0, 200),
    pg: Math.max(0, Math.floor(num('pg') ?? 0)),
    lf: lf !== null && lt !== null && lt > lf ? lf : null,
    lt: lf !== null && lt !== null && lt > lf ? lt : null,
  }
}

/**
 * The period a view asks for, ending at the build time: 24 hours, 7, 30 or
 * 90 days, or whole UTC days from–to (inclusive, cut at the build time).
 * A custom period that does not parse falls back to 7 days.
 */
export function periodOf(view, end) {
  if (view.p === 'custom' && isDay(view.from) && isDay(view.to)) {
    const a = Date.parse(view.from + 'T00:00:00Z'), b = Date.parse(view.to + 'T00:00:00Z')
    if (b >= a && a < end) {
      const to = Math.min(end, b + DAY)
      const days = Math.max(1, Math.round((to - a) / DAY))
      return { from: to - days * DAY, to, days, custom: true }
    }
  }
  const days = [1, 7, 30, 90].includes(Number(view.p)) ? Number(view.p) : 7
  return { from: end - days * DAY, to: end, days, custom: false }
}
