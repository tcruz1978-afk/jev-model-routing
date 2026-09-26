/**
 * The dashboard's arithmetic: every check, window, comparison and
 * reconciliation the page shows. Pure functions over the compact rows and
 * turns (see dashboard.mjs), no DOM, no clock: every range is measured from
 * the build time passed in, never from "now".
 *
 * The same source runs in two places: `node --test` imports it, and
 * dashboard.mjs inlines it into the page (it strips `export`), so the page
 * and the tests can never disagree. Keep it free of imports.
 *
 * Check states: 'pass', 'attention', 'untracked' (no data: never green) and
 * 'thin' (a rate over fewer than TARGETS.minN: too few to judge).
 */

export const DAY = 86400000

/** Declared targets. The page colours only from these, and prints them. */
export const TARGETS = {
  maxGaps: 2, // prompts with no Jev decision within matchMs
  quietMs: 10 * 60000, // last decision behind the last prompt by more than this
  matchMs: 2 * 60000,
  missRate: 0.1, // flagged misroutes over Jev decisions, at most
  landRate: 0.8, // turns that landed over turns with an outcome, at least
  routerRate: 0.1, // routed calls that errored or fell back, at most
  creditFloor: 0.1, // credit or key limit left, at least
  toolFailRate: 0.1, // per tool, at most
  minN: 10, // below this a rate is "too few to judge"
  staleMs: 26 * 3600000, // a build older than this is out of date
}

export const CHECK_IDS = ['jev-deciding', 'jev-picking', 'skills', 'landing', 'router', 'openrouter', 'reporting']

// ---------- formatting (plain text; the page escapes everything) ----------

export const n0 = (x) => Number(x ?? 0).toLocaleString('en-US')
export const usd = (x) =>
  x === null || x === undefined || !Number.isFinite(x) ? '—'
    : x === 0 ? '$0'
      : Math.abs(x) < 0.01 ? '$' + x.toPrecision(2)
        : '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (r) => (r === null || r === undefined || !Number.isFinite(r) ? '—' : Math.round(r * 100) + '%')
export const pp = (a, b) => {
  if (a === null || b === null || a === undefined || b === undefined) return ''
  const d = Math.round((a - b) * 100)
  return (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d) + ' pp'
}
export const fmtTime = (t) =>
  t === null || t === undefined ? '—'
    : new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
