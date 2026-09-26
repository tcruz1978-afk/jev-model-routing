import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, dedupe, eventFromLog, eventsFromTranscript, flushPending, keySnapshot, mcpServerOf, priceOf, slashCommandOf, suggestedSkillOf, transcriptOf } from '../scripts/lib.mjs'
import { compact, readEvents, render } from '../scripts/dashboard.mjs'

const line = (o) => JSON.stringify({ sessionId: 's1', cwd: '/home/user', timestamp: '2026-09-26T14:00:00.000Z', ...o })

test('priceOf matches the longest prefix, dated ids included', () => {
  assert.equal(priceOf('claude-opus-5-5').input, 4)
  assert.equal(priceOf('claude-opus-5').input, 5)
  assert.equal(priceOf('claude-haiku-4-5-20251001').input, 1)
  assert.equal(priceOf('claude-sonnet-4-6').input, 3)
  assert.equal(priceOf('gpt-6'), null)
})

test('costOf prices input, both cache writes, cache reads and output', () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } }
  // Opus 5.5: 4 + 5 (5m) + 8 (1h) + 0.2 (read, 0.05x) + 20
  assert.equal(Math.round(costOf('claude-opus-5-5', usage) * 100) / 100, 37.2)
  assert.equal(costOf('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40)
  assert.equal(costOf('unknown-model', usage), null)
})

test('transcriptOf tells main conversations from subagents', () => {
  assert.deepEqual(transcriptOf('/p/-home-user/abc.jsonl', '/p'), { project: '-home-user', session: 'abc', agentId: null })
  assert.deepEqual(transcriptOf('/p/-home-user/abc/subagents/agent-x1.jsonl', '/p'), { project: '-home-user', session: 'abc', agentId: 'x1' })
  assert.deepEqual(transcriptOf('/p/-home-user/abc/subagents/wf/agent-x2.jsonl', '/p'), { project: '-home-user', session: 'abc', agentId: 'x2' })
  assert.equal(transcriptOf('/p/-home-user/abc/other.jsonl', '/p'), null)
})

test('one API response written as several lines counts once, with its last usage', () => {
  const lines = [
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: 'hi' }] } }),
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 9 }, content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'pdf' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'disabled' }] }, timestamp: '2026-09-26T14:00:02.000Z' }),
  ]
  const events = eventsFromTranscript(lines, { session: 's1', project: 'x', agentId: null, host: 'cloud' }, {})
  const api = events.filter((e) => e.kind === 'api')
  assert.equal(api.length, 1)
  assert.equal(api[0].output_tokens, 9)
  const tool = events.find((e) => e.kind === 'tool')
  assert.equal(tool.skill, 'pdf')
  assert.equal(tool.ok, false)
  assert.equal(tool.data.ms, 2000)
  assert.equal(tool.project, 'user')
})

test('a tool use waits for its result across runs, and can be flushed', () => {
  const pending = {}
  const ctx = { session: 's1', project: 'x', agentId: 'a1', agentType: 'Explore', host: 'local:pc' }
  const first = eventsFromTranscript([line({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 't2', name: 'mcp__github__get_me', input: {} }] } })], ctx, pending)
  assert.equal(first.filter((e) => e.kind === 'tool').length, 0)
  assert.equal(first[0].agent, 'subagent:Explore')
  const second = eventsFromTranscript([line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } })], ctx, pending)
  assert.equal(second[0].mcp_server, 'github')
  assert.equal(second[0].ok, true)
  eventsFromTranscript([line({ type: 'assistant', message: { id: 'm3', model: 'x', usage: {}, content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] } })], ctx, pending)
  assert.equal(flushPending(pending)[0].ok, null)
  assert.deepEqual(pending, {})
})

test('prompts, typed slash commands and Jev suggestions are recorded without their text', () => {
  const events = eventsFromTranscript([
    line({ type: 'user', uuid: 'u1', message: { content: 'secret plans' } }),
    line({ type: 'user', uuid: 'u2', message: { content: '<command-name>/morning</command-name>' } }),
    line({ type: 'attachment', uuid: 'a1', attachment: { type: 'hook_additional_context', content: ['<skill_relevance>\nRelevant to the current request: workflow-design. Ignore this'] } }),
  ], { session: 's1', project: 'x', agentId: null, host: 'cloud' }, {})
  assert.deepEqual(events.map((e) => [e.kind, e.skill]), [['prompt', null], ['prompt', 'morning'], ['jev.suggested', 'workflow-design']])
  assert.ok(!JSON.stringify(events).includes('secret'))
})

test('helpers', () => {
  assert.equal(mcpServerOf('mcp__Claude_Code_Remote__get_session'), 'Claude_Code_Remote')
  assert.equal(mcpServerOf('Bash'), null)
  assert.equal(slashCommandOf([{ type: 'text', text: '<command-name>jev-skill-suggestion:setup</command-name>' }]), 'jev-skill-suggestion:setup')
  assert.equal(suggestedSkillOf('Relevant to the current request: jev-skill-suggestion:model-router. Ignore'), 'jev-skill-suggestion:model-router')
  assert.deepEqual(dedupe([{ id: 'a', v: 1 }, { id: 'a', v: 2 }]), [{ id: 'a', v: 2 }])
})

test('jev-log lines become events', () => {
  const decision = eventFromLog(JSON.stringify({ kind: 'jev.decision', ts: 't', session: 's', decidedBy: 'jev', pick: 'pdf', gate: 0.5, top: [], reason: 'r' }), 'cloud')
  assert.equal(decision.skill, 'pdf')
  assert.equal(decision.ok, true)
  const call = eventFromLog(JSON.stringify({ kind: 'router.call', ts: 't', session: 's', model: 'a/b', costUsd: 0.1, generationId: 'g1', error: null }), 'cloud')
  assert.equal(call.id, 'router:g1')
  assert.equal(call.cost_usd, 0.1)
  assert.equal(eventFromLog('{nope', 'cloud'), null)
  const key = keySnapshot({ label: 'k', usage: 1, limit: 50 }, { total_credits: 10, total_usage: 2 }, 'cloud', new Date('2026-09-26T14:30:00Z'))
  assert.equal(key.id, 'orkey:k:2026-09-26T14')
})

