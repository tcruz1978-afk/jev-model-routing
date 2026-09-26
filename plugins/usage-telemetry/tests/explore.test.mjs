// The master dashboard's engine: grouping, metrics, filters, the URL hash and CSV.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DAY, attribute } from '../scripts/checks.mjs'
import {
  DEFAULT_VIEW, HOUR, accFigures, addTo, bucketStart, bucketsFor, buildIndex, csvCell, decodeView, dimKey, dimLabel, drillFilters, encodeView,
  eventFields, groupRows, logIndices, logsCsv, matcher, metricById, metricText, newAcc, periodOf, quantile, seriesFrom, toCsv,
} from '../scripts/explore.mjs'
import { buildPayload, compact, render } from '../scripts/dashboard.mjs'
import { bannedIn, checkCardsHtml, plainChecks, visibleText } from '../scripts/present.mjs'
import { runChecks } from '../scripts/checks.mjs'

const END = Date.parse('2026-09-26T18:00:00Z') // a Saturday
const D0 = Date.parse('2026-09-25T00:00:00Z'), D1 = Date.parse('2026-09-26T00:00:00Z')

const rows = [
  { k: 'prompt', t: D0 + 1 * HOUR, s: 0, h: 'cloud', a: 'main', sk: 'pdf' },
  { k: 'api', t: D0 + 1 * HOUR + 10, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', c: 2, i: 1000, cr: 800, o: 100 },
  { k: 'tool', t: D0 + 1 * HOUR + 20, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', tl: 'Bash', ok: true, ms: 100 },
  { k: 'tool', t: D0 + 1 * HOUR + 30, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', tl: 'mcp__github__get_me', mc: 'github', ok: false, ms: 300 },
  { k: 'prompt', t: D1 + 2 * HOUR, s: 1, h: 'local:pc', a: 'main' },
  { k: 'api', t: D1 + 2 * HOUR + 10, s: 1, h: 'local:pc', a: 'main', m: 'claude-haiku-4-5', c: 1, i: 400, cr: 0, o: 100 },
  { k: 'api', t: D1 + 2 * HOUR + 20, s: 1, h: 'local:pc', a: 'subagent:Explore', m: 'claude-haiku-4-5', i: 100, o: 0 }, // no price
  { k: 'router.call', t: D1 + 3 * HOUR, s: 1, h: 'local:pc', m: 'z-ai/glm', c: 0.5, i: 50, o: 50, ok: false, d: { category: 'quick', ms: 900 } },
  { k: 'jev.decision', t: D1 + 2 * HOUR + 5, s: 1, h: 'local:pc', sk: 'unlazy', d: { decidedBy: 'backup openrouter/free', wideMs: 100, rerankMs: 100 } },
  { k: 'jev.miss', t: D1 + 2 * HOUR + 60000, s: 1, h: 'local:pc', d: { jevPick: 'unlazy', signal: 'typed-after' } },
]
attribute(rows)
const ix = buildIndex(rows, ['chat-a', 'chat-b'])

test('quantiles: linear between the nearest values; p50 and p90', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(quantile(xs, 0.5), 5.5)
  assert.equal(Math.round(quantile(xs, 0.9) * 100) / 100, 9.1)
  assert.equal(quantile([7], 0.9), 7)
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([3, null, 1, NaN], 0.5), 2, 'non-numbers are left out')
})

test('metrics: cache hit rate, blended cost per million tokens, failures and time', () => {
  const a = newAcc()
  for (const r of rows) addTo(a, r, false)
  const f = accFigures(a)
  assert.equal(f.cacheRate, 800 / 1550, 'cache reads over everything read (1000 + 400 + 100 + 50)')
  // Priced calls only: $3.50 over (1100 + 500 + 100) tokens.
  assert.equal(Math.round(f.costPerM * 100) / 100, Math.round((3.5 / 1700) * 1e6 * 100) / 100)
  assert.deepEqual([f.claude, f.openrouter, f.cost, f.unpriced, f.calls, f.prompts], [3, 0.5, 3.5, 1, 4, 2])
  assert.deepEqual([f.tools, f.toolFails, f.failures, f.judged], [2, 1, 2, 3], 'tool failures, and failures across tools and routed calls')
  assert.deepEqual([f.p50, f.timed], [250, 4], 'tools 100 and 300, the routed call 900, Jev 200')
  const M = metricById('failRate')
  assert.equal(metricText(M, a), '67% (2 of 3 calls)', 'a rate always shows its count')
  assert.equal(metricText(metricById('cacheRate'), newAcc()), '— (none of 0 input tokens)')
})

test('dimension keys: model, provider, skill (the active one), subagent, tier, outcome', () => {
  const k = (id, r) => dimKey(id, r, ['chat-a', 'chat-b'])
  assert.deepEqual([k('model', rows[1]), k('model', rows[7]), k('provider', rows[1]), k('provider', rows[7])], ['claude-opus-5-5', 'or:z-ai/glm', 'Anthropic', 'OpenRouter: z-ai'])
  assert.deepEqual([k('skill', rows[1]), k('skill', rows[2]), k('skill', rows[8]), k('skill', rows[9]), k('skill', rows[5])], ['pdf', 'pdf', 'unlazy', 'unlazy', 'unlazy'], 'model and tool calls carry the active skill; a Jev pick counts')
  assert.deepEqual([k('subagent', rows[6]), k('subagent', rows[5]), k('tier', rows[8]), k('outcome', rows[3]), k('outcome', rows[1]), k('chat', rows[4])], ['Explore', '', 'free-backup', 'failed', 'ok', 'chat-b'])
  assert.equal(dimLabel('model', 'or:z-ai/glm-5.3-flash'), 'glm-5.3-flash (OpenRouter)')
  assert.equal(dimLabel('tool', 'mcp__github__get_me'), 'github · get_me')
  assert.equal(dimLabel('skill', ''), 'no skill')
  assert.equal(dimLabel('tier', 'free-backup'), 'Free backup model · free')
})

test('buckets: UTC hours and days, weeks from Monday; the period is half-open (from, to]', () => {
  assert.equal(bucketStart(END - 1, 'day'), D1)
  assert.equal(bucketStart(END, 'week'), Date.parse('2026-09-21T00:00:00Z'))
  assert.equal(bucketStart(D1 + 90 * 60000, 'hour'), D1 + HOUR)
  assert.deepEqual(bucketsFor(D1, D1 + 3 * HOUR, 'hour'), [D1, D1 + HOUR, D1 + 2 * HOUR, D1 + 3 * HOUR])
  assert.equal(bucketsFor(END - 7 * DAY, END, 'day').length, 8, 'a partial first day and seven more')
})

test('grouping: two dimensions × a day grain, ranked, with every dollar in some cell', () => {
  const res = groupRows(ix, { from: END - 7 * DAY, to: END, dims: ['model', 'skill'], grain: 'day', metric: 'spend', filters: drillFilters('spend') })
  assert.equal(res.times.length, 8)
  assert.deepEqual(res.groups.map((g) => [g.keys, g.value]), [[['claude-opus-5-5', 'pdf'], 2], [['claude-haiku-4-5', 'unlazy'], 1], [['or:z-ai/glm', 'unlazy'], 0.5]])
  const opus = res.groups[0]
  assert.equal(opus.cells.findIndex(Boolean), res.times.indexOf(D0), 'Sep 25')
  assert.equal(res.total.value, 3.5)
  const cellSum = res.groups.reduce((a, g) => a + g.cells.reduce((b, c) => b + (c ? c.claude + c.or : 0), 0), 0)
  assert.equal(cellSum, 3.5)
  const ranked = groupRows(ix, { from: END - 7 * DAY, to: END, dims: ['tool'], metric: 'tools' })
  assert.equal(ranked.times, null, 'no time axis: a ranked table')
  assert.deepEqual(ranked.groups.filter((g) => g.value).map((g) => g.keys[0]).sort(), ['Bash', 'mcp__github__get_me'])
  const rate = groupRows(ix, { from: END - 7 * DAY, to: END, dims: ['tier'], metric: 'missRate', filters: drillFilters('missRate') })
  assert.deepEqual(rate.groups.map((g) => [g.keys[0], g.value]), [['free-backup', 1]], 'the miss is matched to its decision, so the rate splits by tier')
  const S = seriesFrom(groupRows(ix, { from: END - 7 * DAY, to: END, dims: ['model'], grain: 'day', metric: 'spend' }), 1)
  assert.equal(S.length, 2)
  assert.equal(S[1].other, true)
  assert.equal(S[1].value, 1.5, 'the rest merge into "other"')
  assert.equal(S[0].values.length, 8)
})

test('filters: AND across dimensions, OR within one; machines; text search; logs newest first', () => {
  const all = { from: END - 7 * DAY, to: END }
  const pos = (f) => logIndices(ix, { ...all, ...f }).map((i) => ix.rows[i])
  assert.deepEqual(pos({ filters: { type: ['model'] } }).map((r) => r.m), ['claude-haiku-4-5', 'claude-haiku-4-5', 'claude-opus-5-5'], 'newest first')
  assert.equal(pos({ filters: { type: ['model', 'router'], machine: ['local:pc'] } }).length, 3)
  assert.equal(pos({ host: 'cloud' }).length, 4)
  assert.equal(pos({ host: 'local' }).length, 6)
  assert.deepEqual(pos({ q: 'github' }).map((r) => r.tl), ['mcp__github__get_me'])
  assert.deepEqual(pos({ q: 'bash pdf' }).map((r) => r.tl), ['Bash'], 'every word must match')
  assert.equal(pos({ filters: { skill: ['nope'] } }).length, 0, 'a key not in the data matches nothing')
  assert.equal(pos({ from: D1, to: END }).length, 6, 'the period is (from, to]')
  assert.deepEqual(pos({ filters: { skill: ['pdf'] } }).map((r) => r.k), ['tool', 'tool', 'api', 'prompt'], 'a skill holds everything done while it was active')
  const bare = buildIndex([{ k: 'api', t: END - 1, h: 'cloud', c: 1 }])
  const m = matcher(bare, { filters: { skill: [''] } })
  assert.ok(m(0), '"no skill" is a key like any other')
  assert.deepEqual(drillFilters('spend', { model: ['x'] }), { model: ['x'], type: ['model', 'router'] })
  assert.deepEqual(drillFilters('claude', { type: ['model', 'tool'] }).type, ['model'])
  assert.deepEqual(drillFilters('events', { a: ['b'] }), { a: ['b'] })
})

test('the view round-trips through the URL hash; anything malformed falls back', () => {
  const v = { ...DEFAULT_VIEW, tab: 'explore', p: 'custom', from: '2026-09-01', to: '2026-09-20', h: 'local', m: 'p90', g: ['model', 'skill'], c: 'dot', t: 'week',
    f: { skill: ['', 'a,b & c'], model: ['or:z-ai/glm'] }, q: 'git hub', pg: 3, lf: 100, lt: 200 }
  const hash = encodeView(v)
  assert.ok(hash.startsWith('explore?'))
  assert.deepEqual(decodeView('#' + hash), v)
  assert.equal(encodeView(DEFAULT_VIEW), 'overview', 'defaults stay out of the link')
  assert.deepEqual(decodeView(''), DEFAULT_VIEW)
  const bad = decodeView('#nope?p=12&m=x&g=model,zzz,skill,tool&c=pie&t=year&f.zzz=1&pg=-4&lf=5&lt=2&from=2026-99-01')
  assert.deepEqual([bad.tab, bad.p, bad.m, bad.g, bad.c, bad.t, bad.f, bad.pg, bad.lf], ['overview', '7', 'spend', ['model', 'skill'], 'bar', 'day', {}, 0, null])
  assert.deepEqual(decodeView('#logs?g=none').g, [])
  const P = periodOf({ p: 'custom', from: '2026-09-20', to: '2026-09-26' }, END)
  assert.deepEqual([P.days, P.to, P.custom], [7, END, true], 'custom days are inclusive and cut at the build time')
  assert.equal(periodOf({ p: 'custom', from: '2026-09-26', to: '2026-09-20' }, END).days, 7, 'backwards dates fall back to 7 days')
  assert.equal(periodOf({ p: '30' }, END).from, END - 30 * DAY)
})

test('CSV: commas, quotes, line breaks and formulas are escaped', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('two\nlines'), '"two\nlines"')
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(csvCell('-1+1'), "'-1+1")
  assert.equal(csvCell(-1.5), '-1.5', 'numbers stay numbers')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(NaN), '')
  assert.equal(csvCell(' pad'), '" pad"')
  assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n')
  const csv = logsCsv(ix, logIndices(ix, { from: END - 7 * DAY, to: END, filters: { type: ['model'] } }))
  const lines = csv.trim().split('\r\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^time_utc,machine,chat,type,name,model,tokens_in/)
  assert.match(lines[3], /^2026-09-25T01:00:00\.010Z,cloud,chat-a,Model call,Main chat · pdf,claude-opus-5-5,1000,800,100,2,/)
})