export const fmtDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const span = (days) => (days === 1 ? '24 hours' : `${days} days`)
export const plural = (n, word, many = word + 's') => `${n0(n)} ${n === 1 ? word : many}`
export const ago = (ms) => {
  const m = Math.round(ms / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`
}

// ---------- basics ----------

/** Median; for an even count, the mean of the two middle values. */
export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** The window ending at the build time, and the equal window before it. Both half-open: (from, to]. */
export function windowOf(end, days) {
  return { days, from: end - days * DAY, to: end, prevFrom: end - 2 * days * DAY, prevTo: end - days * DAY }
}

const inside = (t, from, to) => t > from && t <= to
export const hostMatch = (h, host) => host === 'all' || (host === 'cloud' ? h === 'cloud' : String(h ?? '').startsWith('local'))
export const hostLabel = (h) => (h === 'cloud' ? 'Cloud' : String(h ?? '').startsWith('local:') ? `Local (${h.slice(6)})` : h === 'local' ? 'Local' : h || 'unknown host')

/** True when the page is being read more than 26 h after it was built. */
export function isStale(generatedAt, now, staleMs = TARGETS.staleMs) {
  const built = typeof generatedAt === 'number' ? generatedAt : Date.parse(generatedAt)
  return !Number.isFinite(built) || now - built > staleMs
}

const isPrompt = (r) => r.k === 'prompt' && (!r.a || r.a === 'main')
const near = (list, r, ms = TARGETS.matchMs) => list.some((d) => d.s === r.s && Math.abs(d.t - r.t) <= ms)

// ---------- check 1: Jev is deciding ----------

export function decidingStats(rows) {
  const prompts = rows.filter(isPrompt)
  const decisions = rows.filter((r) => r.k === 'jev.decision')
  const suggested = rows.filter((r) => r.k === 'jev.suggested')
  const gaps = prompts.filter((p) => !near(decisions, p))
  const unmatched = suggested.filter((s) => !near(decisions, s))
  const last = (list) => (list.length ? Math.max(...list.map((r) => r.t)) : null)
  const by = (f) => decisions.filter(f).length
  return {
    prompts: prompts.length,
    decided: prompts.length - gaps.length,
    gaps: gaps.length,
    decisions: decisions.length,
    picked: by((r) => r.sk),
    byJev: by((r) => r.d?.decidedBy === 'jev'),
    byBackup: by((r) => String(r.d?.decidedBy ?? '').startsWith('backup')),
    unmatched: unmatched.length,
    lastPrompt: last(prompts),
    lastDecision: last(decisions),
  }
}

function checkDeciding(cur, prev, days) {
  const a = decidingStats(cur), b = decidingStats(prev)
  const base = {
    id: 'jev-deciding',
    title: 'Jev is deciding',
    target: `Higher is better. Attention if more than ${TARGETS.maxGaps} prompts get no logged decision within 2 min, or the last decision is more than 10 min behind the last prompt.`,
    n: a.prompts,
  }
  if (!a.prompts) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'No prompts in the window.', compare: '', lines: [] }
  const quietBy = a.lastDecision === null ? null : a.lastPrompt - a.lastDecision
  const quiet = a.lastDecision === null || quietBy > TARGETS.quietMs
  const rate = a.decided / a.prompts
  const prevRate = b.prompts ? b.decided / b.prompts : null
  const lines = [
    `${plural(a.gaps, 'gap')}: prompts with no logged decision within 2 min`,
    `Last prompt ${fmtTime(a.lastPrompt)} · last decision ${a.lastDecision === null ? 'none in the window' : fmtTime(a.lastDecision)}${quiet && a.lastDecision !== null ? ` (${ago(quietBy)} behind)` : ''}`,
  ]
  if (a.decisions) lines.push(`${n0(a.picked)} of ${plural(a.decisions, 'Jev decision')} picked a skill · ${n0(a.byJev)} decided by Jev, ${n0(a.byBackup)} by the backup model, ${n0(a.decisions - a.byJev - a.byBackup)} by the built-in picker`)
  if (a.unmatched) lines.push(`${plural(a.unmatched, 'Jev suggestion')} seen in transcripts with no logged decision: Jev ran, the decision log did not record it`)
  return {
    ...base,
    state: a.gaps > TARGETS.maxGaps || quiet ? 'attention' : 'pass',
    figure: `${n0(a.decided)} of ${plural(a.prompts, 'prompt')}`,
    population: 'Prompts you sent in the window that got a logged Jev decision within 2 min.',
    compare: prevRate === null ? `Previous ${span(days)}: not tracked (no prompts)` : `${pct(rate)} now · previous ${span(days)} ${pct(prevRate)} of ${plural(b.prompts, 'prompt')} · ${pp(rate, prevRate)}`,
    value: rate,
    lines,
    stats: a,
  }
}

// ---------- check 2: Jev is picking right ----------

const SIGNAL = {
  'typed-after': 'you typed a skill next',
  'claude-loaded-other': 'Claude loaded another skill',
  'picked-then-corrected': 'you pushed back after its pick',
  'dropped-decisive': 'a confident pick was dropped',
}

function checkPicking(cur, prev, days) {
  const dec = cur.filter((r) => r.k === 'jev.decision').length
  const misses = cur.filter((r) => r.k === 'jev.miss').sort((x, y) => y.t - x.t)
  const pdec = prev.filter((r) => r.k === 'jev.decision').length
  const pmiss = prev.filter((r) => r.k === 'jev.miss').length
  const base = { id: 'jev-picking', title: 'Jev is picking right', target: `Lower is better; target ≤ ${pct(TARGETS.missRate)} of decisions flagged as misroutes.`, n: dec }
  if (!dec) return { ...base, state: 'untracked', figure: 'Not tracked', population: `No Jev decisions logged in the window${misses.length ? ` (${plural(misses.length, 'flagged miss', 'flagged misses')} anyway)` : ''}.`, compare: '', lines: [] }
  const rate = misses.length / dec
  const prate = pdec ? pmiss / pdec : null
  return {
    ...base,
    state: dec < TARGETS.minN ? 'thin' : rate > TARGETS.missRate ? 'attention' : 'pass',
    figure: `${pct(rate)} misrouted`,
    population: `${n0(misses.length)} flagged misroute${misses.length === 1 ? '' : 's'} (jev.miss) of ${plural(dec, 'Jev decision')}.`,
    compare: prate === null ? `Previous ${span(days)}: not tracked (no decisions)` : `Previous ${span(days)}: ${pct(prate)} (${n0(pmiss)} of ${n0(pdec)}) · ${pp(rate, prate)}`,
    value: rate,
    lines: misses.slice(0, 3).map((m) => `${fmtTime(m.t)} · ${SIGNAL[m.d?.signal] ?? m.d?.signal ?? 'flagged'} · Jev picked ${m.d?.jevPick ?? 'nothing'} · expected ${m.sk ?? 'not known'}`),
  }
}

// ---------- check 3: Skills load ----------

function skillStats(rows) {
  const calls = rows.filter((r) => r.k === 'tool' && r.tl === 'Skill' && r.ok !== null && r.ok !== undefined)
  return { calls: calls.length, refused: calls.filter((r) => r.ok === false) }
}

function checkSkills(cur, prev, days) {
  const a = skillStats(cur), b = skillStats(prev)
  const base = { id: 'skills', title: 'Skills load', target: 'Lower is better; target: no refusals. One refusal needs attention, whatever the count.', n: a.calls }
  if (!a.calls) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'Claude made no Skill tool calls in the window.', compare: '', lines: [] }
  const counts = new Map()
  for (const r of a.refused) counts.set(r.sk ?? 'unnamed', (counts.get(r.sk ?? 'unnamed') ?? 0) + 1)
  const rate = a.refused.length / a.calls
  const prate = b.calls ? b.refused.length / b.calls : null
  const lines = []
  if (counts.size) {
    lines.push('Refused: ' + [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(', '))
    lines.push('A refusal means Claude was blocked from loading the skill: skillOverrides, or a disabled bundled skill.')
  }
  return {
    ...base,
    state: a.refused.length ? 'attention' : 'pass',
    figure: `${n0(a.refused.length)} of ${n0(a.calls)} refused`,
    population: 'Skill tool calls Claude made in the window.',
    compare: prate === null ? `Previous ${span(days)}: not tracked (no Skill calls)` : `Previous ${span(days)}: ${n0(b.refused.length)} of ${n0(b.calls)} refused (${pct(prate)}) · ${pp(rate, prate)}`,
    value: rate,
    lines,
  }
}

// ---------- check 4: Answers land ----------

export function landStats(turns) {
  const known = turns.filter((t) => t.land !== null && t.land !== undefined)
  const landed = known.filter((t) => t.land).length
  return { turns: turns.length, known: known.length, landed, open: turns.length - known.length, rate: known.length ? landed / known.length : null }
}

function checkLanding(tcur, tprev, days) {
  const a = landStats(tcur), b = landStats(tprev)
  const base = { id: 'landing', title: 'Answers land', target: `Higher is better; target ≥ ${pct(TARGETS.landRate)}. Landed = your next message did not push back, read from its wording (a heuristic).`, n: a.known }
  if (!a.known) return { ...base, state: 'untracked', figure: 'Not tracked', population: a.turns ? `No turn has an outcome yet (${plural(a.open, 'turn')} still open).` : 'No turns in the window.', compare: '', lines: [] }
  return {
    ...base,
    state: a.known < TARGETS.minN ? 'thin' : a.rate < TARGETS.landRate ? 'attention' : 'pass',
    figure: `${pct(a.rate)} landed`,
    population: `${n0(a.landed)} of ${plural(a.known, 'turn')} with an outcome; ${n0(a.open)} still open (a session's last turn).`,
    compare: b.rate === null ? `Previous ${span(days)}: not tracked (no turns with an outcome)` : `Previous ${span(days)}: ${pct(b.rate)} of ${n0(b.known)} · ${pp(a.rate, b.rate)}`,
    value: a.rate,
    lines: [],
  }
}

// ---------- check 5: Model router ----------

function routerStats(rows) {
  const calls = rows.filter((r) => r.k === 'router.call')
  const errors = calls.filter((r) => r.ok === false).length
  const fallbacks = calls.filter((r) => r.ok !== false && r.d?.fallbackFrom).length
  return { calls, n: calls.length, errors, fallbacks, rate: calls.length ? (errors + fallbacks) / calls.length : null }
}

function checkRouter(cur, prev, days) {
  const a = routerStats(cur), b = routerStats(prev)
  const base = { id: 'router', title: 'Model router', target: `Lower is better; target ≤ ${pct(TARGETS.routerRate)} of routed calls erroring or served by a fallback model.`, n: a.n }
  if (!a.n) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'No routed calls in the window (n = 0).', compare: b.n ? `Previous ${span(days)}: ${plural(b.n, 'call')}` : '', lines: [] }
  const last = a.calls.reduce((x, y) => (y.t > x.t ? y : x))
  const status = last.ok === false ? `error: ${String(last.d?.error ?? 'unknown').slice(0, 60)}` : last.d?.fallbackFrom ? 'fallback' : 'ok'
  return {
    ...base,
    state: a.n < TARGETS.minN ? 'thin' : a.rate > TARGETS.routerRate ? 'attention' : 'pass',
    figure: `${pct(a.rate)} errors or fallbacks`,
    population: `${plural(a.errors, "error")} + ${plural(a.fallbacks, "fallback")} of ${plural(a.n, 'routed call')} (n = ${n0(a.n)}).`,
    compare: b.rate === null ? `Previous ${span(days)}: not tracked (no routed calls)` : `Previous ${span(days)}: ${pct(b.rate)} of ${n0(b.n)} · ${pp(a.rate, b.rate)}`,
    value: a.rate,
    lines: [`Last call ${fmtTime(last.t)}: ${last.d?.category ?? 'task'} → ${last.m ?? 'unknown model'} (${status})`],
  }
}

