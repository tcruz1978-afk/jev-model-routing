// What the models did and what it cost: the arithmetic behind the top of the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DAY, activityFeed, attribute, confidenceOf, costByModel, creditBurn, daysWords, deltaOf, headline, jevConfidence, jevOutcomes, jevPicks,
  jevTierStats, modelGrid, modelName, openrouterSpend, paidOf, readTierBenchmark, routerDetail, runChecks, tierOf, topChats, windowOf,
  workByConnector, workBySkill, workBySubagent,
} from '../scripts/checks.mjs'
import { buildPayload, extractData, render } from '../scripts/dashboard.mjs'
import { checksHtml } from '../scripts/present.mjs'
import { turnsFrom } from '../scripts/turns.mjs'

const END = Date.parse('2026-09-26T18:00:00Z')
const MIN = 60000

test('tiers: who decided → paid or free', () => {
  assert.equal(tierOf('jev'), 'jev')
  assert.equal(tierOf('backup openai/gpt-5-mini'), 'paid-backup')
  assert.equal(tierOf('backup openrouter/free'), 'free-backup')
  assert.equal(tierOf('backup meta-llama/llama-4-scout:free'), 'free-backup')
  assert.equal(tierOf('built-in classifier'), 'builtin')
  assert.equal(tierOf(null), 'unknown')
  assert.equal(tierOf('backupx'), 'unknown')
  assert.deepEqual(['jev', 'backup x/y', 'backup a:free', 'built-in classifier', undefined].map(paidOf), [true, true, false, false, null])
})

/** Decisions in one chat, each followed by a turn; `land` per turn, misses by pick. */
function jevRows(specs) {
  const rows = []
  specs.forEach((x, i) => {
    const t = END - (100 - i * 3) * MIN
    rows.push({ k: 'prompt', t, s: x.s ?? 0, h: 'cloud', a: 'main', ...(x.cx ? { cx: 1 } : {}) })
    rows.push({ k: 'jev.decision', t: t + 500, s: x.s ?? 0, h: 'cloud', ...(x.pick ? { sk: x.pick } : {}), d: { decidedBy: x.by, wideMs: x.wide ?? null, rerankMs: x.rerank ?? null, conf: x.conf ?? null } })
    if (x.miss) rows.push({ k: 'jev.miss', t: t + (x.missLate ? 90 * MIN : 400), s: x.s ?? 0, h: 'cloud', d: { jevPick: x.pick ?? null } })
  })
  // A last prompt so every earlier turn has an outcome.
  rows.push({ k: 'prompt', t: END - MIN, s: 0, h: 'cloud', a: 'main' })
  rows.sort((a, b) => a.t - b.t)
  return rows
}

test('misses match a decision by chat, the same pick, then the nearest time; each marks one decision', () => {
  const rows = jevRows([
    { by: 'jev', pick: 'pdf' },
    { by: 'jev', pick: 'unlazy', miss: true, missLate: true },
    { by: 'jev', pick: 'pdf', miss: true, missLate: true },
  ])
  rows.push({ k: 'jev.miss', t: END, s: 7, h: 'cloud', d: { jevPick: 'pdf' } }) // a chat with no decision
  const { decisions, unmatchedMisses } = jevOutcomes(rows, turnsFrom(rows))
  // The pdf miss is logged 90 min later: nearest pdf decision is the second pdf one, never the unlazy decision in between.
  assert.deepEqual(decisions.map((d) => [d.r.sk, d.miss]), [['pdf', false], ['unlazy', true], ['pdf', true]])
  assert.equal(unmatchedMisses, 1)
})