test('the logs carry every field of an event, and never any text anyone typed', () => {
  const fields = Object.fromEntries(eventFields(rows[7], ['chat-a', 'chat-b']))
  assert.equal(fields.Chat, 'chat-b')
  assert.equal(fields.Result, 'failed')
  assert.equal(fields.category, 'quick')
  const events = [
    { id: 'p', kind: 'prompt', ts: new Date(END - 60000).toISOString(), session: 's', host: 'cloud', agent: 'main', data: { text: 'secret plans' } },
    { id: 'a', kind: 'api', ts: new Date(END - 50000).toISOString(), session: 's', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', input_tokens: 10, cache_read_tokens: 90, cache_write_tokens: 5, cost_usd: 1 },
  ]
  const { rows: r } = compact(events, { now: END })
  assert.deepEqual([r[1].i, r[1].cr, r[1].cw], [105, 90, 5], 'cache reads and writes kept apart for the hit rate')
  assert.ok(!JSON.stringify(r).includes('secret'))
})

test('the page: tabs in order, the engine inlined, health cards in plain words', () => {
  const data = buildPayload([
    { id: 'p', kind: 'prompt', ts: new Date(END - 60000).toISOString(), session: 's', host: 'cloud', agent: 'main' },
    { id: 'a', kind: 'api', ts: new Date(END - 50000).toISOString(), session: 's', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', cost_usd: 1 },
  ], { now: END })
  const html = render(data)
  const tabs = ['overview', 'explore', 'logs', 'jev', 'router', 'health'].map((t) => html.indexOf(`id="tab-${t}"`))
  assert.ok(tabs.every((i) => i > 0))
  assert.deepEqual([...tabs].sort((a, b) => a - b), tabs)
  assert.ok(html.includes('function groupRows') && html.includes('function decodeView'), 'the engine is inlined')
  assert.ok(html.includes('<title>Claude Usage Monitor</title>'))
  const R = runChecks({ rows: data.rows, turns: data.turns, generatedAt: END, days: 7, since: Date.parse(data.firstEventAt) })
  const cards = checkCardsHtml(plainChecks(R, { days: 7, end: END }))
  assert.equal((cards.match(/<article class="hcard/g) || []).length, 7)
  assert.deepEqual(bannedIn(visibleText(cards)), [])
})

test('the log CSV is saved through the downloads capability, and every outcome is said in words', async () => {
  const { logsCsvName, saveFile } = await import('../scripts/explore.mjs')
  assert.equal(logsCsvName(Date.parse('2026-09-26T18:53:00Z'), 1858), 'claude-usage-2026-09-26-1858-events.csv')
  const saved = []
  const ok = { save: async (req) => { saved.push(req); return { status: 'saved' } } }
  assert.deepEqual(await saveFile(ok, 'a.csv', 'x,y\r\n'), { text: 'Saved.', hide: false })
  assert.deepEqual(saved, [{ filename: 'a.csv', data: 'x,y\r\n' }])
  const failing = (code) => ({ save: async () => { throw { code, message: 'm' } } })
  assert.deepEqual(await saveFile(failing('declined'), 'a.csv', 'x'), { text: 'Not saved.', hide: false })
  assert.match((await saveFile(failing('rate_limited'), 'a.csv', 'x')).text, /already waiting/)
  assert.match((await saveFile(failing('too_large'), 'a.csv', 'x')).text, /Filter the list down/)
  assert.equal((await saveFile(failing('unavailable'), 'a.csv', 'x')).hide, true)
  assert.equal((await saveFile(failing('something_new'), 'a.csv', 'x')).hide, true, 'unknown codes read as unavailable')
  assert.deepEqual(await saveFile(null, 'a.csv', 'x'), { text: "Saving files isn't available here.", hide: true })
})

test('the page saves the CSV through the viewer, never with its own download link inside Claude', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.ok(html.includes("window.claude.use('downloads')"))
  assert.ok(html.includes('saveFile(downloads, name, csv)'))
  assert.ok(html.includes('id="lg-msg"'))
})
