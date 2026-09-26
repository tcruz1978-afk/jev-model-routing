/**
 * The Rankings and Compare views' arithmetic, laid out like OpenRouter's
 * model rankings: what you paid and what it bought, every model's figures
 * (overall or for one kind of request), a performance ranking, the leading
 * models per kind of request, and what Jev, the model router and JQ cost and
 * how the requests they touched went.
 *
 * Pure functions over the compact rows and turns (see live.mjs, turns.mjs).
 * Like checks.mjs it runs in node (tests) and in the page: dashboard.mjs
 * inlines it after checks, turns, live, present and explore, dropping
 * imports and `export`, so its top-level names must not repeat theirs.
 */
import { DAY, JEV_TIERS, TARGETS, creditBurn, jevOutcomes, median, modelName, openrouterSpend, tierOf } from './checks.mjs'

/** An average month, for spreading a monthly plan price over any period. */
export const MONTH_MS = (365.25 / 12) * DAY

/** Plain names for the kinds of request the collector sorts prompts into (lib.mjs REQUEST_RULES). */
export const CATEGORY_LABEL = {
  fix: 'Fix', build: 'Build', review: 'Review', ship: 'Ship', setup: 'Set up', design: 'Design', data: 'Data',
  writing: 'Writing', research: 'Research', command: 'Commands', reply: 'Short replies', other: 'Other',
}
export const categoryLabel = (c) => CATEGORY_LABEL[c] ?? (c ? c[0].toUpperCase() + c.slice(1) : 'Not recorded')

/**
 * What the performance ranking can rank by. `better`: which end is best.
 * `judged`: a rate or a typical value, too few to judge under TARGETS.minN.
 */
export const RANK_MEASURES = [
  { id: 'landed', label: 'Landed rate', better: 'high', judged: true },
  { id: 'speed', label: 'Speed (typical time)', better: 'low', judged: true },
  { id: 'cost', label: 'Typical cost per request', better: 'low', judged: true },
  { id: 'failures', label: 'Failure rate', better: 'low', judged: true },
  { id: 'cache', label: 'Cache hits', better: 'high', judged: false },
  { id: 'spend', label: 'Spend', better: 'high', judged: false },
]

const rkNum = (x) => typeof x === 'number' && Number.isFinite(x)
const rkSum = (list, f) => list.reduce((a, r) => a + (rkNum(f(r)) ? f(r) : 0), 0)
const rkPrompt = (r) => r.k === 'prompt' && (!r.a || r.a === 'main')

/** A model's key: "c:" for Claude's own calls, "r:" for the model router's OpenRouter calls. */
export const modelKey = (r) => (r.k === 'router.call' ? 'r:' : 'c:') + (r.m ?? 'unknown')

/** The plan's price spread over (from, to], or null without a plan. */
export function planShare(plan, from, to) {
  if (!plan || !rkNum(plan.monthlyUsd) || !(to > from)) return null
  return plan.monthlyUsd * ((to - from) / MONTH_MS)
}

/**
 * What you actually paid in a period and what it bought. The plan counts only
 * for the part of the period the data covers (from `since`), so it is set
 * beside the work that was recorded. OpenRouter is what the key billed
 * (account-wide). Claude's work is at pay-as-you-go prices.
 */
export function paidSummary({ rows, cur, tcur, from, to, since = null, plan = null }) {
  const covered = rkNum(since) && since > from ? since : from
  const planUsd = planShare(plan, covered, to)
  const or = openrouterSpend(rows, from, to)
  const claude = rkSum(cur.filter((r) => r.k === 'api'), (r) => r.c)
  const prompts = cur.filter(rkPrompt).length
  const known = tcur.filter((t) => t.land !== null && t.land !== undefined)
  const landed = known.filter((t) => t.land).length
  const paid = (planUsd ?? 0) + (or.usd ?? 0)
  return {
    plan, planUsd, coveredFrom: covered, partial: covered > from,
    openrouter: or.usd, openrouterBasis: or.basis,
    paid, claude,
    leverage: planUsd > 0 ? claude / planUsd : null,
    prompts, landed, known: known.length,
    perRequest: prompts ? paid / prompts : null,
    perLanded: landed ? paid / landed : null,
    typicalTime: median(tcur.map((t) => t.dur)),
    credit: creditBurn(rows, to),
  }
}