test('the dashboard carries compact rows and no raw text', () => {
  const events = [
    { id: 'api:1', kind: 'api', ts: '2026-09-26T14:00:00Z', session: 's1', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', output_tokens: 3, cost_usd: 0.1, data: {} },
    { id: 'api:1', kind: 'api', ts: '2026-09-26T14:00:00Z', session: 's1', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', output_tokens: 4, cost_usd: 0.2, data: {} },
    { id: 'old', kind: 'api', ts: '2020-01-01T00:00:00Z', session: 's0', host: 'cloud', data: {} },
  ]
  const payload = compact(events, { days: 90, now: Date.parse('2026-09-27T00:00:00Z') })
  assert.equal(payload.rows.length, 1)
  assert.equal(payload.rows[0].o, 4)
  assert.deepEqual(payload.sessions, ['s1'])
  const html = render(payload)
  assert.ok(html.includes('"rows":[{'))
  assert.ok(!html.includes('/*__DATA__*/'))
  assert.equal(readEvents('{"id":"a"}\n{bad\n{"id":"b"}\n').length, 2)
  assert.equal(readEvents('[{"id":"a"}]').length, 1)
})

test('turnsFrom splits a session at each prompt and sums the work in between', async () => {
  const { turnsFrom } = await import('../scripts/turns.mjs')
  const rows = [
    { k: 'prompt', t: 1000, s: 0, h: 'cloud', a: 'main', cat: 'fix' },
    { k: 'api', t: 1100, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', i: 10, o: 50, c: 0.5 },
    { k: 'api', t: 1200, s: 0, h: 'cloud', a: 'main', m: 'claude-sonnet-4-6', i: 10, o: 20, c: 0.1 },
    { k: 'tool', t: 1300, s: 0, h: 'cloud', a: 'main', tl: 'Agent', ok: true },
    { k: 'api', t: 1400, s: 0, h: 'cloud', a: 'subagent:Explore', m: 'claude-haiku-4-5', o: 900, c: 0.01 },
    { k: 'tool', t: 1500, s: 0, h: 'cloud', a: 'subagent:Explore', tl: 'Bash', ok: false },
    { k: 'tool', t: 1600, s: 0, h: 'cloud', a: 'main', tl: 'Skill', sk: 'pdf', ok: true },
    { k: 'router.call', t: 1700, s: 0, h: 'cloud', m: 'z-ai/glm', c: 0.02 },
    { k: 'prompt', t: 5000, s: 0, h: 'cloud', a: 'main', cat: 'fix', cx: 1 },
    { k: 'api', t: 5200, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', o: 5, c: 0.2 },
    { k: 'prompt', t: 9000, s: 0, h: 'cloud', a: 'main', cat: 'reply' },
    // another session, interleaved in time; its lone turn has no outcome yet
    { k: 'api', t: 900, s: 1, h: 'local:mac', a: 'main', m: 'claude-opus-5-5', o: 1 },
    { k: 'prompt', t: 1050, s: 1, h: 'local:mac', a: 'main', sl: 1 },
    { k: 'api', t: 1150, s: 1, h: 'local:mac', a: 'main', m: 'claude-opus-5-5', o: 3, c: 0.03 },
    { k: 'api', t: 50, s: -1, h: 'cloud', m: 'claude-opus-5-5', o: 3 },
  ]
  const turns = turnsFrom(rows)
  assert.equal(turns.length, 4)
  const [first, other, second, last] = turns
  assert.equal(first.cat, 'fix')
  assert.equal(first.m, 'claude-opus-5-5') // most main-agent output; the subagent's Haiku output does not count
  assert.deepEqual(first.ms.sort(), ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-4-6'])
  assert.equal(first.c, 0.61) // Claude API-equivalent only
  assert.equal(first.rc, 0.02) // routed OpenRouter cost, kept apart
  assert.equal(first.dur, 700)
  assert.equal(first.tl, 3)
  assert.equal(first.tf, 1)
  assert.equal(first.sa, 1)
  assert.deepEqual(first.sk, ['pdf'])
  assert.equal(first.land, false) // the next prompt pushed back
  assert.equal(second.land, true)
  assert.equal(second.c, 0.2)
  assert.equal(last.land, null) // last turn of the session: unknown
  assert.equal(last.m, null)
  assert.equal(last.dur, 0)
  assert.equal(other.h, 'local:mac')
  assert.equal(other.cat, 'command')
  assert.equal(other.land, null)
  assert.equal(other.c, 0.03)
})

test('compact carries turns built from its own rows', () => {
  const ev = (o) => ({ host: 'cloud', session: 'a', agent: 'main', ...o })
  const events = [
    ev({ id: 'p1', kind: 'prompt', ts: '2026-09-26T10:00:00Z', data: { category: 'build' } }),
    ev({ id: 'a1', kind: 'api', ts: '2026-09-26T10:00:05Z', model: 'claude-opus-5-5', output_tokens: 7, cost_usd: 0.1 }),
    ev({ id: 'p2', kind: 'prompt', ts: '2026-09-26T10:05:00Z', data: { category: 'fix', correction: true } }),
  ]
  const { turns } = compact(events, { now: Date.parse('2026-09-26T12:00:00Z') })
  assert.equal(turns.length, 2)
  assert.deepEqual([turns[0].cat, turns[0].m, turns[0].land, turns[0].dur], ['build', 'claude-opus-5-5', false, 5000])
  assert.equal(turns[1].land, null)
})

import { decisionFor, detectMisses, judgeTurn, remember, saveLocalMisses } from '../scripts/misses.mjs'
import { mkdtempSync, readFileSync as readText } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

const at = (m) => new Date(Date.parse('2026-09-26T14:00:00Z') + m * 60000).toISOString()
const prompt = (uuid, m, extra = {}) => ({ id: `prompt:${uuid}`, kind: 'prompt', ts: at(m), session: 's', agent: 'main', skill: extra.slash ?? null, data: { correction: Boolean(extra.correction) } })
const decision = (m, pick, top = []) => ({ id: `jev:s:${m}`, kind: 'jev.decision', ts: at(m), session: 's', skill: pick, data: { top, gate: 0.5, reason: 'r' } })

test('judgeTurn names each miss signal, and a clean turn raises none', () => {
  const p = { uuid: 'a', t: 0, slash: null }
  assert.deepEqual(judgeTurn(p, { t: 10, slash: 'pdf' }, { pick: null, top: [] }, []), { signal: 'typed-after', expected: 'pdf' })
  assert.deepEqual(judgeTurn(p, { t: 10 }, { pick: 'x', top: [] }, [{ t: 5, skill: 'y', ok: true }]), { signal: 'claude-loaded-other', expected: 'y' })
  assert.deepEqual(judgeTurn(p, { t: 10, correction: true }, { pick: 'x', top: [] }, []), { signal: 'picked-then-corrected', expected: null })
  assert.deepEqual(judgeTurn(p, { t: 10 }, { pick: null, top: [{ name: 'wf', probability: 1 }] }, []), { signal: 'dropped-decisive', expected: 'wf' })
  assert.equal(judgeTurn(p, { t: 10 }, { pick: 'x', top: [] }, [{ t: 5, skill: 'x', ok: true }]), null)
  assert.equal(judgeTurn(p, { t: 10 }, null, []), null)
  assert.equal(judgeTurn({ ...p, slash: 'pdf' }, { t: 10, slash: 'x' }, { pick: null }, []), null)
})

test('decisionFor prefers a logged decision over a transcript suggestion, within two minutes', () => {
  const p = { t: 0 }
  assert.equal(decisionFor([{ t: 1000, full: false, pick: 'a' }, { t: 3000, full: true, pick: 'b' }], p).pick, 'b')
  assert.equal(decisionFor([{ t: 500000, full: true, pick: 'far' }], p), null)
})

test('misses ship without words; the words go only to the local file, and are forgotten once checked', () => {
  const texts = { p1: 'Design the vendor onboarding approval flowchart', p2: 'use /workflow-design', p3: 'thanks' }
  const events = [prompt('p1', 0), decision(0, null, [{ name: 'workflow-design', probability: 1 }]), prompt('p2', 2, { slash: 'workflow-design' }), prompt('p3', 4)]
  const state = remember({}, events, texts)
  const { events: shipped, local } = detectMisses(state, 'cloud', Date.parse(at(5)))
  assert.equal(shipped.length, 1)
  assert.equal(shipped[0].kind, 'jev.miss')
  assert.equal(shipped[0].skill, 'workflow-design')
  assert.equal(shipped[0].data.signal, 'typed-after')
  assert.ok(!JSON.stringify(shipped).includes('vendor'), 'no prompt words in shipped events')
  assert.equal(local[0].prompt, texts.p1)
  assert.equal(state.s.prompts[0].text, null, 'checked prompts drop their words from state')
  assert.equal(detectMisses(state, 'cloud', Date.parse(at(6))).events.length, 0, 'a turn is checked once')
  const dir = mkdtempSync(joinPath(tmpdir(), 'misses-'))
  const file = joinPath(dir, 'misses.jsonl')
  saveLocalMisses(file, [...local, { id: 'old', ts: '2026-09-01T00:00:00Z' }], Date.parse(at(6)))
  assert.deepEqual(readText(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['miss:p1'])
  detectMisses(state, 'cloud', Date.parse(at(6)) + 8 * 86400000)
  assert.deepEqual(state, {}, 'sessions quiet for a week are dropped')
})

// ---------- the dashboard's checks, guards and refresh machinery ----------

import { DAY, TARGETS, TARGET_NOTES, failingTools, fmtTime, isStale, landStats, median, reconcile, runChecks, trendBuckets, verdictOf, windowOf } from '../scripts/checks.mjs'
import { buildPayload, checkGuards, extractData, latestSnapshot, missingKeys, parseEvents, runLine, snapshot, sourceProblem, whatMoved } from '../scripts/dashboard.mjs'
import { projectLabel } from '../scripts/lib.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync as writeText } from 'node:fs'
import { fileURLToPath } from 'node:url'

const END = Date.parse('2026-09-26T15:00:00Z')
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]))
const mins = (m) => END - m * 60000

test('median of an even list is the mean of the two middles', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([null, 5]), 5)
  assert.equal(median([]), null)
})

test('staleness is measured from the build time, 26 h', () => {
  assert.equal(isStale('2026-09-26T15:00:00Z', END + 25 * 3600000), false)
  assert.equal(isStale('2026-09-26T15:00:00Z', END + 27 * 3600000), true)
  assert.equal(isStale('not a date', END), true)
  const w = windowOf(END, 7)
  assert.deepEqual([w.from, w.to, w.prevFrom, w.prevTo], [END - 7 * DAY, END, END - 14 * DAY, END - 7 * DAY])
})

const LONG_AGO = END - 60 * DAY // collection began well before both windows

test('a window with no events is not tracked everywhere, never green', () => {
  const { checks, verdict } = runChecks({ rows: [], turns: [], generatedAt: END, days: 7 })
  assert.ok(checks.every((c) => c.state === 'untracked'), JSON.stringify(checks.map((c) => c.state)))
  assert.equal(verdict.state, 'untracked')
  assert.match(verdict.text, /None of 7 checks/)
  // events eight days before the build: this window is empty, so still not tracked
  const old = [{ k: 'prompt', t: END - 8 * DAY, s: 0, h: 'cloud', a: 'main' }, { k: 'tool', t: END - 8 * DAY, s: 0, h: 'cloud', tl: 'Skill', sk: 'pdf', ok: true }]
  const again = byId(runChecks({ rows: old, generatedAt: END, days: 7, since: LONG_AGO }).checks)
  assert.equal(again['jev-deciding'].state, 'untracked')
  assert.equal(again.skills.state, 'untracked')
  assert.equal(again.reporting.state, 'attention', 'cloud reported last window, not this one')
  assert.ok(again.reporting.lines.some((l) => /Local: not tracked/.test(l)))
})

test('coverage: a previous window that starts before the first event is not tracked, never "none"', () => {
  const since = mins(72)
  const rows = [
    { k: 'prompt', t: since, s: 0, h: 'cloud', a: 'main' },
    { k: 'jev.decision', t: since + 500, s: 0, h: 'cloud', d: { decidedBy: 'jev' } },
    { k: 'tool', t: mins(10), s: 0, h: 'cloud', tl: 'Skill', sk: 'pdf', ok: true },
    { k: 'router.call', t: mins(5), s: 0, h: 'cloud', ok: true, d: {} },
  ]
  for (const days of [1, 7, 30, 90]) {
    const R = runChecks({ rows, generatedAt: END, days })
    assert.equal(R.coverage.since, since)
    assert.equal(R.coverage.partial, true)
    assert.equal(R.coverage.covered, 72 * 60000)
    assert.equal(R.coverage.prevTracked, false)
    assert.match(R.prevNote, /not tracked \(collection began /)
    const c = byId(R.checks)
    for (const id of ['jev-deciding', 'jev-picking', 'skills', 'router']) assert.match(c[id].compare, /not tracked \(collection began/, id)
    assert.equal(c.reporting.state, 'untracked', 'nothing to hold this window to')
    assert.match(c.reporting.compare, /collection began/)
    assert.ok(!/none/.test(c.reporting.compare))
  }
  const full = runChecks({ rows, generatedAt: END, days: 1, since: LONG_AGO })
  assert.equal(full.coverage.prevTracked, true)
  assert.equal(full.prevNote, null)
})

test('reporting is not tracked, never green, when the previous window had no hosts', () => {
  const rows = [{ k: 'api', t: mins(5), s: 0, h: 'cloud' }]
  const c = byId(runChecks({ rows, generatedAt: END, days: 7, since: LONG_AGO }).checks).reporting
  assert.equal(c.state, 'untracked')
  const both = [...rows, { k: 'api', t: END - 8 * DAY, s: 0, h: 'cloud' }]
  assert.equal(byId(runChecks({ rows: both, generatedAt: END, days: 7, since: LONG_AGO }).checks).reporting.state, 'pass')
})

test('Jev deciding is a rate (target 95%), keeps the lag as a fact, and counts suggestions without decisions', () => {
  const prompts = Array.from({ length: 20 }, (_, i) => ({ k: 'prompt', t: mins(120 - i * 5), s: 0, h: 'cloud', a: 'main' }))
  const decisions = prompts.slice(0, 18).map((p, i) => ({ k: 'jev.decision', t: p.t + 500, s: 0, h: 'cloud', sk: i === 0 ? 'pdf' : undefined, d: { decidedBy: 'jev' } }))
  const rows = [...prompts, ...decisions, { k: 'jev.suggested', t: prompts[19].t, s: 0, h: 'cloud', sk: 'pdf' }]
  const c = byId(runChecks({ rows, generatedAt: END, days: 7, since: LONG_AGO }).checks)['jev-deciding']
  assert.equal(c.figure, '90% decided')
  assert.equal(c.state, 'attention', '18 of 20 is under 95%')
  assert.equal(c.stats.gaps, 2)
  assert.equal(c.stats.unmatched, 1)
  assert.ok(c.lines.some((l) => /gone quiet/.test(l)), 'the lag is stated')
  assert.ok(c.lines.some((l) => l.startsWith('1 of 18 Jev decisions picked a skill')))
  const all = [...prompts, ...prompts.map((p) => ({ k: 'jev.decision', t: p.t + 500, s: 0, h: 'cloud', d: { decidedBy: 'jev' } }))]
  assert.equal(byId(runChecks({ rows: all, generatedAt: END, days: 7, since: LONG_AGO }).checks)['jev-deciding'].state, 'pass')
  assert.equal(byId(runChecks({ rows: all.slice(0, 2), generatedAt: END, days: 7, since: LONG_AGO }).checks)['jev-deciding'].state, 'thin')
})

test('Jev picking states the span its decisions cover and goes partial when the log went quiet', () => {
  const decisions = Array.from({ length: 16 }, (_, i) => ({ k: 'jev.decision', t: mins(60 - i), s: 0, h: 'cloud', d: { decidedBy: 'jev' } }))
  const lastDecision = mins(45)
  const quiet = [...decisions, { k: 'prompt', t: mins(5), s: 0, h: 'cloud', a: 'main' }]
  const c = byId(runChecks({ rows: quiet, generatedAt: END, days: 7, since: LONG_AGO }).checks)['jev-picking']
  assert.equal(c.state, 'partial')
  assert.ok(c.lines[0].includes(`decisions up to ${fmtTime(lastDecision)}`))
  assert.match(c.population, /including ones not tied to a prompt/)
  const fine = byId(runChecks({ rows: decisions, generatedAt: END, days: 7, since: LONG_AGO }).checks)['jev-picking']
  assert.equal(fine.state, 'pass')
})

test('rates: skills refused are red at any n; thin rates are grey; router with n = 0 is not tracked', () => {
  const skills = [1, 2, 3, 4, 5].map((i) => ({ k: 'tool', t: mins(i), s: 0, h: 'cloud', tl: 'Skill', sk: 's' + i, ok: false }))
  const router = [{ k: 'router.call', t: mins(3), s: 0, h: 'cloud', m: 'x/y', ok: true, d: {} }]
  const misses = [{ k: 'jev.miss', t: mins(2), s: 0, h: 'cloud', sk: 'dataviz', d: { signal: 'typed-after', jevPick: 'pdf' } }]
  const decisions = Array.from({ length: 16 }, (_, i) => ({ k: 'jev.decision', t: mins(10 + i), s: 0, h: 'cloud', d: { decidedBy: 'jev' } }))
  const c = byId(runChecks({ rows: [...skills, ...router, ...misses, ...decisions], generatedAt: END, days: 7 }).checks)
  assert.equal(c.skills.state, 'attention')
  assert.equal(c.skills.figure, '5 of 5 refused')
  assert.equal(c.router.state, 'thin')
  assert.equal(c['jev-picking'].state, 'pass')
  assert.equal(c['jev-picking'].figure, '6% misrouted')
  assert.ok(c['jev-picking'].lines.some((l) => /expected dataviz/.test(l)))
  assert.equal(byId(runChecks({ rows: skills, generatedAt: END, days: 7 }).checks).router.state, 'untracked')
  const calls = Array.from({ length: 10 }, (_, i) => ({ k: 'router.call', t: mins(i + 1), s: 0, h: 'cloud', ok: i > 1, d: {} }))
  assert.equal(byId(runChecks({ rows: calls, generatedAt: END, days: 7 }).checks).router.state, 'attention', '2 of 10 is over 10%')
})

test('tools: over 10% fails, coloured only from n >= 10', () => {
  const tool = (name, n, bad) => Array.from({ length: n }, (_, i) => ({ k: 'tool', t: mins(i + 1), s: 0, h: 'cloud', tl: name, ok: i >= bad }))
  const list = failingTools([...tool('Bash', 20, 3), ...tool('Read', 20, 2), ...tool('WebFetch', 4, 2), ...tool('Skill', 5, 5)], [])
  assert.deepEqual(list.map((x) => [x.tool, x.thin]), [['Bash', false], ['WebFetch', true]])
})

test('landing compares with the previous window in percentage points', () => {
  const turns = [
    ...Array.from({ length: 10 }, (_, i) => ({ t: mins(i + 1), h: 'cloud', land: i < 9, c: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ t: END - 8 * DAY - i, h: 'cloud', land: i < 7, c: 1 })),
  ]
  const c = byId(runChecks({ rows: [], turns, generatedAt: END, days: 7, since: LONG_AGO }).checks).landing
  assert.equal(c.state, 'pass')
  assert.match(c.compare, /70% of 10 · \+20 pp/)
  assert.deepEqual(landStats([{ land: true }, { land: null }]), { turns: 2, known: 1, landed: 1, open: 1, rate: 1 })
})

test('verdict counts targeted checks; a host filter leaves out account-wide checks', () => {
  const T = (state, extra = {}) => ({ state, targeted: true, ...extra })
  assert.equal(verdictOf([T('pass'), T('pass')]).text, 'All 2 checks passing')
  const v = verdictOf([T('attention'), T('untracked'), T('thin'), T('pass'), T('partial')])
  assert.equal(v.text, '1 of 5 checks needs attention')
  assert.equal(v.tail, '1 not tracked · 1 too few to judge · 1 partial')
  const mixed = verdictOf([T('attention'), T('attention'), { state: 'neutral', targeted: false }])
  assert.equal(mixed.text, '2 of 2 targeted checks need attention')
  assert.match(mixed.tail, /1 check without a target/)
  const credit = T('attention', { account: true })
  assert.equal(verdictOf([T('pass'), credit], 'all').text, '1 of 2 checks needs attention')
  assert.equal(verdictOf([T('pass'), credit], 'cloud').text, 'All 1 check passing')
  const R = runChecks({ rows: [], generatedAt: END, days: 7, host: 'local' })
  assert.match(R.verdict.text, /of 6 checks/, 'OpenRouter credit is left out under a host filter')
})

test('OpenRouter spend reconciles: key usage = routed (logged) + Jev (not logged) + unattributed', () => {
  const key = { k: 'openrouter.key', t: Date.parse('2026-09-26T14:58:00Z'), h: 'cloud', d: { usage_daily: 0.25, usage_weekly: 0.3, total_credits: 10, total_usage: 0.4, limit: 50, limit_remaining: 49.75 } }
  const rows = [
    key,
    { k: 'router.call', t: Date.parse('2026-09-26T14:07:00Z'), h: 'cloud', c: 0.000018 },
    { k: 'router.call', t: Date.parse('2026-09-25T10:00:00Z'), h: 'local:mac', c: 0.01 }, // yesterday: in the week, not the day
    { k: 'jev.decision', t: Date.parse('2026-09-26T14:00:00Z'), h: 'cloud' },
  ]
  const day = reconcile(key, rows, 'daily')
  assert.equal(day.from, Date.parse('2026-09-26T00:00:00Z'))
  assert.equal(day.routedCalls, 1)
  assert.equal(day.decisions, 1)
  assert.ok(Math.abs(day.routed + day.unattributed - day.usage) < 1e-12)
  assert.equal(day.closes, true)
  const week = reconcile(key, rows, 'weekly')
  assert.equal(week.from, Date.parse('2026-09-21T00:00:00Z'), 'OpenRouter weeks start Monday UTC')
  assert.equal(week.routedCalls, 2)
  assert.ok(Math.abs(week.unattributed - (0.3 - 0.010018)) < 1e-12)
  assert.equal(reconcile({ ...key, d: { usage_daily: 0 } }, rows, 'daily').closes, false, 'logged cost above the key does not close')
  const c = byId(runChecks({ rows, generatedAt: END, days: 1 }).checks).openrouter
  assert.equal(c.state, 'pass')
  assert.ok(c.lines.some((l) => l.includes('Spend on this key, UTC day') && l.includes('$0.25')))
  assert.ok(!/\$0\.000018/.test(c.figure), 'the routed log is never the spend figure')
  const old = byId(runChecks({ rows, generatedAt: key.t + 27 * 3600000, days: 1 }).checks).openrouter
  assert.equal(old.state, 'untracked', 'a key check older than 26 h is not shown as current')
  const low = byId(runChecks({ rows: [{ ...key, d: { ...key.d, total_usage: 9.5 } }], generatedAt: END, days: 1 }).checks).openrouter
  assert.equal(low.state, 'attention')
})

test('trend buckets end at the build time; one bucket with data is not a trend', () => {
  const w = windowOf(END, 7)
  const b = trendBuckets([{ t: END - 1000, land: true, c: 1 }, { t: END - 2000, land: false, c: 3 }], w)
  assert.equal(b.buckets.length, 7)
  assert.equal(b.buckets[6].to, END)
  assert.equal(b.withData, 1)
  assert.equal(b.buckets[6].cost, 2)
})

test('project label: the home folder is "~", not the user name', () => {
  assert.equal(projectLabel('/home/user', '/home/user'), '~')
  assert.equal(projectLabel('/home/user/jev-model-routing/', '/home/user'), 'jev-model-routing')
  assert.equal(projectLabel(null), null)
})

const sampleEvents = (count = 3) => Array.from({ length: count }, (_, i) => ({ id: 'p' + i, kind: 'prompt', ts: new Date(END - (i + 1) * 3600000).toISOString(), session: 's', host: 'cloud', agent: 'main', data: {} }))
  .concat([{ id: 'a1', kind: 'api', ts: new Date(END - 1800000).toISOString(), session: 's', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', cost_usd: 2 }])

test('the payload carries every key the page reads, the source and the price provenance', () => {
  const data = buildPayload(sampleEvents(), { source: 'supabase', now: END })
  assert.deepEqual(missingKeys(data), [])
  assert.equal(data.source, 'supabase')
  assert.equal(data.lastEventAt, new Date(END - 1800000).toISOString())
  assert.match(data.prices.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(data.summary.headline.prompts, 3)
  assert.equal(data.summary.cost.claude24h, 2)
  assert.deepEqual(missingKeys({ ...data, rows: undefined, summary: null }).sort(), ['rows', 'summary'])
  const html = render(data)
  assert.deepEqual(extractData(html).summary, data.summary)
  assert.ok(html.includes('function runChecks'), 'the checks are inlined')
  assert.ok(!html.includes('export function'))
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts')
})

test('guards: headline zero, missing key, cost 5x, unusable source', () => {
  const prev = buildPayload(sampleEvents(), { now: END })
  assert.deepEqual(checkGuards(buildPayload(sampleEvents(), { now: END + 3600000 }), prev), [])
  const empty = buildPayload([{ id: 'x', kind: 'tool', ts: new Date(END).toISOString(), host: 'cloud', tool: 'Bash', ok: true }], { now: END })
  assert.ok(checkGuards(empty, prev).some((g) => g.guard === 'headline-zero' && /prompts/.test(g.message)))
  const broken = { ...prev, turns: undefined }
  assert.ok(checkGuards(broken, prev).some((g) => g.guard === 'missing-key'))
  const pricey = { ...prev, summary: { ...prev.summary, cost: { claude24h: 20, claude7d: 20 } } }
  assert.ok(checkGuards(pricey, prev).some((g) => g.guard === 'cost-5x'))
  assert.equal(sourceProblem(parseEvents(''), 'local'), 'the input is empty')
  assert.match(sourceProblem(parseEvents('{bad\n{bad\n{"id":"a","ts":"2026-01-01"}'), 'local'), /2 of 3 lines/)
  assert.match(sourceProblem(parseEvents('[{"ts":"2026-09-26T00:00:00Z"}]'), 'supabase'), /missing id or kind/)
  assert.equal(sourceProblem(parseEvents(JSON.stringify(sampleEvents())), 'supabase'), null)
  assert.ok(checkGuards(null, prev, { problem: 'the input is empty' }).some((g) => g.guard === 'source-unusable'))
  assert.deepEqual(whatMoved(buildPayload(sampleEvents(), { now: END }), prev), [])
})

test('snapshots keep the newest 30; runs.log gets one line per run', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'snaps-'))
  for (let i = 0; i < 33; i++) snapshot({ generatedAt: new Date(END + i * 3600000).toISOString(), summary: { i } }, dir)
  const files = readdirSync(dir).sort()
  assert.equal(files.length, 30)
  assert.equal(files[0], '2026-09-26T18.json')
  assert.equal(latestSnapshot(dir).summary.i, 32)
  const payload = buildPayload(sampleEvents(), { now: END })
  const line = runLine({ at: END, payload, events: 4, guards: [{ guard: 'cost-5x' }], published: 'no' })
  assert.match(line, /^2026-09-26T15:00:00.000Z source=local verdict="/)
  assert.match(line, /prompts7d=3 /)
  assert.match(line, /guards=cost-5x published=no$/)
  assert.ok(!line.includes('\n'))
})

test('the CLI snapshots, refuses on a tripped guard (exit 2, guard named), and --force publishes', () => {
  const script = fileURLToPath(new URL('../scripts/dashboard.mjs', import.meta.url))
  const dir = mkdtempSync(joinPath(tmpdir(), 'cli-'))
  const input = joinPath(dir, 'events.jsonl'), out = joinPath(dir, 'dashboard.html'), state = joinPath(dir, 'state')
  const run = (...extra) => spawnSync(process.execPath, [script, '--input', input, '--out', out, '--state-dir', state, ...extra], { encoding: 'utf8' })
  const now = new Date(END).toISOString()
  writeText(input, sampleEvents().map((e) => JSON.stringify(e)).join('\n'))
  assert.equal(run('--now', now).status, 0)
  assert.ok(existsSync(out))
  // The pull comes back with no prompts: refuse, keep the old page.
  writeText(input, JSON.stringify({ id: 'x', kind: 'tool', ts: now, host: 'cloud', tool: 'Bash', ok: true }))
  const refused = run('--now', new Date(END + 3600000).toISOString())
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /guard headline-zero/)
  assert.equal(extractData(readText(out, 'utf8')).generatedAt, now, 'the old page is untouched')
  assert.equal(readdirSync(joinPath(state, 'snapshots')).length, 1)
  const forced = run('--now', new Date(END + 3600000).toISOString(), '--force')
  assert.equal(forced.status, 0)
  assert.match(forced.stderr, /overridden by --force/)
  const log = readText(joinPath(state, 'runs.log'), 'utf8').trim().split('\n')
  assert.equal(log.length, 3)
  assert.deepEqual(log.map((l) => /published=(\w+)/.exec(l)[1]), ['yes', 'no', 'forced'])
  writeText(input, '')
  const unusable = run()
  assert.equal(unusable.status, 2)
  assert.match(unusable.stderr, /guard source-unusable/)
  assert.equal(run('--source', 'nope').status, 1)
})

test('reconciliation sums dollars only, states Jev separately, and refuses a period older than collection', () => {
  const key = { k: 'openrouter.key', t: Date.parse('2026-09-26T14:58:00Z'), h: 'cloud', d: { usage_daily: 0.25, usage_weekly: 0.5, total_credits: 10, total_usage: 0.4 } }
  const rows = [key, { k: 'router.call', t: Date.parse('2026-09-26T14:07:00Z'), h: 'cloud', c: 0.05 }, { k: 'jev.decision', t: Date.parse('2026-09-26T14:01:00Z'), h: 'cloud' }]
  const since = Date.parse('2026-09-26T14:01:00Z')
  const week = reconcile(key, rows, 'weekly', since)
  assert.equal(week.reconcilable, false)
  assert.equal(week.unattributed, null)
  const c = byId(runChecks({ rows, generatedAt: END, days: 7, since }).checks).openrouter
  assert.ok(c.lines.some((l) => /^Not reconcilable: the key's UTC week to date began .* before collection began/.test(l)))
  assert.ok(!c.lines.some((l) => /= routed calls/.test(l)))
  const day = byId(runChecks({ rows, generatedAt: END, days: 1, since: Date.parse('2026-09-25T00:00:00Z') }).checks).openrouter
  const sum = day.lines.find((l) => l.includes('= routed calls'))
  assert.equal(sum, '$0.25 = routed calls $0.05 (1 call, cost logged) + unattributed $0.20')
  assert.ok(day.lines.some((l) => /^Jev's decision calls \(1 this period\) .* not logged/.test(l)))
})

test('guards: model calls with $0 or missing Claude cost trip headline-zero', () => {
  const unpriced = buildPayload([{ id: 'a', kind: 'api', ts: new Date(END - 60000).toISOString(), session: 's', host: 'cloud', agent: 'main', model: 'mystery-model', cost_usd: null }], { now: END })
  assert.ok(checkGuards(unpriced, null).some((g) => g.guard === 'headline-zero' && /Claude cost/.test(g.message)))
  const missing = { ...unpriced, summary: { ...unpriced.summary, cost: undefined } }
  assert.ok(checkGuards(missing, null).some((g) => g.guard === 'headline-zero' && /missing/.test(g.message)))
  assert.deepEqual(checkGuards(buildPayload(sampleEvents(), { now: END }), null), [])
})

test('turns with no priced model call have no cost and stay out of the median', async () => {
  const { turnsFrom } = await import('../scripts/turns.mjs')
  const turns = turnsFrom([
    { k: 'prompt', t: 1, s: 0, h: 'cloud', a: 'main' },
    { k: 'api', t: 2, s: 0, h: 'cloud', a: 'main', m: 'mystery' },
    { k: 'prompt', t: 3, s: 0, h: 'cloud', a: 'main' },
    { k: 'api', t: 4, s: 0, h: 'cloud', a: 'main', m: 'claude-opus-5-5', c: 0.4 },
  ])
  assert.deepEqual(turns.map((t) => t.c), [null, 0.4])
  assert.equal(median(turns.map((t) => t.c)), 0.4)
})

test('--help prints usage (with --state-dir and --now) and builds nothing', () => {
  const script = fileURLToPath(new URL('../scripts/dashboard.mjs', import.meta.url))
  const dir = mkdtempSync(joinPath(tmpdir(), 'help-'))
  const r = spawnSync(process.execPath, [script, '--help', '--state-dir', dir], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /--state-dir/)
  assert.match(r.stdout, /--now/)
  assert.deepEqual(readdirSync(dir), [])
  assert.match(readText(script, 'utf8').split('*/')[0], /--state-dir dir.*\n.*--now ISO-time/)
})

test('the page lists the eight approved targets and leads with what the models did, health last', () => {
  assert.equal(TARGET_NOTES.length, 8)
  const html = render(buildPayload(sampleEvents(), { now: END }))
  assert.ok(html.includes('TARGET_NOTES.map'))
  assert.ok(html.includes('firstEventAt'))
  const order = ['id="ov-cards"', 'id="ov-chart"', 'id="top-skills"', 'id="ex-chart"', 'id="lg-table"', 'id="jev-tiers"', 'id="r-cat"', 'id="checks"']
  const at = order.map((id) => html.indexOf(id))
  assert.ok(at.every((i) => i > 0), 'every panel is on the page')
  assert.deepEqual([...at].sort((x, y) => x - y), at, 'in the approved order: headline first, health last')
})

// ---------- the plain-words page: actions, one line per check, no jargon ----------

import { FIXES, HOW_TO, actionsFor, whenPlain } from '../scripts/checks.mjs'
import { actionsHtml, bannedIn, checksHtml, plainChecks, spendPlain, usdTop, verdictPlain, visibleText } from '../scripts/present.mjs'
import vm from 'node:vm'

const chk = (id, state, facts = {}, extra = {}) => ({ id, state, targeted: true, facts, ...extra })
const texts = (list) => list.map((a) => a.text)

test('actionsFor: Jev stopped mid-chat → start a new chat; never logged → turn on the latest Jev (with steps)', () => {
  const stopped = actionsFor([chk('jev-deciding', 'attention', { chats: [{ s: 0, h: 'cloud', stoppedMidChat: true, neverLogged: false }] })])
  assert.deepEqual(stopped.map((a) => [a.who, a.text]), [['You', "Start a new chat — this one started before today's Jev update."]])
  assert.match(stopped[0].doneWhen, /new requests show Jev's pick/)
  const never = actionsFor([chk('jev-deciding', 'attention', { chats: [{ s: 1, h: 'cloud', stoppedMidChat: false, neverLogged: true }, { s: 2, h: 'local:pc', neverLogged: true }] })])
  assert.deepEqual(texts(never), ['Turn on the latest Jev in your cloud setup.', 'Turn on the latest Jev on your PC.'])
  assert.equal(never[0].how, HOW_TO.jevCloud)
  assert.equal(never[1].how, HOW_TO.jevPc)
})

test('actionsFor: partial picking merges into the Jev logging item (no duplicate)', () => {
  const chats = [{ s: 0, h: 'cloud', stoppedMidChat: true }]
  const list = actionsFor([chk('jev-deciding', 'attention', { chats }), chk('jev-picking', 'partial')])
  assert.equal(list.length, 1)
  const failing = actionsFor([chk('jev-deciding', 'pass', { chats }), chk('jev-picking', 'attention')])
  assert.deepEqual(failing.map((a) => [a.who, a.text]), [['Claude', 'Ask Claude to run the daily routing check now.']])
})

test('actionsFor: skills blocked before the fix clear on their own; blocked after it → tell Claude', () => {
  const before = actionsFor([chk('skills', 'attention', { refused: [{ skill: 'dataviz', t: FIXES.skills + 60000, chatStart: FIXES.skills - 60000 }] })])
  assert.equal(before[0].who, 'Nothing')
  assert.match(before[0].text, /fixed in new chats/)
  const after = actionsFor([chk('skills', 'attention', { refused: [{ skill: 'dataviz', t: FIXES.skills + 7200000, chatStart: FIXES.skills + 3600000 }, { skill: 'pdf', t: FIXES.skills + 7300000, chatStart: FIXES.skills + 3600000 }] })])
  assert.deepEqual([after[0].who, after[0].text], ['You', 'Tell Claude "skills are being blocked" and name them: dataviz, pdf.'])
})

test('actionsFor: landing, router, credit and reporting states', () => {
  assert.equal(actionsFor([chk('landing', 'attention')])[0].who, 'You')
  assert.deepEqual(actionsFor([chk('router', 'thin')]).map((a) => [a.who, a.text]), [['Nothing', 'Nothing to do — the model router is judged after 10 uses.']])
  assert.equal(actionsFor([chk('router', 'attention')])[0].who, 'Claude')
  assert.deepEqual(texts(actionsFor([chk('openrouter', 'attention', {}, { account: true })])), ['Add credit at openrouter.ai → Settings → Credits.'])
  assert.deepEqual(actionsFor([chk('openrouter', 'attention', {}, { account: true })], { host: 'cloud' }), [], 'account-wide checks are left out under a machine filter')
  assert.ok(actionsFor([chk('openrouter', 'untracked', null, { account: true, facts: null })])[0].how)
  const rep = (state, facts) => actionsFor([chk('reporting', state, { now: [], quiet: [], everLocal: true, everCloud: true, host: 'all', ...facts })], { end: END, prevStarts: END + 14 * DAY })
  assert.deepEqual(texts(rep('untracked', {})), [`Nothing to do — comparisons start ${whenPlain(END + 14 * DAY, END)}.`])
  assert.deepEqual(texts(rep('attention', { quiet: [{ h: 'local:pc', last: END - 9 * DAY }] })), ['Open a chat on your PC so it reports again.'])
  assert.deepEqual(texts(rep('pass', { everLocal: false })), ['Run one chat on your PC in these projects, so it reports too.'])
  assert.equal(whenPlain(END + DAY, END), 'tomorrow')
})

test('actionsFor: You first by severity, then Claude, then Nothing; max 5; duplicates collapse; all passing → nothing', () => {
  const list = actionsFor([
    chk('router', 'thin'),
    chk('jev-picking', 'attention'),
    chk('landing', 'attention'),
    chk('openrouter', 'attention', {}, { account: true }),
    chk('reporting', 'untracked', { now: [], quiet: [], everLocal: false, host: 'all' }),
    chk('jev-deciding', 'attention', { chats: [{ stoppedMidChat: true }, { stoppedMidChat: true }] }),
  ], { stale: true, builtAgo: '8 days', end: END, prevStarts: END + DAY })
  assert.deepEqual(list.map((a) => a.who), ['You', 'You', 'You', 'You', 'You'])
  assert.match(list[0].text, /refresh this page — it is 8 days old/)
  assert.equal(list.length, 5)
  assert.equal(new Set(texts(list)).size, 5)
  const all = actionsFor([chk('router', 'thin'), chk('jev-picking', 'attention'), chk('landing', 'attention')])
  assert.deepEqual(all.map((a) => a.who), ['You', 'Claude', 'Nothing'])
  assert.deepEqual(actionsFor([chk('landing', 'pass'), chk('skills', 'pass')]), [])
  assert.equal(visibleText(actionsHtml([])), 'Nothing to do.')
})

/** Every check state in one realistic build: attention, partial, pass, thin, not tracked. */
function mixedBuild() {
  const ev = []
  const at = (m) => new Date(END - m * 60000).toISOString()
  for (let i = 0; i < 22; i++) {
    ev.push({ id: 'p' + i, kind: 'prompt', ts: at(200 - i * 8), session: 's', host: 'cloud', agent: 'main', data: { correction: i === 5 } })
    if (i < 5) ev.push({ id: 'd' + i, kind: 'jev.decision', ts: at(200 - i * 8), session: 's', host: 'cloud', skill: 'pdf', data: { decidedBy: 'jev' } })
    ev.push({ id: 'a' + i, kind: 'api', ts: at(199 - i * 8), session: 's', host: 'cloud', agent: 'main', model: 'claude-opus-5-5', cost_usd: 2.13 })
  }
  for (let i = 0; i < 11; i++) ev.push({ id: 'dx' + i, kind: 'jev.decision', ts: at(190 - i), session: 's', host: 'cloud', data: { decidedBy: 'jev' } })
  ev.push({ id: 'm', kind: 'jev.miss', ts: at(150), session: 's', host: 'cloud', skill: null, data: { signal: 'picked-then-corrected', jevPick: 'pdf' } })
  for (let i = 0; i < 5; i++) ev.push({ id: 'k' + i, kind: 'tool', ts: at(100 - i), session: 's', host: 'cloud', agent: 'main', tool: 'Skill', skill: 'dataviz', ok: false, data: { refusal: 'blocked' } })
  ev.push({ id: 'r', kind: 'router.call', ts: at(90), session: 's', host: 'cloud', model: 'z-ai/glm', cost_usd: 0.000018, ok: true, data: {} })
  ev.push({ id: 'key', kind: 'openrouter.key', ts: at(5), host: 'cloud', cost_usd: 0.5, data: { limit: 50, limit_remaining: 49.5, limit_reset: 'daily', usage_daily: 0.24, usage_weekly: 0.56, usage_monthly: 0.56, total_credits: 10, total_usage: 0.71 } })
  return buildPayload(ev, { now: END })
}

function topBlock(data, { days = 7, host = 'all', stale = false } = {}) {
  const R = runChecks({ rows: data.rows, turns: data.turns, generatedAt: END, days, host, since: Date.parse(data.firstEventAt) })
  const rows = plainChecks(R, { days, end: END, host, stale, builtAgo: '8 days' })
  const actions = actionsFor(R.checks, { stale, builtAgo: '8 days', end: END, prevStarts: R.coverage.prevStarts, host })
  return { R, rows, actions, checks: checksHtml(rows), todo: actionsHtml(actions), verdict: verdictPlain(R, { stale, builtAgo: '8 days', host }), spend: spendPlain(R, data.rows, { days, end: END, host }) }
}

test('the top block: exactly one line per check, panels and Details closed by default', () => {
  const t = topBlock(mixedBuild())
  assert.equal((t.checks.match(/<details class="check /g) || []).length, 7)
  assert.equal((t.checks.match(/<summary>/g) || []).length, 7)
  for (const li of t.checks.split('<details class="check ').slice(1)) {
    const summary = li.slice(li.indexOf('<summary>'), li.indexOf('</summary>'))
    assert.equal((summary.match(/class="name"/g) || []).length, 1)
    assert.equal((summary.match(/class="figure"/g) || []).length, 1)
    assert.ok(!/<(br|p|div|ul)\b/.test(summary), 'nothing but one line in a summary')
  }
  assert.ok(!/<details[^>]*\sopen/.test(t.checks), 'no check starts open')
  const page = render(mixedBuild())
  assert.match(page, /<details class="more" id="more">/)
  assert.ok(!/<details[^>]*\bopen\b[^>]*>/.test(page.replace(/details\[open\]|\.check\[open\]|\.options\[open\]|\.more\[open\]/g, '')), 'Details and Options start closed')
  assert.deepEqual(t.rows.map((r) => r.state), ['attention', 'attention', 'partial', 'pass', 'pass', 'thin', 'untracked'], 'most important first')
})

test('the top block reads like the approved wireframe', () => {
  const t = topBlock(mixedBuild())
  const by = Object.fromEntries(t.rows.map((r) => [r.id, r]))
  assert.equal(t.verdict.text, '2 need attention')
  assert.deepEqual([by['jev-deciding'].icon, by['jev-deciding'].name, by['jev-deciding'].figure], ['✕', "Jev's picks are missing for most requests", '23% of requests · target 95%'])
  assert.deepEqual([by.skills.name, by.skills.figure], ['Claude was blocked from some skills', '5 of 5 blocked · target 0'])
  assert.deepEqual([by['jev-picking'].icon, by['jev-picking'].figure], ['◐', '6% wrong · partly checked'])
  assert.deepEqual([by.openrouter.name, by.openrouter.figure], ['OpenRouter has enough credit', '$9.29 left'])
  assert.deepEqual([by.router.icon, by.router.figure], ['–', 'too few uses to judge'])
  assert.match(by.reporting.figure, /^starts /)
  assert.deepEqual([t.spend.label, t.spend.claude, t.spend.openrouter], ['This week', '$47', '$0.56'])
  assert.match(t.spend.tooltip, /OpenRouter says you've spent \$0\.56 this week/)
  for (const r of t.rows) assert.ok(r.todo, r.id)
  assert.equal(by.landing.todo, 'Nothing to do.')
  assert.equal(by['jev-deciding'].todo, t.actions.find((a) => a.check === 'jev-deciding').text, 'the panel repeats the list')
  assert.ok(t.checks.includes('aria-label="Needs attention"'))
  assert.equal(verdictPlain(t.R, { stale: true, builtAgo: '8 days' }).text, 'Out of date — built 8 days ago')
  assert.deepEqual([usdTop(47.43), usdTop(9.289), usdTop(0.558), usdTop(0.000018), usdTop(0)], ['$47', '$9.29', '$0.56', 'under $0.01', '$0'])
})

test('no jargon: the top block, panels and action list pass the banned-word scan', () => {
  for (const opts of [{}, { days: 1 }, { days: 90 }, { host: 'local' }, { host: 'cloud' }, { stale: true }]) {
    const t = topBlock(mixedBuild(), opts)
    const top = [visibleText(t.checks, { collapsed: true }), visibleText(t.todo), t.verdict.text, t.verdict.sub, `${t.spend.label} Claude ${t.spend.claude} (at pay-as-you-go prices) · OpenRouter ${t.spend.openrouter}`].join(' \n ')
    assert.deepEqual(bannedIn(top), [], `top block ${JSON.stringify(opts)}: ${top}`)
    assert.deepEqual(bannedIn(visibleText(t.checks)), [], `panels ${JSON.stringify(opts)}`)
  }
  const empty = topBlock(buildPayload([{ id: 'x', kind: 'api', ts: new Date(END - 60000).toISOString(), host: 'cloud', cost_usd: 1, model: 'claude-opus-5-5' }], { now: END }))
  assert.deepEqual(bannedIn(visibleText(empty.checks) + visibleText(empty.todo)), [])
  assert.ok(bannedIn('the decision log for this session').length === 2, 'the scan itself catches jargon')
  assert.deepEqual(bannedIn(TARGET_NOTES.join(' ')), [], 'the targets list is plain too')
  // The pasted values live only behind "Show me how".
  assert.ok(visibleText(actionsHtml([{ text: 'Turn on the latest Jev in your cloud setup.', who: 'You', doneWhen: 'x', how: HOW_TO.jevCloud }])).indexOf('CLAUDE_CODE') < 0)
})

test('the page scripts compile together: no name declared twice', () => {
  const page = render(mixedBuild())
  const scripts = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(scripts.length, 2)
  // The second is a module (it awaits the live rows); compiled here as an async body.
  assert.doesNotThrow(() => new vm.Script(`${scripts[0]}\n;\nasync function page() {\n${scripts[1]}\n}`))
})

test('the action list holds only things someone has to do; self-clearing items get one quiet line', async () => {
  const { actionsHtml } = await import('../scripts/present.mjs')
  const html = actionsHtml([
    { text: 'Start a new chat.', who: 'You', doneWhen: 'new requests show a pick.' },
    { text: 'Nothing to do — judged after 10 uses.', who: 'Nothing', doneWhen: 'used 10 times.' },
    { text: 'Nothing to do — comparisons start Oct 10.', who: 'Nothing', doneWhen: "it's Oct 10." },
  ])
  assert.equal((html.match(/<li>/g) || []).length, 1)
  assert.ok(!html.includes('Nothing to do —'))
  assert.ok(html.includes('2 other items clear on their own'))
  const none = actionsHtml([{ text: 'Nothing to do — x.', who: 'Nothing', doneWhen: 'y.' }])
  assert.ok(none.startsWith('<p class="none">Nothing to do.</p>'))
  assert.ok(none.includes('1 other item clears on its own'))
})