test('paid against free: decisions, share, misroutes, landed and latency per tier; under 10 is too few', () => {
  const specs = [
    ...Array.from({ length: 10 }, (_, i) => ({ by: 'jev', pick: i < 8 ? 'pdf' : null, miss: i === 0, cx: i === 1, wide: 300, rerank: 100 })),
    { by: 'backup openai/gpt-5-mini', pick: 'pdf', wide: 900 },
    { by: 'backup openrouter/free', pick: 'dataviz', miss: true, wide: 2000 },
    { by: 'built-in classifier', pick: null, cx: true },
  ]
  const rows = jevRows(specs)
  const T = jevTierStats(rows, turnsFrom(rows))
  assert.equal(T.total, 13)
  const by = Object.fromEntries(T.tiers.map((t) => [t.id, t]))
  assert.deepEqual([by.jev.decisions, by.jev.misses, by.jev.thin, by.jev.ms], [10, 1, false, 400])
  assert.equal(by.jev.share, 10 / 13)
  // Turn after decision 1 pushed back (the prompt after it carries cx): 9 of 10 landed.
  assert.deepEqual([by.jev.landed, by.jev.known], [9, 10])
  assert.deepEqual([T.paid.decisions, T.paid.misses, T.paid.ms], [11, 1, 400])
  assert.deepEqual([T.free.decisions, T.free.misses, T.free.thin], [2, 1, true])
  assert.equal(by['free-backup'].missRate, 1)
  assert.equal(by['builtin'].ms, null, 'no timing logged, no latency')
  // The turn decided by the free backup is pushed back by the built-in classifier's prompt.
  assert.deepEqual([by['free-backup'].landed, by['free-backup'].known], [0, 1])
  assert.ok(!('unknown' in by))
  const picks = jevPicks(rows, turnsFrom(rows))
  assert.equal(picks[picks.length - 1].skill, null, '"picked nothing" comes last')
  assert.deepEqual(picks.find((p) => p.skill === 'pdf').decisions, 9)
})

test('confidence: the pick\'s fit, the best fit when nothing was picked, in bands', () => {
  const data = { rerank: { fits: { pdf: 0.62, unlazy: 0.2 } }, top: [{ name: 'unlazy', probability: 0.4 }] }
  assert.equal(confidenceOf('pdf', data), 0.62)
  assert.equal(confidenceOf(null, data), 0.62)
  assert.equal(confidenceOf('unlazy', { top: [{ name: 'unlazy', probability: 0.4 }] }), 0.4)
  assert.equal(confidenceOf('pdf', { top: [{ name: 'unlazy', probability: 0.4 }] }), null)
  const c = jevConfidence([{ k: 'jev.decision', sk: 'a', d: { conf: 0.95 } }, { k: 'jev.decision', d: { conf: 0.1 } }, { k: 'jev.decision', sk: 'b', d: { conf: 0.3 } }, { k: 'jev.decision', d: {} }])
  assert.deepEqual(c.bands.map((b) => [b.picked, b.nothing]), [[0, 1], [1, 0], [0, 0], [0, 0], [1, 0]])
  assert.equal(c.unknown, 1)
})

test('the benchmark file: accepted only in its shape', () => {
  assert.equal(readTierBenchmark(null), null)
  assert.equal(readTierBenchmark({ tiers: { jev: { right: 1 } } }), null)
  const b = readTierBenchmark({ ranAt: '2026-09-26T00:00:00Z', cases: 40, tiers: { jev: { right: 36, of: 40 }, free: { right: 20, of: 40 } } })
  assert.deepEqual(Object.keys(b.tiers), ['jev', 'free'])
  assert.equal(b.tiers.jev.rate, 0.9)
})

