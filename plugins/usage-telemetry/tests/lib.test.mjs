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