// ---------- check 6: OpenRouter credit, and the key's spend reconciled ----------

/** Which usage field of the key answers a range: OpenRouter reports UTC day, week (from Monday) and month. */
export function periodFor(days) {
  return days <= 1 ? 'daily' : days <= 7 ? 'weekly' : 'monthly'
}

export function periodStart(t, period) {
  const d = new Date(t)
  d.setUTCHours(0, 0, 0, 0)
  if (period === 'weekly') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  if (period === 'monthly') d.setUTCDate(1)
  return d.getTime()
}

const PERIOD_LABEL = { daily: 'UTC day', weekly: 'UTC week to date', monthly: 'UTC month to date' }
const PREV_LABEL = { daily: 'previous UTC day', weekly: 'previous UTC week', monthly: 'previous UTC month' }

/**
 * The key's spend for its period, split into what the logs can explain:
 *   key usage = routed calls (cost logged) + Jev decisions (cost not logged) + unattributed.
 * Jev's decision calls go through OpenRouter too but log no cost, so their
 * share is inside `unattributed` and printed as not tracked. All hosts.
 */
export function reconcile(keyRow, rows, period) {
  const d = keyRow?.d ?? {}
  const usage = d[`usage_${period}`]
  const to = keyRow.t
  const from = periodStart(to, period)
  const inPeriod = rows.filter((r) => r.t >= from && r.t <= to)
  const routedCalls = inPeriod.filter((r) => r.k === 'router.call')
  const routed = routedCalls.reduce((a, r) => a + (Number.isFinite(r.c) ? r.c : 0), 0)
  const decisions = inPeriod.filter((r) => r.k === 'jev.decision').length
  const known = Number.isFinite(usage)
  const unattributed = known ? usage - routed : null
  return { period, from, to, usage: known ? usage : null, routed, routedCalls: routedCalls.length, decisions, unattributed, closes: known ? unattributed >= -1e-9 : null }
}