test('cost by model: UTC days (hours for 24 h), top models kept, the rest as other models', () => {
  const w = windowOf(END, 7)
  const rows = [
    { k: 'api', t: END - 1 * MIN, m: 'claude-opus-5-5', c: 2 },
    { k: 'api', t: END - 19 * 60 * MIN, m: 'claude-opus-5-5', c: 1 }, // Sep 25, 23:00 UTC
    { k: 'api', t: END - 2 * DAY, m: 'claude-haiku-4-5', c: 0.5 },
    { k: 'api', t: END - 2 * DAY, m: 'claude-nopri' }, // no price: a call, no cost
    { k: 'router.call', t: END - 3 * MIN, m: 'z-ai/glm', c: 0.01 },
    { k: 'api', t: END - 8 * DAY, m: 'claude-opus-5-5', c: 100 }, // before the period
  ]
  const C = costByModel(rows.filter((r) => r.t > w.from), w, 2)
  assert.equal(C.size, DAY)
  assert.equal(C.buckets.length, 8, 'the partial first UTC day and seven more')
  assert.equal(C.buckets[C.buckets.length - 1].from, Date.parse('2026-09-26T00:00:00Z'))
  assert.deepEqual(C.buckets[C.buckets.length - 1].by, { 'claude-opus-5-5': 2, other: 0.01 })
  assert.deepEqual(C.buckets[C.buckets.length - 2].by, { 'claude-opus-5-5': 1 })
  assert.deepEqual(C.series.map((s) => [s.key, s.cost, s.calls]), [['claude-opus-5-5', 3, 2], ['claude-haiku-4-5', 0.5, 1], ['other', 0.01, 2]])
  assert.equal(C.total, 3.51)
  const H = costByModel(rows.filter((r) => r.t > END - DAY), windowOf(END, 1))
  assert.equal(H.size, 3600000)
  assert.equal(H.buckets.length, 24)
  assert.equal(H.buckets[23].total, 2.01)
  assert.deepEqual([modelName('claude-opus-5-5'), modelName('claude-haiku-4-5-20251001'), modelName('z-ai/glm-5.3-flash')], ['Opus 5.5', 'Haiku 4.5', 'glm-5.3-flash'])
})

test('attribution: model calls go to the skill active in their turn; tools get a share of the reply that asked', () => {
  const rows = [
    { k: 'prompt', t: 1000, s: 0, a: 'main', sk: 'pdf' },
    { k: 'api', t: 2000, s: 0, a: 'main', c: 1 },
    { k: 'tool', t: 2000, s: 0, a: 'main', tl: 'Skill', sk: 'dataviz', ok: false }, // refused: not active
    { k: 'api', t: 3000, s: 0, a: 'main', c: 2 },
    { k: 'tool', t: 3000, s: 0, a: 'main', tl: 'Skill', sk: 'dataviz', ok: true },
    { k: 'tool', t: 3000, s: 0, a: 'main', tl: 'mcp__github__x', mc: 'github', ok: true },
    { k: 'api', t: 4000, s: 0, a: 'main', c: 4 },
    { k: 'api', t: 4500, s: 0, a: 'subagent:Explore', c: 8 }, // inherits the main chat's skill
    { k: 'prompt', t: 5 * MIN, s: 0, a: 'main' },
    { k: 'jev.decision', t: 5 * MIN + 300, s: 0, sk: 'unlazy', d: { injected: false } }, // a pick counts, shown or not
    { k: 'api', t: 6 * MIN, s: 0, a: 'main', c: 16 },
    { k: 'prompt', t: 10 * MIN, s: 0, a: 'main' },
    { k: 'api', t: 11 * MIN, s: 0, a: 'main', c: 32 }, // no skill
  ]
  attribute(rows)
  assert.deepEqual(rows.filter((r) => r.k === 'api').map((r) => r.as ?? null), ['pdf', 'pdf', 'dataviz', 'dataviz', 'unlazy', null])
  assert.deepEqual(rows.filter((r) => r.k === 'tool').map((r) => r.xc), [1, 1, 1], 'the reply at 3000 cost 2 and asked for two tools')
  const turns = turnsFrom(rows)
  assert.deepEqual(turns.map((t) => t.ak), [['pdf', 'dataviz'], ['unlazy'], []])
  const W = workBySkill(rows, turns)
  const by = Object.fromEntries(W.map((e) => [e.skill, e]))
  assert.deepEqual([by.dataviz.cost, by.dataviz.uses, by.dataviz.failed], [12, 2, 1])
  assert.deepEqual([by.pdf.cost, by.pdf.uses, by.unlazy.cost, by.unlazy.uses], [3, 1, 16, 1])
  assert.deepEqual([by.null.cost, by.null.calls, by.null.uses], [32, 1, 1], 'unattributed calls show as "no skill", never dropped')
  assert.equal(W.reduce((a, e) => a + e.cost, 0), 63, 'every dollar lands somewhere')
  const C = workByConnector(rows, turns)
  assert.deepEqual(C.map((e) => [e.name, e.calls, e.cost]), [['github', 1, 1]])
  const G = modelGrid(rows.map((r) => (r.k === 'api' ? { ...r, m: 'claude-opus-5-5' } : r)))
  assert.deepEqual(G.rows[0].cells.map((c) => c.cost), [32, 16, 12, 3])
})