/** For each row, the turn it belongs to: the latest turn in its chat that started at or before it. */
function turnFinder(tcur) {
  const bySession = new Map()
  for (const t of tcur) (bySession.get(t.s) ?? bySession.set(t.s, []).get(t.s)).push(t)
  for (const list of bySession.values()) list.sort((a, b) => a.t - b.t)
  return (r) => {
    const list = bySession.get(r.s)
    if (!list) return null
    let lo = 0, hi = list.length - 1, hit = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].t <= r.t) { hit = list[mid]; lo = mid + 1 } else hi = mid - 1
    }
    return hit
  }
}

/**
 * Every model's figures in a period, overall or for one kind of request
 * (`category`: a Claude call counts when its request was of that kind; a
 * routed call when its router task has that name).
 *   Claude models: requests led (turns whose main model it was), landed of
 *   those with an outcome, typical cost and time per request, tool failures
 *   in them. Router models: calls answered without an error or a fallback,
 *   typical call time.
 */
export function modelStats(cur, tcur, { category = '' } = {}) {
  const turnOf = turnFinder(tcur)
  const inCat = (r) => !category || (r.k === 'router.call' ? r.d?.category === category : turnOf(r)?.cat === category)
  const turns = category ? tcur.filter((t) => t.cat === category) : tcur
  const by = new Map()
  const get = (key, r) => by.get(key) ?? by.set(key, { key, model: r.m ?? null, name: modelName(r.m), via: key.startsWith('r:') ? 'openrouter' : 'claude', calls: 0, spend: 0, unpriced: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, answered: 0, failed: 0, ms: [], turns: [] }).get(key)
  for (const r of cur) {
    if (r.k !== 'api' && r.k !== 'router.call') continue
    if (!inCat(r)) continue
    const e = get(modelKey(r), r)
    e.calls++
    if (rkNum(r.c)) e.spend += r.c
    else e.unpriced++
    if (rkNum(r.i)) e.tokensIn += r.i
    if (rkNum(r.o)) e.tokensOut += r.o
    if (rkNum(r.cr)) e.cacheRead += r.cr
    if (r.k === 'router.call') {
      if (r.ok === false || r.d?.fallbackFrom) e.failed++
      else if (r.ok === true) e.answered++
      if (rkNum(r.d?.ms)) e.ms.push(r.d.ms)
    }
  }
  for (const t of turns) {
    if (!t.m) continue
    const key = 'c:' + t.m
    const e = by.get(key) ?? get(key, { m: t.m })
    e.turns.push(t)
  }
  return [...by.values()].map((e) => {
    const known = e.turns.filter((t) => t.land !== null && t.land !== undefined)
    const tools = rkSum(e.turns, (t) => t.tl), toolFails = rkSum(e.turns, (t) => t.tf)
    const router = e.via === 'openrouter'
    const judged = router ? e.answered + e.failed : known.length
    return {
      key: e.key, model: e.model, name: e.name, via: e.via,
      calls: e.calls, spend: e.spend, unpriced: e.unpriced,
      tokens: e.tokensIn + e.tokensOut, tokensIn: e.tokensIn, tokensOut: e.tokensOut,
      cacheRate: e.tokensIn ? e.cacheRead / e.tokensIn : null,
      requests: router ? null : e.turns.length,
      landed: router ? e.answered : known.filter((t) => t.land).length,
      known: judged,
      landRate: judged ? (router ? e.answered : known.filter((t) => t.land).length) / judged : null,
      costPerRequest: router ? median(cur.filter((r) => r.k === 'router.call' && modelKey(r) === e.key && inCat(r)).map((r) => r.c)) : median(e.turns.map((t) => t.c)),
      time: router ? median(e.ms) : median(e.turns.map((t) => t.dur)),
      timed: router ? e.ms.length : e.turns.filter((t) => rkNum(t.dur)).length,
      tools: router ? null : tools,
      toolFails: router ? null : toolFails,
      failRate: router ? (judged ? e.failed / judged : null) : tools ? toolFails / tools : null,
      failJudged: router ? judged : tools,
    }
  }).sort((a, b) => b.spend - a.spend || b.calls - a.calls)
}

