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
  assert.equal(first.c, 0.63)
  assert.equal(first.tk, 10 + 50 + 10 + 20 + 900)
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