test('subagents: runs, failures, their own cost; background runs have no time', () => {
  const rows = [
    { k: 'tool', t: 1, tl: 'Agent', st: 'Explore', ok: true, ms: 7000 },
    { k: 'tool', t: 2, tl: 'Agent', st: 'general-purpose', ok: true, ms: 1500, bg: 1 },
    { k: 'tool', t: 3, tl: 'Task', st: 'general-purpose', ok: false, ms: 900, bg: 1 },
    { k: 'api', t: 4, a: 'subagent:general-purpose', c: 5 },
    { k: 'api', t: 5, a: 'main', c: 1 },
  ]
  const S = workBySubagent(rows)
  assert.deepEqual(S.list.map((e) => [e.type, e.calls, e.failed, e.cost, e.ms, e.background ?? 0]), [['general-purpose', 2, 1, 5, null, 2], ['Explore', 1, 0, 0, 7000, 0]])
  assert.deepEqual(S.main, { cost: 1, modelCalls: 1 })
})

test('headline: spend, counts and change against the previous period only when it is tracked', () => {
  assert.deepEqual(deltaOf(12, 10), { text: 'up 20%', dir: 1 })
  assert.deepEqual(deltaOf(5, 10), { text: 'down 50%', dir: -1 })
  assert.deepEqual(deltaOf(3, 0), { text: 'new', dir: 1 })
  assert.deepEqual(deltaOf(10.01, 10), { text: 'no change', dir: 0 })
  assert.equal(deltaOf(12, 10, false), null)
  const key = (t, usage) => ({ k: 'openrouter.key', t, h: 'cloud', d: { total_credits: 10, total_usage: usage } })
  const rows = [
    key(END - 15 * DAY, 1), key(END - 8 * DAY, 1), key(END - 7 * DAY - MIN, 2), key(END - 2 * DAY, 4), key(END - MIN, 6),
    { k: 'api', t: END - DAY, h: 'cloud', c: 3 }, { k: 'api', t: END - 8 * DAY, h: 'cloud', c: 2 }, { k: 'api', t: END - DAY, h: 'cloud' },
    { k: 'prompt', t: END - DAY, h: 'cloud', a: 'main' },
    { k: 'tool', t: END - DAY, h: 'cloud', tl: 'Bash', ok: false }, { k: 'tool', t: END - DAY, h: 'cloud', tl: 'Bash', ok: true },
    { k: 'router.call', t: END - DAY, h: 'cloud', c: 0.5 },
  ]
  const R = runChecks({ rows, generatedAt: END, days: 7, since: END - 30 * DAY })
  const H = headline({ cur: R.cur, prev: R.prev, rows, window: R.window, prevTracked: R.coverage.prevTracked })
  assert.deepEqual([H.cur.claude, H.cur.unpriced, H.cur.prompts, H.cur.calls, H.cur.routed, H.cur.tools, H.cur.toolFails], [3, 1, 1, 2, 1, 2, 1])
  assert.deepEqual(H.delta.claude, { text: 'up 50%', dir: 1 })
  assert.deepEqual([H.openrouter.basis, H.openrouter.usd], ['key', 4], 'from the key check just before the period to the last one')
  assert.equal(H.openrouterPrev.usd, 1)
  assert.deepEqual(H.delta.openrouter, { text: 'up 300%', dir: 1 })
  const untracked = headline({ cur: R.cur, prev: R.prev, rows, window: R.window, prevTracked: false })
  assert.equal(untracked.delta.claude, null)
})