function checkCredit(rows, end, days) {
  const keys = rows.filter((r) => r.k === 'openrouter.key' && r.t <= end).sort((a, b) => a.t - b.t)
  const last = keys[keys.length - 1]
  const base = { id: 'openrouter', title: 'OpenRouter credit', target: `Attention under ${pct(TARGETS.creditFloor)} of credit or of the key's limit left.`, account: true }
  if (!last) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'The collector has not read the OpenRouter key (it needs OPENROUTER_API_KEY). Account-wide, not filtered.', compare: '', lines: [] }
  if (end - last.t > TARGETS.staleMs) return { ...base, state: 'untracked', figure: 'Not tracked', population: `The last key check was ${fmtTime(last.t)}, more than 26 h before this build; its figures are not shown as current. Account-wide, not filtered.`, compare: '', lines: [] }
  const d = last.d ?? {}
  const credits = Number.isFinite(d.total_credits) && Number.isFinite(d.total_usage) ? d.total_credits - d.total_usage : null
  const creditShare = credits !== null && d.total_credits > 0 ? credits / d.total_credits : null
  const limitShare = Number.isFinite(d.limit) && d.limit > 0 && Number.isFinite(d.limit_remaining) ? d.limit_remaining / d.limit : null
  const low = (creditShare !== null && creditShare < TARGETS.creditFloor) || (limitShare !== null && limitShare < TARGETS.creditFloor)
  const earlier = keys.filter((r) => r.t <= last.t - days * DAY).pop()
  const earlierCredit = earlier && Number.isFinite(earlier.d?.total_credits) && Number.isFinite(earlier.d?.total_usage) ? earlier.d.total_credits - earlier.d.total_usage : null
  const period = periodFor(days)
  const rec = reconcile(last, rows.filter((r) => r.t <= end), period)
  const prevKey = keys.filter((r) => r.t < rec.from && r.t >= periodStart(rec.from - 1, period)).pop()
  const prevUsage = prevKey ? prevKey.d?.[`usage_${period}`] : null
  const lines = [
    `As of ${fmtTime(last.t)} · account-wide: every host, not filtered by host or range`,
    Number.isFinite(d.limit) ? `Key limit: ${usd(d.limit_remaining)} left of ${usd(d.limit)}${d.limit_reset ? ` (resets ${d.limit_reset})` : ''}${limitShare !== null ? ` · ${pct(limitShare)}` : ''}` : 'No spending limit on this key',
    `Spend on this key, ${PERIOD_LABEL[period]} (${fmtDate(rec.from)} to ${fmtTime(rec.to)}): ${usd(rec.usage)}, as OpenRouter reports it` +
      (Number.isFinite(prevUsage) ? ` · ${PREV_LABEL[period]} ${usd(prevUsage)} (as of ${fmtTime(prevKey.t)})` : ` · ${PREV_LABEL[period]}: not tracked`),
  ]
  if (rec.usage !== null) {
    lines.push(`= routed calls ${usd(rec.routed)} (${plural(rec.routedCalls, 'call')}, cost logged) + Jev decisions: ${n0(rec.decisions)}, cost not logged (not tracked) + unattributed ${usd(rec.unattributed)}`)
    if (!rec.closes) lines.push(`Does not close: logged routed cost is ${usd(-rec.unattributed)} more than the key reports. Trust the key's figure.`)
  }
  return {
    ...base,
    state: low ? 'attention' : 'pass',
    figure: credits === null ? `${usd(d.limit_remaining)} key limit left` : `${usd(credits)} credit left`,
    population: credits === null ? 'The credits endpoint did not answer; key limit only.' : `Of ${usd(d.total_credits)} bought (${pct(creditShare)} left).`,
    compare: earlierCredit === null ? `${span(days)} earlier: no key check that far back` : `${span(days)} earlier: ${usd(earlierCredit)} left (${fmtTime(earlier.t)})`,
    value: creditShare ?? limitShare,
    lines,
    reconciliation: rec,
  }
}

