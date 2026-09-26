// Rankings and Compare: what you paid, every model's figures, the performance ranking, top models by task, and efficiency.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY } from '../scripts/checks.mjs'
import { eventFromJq, jqLogPaths } from '../scripts/lib.mjs'
import { compact } from '../scripts/live.mjs'
import { MONTH_MS, categoryLabel, contribution, efficiency, leaderboard, modelKey, modelStats, paidSummary, planShare, rankModels, topByTask } from '../scripts/rankings.mjs'
import { buildPayload, claudeRates, readPlan } from '../scripts/dashboard.mjs'

const END = Date.parse('2026-09-26T18:00:00Z')
const MIN = 60000
const at = (m) => new Date(END - m * MIN).toISOString()
const PLAN = { name: 'Max 20x', monthlyUsd: 200 }

/** Two chats: Opus leads 12 requests (11 land), Sonnet 3; one routed call; Jev decides on 4. */
function sample() {
  const ev = []
  for (let i = 0; i < 12; i++) {
    const t = 300 - i * 20
    ev.push({ id: `p${i}`, kind: 'prompt', ts: at(t), session: 's1', host: 'cloud', agent: 'main', data: { category: i < 8 ? 'fix' : 'build', correction: i === 5 } })
    ev.push({ id: `a${i}`, kind: 'api', ts: at(t - 1), session: 's1', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', input_tokens: 10, cache_read_tokens: 90, output_tokens: 100, cost_usd: 1 })
    ev.push({ id: `t${i}`, kind: 'tool', ts: at(t - 2), session: 's1', host: 'cloud', agent: 'main', tool: 'Bash', ok: i !== 3, data: { ms: 1000 } })
  }
  for (let i = 0; i < 3; i++) {
    const t = 50 - i * 10
    ev.push({ id: `q${i}`, kind: 'prompt', ts: at(t), session: 's2', host: 'cloud', agent: 'main', data: { category: 'fix' } })
    ev.push({ id: `b${i}`, kind: 'api', ts: at(t - 1), session: 's2', host: 'cloud', agent: 'main', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, cost_usd: 0.1 })
  }
  ev.push({ id: 'r1', kind: 'router.call', ts: at(40), session: 's2', host: 'cloud', model: 'z-ai/glm', input_tokens: 1000, output_tokens: 500, cost_usd: 0.001, ok: true, data: { category: 'code', ms: 900 } })
  for (let i = 0; i < 4; i++) ev.push({ id: `d${i}`, kind: 'jev.decision', ts: at(300 - i * 20), session: 's1', host: 'cloud', skill: i < 3 ? 'pdf' : null, data: { decidedBy: 'jev' } })
  ev.push({ id: 'k0', kind: 'openrouter.key', ts: at(400), host: 'cloud', data: { total_usage: 1, total_credits: 20 } })
  ev.push({ id: 'k1', kind: 'openrouter.key', ts: at(5), host: 'cloud', data: { total_usage: 3.001, total_credits: 20 } })
  return compact(ev, { now: END })
}
const span = (rows) => ({ from: END - DAY, to: END, cur: rows.filter((r) => r.t > END - DAY && r.t <= END) })

test('the plan is spread over the period by an average month', () => {
  assert.equal(planShare(PLAN, 0, MONTH_MS), 200)
  assert.ok(Math.abs(planShare(PLAN, END - DAY, END) - 6.57) < 0.01, 'one day of $200 a month')
  assert.equal(planShare(null, 0, DAY), null)
  assert.equal(planShare(PLAN, 5, 5), null)
})

test('what you paid: the plan for the hours recorded, OpenRouter as billed, beside the work it bought', () => {
  const { rows, turns } = sample()
  const { from, to, cur } = span(rows)
  const since = rows[0].t
  const P = paidSummary({ rows, cur, tcur: turns, from, to, since, plan: PLAN })
  assert.equal(P.partial, true, 'collection began inside the day')
  assert.ok(Math.abs(P.planUsd - planShare(PLAN, since, to)) < 1e-9)
  assert.ok(Math.abs(P.openrouter - 2.001) < 1e-9, "the key's growth over the day")
  assert.ok(Math.abs(P.paid - (P.planUsd + 2.001)) < 1e-9)
  assert.ok(Math.abs(P.claude - 12.3) < 1e-9, 'Claude work at pay-as-you-go prices')
  assert.ok(Math.abs(P.leverage - 12.3 / P.planUsd) < 1e-9)
  assert.equal(P.prompts, 15)
  assert.ok(Math.abs(P.perRequest - P.paid / 15) < 1e-9)
  const none = paidSummary({ rows, cur, tcur: turns, from, to, since, plan: null })
  assert.equal(none.planUsd, null)
  assert.equal(none.leverage, null)
})

test("every model's figures: requests led, landed, typical cost and time, cache hits, failures", () => {
  const { rows, turns } = sample()
  const S = modelStats(span(rows).cur, turns)
  const opus = S.find((s) => s.key === 'c:claude-opus-5-5')
  assert.deepEqual([opus.calls, opus.requests, opus.spend, opus.cacheRate], [12, 12, 12, 0.9])
  assert.equal(opus.known, 11, "the last request in a chat has no outcome yet")
  assert.equal(opus.landed, 10, 'one pushed back')
  assert.equal(opus.costPerRequest, 1)
  assert.deepEqual([opus.tools, opus.toolFails], [12, 1])
  const glm = S.find((s) => s.key === 'r:z-ai/glm')
  assert.deepEqual([glm.via, glm.calls, glm.landed, glm.known, glm.time, glm.failRate], ['openrouter', 1, 1, 1, 900, 0])
  assert.equal(modelKey({ k: 'router.call', m: 'x/y' }), 'r:x/y')
  const fix = modelStats(span(rows).cur, turns, { category: 'fix' })
  assert.equal(fix.find((s) => s.key === 'c:claude-opus-5-5').calls, 8, 'only the calls made for fix requests')
  assert.equal(fix.find((s) => s.key === 'c:claude-sonnet-5').requests, 3)
  assert.equal(fix.find((s) => s.key === 'r:z-ai/glm'), undefined, 'a router task named "code" is not a fix request')
})

test('the performance ranking puts judged models first, best first, and too-few-to-judge after', () => {
  const { rows, turns } = sample()
  const S = modelStats(span(rows).cur, turns)
  const L = rankModels(S, 'landed')
  assert.deepEqual(L.ranked.map((r) => [r.rank, r.name]), [[1, 'Opus 5.5']])
  assert.deepEqual(L.unranked.map((r) => r.name).sort(), ['Sonnet 5', 'glm'].sort())
  assert.ok(L.unranked.every((r) => r.thin || r.value === null))
  const spend = rankModels(S, 'spend')
  assert.deepEqual(spend.ranked.map((r) => r.name), ['Opus 5.5', 'Sonnet 5', 'glm'], 'spend is never too few to judge')
  assert.equal(rankModels(S, 'nonsense').measure.id, 'landed')
  const board = leaderboard(S, 'tokens')
  assert.equal(board[0].name, 'Opus 5.5')
  assert.ok(Math.abs(board.reduce((a, b) => a + b.share, 0) - 1) < 1e-9)
})

test('top models by task: each kind of request with its models, busiest first', () => {
  const { rows, turns } = sample()
  const T = topByTask(span(rows).cur, turns)
  assert.deepEqual(T.tasks.map((t) => [t.category, t.label, t.requests, t.routed]), [['fix', 'Fix', 11, 0], ['build', 'Build', 4, 0], ['code', 'Code', 0, 1]])
  assert.deepEqual(T.tasks[0].models.unranked.map((m) => m.name).sort(), ['Opus 5.5', 'Sonnet 5'], 'under 10 each: too few to judge')
  assert.equal(categoryLabel('setup'), 'Set up')
  assert.equal(categoryLabel(null), 'Not recorded')
})

test('efficiency: Jev with and without a pick, the router against Claude prices, JQ outcomes', () => {
  const { rows, turns } = sample()
  const { from, to, cur } = span(rows)
  const rates = { 'claude-opus-5-5': { input: 4, output: 20 } }
  const E = efficiency({ rows, cur, tcur: turns, from, to, rates })
  assert.equal(E.jev.decisions, 4)
  assert.deepEqual([E.jev.picked.n, E.jev.none.n], [3, 1])
  assert.ok(Math.abs(E.jev.unattributed - 2) < 1e-9, 'key growth less the routed call')
  assert.ok(Math.abs(E.jev.perDecision - 0.5) < 1e-9)
  assert.equal(E.router.reference, 'claude-opus-5-5')
  assert.ok(Math.abs(E.router.asClaude - (1000 * 4 + 500 * 20) / 1e6) < 1e-12)
  assert.ok(Math.abs(E.router.saved - (0.014 - 0.001)) < 1e-12)
  assert.equal(E.jq.tracked, false)

  const jq = compact([
    ...[1, 2, 3].map((i) => ({ id: `jq:${i}`, kind: 'jq.decision', ts: at(30 + i), host: 'cloud', tool: 'router', data: { jq: `a${i}`, confidence: 0.8 } })),
    { id: 'jqo:a1:1', kind: 'jq.outcome', ts: at(20), host: 'cloud', ok: true, data: { jq: 'a1', outcome: 'kept' } },
    { id: 'jqo:a2:1', kind: 'jq.outcome', ts: at(20), host: 'cloud', ok: false, data: { jq: 'a2', outcome: 'overruled' } },
  ], { now: END })
  const J = efficiency({ rows: jq.rows, cur: jq.rows, tcur: [], from, to }).jq
  assert.deepEqual([J.tracked, J.decisions, J.kept, J.overruled, J.open, J.keptRate, J.sureness, J.thin], [true, 3, 1, 1, 1, 0.5, 0.8, true])
})

test('JQ log lines become events without the question; bad lines are skipped', () => {
  const d = eventFromJq(JSON.stringify({ kind: 'decision', id: '1a2b3c4d', t: END, tool: 'router', question: 'my secret prompt', answer: 'code', confidence: 0.7, decidedBy: 'jev' }), 'cloud')
  assert.equal(d.id, 'jq:1a2b3c4d')
  assert.equal(d.kind, 'jq.decision')
  assert.deepEqual(d.data, { jq: '1a2b3c4d', answer: 'code', confidence: 0.7, decidedBy: 'jev' })
  assert.ok(!JSON.stringify(d).includes('secret'))
  const o = eventFromJq(JSON.stringify({ kind: 'outcome', id: '1a2b3c4d', t: END + 1, outcome: 'overruled', answer: 'writing' }), 'cloud')
  assert.deepEqual([o.kind, o.ok, o.data], ['jq.outcome', false, { jq: '1a2b3c4d', outcome: 'overruled' }])
  assert.equal(eventFromJq('not json', 'cloud'), null)
  assert.equal(eventFromJq(JSON.stringify({ kind: 'outcome', id: '1a2b3c4d', t: END, outcome: 'maybe' }), 'cloud'), null)
  assert.equal(eventFromJq(JSON.stringify({ kind: 'decision', id: '../../x', t: END }), 'cloud'), null)
  assert.deepEqual(jqLogPaths({ JQ_LOG: 'off' }, '/h'), [])
  assert.deepEqual(jqLogPaths({ JQ_LOG_FILE: '/x.jsonl' }, '/h'), ['/x.jsonl', '/mnt/project-files/judgement-quotient/decisions.jsonl', '/h/.jq/decisions.jsonl'])
})

test('the build carries the plan and Claude prices for the page', () => {
  assert.deepEqual(readPlan(), { name: 'Max 20x', monthlyUsd: 200 })
  assert.deepEqual(claudeRates()['claude-opus-5-5'], { input: 4, output: 20 })
  const P = buildPayload([{ id: 'a', kind: 'api', ts: at(10), session: 's', host: 'cloud', model: 'claude-opus-5-5', cost_usd: 1 }], { now: END })
  assert.deepEqual(P.plan, { name: 'Max 20x', monthlyUsd: 200 })
  assert.ok(P.rates['claude-haiku-4-5'])
})

test('contribution: each part as KPIs, the three together, and spend nothing explains kept apart', () => {
  const { rows, turns } = sample()
  const { from, to, cur } = span(rows)
  const rates = { 'claude-opus-5-5': { input: 4, output: 20 } }
  const K = contribution({ rows, cur, tcur: turns, from, to, rates })
  // Jev: 4 decisions on s1's first 4 requests of 15.
  assert.deepEqual([K.jev.decisions, K.jev.covered, K.jev.requests], [4, 4, 15])
  assert.ok(Math.abs(K.jev.coverage - 4 / 15) < 1e-9)
  assert.equal(K.jev.accuracy, 1, 'no pick flagged wrong')
  assert.equal(K.jev.cost, null, 'no decision reported a cost: unknown, never zero')
  assert.equal(K.total.jevCostMissing, true)
  assert.equal(K.jev.fair, false)
  assert.equal(K.jev.thin, true)
  assert.ok(K.jev.quiet, 'prompts came after the last decision')
  // Router: 1 of 16 model calls.
  assert.ok(Math.abs(K.router.offload - 1 / 16) < 1e-9)
  assert.ok(Math.abs(K.router.saved - 0.013) < 1e-12)
  assert.equal(K.router.quality, 1)
  // Total: the key grew $2.001; the router explains $0.001; the rest is kept apart.
  assert.ok(Math.abs(K.total.cost - 0.001) < 1e-12)
  assert.ok(Math.abs(K.total.net - 0.012) < 1e-12)
  assert.ok(Math.abs(K.total.unexplained - 2) < 1e-9, 'never charged to Jev or the router')
  assert.equal(K.jq.tracked, false)

  // Once Jev's decisions carry their cost, it is counted and the unexplained part shrinks.
  const ev = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, kind: 'jev.decision', ts: at(300 - i * 20), session: 's1', host: 'cloud', skill: 'pdf', cost_usd: 0.25, data: { decidedBy: 'jev' } })),
    { id: 'k0', kind: 'openrouter.key', ts: at(400), host: 'cloud', data: { total_usage: 1, total_credits: 20 } },
    { id: 'k1', kind: 'openrouter.key', ts: at(5), host: 'cloud', data: { total_usage: 2, total_credits: 20 } },
  ]
  const P = compact(ev, { now: END })
  const Q = contribution({ rows: P.rows, cur: P.rows, tcur: P.turns, from, to })
  assert.equal(Q.jev.cost, 0.75)
  assert.equal(Q.total.jevCostMissing, false)
  assert.ok(Math.abs(Q.total.unexplained - 0.25) < 1e-9)
  assert.ok(Math.abs(Q.total.net + 0.75) < 1e-9, 'cost with no measured saving is a negative net')
})