test('OpenRouter spend before the first balance check: routed calls before it plus the key after', () => {
  const rows = [
    { k: 'router.call', t: END - 5 * 3600000, c: 0.25 },
    { k: 'openrouter.key', t: END - 4 * 3600000, d: { total_usage: 1 } },
    { k: 'router.call', t: END - 3 * 3600000, c: 0.5 },
    { k: 'openrouter.key', t: END - 3600000, d: { total_usage: 3 } },
  ]
  assert.deepEqual([openrouterSpend(rows, END - DAY, END).basis, openrouterSpend(rows, END - DAY, END).usd], ['partial', 2.25])
  const none = openrouterSpend(rows.filter((r) => r.k === 'router.call'), END - DAY, END)
  assert.deepEqual([none.basis, none.usd], ['router', 0.75])
})

test('credit left and how long it lasts at the recent burn rate', () => {
  const key = (t, usage) => ({ k: 'openrouter.key', t, d: { total_credits: 10, total_usage: usage } })
  const b = creditBurn([key(END - 10 * DAY, 0), key(END - 2 * DAY, 4), key(END, 6)], END)
  assert.equal(b.credit, 4)
  assert.equal(b.perDay, 1, '$2 over the last 2 days of checks (the 7-day look-back skips the older one)')
  assert.equal(b.daysLeft, 4)
  assert.equal(creditBurn([key(END - 30 * MIN, 1), key(END, 2)], END).perDay, null, 'under an hour of checks: no rate')
  assert.equal(creditBurn([key(END - DAY, 2), key(END, 2)], END).daysLeft, null, 'nothing spent: no end date')
  assert.equal(creditBurn([], END), null)
  assert.deepEqual([daysWords(0.01), daysWords(0.5), daysWords(4), daysWords(90)], ['under 1 hour', '12 hours', '4 days', 'about 3 months'])
})