// ---------- check 7: Reporting ----------

function checkReporting(all, cur, prev, host, end, days) {
  const lastBy = (list) => {
    const m = new Map()
    for (const r of list) {
      const e = m.get(r.h) ?? { n: 0, last: 0 }
      e.n++
      e.last = Math.max(e.last, r.t)
      m.set(r.h, e)
    }
    return m
  }
  const now = lastBy(cur), before = lastBy(prev)
  const ever = lastBy(all.filter((r) => r.t <= end && hostMatch(r.h, host)))
  const lines = [...now.entries()].sort((a, b) => b[1].last - a[1].last).map(([h, e]) => `${hostLabel(h)}: ${plural(e.n, 'event')}, last ${fmtTime(e.last)}`)
  const quiet = [...before.keys()].filter((h) => !now.has(h))
  for (const h of quiet) lines.push(`${hostLabel(h)}: nothing in this window; last event ${fmtTime(ever.get(h).last)}`)
  const hosts = [...ever.keys()]
  if (host !== 'cloud' && !hosts.some((h) => String(h).startsWith('local'))) lines.push('Local: not tracked. No local machine has reported.')
  if (host !== 'local' && !hosts.includes('cloud')) lines.push('Cloud: not tracked. No cloud session has reported.')
  const base = { id: 'reporting', title: 'Reporting', target: 'Every host that reported in the previous window reports in this one.', n: now.size }
  if (!now.size && !before.size) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'No host reported any event in the window.', compare: before.size ? `Previous ${span(days)}: ${plural(before.size, 'host')}` : '', lines }
  return {
    ...base,
    state: quiet.length ? 'attention' : 'pass',
    figure: now.size ? `${plural(now.size, 'host')} reported` : 'No host reported',
    population: now.size ? 'Hosts with any event in the window.' : 'No host reported any event in this window, though some did in the one before: collection or shipping stopped.',
    compare: `Previous ${span(days)}: ${before.size ? plural(before.size, 'host') : 'none'}`,
    value: now.size,
    lines,
  }
}