test('the on/off comparison: each part against the same work without it, and all together', async () => {
  const { comparison } = await import('../scripts/rankings.mjs')
  const ev = []
  // Three chats, one per group, 12 requests each; "Neither" lands 9, the others 11.
  const groups = [['on', 'son'], ['no-router', 'sjev'], ['off', 'soff']]
  groups.forEach(([arm, s], g) => {
    ev.push({ id: `arm${g}`, kind: 'jev.arm', ts: at(1000), session: s, host: 'cloud', data: { arm } })
    for (let i = 0; i < 13; i++) {
      const t = 900 - i * 30
      ev.push({ id: `${s}p${i}`, kind: 'prompt', ts: at(t), session: s, host: 'cloud', agent: 'main', data: { category: 'fix', correction: arm === 'off' ? i % 4 === 1 : i === 5 } })
      ev.push({ id: `${s}a${i}`, kind: 'api', ts: at(t - 1), session: s, host: 'cloud', agent: 'main', model: 'claude-opus-5-5', cost_usd: arm === 'off' ? 2 : 1 })
      if (arm !== 'off') ev.push({ id: `${s}d${i}`, kind: 'jev.decision', ts: at(t), session: s, host: 'cloud', skill: 'pdf', cost_usd: 0.1, data: { decidedBy: 'jev' } })
    }
  })
  ev.push({ id: 'r1', kind: 'router.call', ts: at(20), session: 'son', host: 'cloud', model: 'z/free', cost_usd: 0, ok: true, data: { offload: true, ms: 800 } })
  const P = compact(ev, { now: END })
  const C = comparison({ rows: P.rows, cur: P.rows, tcur: P.turns })
  assert.equal(C.tracked, true)
  assert.deepEqual([C.groups.on.requests, C.groups.on.byRouter, C.groups['no-router'].requests, C.groups.off.requests], [14, 1, 13, 13], 'a router answer is a request of the "on" group')
  assert.deepEqual([C.groups.on.known, C.groups.off.known], [12, 12], "each chat's last request has no outcome yet")
  assert.equal(C.groups['no-router'].cost, 1.1, 'Claude plus the Jev decision')
  assert.equal(C.groups.off.cost, 2)
  assert.ok(Math.abs(C.jev.costDiff + 0.9) < 1e-9, 'Jev: 90 cents less per request than neither')
  assert.ok(C.jev.landDiff > 0, 'and more landed')
  assert.equal(C.jev.thin, false)
  assert.equal(C.router.costDiff, 1.1 - 1.1)
  assert.ok(C.total.costDiff < 0)
  const none = comparison({ rows: [], cur: [], tcur: [] })
  assert.equal(none.tracked, false)
  assert.equal(none.total.thin, true)
})