/** A model's value for a ranking measure, and how many things it rests on. */
export function measureOf(s, id) {
  switch (id) {
    case 'landed': return { v: s.landRate, n: s.known }
    case 'speed': return { v: s.time, n: s.timed }
    case 'cost': return { v: s.costPerRequest, n: s.via === 'openrouter' ? s.calls : s.requests }
    case 'failures': return { v: s.failRate, n: s.failJudged }
    case 'cache': return { v: s.cacheRate, n: s.calls }
    default: return { v: s.spend, n: s.calls }
  }
}

/**
 * Stack-ranks models by a measure, best first. A rate or a typical value
 * resting on fewer than TARGETS.minN is "too few to judge" and goes after the
 * judged ones, unranked, as do models with no value at all.
 */
export function rankModels(stats, measure = 'landed') {
  const M = RANK_MEASURES.find((m) => m.id === measure) ?? RANK_MEASURES[0]
  const rows = stats.map((s) => {
    const { v, n } = measureOf(s, M.id)
    const thin = M.judged && (n ?? 0) < TARGETS.minN
    return { ...s, value: rkNum(v) ? v : null, n: n ?? 0, thin }
  })
  const judged = rows.filter((r) => r.value !== null && !r.thin).sort((a, b) => (M.better === 'high' ? b.value - a.value : a.value - b.value) || b.n - a.n)
  const rest = rows.filter((r) => r.value === null || r.thin).sort((a, b) => b.n - a.n || b.calls - a.calls)
  return { measure: M, ranked: judged.map((r, i) => ({ ...r, rank: i + 1 })), unranked: rest }
}

/**
 * The leading models for each kind of request, ranked by how often the
 * answer landed (Claude) or came back without an error or fallback (router),
 * busiest kinds first. Requests with no recorded kind are counted apart.
 */
export function topByTask(cur, tcur) {
  const cats = new Map()
  for (const t of tcur) {
    const c = t.cat || null
    if (!c) continue
    const e = cats.get(c) ?? cats.set(c, { category: c, requests: 0, routed: 0 }).get(c)
    e.requests++
  }
  for (const r of cur) {
    if (r.k !== 'router.call' || !r.d?.category) continue
    const e = cats.get(r.d.category) ?? cats.set(r.d.category, { category: r.d.category, requests: 0, routed: 0 }).get(r.d.category)
    e.routed++
  }
  const unlabelled = tcur.filter((t) => !t.cat).length
  const tasks = [...cats.values()].map((e) => ({
    ...e,
    label: categoryLabel(e.category),
    models: rankModels(modelStats(cur, tcur, { category: e.category }).filter((s) => s.known > 0), 'landed'),
  })).sort((a, b) => b.requests + b.routed - (a.requests + a.routed))
  return { tasks, unlabelled }
}

/**
 * Is it making the work more efficient? Comparisons, not proof of cause.
 *   jev     decisions by tier, picks flagged wrong, requests with a pick
 *           against those without (landed), and the OpenRouter spend no
 *           routed call explains (Jev's calls are not priced one by one).
 *   router  routed calls: what OpenRouter billed against the same tokens at
 *           the list price of the Claude model that did most of the work.
 *   jq      judgement calls logged, their outcomes (kept, overruled, asked),
 *           and how sure they were against how often they were kept.
 */
