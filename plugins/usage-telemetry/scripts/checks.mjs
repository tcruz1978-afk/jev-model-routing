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
 * Check states: 'pass' and 'attention' (only for a check with an
 * owner-approved target), 'neutral' (a check with no approved target: facts
 * only, never coloured), 'untracked' (no data: never green), 'thin' (a rate
 * over fewer than TARGETS.minN: too few to judge) and 'partial' (the data it
 * rests on stopped early).
 */

export const DAY = 86400000

/**
 * The owner's targets (approved 2026-09-26): the only rules that colour
 * anything. A check without an approved target would render 'neutral'.
 */
export const TARGETS = {
  decideRate: 0.95, // your prompts with a logged Jev decision within matchMs, at least
  missRate: 0.1, // flagged misroutes over Jev decisions, at most
  maxRefusals: 0, // Skill tool refusals
  landRate: 0.8, // turns that landed over turns with an outcome, at least
  routerRate: 0.1, // routed calls that errored or fell back, at most
  creditFloor: 0.1, // credit or key limit left: attention under this
  toolFailRate: 0.1, // per tool with n >= minN, at most
  // Reporting: every host that reported in the previous window reports in this one.
  minN: 10, // below this a rate is "too few to judge"
  staleMs: 26 * 3600000, // a build older than this is out of date
  matchMs: 2 * 60000, // a decision within this of a prompt belongs to it (a matching rule, not a target)
}