test('router detail, top chats and the activity feed', () => {
  const rows = [
    { k: 'prompt', t: 1000, s: 0, h: 'cloud', a: 'main' },
    { k: 'api', t: 2000, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', c: 1, i: 100, o: 5, as: 'pdf' },
    { k: 'router.call', t: 3000, s: 0, h: 'cloud', m: 'b/model', c: 0.1, ok: true, d: { category: 'quick', requested: 'a/model', fallbackFrom: 'a/model', ms: 900 } },
    { k: 'router.call', t: 3500, s: 0, h: 'cloud', m: 'a/model', ok: false, d: { category: 'quick', requested: 'a/model', error: 'x' } },
    { k: 'jev.decision', t: 4000, s: 0, h: 'cloud', sk: null, ok: false, d: { decidedBy: 'backup openrouter/free', wideMs: 100, rerankMs: 50 } },
    { k: 'tool', t: 5000, s: 0, h: 'cloud', tl: 'Agent', st: 'Explore', ok: false, ms: 20 },
    { k: 'prompt', t: 6000, s: 0, h: 'cloud', a: 'main', cx: 1 },
    { k: 'prompt', t: 6500, s: 1, h: 'local:pc', a: 'main' },
    { k: 'api', t: 7000, s: 1, h: 'local:pc', a: 'main', m: 'claude-haiku-4-5', c: 5 },
  ]
  const D = routerDetail(rows)
  assert.deepEqual(D.categories.map((c) => [c.category, c.calls, c.errors, c.fallbacks]), [['quick', 2, 1, 1]])
  assert.deepEqual(D.pairs.map((p) => [p.asked, p.answered, p.calls]), [['a/model', 'b/model', 1], ['a/model', null, 1]])
  const chats = topChats(rows, turnsFrom(rows), ['one', 'two'])
  assert.deepEqual(chats.map((c) => [c.id, c.cost, c.prompts, c.pushedBack, c.topSkill]), [['two', 5, 1, 0, null], ['one', 1, 2, 1, 'pdf']])
  assert.deepEqual(chats[1].models, ['claude-opus-5-5', 'b/model', 'a/model'])
  const f = activityFeed(rows)
  assert.deepEqual(f.map((x) => x.type), ['model', 'subagent', 'jev', 'router', 'router', 'model'], 'newest first')
  assert.deepEqual([f[2].name, f[2].model, f[2].ms, f[2].ok], ['picked nothing', 'Free backup model', 150, null], 'picking nothing is not a failure')
  assert.equal(f[1].ok, false)
  assert.deepEqual(activityFeed(rows, { type: 'router', limit: 1 }).map((x) => x.name), ['quick'])
})

test('health strip: "What to do" sits beside a pill someone has to act on, never beside a passing one', () => {
  const row = (id, state, who, todo) => ({ id, state, who, todo, word: state, icon: '·', name: id, figure: '1', about: 'a', compare: '', examples: [] })
  const html = checksHtml([row('skills', 'attention', 'You', 'Tell Claude.'), row('landing', 'pass', 'Nothing', 'Nothing to do.'), row('router', 'thin', 'Nothing', 'Nothing to do — later.')])
  const items = html.split('<li').slice(1)
  assert.match(items[0], /class="has-todo".*<\/details><div class="pill-todo"><b>What to do:<\/b> Tell Claude\./)
  assert.ok(!/pill-todo/.test(items[1]) && !/pill-todo/.test(items[2]))
})

test('the benchmark file is read from --tiers and inlined; absent it is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiers-'))
  const input = join(dir, 'events.jsonl')
  writeFileSync(input, [
    { id: 'p', kind: 'prompt', ts: new Date(END - MIN).toISOString(), session: 's', host: 'cloud', agent: 'main', data: {} },
    { id: 'a', kind: 'api', ts: new Date(END - MIN).toISOString(), session: 's', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', cost_usd: 1 },
  ].map((e) => JSON.stringify(e)).join('\n'))
  const tiers = join(dir, 'jev-tiers.json')
  writeFileSync(tiers, JSON.stringify({ ranAt: '2026-09-26T00:00:00Z', cases: 20, tiers: { jev: { right: 18, of: 20 }, paid: { right: 15, of: 20 }, free: { right: 9, of: 20 } } }))
  const script = fileURLToPath(new URL('../scripts/dashboard.mjs', import.meta.url))
  const run = (extra) => spawnSync(process.execPath, [script, '--input', input, '--state-dir', dir, '--out', join(dir, 'page.html'), '--now', new Date(END).toISOString(), '--force', ...extra], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
  assert.equal(run(['--tiers', tiers]).status, 0)
  assert.equal(extractData(readFileSync(join(dir, 'page.html'), 'utf8')).jevTiers.tiers.free.rate, 0.45)
  assert.equal(run(['--tiers', join(dir, 'missing.json')]).status, 0)
  assert.equal(extractData(readFileSync(join(dir, 'page.html'), 'utf8')).jevTiers, null)
  const data = buildPayload([], { now: END })
  assert.ok('jevTiers' in data)
  assert.ok(render(data).includes('Not run yet'))
})