// ---------- the verdict ----------

export function verdictOf(checks) {
  const count = (s) => checks.filter((c) => c.state === s).length
  const att = count('attention'), un = count('untracked'), thin = count('thin'), ok = count('pass')
  const tail = [un ? `${n0(un)} not tracked` : '', thin ? `${n0(thin)} too few to judge` : ''].filter(Boolean).join(' · ')
  const N = checks.length
  if (att) return { state: 'attention', text: `${n0(att)} of ${n0(N)} checks need attention`, tail }
  if (!ok) return { state: 'untracked', text: `None of ${n0(N)} checks can be judged`, tail }
  if (un || thin) return { state: 'untracked', text: `${n0(ok)} of ${n0(N)} checks passing`, tail }
  return { state: 'pass', text: `All ${n0(N)} checks passing`, tail: '' }
}

/** Every check for one window and host filter, measured back from the build time. */
export function runChecks({ rows, turns = [], generatedAt, days, host = 'all' }) {
  const end = typeof generatedAt === 'number' ? generatedAt : Date.parse(generatedAt)
  const w = windowOf(end, days)
  const scoped = rows.filter((r) => hostMatch(r.h, host))
  const cur = scoped.filter((r) => inside(r.t, w.from, w.to))
  const prev = scoped.filter((r) => inside(r.t, w.prevFrom, w.prevTo))
  const st = turns.filter((t) => hostMatch(t.h, host))
  const tcur = st.filter((t) => inside(t.t, w.from, w.to))
  const tprev = st.filter((t) => inside(t.t, w.prevFrom, w.prevTo))
  const checks = [
    checkDeciding(cur, prev, days),
    checkPicking(cur, prev, days),
    checkSkills(cur, prev, days),
    checkLanding(tcur, tprev, days),
    checkRouter(cur, prev, days),
    checkCredit(rows, end, days),
    checkReporting(rows, cur, prev, host, end, days),
  ]
  return { window: w, checks, verdict: verdictOf(checks), cur, prev, tcur, tprev }
}