/** The approved targets in words, for the page's note. */
export const TARGETS_APPROVED = '2026-09-26'
export const TARGET_NOTES = [
  'Jev picks a skill for at least 95 in 100 of your requests, within 2 minutes',
  "No more than 1 in 10 of Jev's picks is wrong",
  'Claude is never blocked from a skill',
  'At least 8 in 10 of your requests land',
  "No more than 1 in 10 of the model router's answers fail or come from a backup model",
  'A warning when less than 10% of your OpenRouter credit or spending cap is left',
  'No tool fails more than 1 in 10 times (judged from 10 uses)',
  'Every machine that reported in the period before reports again',
]

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
  return m < 1 ? 'just now' : m < 180 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`
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

export function decidingStats(rows) {
  const prompts = rows.filter(isPrompt)
  const decisions = rows.filter((r) => r.k === 'jev.decision')
  const suggested = rows.filter((r) => r.k === 'jev.suggested')
  const gaps = prompts.filter((p) => !near(decisions, p))
  const unmatched = suggested.filter((s) => !near(decisions, s))
  const last = (list) => (list.length ? Math.max(...list.map((r) => r.t)) : null)
  const by = (f) => decisions.filter(f).length
  const lastDecision = last(decisions)
  // Prompts after the last logged decision (beyond the 2-min match): the log went quiet.
  const afterLast = prompts.filter((p) => lastDecision === null || p.t > lastDecision + TARGETS.matchMs).length
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
    lastDecision,
    afterLast,
    quiet: afterLast > 0,
  }
}

/**
 * What the previous window can say, given when collection began: a previous
 * window that starts before the first event is not tracked, never "none".
 */
export function prevNote(ctx) {
  const { w, since, days } = ctx
  if (since === null || since === undefined || !Number.isFinite(since)) return `Previous ${span(days)}: not tracked (no data)`
  return w.prevFrom < since ? `Previous ${span(days)}: not tracked (collection began ${fmtTime(since)})` : null
}
const prevOk = (ctx) => prevNote(ctx) === null

// ---------- check 1: Jev is deciding (no target set) ----------

function checkDeciding(cur, prev, ctx) {
  const a = decidingStats(cur), b = decidingStats(prev)
  const base = { id: 'jev-deciding', title: 'Jev is deciding', targeted: true, target: `Higher is better; target ≥ ${pct(TARGETS.decideRate)} of your prompts get a logged decision within 2 min.`, n: a.prompts }
  if (!a.prompts) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'No prompts in the window.', compare: '', lines: [] }
  const rate = a.decided / a.prompts
  const prevRate = b.prompts ? b.decided / b.prompts : null
  const behind = a.lastDecision === null ? null : a.lastPrompt - a.lastDecision
  const lines = [
    `${n0(a.gaps)} of ${plural(a.prompts, 'prompt')} had no logged decision within 2 min`,
    `Last prompt ${fmtTime(a.lastPrompt)} · last decision ${a.lastDecision === null ? 'none in the window' : fmtTime(a.lastDecision)}${behind > TARGETS.matchMs ? ` (${ago(behind)} behind)` : ''}`,
  ]
  if (a.quiet) lines.push(`${plural(a.afterLast, 'prompt')} came after the last logged decision: the decision log has gone quiet`)
  if (a.decisions) lines.push(`${n0(a.picked)} of ${plural(a.decisions, 'Jev decision')} picked a skill · ${n0(a.byJev)} decided by Jev, ${n0(a.byBackup)} by the backup model, ${n0(a.decisions - a.byJev - a.byBackup)} by the built-in picker`)
  if (a.unmatched) lines.push(`${plural(a.unmatched, 'Jev suggestion')} seen in transcripts with no logged decision: Jev ran, the decision log did not record it`)
  return {
    ...base,
    state: a.prompts < TARGETS.minN ? 'thin' : rate < TARGETS.decideRate ? 'attention' : 'pass',
    figure: `${pct(rate)} decided`,
    population: `${n0(a.decided)} of ${plural(a.prompts, 'prompt')} you sent in the window got a logged Jev decision within 2 min.`,
    compare: prevNote(ctx) ?? (prevRate === null ? `Previous ${span(ctx.days)}: not tracked (no prompts)` : `Previous ${span(ctx.days)}: ${pct(prevRate)} of ${plural(b.prompts, 'prompt')} · ${pp(rate, prevRate)}`),
    value: rate,
    lines,
    stats: a,
  }
}

// ---------- check 2: Jev is picking right (target ≤ 10%) ----------

const SIGNAL = {
  'typed-after': 'you typed a skill next',
  'claude-loaded-other': 'Claude loaded another skill',
  'picked-then-corrected': 'you pushed back after its pick',
  'dropped-decisive': 'a confident pick was dropped',
}

function checkPicking(cur, prev, ctx, deciding) {
  const decs = cur.filter((r) => r.k === 'jev.decision')
  const dec = decs.length
  const misses = cur.filter((r) => r.k === 'jev.miss').sort((x, y) => y.t - x.t)
  const pdec = prev.filter((r) => r.k === 'jev.decision').length
  const pmiss = prev.filter((r) => r.k === 'jev.miss').length
  const base = { id: 'jev-picking', title: 'Jev is picking right', targeted: true, target: `Lower is better; target ≤ ${pct(TARGETS.missRate)} of decisions flagged as misroutes.`, n: dec }
  if (!dec) return { ...base, state: 'untracked', figure: 'Not tracked', population: `No Jev decisions logged in the window${misses.length ? ` (${plural(misses.length, 'flagged miss', 'flagged misses')} anyway)` : ''}.`, compare: '', lines: [] }
  const rate = misses.length / dec
  const prate = pdec ? pmiss / pdec : null
  const first = Math.min(...decs.map((r) => r.t)), last = Math.max(...decs.map((r) => r.t))
  const lines = [`Decisions cover ${fmtTime(first)} to ${fmtTime(last)} (decisions up to ${fmtTime(last)})`]
  if (deciding?.quiet) lines.push(`Partial: ${plural(deciding.afterLast, 'prompt')} came after the last logged decision, so their picks are not judged`)
  lines.push(...misses.slice(0, 3).map((m) => `${fmtTime(m.t)} · ${SIGNAL[m.d?.signal] ?? m.d?.signal ?? 'flagged'} · Jev picked ${m.d?.jevPick ?? 'nothing'} · expected ${m.sk ?? 'not known'}`))
  return {
    ...base,
    state: deciding?.quiet ? 'partial' : dec < TARGETS.minN ? 'thin' : rate > TARGETS.missRate ? 'attention' : 'pass',
    figure: `${pct(rate)} misrouted`,
    population: `${n0(misses.length)} flagged misroute${misses.length === 1 ? '' : 's'} (jev.miss) of ${plural(dec, 'Jev decision')} logged: every decision, including ones not tied to a prompt you sent.`,
    compare: prevNote(ctx) ?? (prate === null ? `Previous ${span(ctx.days)}: not tracked (no decisions)` : `Previous ${span(ctx.days)}: ${pct(prate)} (${n0(pmiss)} of ${n0(pdec)}) · ${pp(rate, prate)}`),
    value: rate,
    lines,
  }
}

// ---------- check 3: Skills load (target: no refusals) ----------

function skillStats(rows) {
  const calls = rows.filter((r) => r.k === 'tool' && r.tl === 'Skill' && r.ok !== null && r.ok !== undefined)
  return { calls: calls.length, refused: calls.filter((r) => r.ok === false) }
}

function checkSkills(cur, prev, ctx) {
  const a = skillStats(cur), b = skillStats(prev)
  const base = { id: 'skills', title: 'Skills load', targeted: true, target: 'Lower is better; target: no refusals. One refusal needs attention, whatever the count.', n: a.calls }
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
    state: a.refused.length > TARGETS.maxRefusals ? 'attention' : 'pass',
    figure: `${n0(a.refused.length)} of ${n0(a.calls)} refused`,
    population: 'Skill tool calls Claude made in the window.',
    compare: prevNote(ctx) ?? (prate === null ? `Previous ${span(ctx.days)}: not tracked (no Skill calls)` : `Previous ${span(ctx.days)}: ${n0(b.refused.length)} of ${n0(b.calls)} refused (${pct(prate)}) · ${pp(rate, prate)}`),
    value: rate,
    lines,
  }
}

// ---------- check 4: Answers land (target ≥ 80%) ----------

export function landStats(turns) {
  const known = turns.filter((t) => t.land !== null && t.land !== undefined)
  const landed = known.filter((t) => t.land).length
  return { turns: turns.length, known: known.length, landed, open: turns.length - known.length, rate: known.length ? landed / known.length : null }
}

function checkLanding(tcur, tprev, ctx) {
  const a = landStats(tcur), b = landStats(tprev)
  const base = { id: 'landing', title: 'Answers land', targeted: true, target: `Higher is better; target ≥ ${pct(TARGETS.landRate)}. Landed = your next message did not push back, read from its wording (a heuristic).`, n: a.known }
  if (!a.known) return { ...base, state: 'untracked', figure: 'Not tracked', population: a.turns ? `No turn has an outcome yet (${plural(a.open, 'turn')} still open).` : 'No turns in the window.', compare: '', lines: [] }
  return {
    ...base,
    state: a.known < TARGETS.minN ? 'thin' : a.rate < TARGETS.landRate ? 'attention' : 'pass',
    figure: `${pct(a.rate)} landed`,
    population: `${n0(a.landed)} of ${plural(a.known, 'turn')} with an outcome; ${n0(a.open)} still open (a session's last turn).`,
    compare: prevNote(ctx) ?? (b.rate === null ? `Previous ${span(ctx.days)}: not tracked (no turns with an outcome)` : `Previous ${span(ctx.days)}: ${pct(b.rate)} of ${n0(b.known)} · ${pp(a.rate, b.rate)}`),
    value: a.rate,
    lines: [],
  }
}