test('skills check: only real blocks count; wrong names and pre-fix blocks are listed apart', async () => {
  const { skillRefusalOf } = await import('../scripts/lib.mjs')
  assert.equal(skillRefusalOf([{ type: 'text', text: 'Unknown skill: artifact-design' }]), 'not-installed')
  assert.equal(skillRefusalOf('Skill dataviz is disabled by skillOverrides'), 'blocked')
  assert.equal(skillRefusalOf('something else'), 'failed')
  const fix = Date.parse('2026-09-26T14:16:47Z')
  const H = 3600000
  const rows = [
    { k: 'prompt', t: fix - H, s: 0, a: 'main' }, // an old chat
    { k: 'tool', t: fix - H + 1, s: 0, tl: 'Skill', sk: 'dataviz', ok: false }, // blocked before the fix, cause not recorded
    { k: 'tool', t: fix + H, s: 0, tl: 'Skill', sk: 'unlazy', ok: false }, // same old chat, after the fix time, cause not recorded
    { k: 'tool', t: fix + H, s: 0, tl: 'Skill', sk: 'artifact-design', ok: false, rf: 'not-installed' },
    { k: 'prompt', t: fix + 2 * H, s: 1, a: 'main' }, // a new chat
    { k: 'tool', t: fix + 2 * H + 1, s: 1, tl: 'Skill', sk: 'pdf', ok: true },
  ]
  const R = runChecks({ rows, turns: [], generatedAt: fix + 3 * H, days: 1 })
  const c = R.checks.find((x) => x.id === 'skills')
  assert.equal(c.state, 'pass')
  assert.equal(c.figure, '0 of 4 refused (3 more not counted)')
  assert.ok(c.lines.some((l) => l.startsWith('Not counted, fixed since: ')))
  assert.ok(c.lines.some((l) => l.includes('artifact-design') && l.includes('not installed')))
  rows.push({ k: 'tool', t: fix + 2 * H + 2, s: 1, tl: 'Skill', sk: 'dataviz', ok: false, rf: 'blocked' })
  const R2 = runChecks({ rows, turns: [], generatedAt: fix + 3 * H, days: 1 })
  assert.equal(R2.checks.find((x) => x.id === 'skills').state, 'attention')
})

test('only what a person typed is a prompt: notifications, peers and continuation summaries are not', async () => {
  const { typedByPerson } = await import('../scripts/lib.mjs')
  assert.equal(typedByPerson({ origin: { kind: 'human' }, message: { content: 'fix it' } }), true)
  assert.equal(typedByPerson({ origin: { kind: 'task-notification' }, message: { content: '<task-notification>' } }), false)
  assert.equal(typedByPerson({ origin: { kind: 'peer' }, message: { content: 'hello' } }), false)
  assert.equal(typedByPerson({ message: { content: 'This session is being continued from a previous conversation that ran out' } }), false)
  assert.equal(typedByPerson({ message: { content: [{ type: 'text', text: 'plain old prompt' }] } }), true)
})

test('Jev deciding counts a chat from when the current Jev loaded (its group record), not from stray earlier decisions', () => {
  const fix = Date.parse('2026-09-26T14:16:47Z')
  const at = (m) => fix + m * 60000
  const rows = [
    { k: 'prompt', t: at(100), s: 0, h: 'cloud', a: 'main' },
    { k: 'jev.decision', t: at(101), s: 0, h: 'cloud', d: { decidedBy: 'jev' } }, // a test run's line
    { k: 'prompt', t: at(110), s: 0, h: 'cloud', a: 'main' },
    { k: 'prompt', t: at(120), s: 0, h: 'cloud', a: 'main' },
    { k: 'jev.arm', t: at(200), s: 0, h: 'cloud', d: { arm: 'on' } },
    { k: 'prompt', t: at(200), s: 0, h: 'cloud', a: 'main' },
    { k: 'jev.decision', t: at(200) + 500, s: 0, h: 'cloud', d: { decidedBy: 'jev' } },
  ]
  const c = runChecks({ fixes: { skills: fix, jevLog: fix }, rows, generatedAt: at(260), days: 1, since: at(0) }).checks.find((x) => x.id === 'jev-deciding')
  assert.equal(c.figure, '100% decided')
  assert.equal(c.stats.left.none, 3)
})