// ---------- the sections under the checks ----------

const agentLabel = (a) => (!a || a === 'main' ? 'Main conversation' : String(a).startsWith('subagent:') ? `Subagent: ${a.slice(9)}` : a)

/** Claude API-equivalent cost by main conversation and each subagent type, this window and the one before. */
export function workSplit(cur, prev) {
  const add = (m, r, key) => {
    const label = agentLabel(r.a)
    const e = m.get(label) ?? { who: label, n: 0, c: 0, unpriced: 0, pn: 0, pc: 0 }
    if (key === 'cur') {
      e.n++
      if (Number.isFinite(r.c)) e.c += r.c
      else e.unpriced++
    } else {
      e.pn++
      if (Number.isFinite(r.c)) e.pc += r.c
    }
    m.set(label, e)
  }
  const m = new Map()
  for (const r of cur) if (r.k === 'api') add(m, r, 'cur')
  for (const r of prev) if (r.k === 'api') add(m, r, 'prev')
  return [...m.values()].sort((a, b) => b.c - a.c || b.pc - a.pc)
}

/** Tools (not Skill: check 3 covers it) failing above target, this window, with the previous window's rate. */
export function failingTools(cur, prev) {
  const stats = (rows) => {
    const m = new Map()
    for (const r of rows) {
      if (r.k !== 'tool' || r.tl === 'Skill' || r.ok === null || r.ok === undefined) continue
      const e = m.get(r.tl) ?? { n: 0, bad: 0, mc: r.mc }
      e.n++
      if (r.ok === false) e.bad++
      m.set(r.tl, e)
    }
    return m
  }
  const a = stats(cur), b = stats(prev)
  return [...a.entries()]
    .map(([tool, e]) => ({ tool, label: e.mc ? `${e.mc.replace(/_/g, ' ')} · ${tool.split('__').slice(2).join('__')}` : tool, n: e.n, bad: e.bad, rate: e.bad / e.n, prev: b.get(tool) ?? null, thin: e.n < TARGETS.minN }))
    .filter((x) => x.rate > TARGETS.toolFailRate)
    .sort((x, y) => Number(x.thin) - Number(y.thin) || y.bad - x.bad)
}

/** Refused skills, with how often Jev picked each (logged decisions plus transcript suggestions no decision matched). */
export function refusedSkills(cur) {
  const decisions = cur.filter((r) => r.k === 'jev.decision')
  const unmatched = cur.filter((r) => r.k === 'jev.suggested' && !near(decisions, r))
  const m = new Map()
  for (const r of cur) {
    if (r.k !== 'tool' || r.tl !== 'Skill' || r.ok === null || r.ok === undefined) continue
    const e = m.get(r.sk) ?? { skill: r.sk ?? 'unnamed', calls: 0, refused: 0, last: 0 }
    e.calls++
    if (r.ok === false) {
      e.refused++
      e.last = Math.max(e.last, r.t)
    }
    m.set(r.sk, e)
  }
  return [...m.values()]
    .filter((e) => e.refused)
    .map((e) => ({ ...e, jevPicked: decisions.filter((r) => r.sk === e.skill).length + unmatched.filter((r) => r.sk === e.skill).length }))
    .sort((a, b) => b.refused - a.refused || b.last - a.last)
}

/** Buckets ending at the build time: 4 h for a day, days up to a month, weeks beyond. */
export function trendBuckets(turns, w) {
  const size = w.days <= 1 ? 4 * 3600000 : w.days <= 30 ? DAY : 7 * DAY
  const k = Math.round((w.to - w.from) / size)
  const buckets = []
  for (let i = 0; i < k; i++) {
    const to = w.to - (k - 1 - i) * size, from = to - size
    const ts = turns.filter((t) => inside(t.t, from, to))
    const s = landStats(ts)
    buckets.push({ from, to, n: ts.length, known: s.known, landed: s.landed, rate: s.rate, cost: median(ts.map((t) => t.c)) })
  }
  return { size, buckets, withData: buckets.filter((b) => b.n > 0).length }
}