// ---------- check 5: Model router (no target set) ----------

function routerStats(rows) {
  const calls = rows.filter((r) => r.k === 'router.call')
  const errors = calls.filter((r) => r.ok === false).length
  const fallbacks = calls.filter((r) => r.ok !== false && r.d?.fallbackFrom).length
  return { calls, n: calls.length, errors, fallbacks, rate: calls.length ? (errors + fallbacks) / calls.length : null }
}

function checkRouter(cur, prev, ctx) {
  const a = routerStats(cur), b = routerStats(prev)
  const base = { id: 'router', title: 'Model router', targeted: true, target: `Lower is better; target ≤ ${pct(TARGETS.routerRate)} of routed calls erroring or served by a fallback model.`, n: a.n }
  if (!a.n) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'No routed calls in the window (n = 0).', compare: prevNote(ctx) ?? (b.n ? `Previous ${span(ctx.days)}: ${plural(b.n, 'call')}` : ''), lines: [] }
  const last = a.calls.reduce((x, y) => (y.t > x.t ? y : x))
  const status = last.ok === false ? `error: ${String(last.d?.error ?? 'unknown').slice(0, 60)}` : last.d?.fallbackFrom ? 'fallback' : 'ok'
  return {
    ...base,
    state: a.n < TARGETS.minN ? 'thin' : a.rate > TARGETS.routerRate ? 'attention' : 'pass',
    figure: `${pct(a.rate)} errors or fallbacks`,
    population: `${plural(a.errors, 'error')} + ${plural(a.fallbacks, 'fallback')} of ${plural(a.n, 'routed call')} (n = ${n0(a.n)}).`,
    compare: prevNote(ctx) ?? (b.rate === null ? `Previous ${span(ctx.days)}: not tracked (no routed calls)` : `Previous ${span(ctx.days)}: ${pct(b.rate)} of ${n0(b.n)} · ${pp(a.rate, b.rate)}`),
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
 * The key's spend for its period, in dollars the logs can explain:
 *   key usage = routed calls (cost logged) + unattributed.
 * Jev's decision calls go through OpenRouter too but log no cost, so they sit
 * inside `unattributed`; they are counted, never priced. A period that began
 * before collection did (`since`) cannot be reconciled.
 */
export function reconcile(keyRow, rows, period, since = null) {
  const d = keyRow?.d ?? {}
  const usage = d[`usage_${period}`]
  const to = keyRow.t
  const from = periodStart(to, period)
  const inPeriod = rows.filter((r) => r.t >= from && r.t <= to)
  const routedCalls = inPeriod.filter((r) => r.k === 'router.call')
  const routed = routedCalls.reduce((a, r) => a + (Number.isFinite(r.c) ? r.c : 0), 0)
  const decisions = inPeriod.filter((r) => r.k === 'jev.decision').length
  const known = Number.isFinite(usage)
  const reconcilable = known && !(Number.isFinite(since) && from < since)
  const unattributed = reconcilable ? usage - routed : null
  return { period, from, to, usage: known ? usage : null, routed, routedCalls: routedCalls.length, decisions, unattributed, reconcilable, closes: reconcilable ? unattributed >= -1e-9 : null }
}

function checkCredit(rows, end, ctx) {
  const days = ctx.days
  const keys = rows.filter((r) => r.k === 'openrouter.key' && r.t <= end).sort((a, b) => a.t - b.t)
  const last = keys[keys.length - 1]
  const base = { id: 'openrouter', title: 'OpenRouter credit', targeted: true, target: `Warns under ${pct(TARGETS.creditFloor)} of credit or of the key's limit left.`, account: true }
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
  const rec = reconcile(last, rows.filter((r) => r.t <= end), period, ctx.since)
  const prevKey = keys.filter((r) => r.t < rec.from && r.t >= periodStart(rec.from - 1, period)).pop()
  const prevUsage = prevKey ? prevKey.d?.[`usage_${period}`] : null
  const lines = [
    `As of ${fmtTime(last.t)} · account-wide: every host, not filtered by host or range`,
    Number.isFinite(d.limit) ? `Key limit: ${usd(d.limit_remaining)} left of ${usd(d.limit)}${d.limit_reset ? ` (resets ${d.limit_reset})` : ''}${limitShare !== null ? ` · ${pct(limitShare)}` : ''}` : 'No spending limit on this key',
    `Spend on this key, ${PERIOD_LABEL[period]} (${fmtDate(rec.from)} to ${fmtTime(rec.to)}): ${usd(rec.usage)}, as OpenRouter reports it` +
      (Number.isFinite(prevUsage) ? ` · ${PREV_LABEL[period]} ${usd(prevUsage)} (as of ${fmtTime(prevKey.t)})` : ` · ${PREV_LABEL[period]}: not tracked`),
  ]
  if (rec.usage !== null && !rec.reconcilable) {
    lines.push(`Not reconcilable: the key's ${PERIOD_LABEL[period]} began ${fmtTime(rec.from)}, before collection began ${fmtTime(ctx.since)}.`)
  } else if (rec.usage !== null) {
    lines.push(`${usd(rec.usage)} = routed calls ${usd(rec.routed)} (${plural(rec.routedCalls, 'call')}, cost logged) + unattributed ${usd(rec.unattributed)}`)
    lines.push(`Jev's decision calls (${n0(rec.decisions)} this period) also go through OpenRouter; their cost is not logged, so it is inside unattributed.`)
    if (!rec.closes) lines.push(`Does not close: logged routed cost is ${usd(-rec.unattributed)} more than the key reports. Trust the key's figure.`)
  }
  return {
    ...base,
    state: low ? 'attention' : 'pass',
    figure: credits === null ? `${usd(d.limit_remaining)} key limit left` : `${usd(credits)} credit left`,
    population: credits === null ? 'The credits endpoint did not answer; key limit only.' : `Of ${usd(d.total_credits)} bought (${pct(creditShare)} left).`,
    compare: earlierCredit === null ? `${span(days)} earlier: not tracked (no key check that far back)` : `${span(days)} earlier: ${usd(earlierCredit)} left (${fmtTime(earlier.t)})`,
    value: creditShare ?? limitShare,
    lines,
    reconciliation: rec,
    facts: { asOf: last.t, credits, total: d.total_credits ?? null, creditShare, limitLeft: d.limit_remaining ?? null, limit: d.limit ?? null, limitReset: d.limit_reset ?? null, limitShare, earlierCredit, earlierAt: earlier?.t ?? null, prevUsage: Number.isFinite(prevUsage) ? prevUsage : null, period },
  }
}

// ---------- check 7: Reporting (no target set) ----------

function checkReporting(all, cur, prev, host, end, ctx) {
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
  const base = { id: 'reporting', title: 'Reporting', targeted: true, target: 'Every host that reported in the previous window reports in this one. Not tracked when the previous window has no hosts.', n: now.size }
  const blocked = prevNote(ctx)
  const compare = blocked ?? `Previous ${span(ctx.days)}: ${before.size ? plural(before.size, 'host') : 'no host reported'}`
  if (!now.size && !before.size) return { ...base, state: 'untracked', figure: 'Not tracked', population: 'No host reported any event in this window or the one before.', compare: blocked ?? '', lines }
  if (blocked || !before.size) {
    return { ...base, state: 'untracked', figure: `${plural(now.size, 'host')} reported`, population: 'Nothing to compare with: the previous window has no hosts to hold this one to.', compare, value: now.size, lines }
  }
  return {
    ...base,
    state: quiet.length ? 'attention' : 'pass',
    figure: now.size ? `${plural(now.size, 'host')} reported` : 'No host reported',
    population: now.size ? `Hosts with any event in the window${quiet.length ? `; ${plural(quiet.length, 'host')} that reported before did not` : ''}.` : 'No host reported any event in this window, though some did in the one before.',
    compare,
    value: now.size,
    lines,
  }
}

// ---------- the verdict ----------

/**
 * Counts only checks with an owner-approved target; the rest are facts.
 * With a host filter, account-wide checks (OpenRouter) are left out: the
 * filter cannot apply to them.
 */
export function verdictOf(checks, host = 'all') {
  const acct = host !== 'all' ? checks.filter((c) => c.targeted && c.account) : []
  const judged = checks.filter((c) => c.targeted && !acct.includes(c))
  const others = checks.filter((c) => !c.targeted).length
  const count = (s) => judged.filter((c) => c.state === s).length
  const att = count('attention'), un = count('untracked'), thin = count('thin'), part = count('partial'), ok = count('pass')
  const N = judged.length
  const tail = [
    un ? `${n0(un)} not tracked` : '',
    thin ? `${n0(thin)} too few to judge` : '',
    part ? `${n0(part)} partial` : '',
    others ? `${plural(others, 'check')} without a target` : '',
    acct.length ? `${acct.map((c) => c.title).join(', ')} left out (account-wide)` : '',
  ].filter(Boolean).join(' · ')
  const noun = `${others ? 'targeted ' : ''}check${N === 1 ? '' : 's'}`
  if (att) return { state: 'attention', text: `${n0(att)} of ${n0(N)} ${noun} ${att === 1 ? 'needs' : 'need'} attention`, tail }
  if (!ok) return { state: 'untracked', text: `None of ${n0(N)} ${noun} can be judged`, tail }
  if (un || thin || part) return { state: 'untracked', text: `${n0(ok)} of ${n0(N)} ${noun} passing`, tail }
  return { state: 'pass', text: `All ${n0(N)} ${noun} passing`, tail }
}

/** Every check for one window and host filter, measured back from the build time. `since` is the first event (collection start). */
export function runChecks({ rows, turns = [], generatedAt, days, host = 'all', since = null }) {
  const end = typeof generatedAt === 'number' ? generatedAt : Date.parse(generatedAt)
  const w = windowOf(end, days)
  const all = [...rows, ...turns]
  const first = since === null || since === undefined ? (all.length ? Math.min(...all.map((r) => r.t)) : null) : typeof since === 'number' ? since : Date.parse(since)
  const ctx = { w, days, since: first }
  const scoped = rows.filter((r) => hostMatch(r.h, host))
  const cur = scoped.filter((r) => inside(r.t, w.from, w.to))
  const prev = scoped.filter((r) => inside(r.t, w.prevFrom, w.prevTo))
  const st = turns.filter((t) => hostMatch(t.h, host))
  const tcur = st.filter((t) => inside(t.t, w.from, w.to))
  const tprev = st.filter((t) => inside(t.t, w.prevFrom, w.prevTo))
  const deciding = checkDeciding(cur, prev, ctx)
  const checks = [
    deciding,
    checkPicking(cur, prev, ctx, deciding.stats),
    checkSkills(cur, prev, ctx),
    checkLanding(tcur, tprev, ctx),
    checkRouter(cur, prev, ctx),
    checkCredit(rows, end, ctx),
    checkReporting(rows, cur, prev, host, end, ctx),
  ]
  const covered = first === null ? 0 : Math.max(0, end - Math.max(w.from, first))
  // prevStarts: when the previous window will lie wholly inside the data, so comparisons begin.
  const coverage = { since: first, covered, partial: first === null || first > w.from, prevTracked: prevOk(ctx), prevStarts: first === null ? null : first + 2 * days * DAY }
  attachFacts(checks, { rows, cur, prev, tcur, tprev, host, end })
  return { window: w, checks, verdict: verdictOf(checks, host), cur, prev, tcur, tprev, coverage, prevNote: prevNote(ctx) }
}

// ---------- facts: the numbers behind each check, for the plain-words page and the actions ----------

/** Per-chat view of Jev's logging: chats whose decisions stopped part-way, and chats that never logged one. */
export function decisionChats(cur, all) {
  const chats = new Map()
  for (const r of cur) if (isPrompt(r) && r.s >= 0) chats.set(r.s, { s: r.s, h: r.h, prompts: [] })
  for (const r of cur) if (isPrompt(r) && chats.has(r.s)) chats.get(r.s).prompts.push(r.t)
  const out = []
  for (const c of chats.values()) {
    const decided = all.filter((r) => r.k === 'jev.decision' && r.s === c.s).map((r) => r.t)
    const lastDecision = decided.length ? Math.max(...decided) : null
    const after = lastDecision === null ? c.prompts.length : c.prompts.filter((t) => t > lastDecision + TARGETS.matchMs).length
    out.push({ s: c.s, h: c.h, prompts: c.prompts.length, decisions: decided.length, lastDecision, after, stoppedMidChat: decided.length > 0 && after > 0, neverLogged: decided.length === 0 })
  }
  return out
}

/** When a chat started: its first event of any kind. */
export function chatStart(rows, s) {
  let t = Infinity
  for (const r of rows) if (r.s === s && r.t < t) t = r.t
  return Number.isFinite(t) ? t : null
}

function attachFacts(checks, { rows, cur, prev, tcur, tprev, host, end }) {
  const by = Object.fromEntries(checks.map((c) => [c.id, c]))
  const d = by['jev-deciding']
  d.facts = { ...decidingStats(cur), prev: decidingStats(prev), chats: decisionChats(cur, rows) }
  const decs = cur.filter((r) => r.k === 'jev.decision')
  const misses = cur.filter((r) => r.k === 'jev.miss').sort((x, y) => y.t - x.t)
  by['jev-picking'].facts = {
    decisions: decs.length,
    misses: misses.length,
    recent: misses.slice(0, 3).map((m) => ({ t: m.t, signal: m.d?.signal ?? null, pick: m.d?.jevPick ?? null, expected: m.sk ?? null })),
    first: decs.length ? Math.min(...decs.map((r) => r.t)) : null,
    last: decs.length ? Math.max(...decs.map((r) => r.t)) : null,
    prevDecisions: prev.filter((r) => r.k === 'jev.decision').length,
    prevMisses: prev.filter((r) => r.k === 'jev.miss').length,
  }
  const sk = skillStats(cur), psk = skillStats(prev)
  by.skills.facts = { calls: sk.calls, refused: sk.refused.map((r) => ({ skill: r.sk ?? 'unnamed', t: r.t, s: r.s, chatStart: chatStart(rows, r.s) })), prevCalls: psk.calls, prevRefused: psk.refused.length }
  by.landing.facts = { ...landStats(tcur), prev: landStats(tprev) }
  const ro = routerStats(cur), pro = routerStats(prev)
  const lastCall = ro.calls.length ? ro.calls.reduce((x, y) => (y.t > x.t ? y : x)) : null
  by.router.facts = { n: ro.n, errors: ro.errors, fallbacks: ro.fallbacks, rate: ro.rate, prev: { n: pro.n, rate: pro.rate }, last: lastCall && { t: lastCall.t, task: lastCall.d?.category ?? null, model: lastCall.m ?? null, ok: lastCall.ok !== false && !lastCall.d?.fallbackFrom } }
  by.openrouter.facts ??= null
  const hostsBy = (list) => {
    const m = new Map()
    for (const r of list) m.set(r.h, Math.max(m.get(r.h) ?? 0, r.t))
    return m
  }
  const now = hostsBy(cur), before = hostsBy(prev), ever = hostsBy(rows.filter((r) => r.t <= end))
  by.reporting.facts = {
    now: [...now.entries()].map(([h, last]) => ({ h, last })).sort((a, b) => b.last - a.last),
    quiet: [...before.keys()].filter((h) => !now.has(h)).map((h) => ({ h, last: ever.get(h) })),
    prevHosts: before.size,
    everLocal: [...ever.keys()].some((h) => String(h).startsWith('local')),
    everCloud: ever.has('cloud'),
    host,
  }
}

// ---------- actions: what to do, in plain words, from each check's state and facts ----------

/**
 * Fixes shipped, with when they landed. A chat that started before a fix
 * still runs the old code; new chats get it.
 * - skills and Jev logging: commit 98eb9d7 ("Fix Jev picks that could never
 *   load; keep bundled skills on; log decisions", #2).
 */
export const FIXES = { skills: Date.parse('2026-09-26T14:16:47Z'), jevLog: Date.parse('2026-09-26T14:16:47Z') }

/** Click-by-click steps, the only place a value to paste may appear. */
export const HOW_TO = {
  jevCloud: [
    'Open claude.ai/code and start or open any chat.',
    'Click the cloud setup menu at the top of the chat, point at your setup, and click its settings (gear) icon.',
    'Under "Setup script", make sure this line is there: git clone --depth 1 https://github.com/tcruz1978-afk/jev-model-routing /root/.claude/jev-model-routing || true',
    'Under "Environment variables", make sure this line is there: CLAUDE_CODE_PLUGIN_DIRS=/root/.claude/jev-model-routing/plugins/jev-skill-suggestion',
    'Click "Save changes", then start a new chat. Chats that were already open keep the old setup.',
  ],
  jevPc: [
    'Open Claude on your PC.',
    'Type this and press Enter: /plugin marketplace update jev-model-routing',
    'Then type this and press Enter: /plugin install jev-skill-suggestion@jev-model-routing',
    'Quit Claude, start it again, and open a new chat.',
  ],
  openrouterKey: [
    'Open claude.ai/code, click the cloud setup menu at the top of a chat, and click the settings (gear) icon of your setup.',
    'Under "API credentials", click "Add credential". Name it OpenRouter, allow the website openrouter.ai, and paste your OpenRouter key as the value.',
    'Click "Connect", then start a new chat.',
  ],
}

const WHO_ORDER = { You: 0, Claude: 1, Nothing: 2 }
const SEVERITY = { attention: 0, partial: 1, stale: 0, untracked: 2, thin: 2 }

/**
 * What to do, most important first: You items (by severity), then Claude,
 * then Nothing. Built only from checks that need attention, are partial or
 * are not tracked (too few counts as not tracked). Duplicates collapse.
 * `data`: { rows, stale, builtAgo, end, since, prevStarts, host }.
 * Returns [{ text, who, doneWhen, check, how? }] (at most 5), or [] when all pass.
 */
export function actionsFor(checks, data = {}) {
  const out = []
  const add = (check, state, text, who, doneWhen, how = null) => out.push({ check, state, text, who, doneWhen, ...(how ? { how } : {}) })
  const starts = data.prevStarts ? whenPlain(data.prevStarts, data.end) : 'soon'
  if (data.stale) add('page', 'stale', `Ask Claude to refresh this page — it is ${data.builtAgo ?? 'more than a day'} old.`, 'You', 'the page no longer says it is out of date.')
  const by = Object.fromEntries(checks.map((c) => [c.id, c]))
  const where = (h) => (String(h).startsWith('local') ? 'on your PC' : 'in your cloud setup')
  const jevAction = (c) => {
    const chats = c.facts?.chats ?? []
    const acts = []
    if (chats.some((x) => x.stoppedMidChat)) acts.push(['Start a new chat — this one started before today\'s Jev update.', 'You', 'new requests show Jev\'s pick.'])
    for (const h of [...new Set(chats.filter((x) => x.neverLogged).map((x) => x.h))]) {
      acts.push([`Turn on the latest Jev ${where(h)}.`, 'You', 'a new chat shows Jev\'s picks.', String(h).startsWith('local') ? HOW_TO.jevPc : HOW_TO.jevCloud])
    }
    if (!acts.length) acts.push(['Start a new chat so Jev can pick skills again.', 'You', 'new requests show Jev\'s pick.'])
    return acts
  }
  for (const c of checks) {
    const st = c.state
    if (st === 'pass' || st === 'neutral') continue
    if (c.account && data.host && data.host !== 'all') continue
    if (c.id === 'jev-deciding') {
      if (st === 'attention') for (const a of jevAction(c)) add(c.id, st, ...a)
      else add(c.id, st, 'Nothing to do — this fills in as you make more requests.', 'Nothing', 'you have made 10 requests.')
    } else if (c.id === 'jev-picking') {
      if (st === 'partial') for (const a of jevAction(by['jev-deciding'])) add(c.id, st, ...a)
      else if (st === 'attention') add(c.id, st, 'Ask Claude to run the daily routing check now.', 'Claude', 'no more than 1 in 10 of Jev\'s picks is wrong.')
      else add(c.id, st, 'Nothing to do — this fills in as Jev picks more skills.', 'Nothing', 'Jev has picked for 10 requests.')
    } else if (c.id === 'skills') {
      if (st === 'attention') {
        const refused = c.facts?.refused ?? []
        const old = refused.every((r) => r.t < FIXES.skills || (r.chatStart !== null && r.chatStart < FIXES.skills))
        if (old) add(c.id, st, 'Nothing to do — this is fixed in new chats. Tell Claude if a new chat is blocked too.', 'Nothing', 'a new chat uses skills without being blocked.')
        else add(c.id, st, `Tell Claude "skills are being blocked" and name them: ${[...new Set(refused.map((r) => r.skill))].slice(0, 4).join(', ')}.`, 'You', 'Claude can use every skill it asks for.')
      } else add(c.id, st, 'Nothing to do — this fills in when Claude next uses a skill.', 'Nothing', 'Claude has used a skill.')
    } else if (c.id === 'landing') {
      if (st === 'attention') add(c.id, st, 'Look at the kinds of requests that didn\'t land (under Details) and tell Claude which to fix.', 'You', '8 in 10 of your requests land.')
      else add(c.id, st, 'Nothing to do — this fills in as you make more requests.', 'Nothing', '10 of your requests have finished.')
    } else if (c.id === 'router') {
      if (st === 'attention') add(c.id, st, 'Ask Claude to check the model router\'s backup models.', 'Claude', 'fewer than 1 in 10 of its answers fail.')
      else add(c.id, st, 'Nothing to do — the model router is judged after 10 uses.', 'Nothing', 'it has been used 10 times.')
    } else if (c.id === 'openrouter') {
      if (st === 'attention') add(c.id, st, 'Add credit at openrouter.ai → Settings → Credits.', 'You', 'more than 10% of your credit is left.')
      else if (c.facts === null || c.facts === undefined) add(c.id, st, 'Connect your OpenRouter key so this page can read your balance.', 'You', 'this page shows your OpenRouter credit.', HOW_TO.openrouterKey)
    } else if (c.id === 'reporting') {
      const f = c.facts ?? {}
      for (const q of f.quiet ?? []) add(c.id, 'attention', `Open a chat on ${String(q.h).startsWith('local') ? 'your PC' : 'Claude in the cloud'} so it reports again.`, 'You', 'it shows up here again.')
      if (st === 'untracked') add(c.id, st, `Nothing to do — comparisons start ${starts}.`, 'Nothing', `it's ${starts}.`)
    }
  }
  // A PC that has never reported is a gap whatever the state (only when the filter includes your PC).
  const rep = by.reporting?.facts
  if (rep && !rep.everLocal && rep.host !== 'cloud') add('reporting', 'untracked', 'Run one chat on your PC in these projects, so it reports too.', 'You', 'your PC shows up here.')
  const seen = new Set()
  return out
    .filter((a) => (seen.has(a.text) ? false : seen.add(a.text)))
    .map((a, i) => ({ ...a, i }))
    .sort((x, y) => WHO_ORDER[x.who] - WHO_ORDER[y.who] || (SEVERITY[x.state] ?? 3) - (SEVERITY[y.state] ?? 3) || x.i - y.i)
    .slice(0, data.limit ?? 5)
    .map(({ i, state, ...a }) => a)
}

/** "today", "tomorrow" or "Oct 10": when a future time falls, in plain words (UTC days). */
export function whenPlain(t, end) {
  const day = (x) => Math.floor(x / DAY)
  if (t <= end || day(t) === day(end)) return 'today'
  if (day(t) === day(end) + 1) return 'tomorrow'
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
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

/** Tools (not Skill: check 3 covers it) failing above target, this window, with the previous window's rate. `thin`: under minN calls, not coloured. */
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
    buckets.push({ from, to, n: ts.length, known: s.known, landed: s.landed, rate: s.rate, cost: median(ts.map((t) => t.c)), priced: ts.filter((t) => Number.isFinite(t.c)).length })
  }
  return { size, buckets, withData: buckets.filter((b) => b.n > 0).length }
}