export function efficiency({ rows, cur, tcur, from, to, rates = {} }) {
  const { decisions } = jevOutcomes(cur, tcur)
  const group = (list) => {
    const known = list.filter((d) => d.land !== null)
    return { n: list.length, misses: list.filter((d) => d.miss).length, known: known.length, landed: known.filter((d) => d.land).length }
  }
  const or = openrouterSpend(rows, from, to)
  const unattributed = or.basis === 'router' ? null : Math.max(0, (or.usd ?? 0) - (or.routed ?? 0))
  const tiers = JEV_TIERS.map((t) => ({ id: t.id, label: t.label, paid: t.paid, n: decisions.filter((d) => d.tier === t.id).length })).filter((t) => t.n)
  const jev = {
    decisions: decisions.length,
    tiers,
    picked: group(decisions.filter((d) => d.r.sk)),
    none: group(decisions.filter((d) => !d.r.sk)),
    unattributed,
    perDecision: unattributed !== null && decisions.length ? unattributed / decisions.length : null,
  }
  jev.thin = jev.picked.known + jev.none.known < TARGETS.minN

  const api = cur.filter((r) => r.k === 'api' && r.m)
  const out = new Map()
  for (const r of api) out.set(r.m, (out.get(r.m) ?? 0) + (rkNum(r.o) ? r.o : 0) + 1)
  const ref = [...out.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const rateKey = ref ? Object.keys(rates).filter((k) => ref === k || ref.startsWith(k + '-')).sort((a, b) => b.length - a.length)[0] : null
  const rate = rateKey ? rates[rateKey] : null
  const routed = cur.filter((r) => r.k === 'router.call')
  const billed = rkSum(routed, (r) => r.c)
  const asClaude = rate ? rkSum(routed, (r) => ((rkNum(r.i) ? r.i : 0) * rate.input + (rkNum(r.o) ? r.o : 0) * rate.output) / 1e6) : null
  const router = {
    calls: routed.length,
    answered: routed.filter((r) => r.ok === true && !r.d?.fallbackFrom).length,
    billed, asClaude, reference: ref,
    saved: asClaude === null ? null : asClaude - billed,
    thin: routed.length < TARGETS.minN,
  }

  const jqDecisions = cur.filter((r) => r.k === 'jq.decision')
  const latest = new Map()
  for (const r of rows.filter((x) => x.k === 'jq.outcome' && x.d?.jq).sort((a, b) => a.t - b.t)) latest.set(r.d.jq, r.d.outcome)
  const judged = jqDecisions.map((d) => ({ conf: d.d?.conf, outcome: latest.get(d.d?.jq) ?? null }))
  const withOutcome = judged.filter((j) => j.outcome === 'kept' || j.outcome === 'overruled')
  const kept = withOutcome.filter((j) => j.outcome === 'kept').length
  const confs = withOutcome.map((j) => j.conf).filter(rkNum)
  const jq = {
    tracked: rows.some((r) => r.k === 'jq.decision' || r.k === 'jq.outcome'),
    decisions: jqDecisions.length,
    kept,
    overruled: withOutcome.length - kept,
    asked: judged.filter((j) => j.outcome === 'asked').length,
    open: judged.filter((j) => j.outcome === null).length,
    keptRate: withOutcome.length ? kept / withOutcome.length : null,
    sureness: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    thin: withOutcome.length < TARGETS.minN,
  }
  return { jev, router, jq, openrouter: or }
}

/** The top models ranked by what the chart shows (spend, tokens or calls). */
export function leaderboard(stats, show = 'spend', top = 10) {
  const val = (s) => (show === 'tokens' ? s.tokens : show === 'calls' ? s.calls : s.spend)
  const total = stats.reduce((a, s) => a + val(s), 0)
  return stats.map((s) => ({ ...s, value: val(s), share: total ? val(s) / total : null })).sort((a, b) => b.value - a.value || b.calls - a.calls).slice(0, top).map((s, i) => ({ ...s, rank: i + 1 }))
}
