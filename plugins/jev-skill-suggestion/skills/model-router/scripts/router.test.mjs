import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, route, plan, ownedFamilies, isOwned, askDecider, complete, callRecord, jqBar, loadTeams, accuracyNeed, DPMO, JQ_MIN_TIER, sweep, sweepRoutes, creditStatus, fellBack, config, DEFAULT_MAX_TOKENS, ollamaBase, localModels, pickInstalled, isEmbeddingModel, modelSize, autoLocalRoute, LOCAL_TIMEOUT_MS, LOCAL_MAX_TOKENS, statsFilePath, loadStats, recordOutcomes, trackRecord, rankByTrackRecord, modelOverview, explore, EXPLORE_RATE } from './router.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Tests never read or write the real track record; the track-record tests use their own files.
process.env.ROUTER_STATS = 'off'
// Nor the real judgement-quotient log.
process.env.JQ_LOG = 'off'
// Nor the owner's private teams file (tools/jq/teams.json or ~/.jq/teams.json):
// the JQ tests bring their own made-up teams. This one has no default level.
const teamsFixture = (json) => {
  const file = join(mkdtempSync(join(tmpdir(), 'router-teams-')), 'teams.json')
  writeFileSync(file, JSON.stringify(json))
  return file
}
process.env.JQ_TEAMS_FILE = teamsFixture({ teams: { alpha: { level: 3, source: 'test fixture' }, beta: { level: 4, source: 'test fixture' } } })
// Exploration is random; the tests that cover it turn it on and fix the dice.
process.env.ROUTER_EXPLORE = 'off'
// The owned-provider guard is off except in the tests that cover it, so the
// route tests keep checking routes.json as written.
process.env.ROUTER_OWNED = 'none'
const tempStats = () => join(mkdtempSync(join(tmpdir(), 'router-stats-')), 'stats.json')

test('classifies common task types', () => {
  assert.equal(classify('Fix this bug in my TypeScript function'), 'code')
  assert.equal(classify('Solve this equation step by step: 3x + 2 = 11'), 'reasoning')
  assert.equal(classify('Write a short email to my landlord about the heating'), 'writing')
  assert.equal(classify('hi'), 'quick')
  assert.equal(classify('x'.repeat(50000)), 'long_context')
  assert.equal(classify('Tell me about the history of the Roman Empire. '.repeat(10)), 'general')
})

test('explicit model wins', () => {
  assert.deepEqual(route('anything', { model: 'openai/gpt-4o' }).models, ['openai/gpt-4o'])
})

test('default routes end with the auto router', () => {
  const { models } = route('debug this python stack trace')
  assert.equal(models.at(-1), 'openrouter/auto')
  assert.ok(models.length <= 3, 'OpenRouter accepts at most 3 fallback models')
})

test('open-only routes use only open-weight models and never auto', () => {
  for (const category of Object.keys(config.routes)) {
    for (const prefer of ['quality', 'balanced', 'cheap']) {
      const { models } = route('x', { category, prefer, open: true })
      assert.ok(models.length > 0 && models.length <= 3, `${category}/${prefer}`)
      for (const id of models) assert.equal(config.models[id]?.open, true, `${id} in ${category}/${prefer}`)
    }
  }
})

test('every routed model is declared', () => {
  for (const tiers of Object.values(config.routes))
    for (const ids of Object.values(tiers)) for (const id of ids) assert.ok(config.models[id], id)
})

test('rejects an unknown tier', () => {
  assert.throws(() => route('x', { prefer: 'fastest' }))
})

const jevReply = (answers, ok = true) => async (url, init) => {
  jevReply.last = { url, init: { ...init, body: JSON.parse(init.body) } }
  return { ok, json: async () => ({ answers }) }
}
const TS = { TYPESAFE_API_KEY: 'k' }

test('without a Jev key the heuristics decide', async () => {
  const decision = await plan('fix this python bug', { env: {}, fetchImpl: () => assert.fail('no call expected') })
  assert.equal(decision.category, 'code')
  assert.match(decision.reason, /heuristics/)
})

test("Jev's category and tier drive the route", async () => {
  const fetchImpl = jevReply({ category: { choice: 'writing', confidence: 0.9 }, tier: { choice: 'quality', confidence: 0.8 } })
  const decision = await plan('fix this python bug', { env: TS, fetchImpl })
  assert.equal(decision.category, 'writing')
  assert.deepEqual(decision.models.slice(0, 2), config.routes.writing.quality.slice(0, 2))
  assert.match(decision.reason, /Jev \(typesafe\)/)
  assert.equal(jevReply.last.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(jevReply.last.init.body.model, 'jev-latest')
  assert.ok(jevReply.last.init.body.questions.tier)
})

test('a fixed --prefer is not asked of Jev', async () => {
  const fetchImpl = jevReply({ category: { choice: 'code', confidence: 0.9 } })
  const decision = await plan('anything at all', { env: TS, fetchImpl, prefer: 'cheap' })
  assert.equal(jevReply.last.init.body.questions.tier, undefined)
  assert.deepEqual(decision.models.slice(0, 2), config.routes.code.cheap.slice(0, 2))
})

test('an unsure or failed Jev falls back to the heuristics', async () => {
  const unsure = await plan('fix this python bug', { env: TS, fetchImpl: jevReply({ category: { choice: 'writing', confidence: 0.1 } }) })
  assert.equal(unsure.category, 'code')
  const failed = await plan('fix this python bug', { env: TS, fetchImpl: jevReply({}, false) })
  assert.equal(failed.category, 'code')
  const thrown = await plan('fix this python bug', { env: TS, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(thrown.category, 'code')
})

test('the AI Gateway key uses the gateway endpoint and headers', async () => {
  await plan('hello', { env: { AI_GATEWAY_API_KEY: 'g' }, fetchImpl: jevReply({ category: { choice: 'quick', probabilities: { quick: 0.7 } } }) })
  assert.match(jevReply.last.url, /ai-gateway\.vercel\.sh/)
  assert.equal(jevReply.last.init.headers['ai-model-id'], 'typesafe-ai/jev')
  assert.equal(jevReply.last.init.body.model, undefined)
})

// Answers OpenRouter's System One (Jev) and chat endpoints separately.
const openRouter = ({ jev = null, chat = null } = {}) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })
    if (url.endsWith('/v1/systemone')) return jev ? { ok: true, json: async () => ({ answers: jev }) } : { ok: false, json: async () => ({}) }
    return chat === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ choices: [{ message: { content: chat } }] }) }
  }
  return { calls, fetchImpl }
}
const OR = { OPENROUTER_API_KEY: 'o' }

test('an OpenRouter key alone reaches Jev through OpenRouter', async () => {
  const { calls, fetchImpl } = openRouter({ jev: { category: { choice: 'writing', confidence: 0.9 }, tier: { choice: 'quality', confidence: 0.8 } } })
  const decision = await plan('fix this python bug', { env: OR, fetchImpl })
  assert.equal(decision.category, 'writing')
  assert.match(decision.reason, /Jev \(openrouter\)/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/systemone')
  assert.equal(calls[0].body.model, 'jev-latest')
  assert.equal(calls[0].headers.authorization ?? calls[0].headers.Authorization, 'Bearer o')
})

test("logs Jev's picks for the judgement quotient", async () => {
  const jqLogFile = join(mkdtempSync(join(tmpdir(), 'router-jq-')), 'decisions.jsonl')
  const { fetchImpl } = openRouter({ jev: { category: { choice: 'writing', confidence: 0.9 }, tier: { choice: 'quality', confidence: 0.8 } } })
  const decision = await plan('write a toast', { env: OR, fetchImpl, jqLogFile })
  const lines = readFileSync(jqLogFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(
    lines.map(({ tool, question, answer, confidence }) => ({ tool, question, answer, confidence })),
    [
      { tool: 'model-router Jev', question: 'category', answer: 'writing', confidence: 0.9 },
      { tool: 'model-router Jev', question: 'tier', answer: 'quality', confidence: 0.8 },
    ],
  )
  assert.equal(decision.jev.category.jqId, lines[0].id)
})

test("a team's JQ level sets the bar for Jev's picks and the tier floor", async () => {
  // alpha is JQ 3: picks must be at least 93.3% sure, and the tier is at least balanced.
  const sure = openRouter({ jev: { category: { choice: 'writing', confidence: 0.95 }, tier: { choice: 'cheap', confidence: 0.97 } } })
  let decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl, team: 'alpha' })
  assert.equal(decision.category, 'writing')
  assert.match(decision.reason, /writing \/ balanced · decided by Jev \(openrouter\) · team alpha \(JQ 3\)$/)
  const unsure = openRouter({ jev: { category: { choice: 'writing', confidence: 0.8 }, tier: { choice: 'quality', confidence: 0.8 } } })
  decision = await plan('Fix this bug in my TypeScript function', { env: OR, fetchImpl: unsure.fetchImpl, team: 'alpha' })
  assert.equal(decision.category, 'code') // Jev wasn't sure enough, so the heuristics decided
  assert.match(decision.reason, /code \/ balanced · decided by heuristics · team alpha/)
  // An unknown team fails before Jev is asked, and names the teams there are.
  const none = openRouter()
  await assert.rejects(plan('hi', { env: OR, fetchImpl: none.fetchImpl, team: 'nobody' }), /unknown team "nobody"; teams in .*: alpha, beta/)
  assert.equal(none.calls.length, 0)
  // A level given directly: JQ 4 needs 99.38% and at least the quality tier.
  decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl, jq: 4 })
  assert.match(decision.reason, /\/ quality · decided by heuristics · JQ 4$/)
  // beta is JQ 4: an explicit --prefer still wins over the floor.
  decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl, team: 'beta', prefer: 'cheap' })
  assert.match(decision.reason, /\/ cheap · .* · team beta \(JQ 4\)$/)
})

test('the trust rule: a pick counts only at or above the level\'s accuracy need', async () => {
  const need = accuracyNeed(3)
  const at = openRouter({ jev: { category: { choice: 'writing', confidence: need }, tier: { choice: 'quality', confidence: need } } })
  let decision = await plan('fix this python bug', { env: OR, fetchImpl: at.fetchImpl, jq: 3 })
  assert.equal(decision.category, 'writing')
  assert.match(decision.reason, /writing \/ quality · decided by Jev/)
  const below = openRouter({ jev: { category: { choice: 'writing', confidence: need - 0.0001 }, tier: { choice: 'quality', confidence: need - 0.0001 } } })
  decision = await plan('fix this python bug', { env: OR, fetchImpl: below.fetchImpl, jq: 3 })
  assert.equal(decision.category, 'code')
  assert.match(decision.reason, /code \/ balanced · decided by heuristics · JQ 3$/)
  // A pick with no stated confidence is never trusted under a bar.
  const unstated = openRouter({ jev: { category: { choice: 'writing' } } })
  decision = await plan('fix this python bug', { env: OR, fetchImpl: unstated.fetchImpl, jq: 1 })
  assert.equal(decision.category, 'code')
})

test('the tier floor per level, and the levels follow the Six Sigma table', () => {
  assert.deepEqual(JQ_MIN_TIER, { 1: 'cheap', 2: 'cheap', 3: 'balanced', 4: 'quality', 5: 'quality' })
  assert.deepEqual(DPMO, { 1: 691462, 2: 308538, 3: 66807, 4: 6210, 5: 233 })
  assert.ok(Math.abs(accuracyNeed(3) - 0.933193) < 1e-12)
  assert.throws(() => accuracyNeed(6), /1 to 5/)
  assert.throws(() => jqBar({ jq: 0 }), /1 to 5/)
})

test("the teams file's default level applies when no team is named", async () => {
  const teams = loadTeams({ env: { JQ_TEAMS_FILE: teamsFixture({ teams: { alpha: { level: 3 } }, default: { level: 4, source: 'test fixture' } }) } })
  const sure = openRouter({ jev: { category: { choice: 'writing', confidence: 0.95 }, tier: { choice: 'cheap', confidence: 0.97 } } })
  let decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl, teams })
  assert.match(decision.reason, /\/ quality · decided by heuristics · default JQ 4$/)
  // A named team or a direct level wins over the default.
  decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl, teams, team: 'alpha' })
  assert.match(decision.reason, /team alpha \(JQ 3\)$/)
  decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl, teams, jq: 1 })
  assert.match(decision.reason, /writing \/ cheap · decided by Jev \(openrouter\) · JQ 1$/)
  // A teams file without a default sets no bar.
  decision = await plan('write a toast', { env: OR, fetchImpl: sure.fetchImpl })
  assert.match(decision.reason, /writing \/ cheap · decided by Jev \(openrouter\)$/)
})

test('teams come from JQ_TEAMS_FILE, else ./tools/jq/teams.json, else ~/.jq/teams.json; none → --team says where', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'router-cwd-'))
  const home = mkdtempSync(join(tmpdir(), 'router-home-'))
  let teams = loadTeams({ env: {}, cwd, home })
  assert.equal(teams.path, null)
  assert.equal(jqBar({ teams }), null) // no file, no team: no bar
  assert.throws(() => jqBar({ team: 'alpha', teams }), (error) => error.message.includes(join(cwd, 'tools/jq/teams.json')) && error.message.includes(join(home, '.jq', 'teams.json')) && error.message.includes('JQ_TEAMS_FILE'))
  const inHome = join(home, '.jq', 'teams.json')
  mkdirSync(dirname(inHome), { recursive: true })
  writeFileSync(inHome, JSON.stringify({ teams: { gamma: { level: 2 } } }))
  teams = loadTeams({ env: {}, cwd, home })
  assert.equal(teams.path, inHome)
  const inRepo = join(cwd, 'tools', 'jq', 'teams.json')
  mkdirSync(dirname(inRepo), { recursive: true })
  writeFileSync(inRepo, JSON.stringify({ teams: { delta: { level: 5 } } }))
  teams = loadTeams({ env: {}, cwd, home })
  assert.equal(teams.path, inRepo)
  assert.equal(jqBar({ team: 'delta', teams }).minTier, 'quality')
  assert.equal(loadTeams({ env: { JQ_TEAMS_FILE: inHome }, cwd, home }).path, inHome)
})

test('JQ log entries use the jq.mjs format, carry decidedBy, and never the prompt', async () => {
  const jqLogFile = join(mkdtempSync(join(tmpdir(), 'router-jq-')), 'decisions.jsonl')
  const { fetchImpl } = openRouter({ chat: '{"category": "reasoning", "tier": "cheap", "confidence": 0.8}' })
  const decision = await plan('a secret plan to solve x', { env: OR, fetchImpl, jqLogFile })
  const lines = readFileSync(jqLogFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), ['answer', 'confidence', 'decidedBy', 'id', 'kind', 'question', 't', 'tool'])
    assert.match(line.id, /^[0-9a-f]{8}$/)
    assert.equal(line.tool, 'model-router stand-in')
    assert.match(line.decidedBy, /^stand-in /)
  }
  assert.ok(!readFileSync(jqLogFile, 'utf8').includes('secret'))
  assert.equal(decision.jev.tier.jqId, lines[1].id)
  // JQ_LOG=off (set for this file) and a null log file log nothing, and leave no jqId.
  const off = await plan('write a toast', { env: OR, fetchImpl: openRouter({ jev: { category: { choice: 'writing', confidence: 0.9 } } }).fetchImpl })
  assert.equal(off.jev.category.jqId, undefined)
})

test('when Jev fails an OpenRouter chat model stands in', async () => {
  const { calls, fetchImpl } = openRouter({ chat: '{"category": "reasoning", "tier": "cheap", "confidence": 0.8}' })
  const decision = await plan('fix this python bug', { env: OR, fetchImpl })
  assert.equal(decision.category, 'reasoning')
  assert.deepEqual(decision.models.slice(0, 2), config.routes.reasoning.cheap.slice(0, 2))
  assert.match(decision.reason, /stand-in openai\/gpt-6-luna/)
  assert.deepEqual(calls.map((c) => c.url), ['https://openrouter.ai/api/v1/systemone', 'https://openrouter.ai/api/v1/chat/completions'])
  assert.equal(calls[1].body.model, config.decider.default)
})

test('the stand-in uses an open model with --open, and ROUTER_DECIDER_MODEL wins', async () => {
  let r = openRouter({ chat: '{"category":"quick","tier":"cheap"}' })
  await plan('x', { env: OR, open: true, fetchImpl: r.fetchImpl })
  assert.equal(r.calls.at(-1).body.model, config.decider.open)
  r = openRouter({ chat: '{"category":"quick"}' })
  await plan('x', { env: { ...OR, ROUTER_DECIDER_MODEL: 'z-ai/glm-5.3-flash' }, fetchImpl: r.fetchImpl })
  assert.equal(r.calls.at(-1).body.model, 'z-ai/glm-5.3-flash')
})

test('a bad or unsure stand-in answer falls back to the heuristics', async () => {
  for (const chat of ['not json', '{"category": "poetry"}', '{"category": "writing", "confidence": 0.1}']) {
    const decision = await plan('fix this python bug', { env: OR, fetchImpl: openRouter({ chat }).fetchImpl })
    assert.equal(decision.category, 'code', chat)
    assert.match(decision.reason, /heuristics/, chat)
  }
})

test('a direct TypeSafe key is preferred, and TYPESAFE_BASE_URL is honoured', async () => {
  const fetchImpl = jevReply({ category: { choice: 'writing', confidence: 0.9 } })
  const decision = await plan('x', { env: { ...TS, ...OR, TYPESAFE_BASE_URL: 'https://openrouter.ai/api/' }, fetchImpl })
  assert.match(decision.reason, /Jev \(typesafe\)/)
  assert.equal(jevReply.last.url, 'https://openrouter.ai/api/v1/systemone')
})

test('--no-jev skips both Jev and the stand-in', async () => {
  const decision = await plan('fix this python bug', { env: { ...TS, ...OR }, jev: false, fetchImpl: () => assert.fail('no call expected') })
  assert.match(decision.reason, /heuristics/)
})

test('no route ever sends OpenRouter more than 3 models', () => {
  for (const category of Object.keys(config.routes))
    for (const prefer of ['quality', 'balanced', 'cheap'])
      for (const open of [false, true])
        assert.ok(route('x', { category, prefer, open }).models.length <= 3, `${category}/${prefer}/${open}`)
})

test('OPENROUTER_AUTH=proxy: Jev and the stand-in go out with no Authorization header', async () => {
  const { calls, fetchImpl } = openRouter({ chat: '{"category":"reasoning","tier":"cheap","confidence":0.9}' })
  const decision = await plan('fix this python bug', { env: { OPENROUTER_AUTH: 'proxy' }, fetchImpl })
  assert.equal(decision.category, 'reasoning')
  assert.deepEqual(calls.map((c) => c.url), ['https://openrouter.ai/api/v1/systemone', 'https://openrouter.ai/api/v1/chat/completions'])
  for (const c of calls) {
    assert.equal(c.headers.authorization, undefined)
    assert.equal(c.headers.Authorization, undefined)
  }
})

test('neither a key nor proxy mode: no OpenRouter calls', async () => {
  const decision = await plan('fix this python bug', { env: { OPENROUTER_AUTH: 'nope' }, fetchImpl: () => assert.fail('no call expected') })
  assert.match(decision.reason, /heuristics/)
})

test('completions cap max_tokens: the default, or what the caller asks for', async () => {
  const { calls, fetchImpl } = openRouter({ chat: 'Hello there, how are you?' })
  const result = await complete('hi', { env: OR, fetchImpl, jev: false, prefer: 'cheap' })
  assert.equal(result.text, 'Hello there, how are you?')
  assert.equal(calls.at(-1).url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(calls.at(-1).body.max_tokens, DEFAULT_MAX_TOKENS)
  await complete('hi', { env: OR, fetchImpl, jev: false, maxTokens: 256 })
  assert.equal(calls.at(-1).body.max_tokens, 256)
  for (const maxTokens of [0, -1, 1.5, NaN])
    await assert.rejects(complete('hi', { env: OR, fetchImpl, jev: false, maxTokens }), /positive integer/)
})

test('fellBack: only a different model than the first choice counts', () => {
  assert.equal(fellBack('anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5'), false)
  assert.equal(fellBack('anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5-20251001'), false)
  assert.equal(fellBack('anthropic/claude-haiku-4.5', 'deepseek/deepseek-v4.1-flash'), true)
  assert.equal(fellBack('openrouter/auto', 'deepseek/deepseek-v4.1-flash'), false)
  assert.equal(fellBack('anthropic/claude-haiku-4.5', undefined), false)
})

test('complete reports which first choice it fell back from', async () => {
  const served = (model) => async () => ({ ok: true, json: async () => ({ model, choices: [{ message: { content: 'hi' } }] }) })
  const opts = { env: OR, jev: false, category: 'quick', prefer: 'quality' }
  const [first] = route('hi', opts).models
  assert.equal((await complete('hi', { ...opts, fetchImpl: served(first) })).fallbackFrom, null)
  assert.equal((await complete('hi', { ...opts, fetchImpl: served('deepseek/deepseek-v4.1-flash') })).fallbackFrom, first)
})

// A fake OpenRouter that answers 402 (out of credit) for every paid model.
const outOfCredit = () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const isFree = (id) => id === 'openrouter/free' || String(id).endsWith(':free')
    if (url.endsWith('/v1/systemone')) return { ok: false, status: 402, json: async () => ({ error: { message: 'Insufficient credits' } }) }
    const models = body.models ?? [body.model]
    if (!models.every(isFree)) return { ok: false, status: 402, json: async () => ({ error: { message: 'Insufficient credits' } }) }
    if (body.response_format) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"category":"writing","tier":"cheap","confidence":0.9}' } }] }) }
    return { ok: true, status: 200, json: async () => ({ model: models[0], choices: [{ message: { content: 'hi from a free model' } }] }) }
  }
  return { calls, fetchImpl }
}

test('out of credit: the decider and the answer both move to free models', async () => {
  const { calls, fetchImpl } = outOfCredit()
  const result = await complete('fix this python bug', { env: OR, fetchImpl })
  assert.equal(result.text, 'hi from a free model')
  assert.equal(result.outOfCredit, true)
  assert.equal(result.category, 'writing')
  assert.match(result.reason, /stand-in openrouter\/free/)
  assert.match(result.reason, /out of credit, switched to free models/)
  assert.deepEqual(result.models, config.free.writing.slice(0, 3))
  const deciders = calls.filter((c) => c.body.response_format).map((c) => c.body.model)
  assert.deepEqual(deciders, [config.decider.default, config.decider.free])
})

test('--free uses free models only, from the start', async () => {
  const { calls, fetchImpl } = outOfCredit()
  const result = await complete('fix this python bug', { env: OR, fetchImpl, free: true, jev: false })
  assert.equal(result.outOfCredit, false)
  assert.deepEqual(result.models, config.free.code.slice(0, 3))
  assert.equal(calls.length, 1)
})

test('free routes: every model is a free one, 3 at most, open-only honoured', () => {
  for (const category of Object.keys(config.routes)) {
    for (const open of [false, true]) {
      const { models } = route('x', { category, free: true, open })
      assert.ok(models.length >= 1 && models.length <= 3, `${category}/${open}`)
      for (const id of models) {
        assert.ok(id === 'openrouter/free' || id.endsWith(':free'), id)
        assert.ok(config.models[id], `${id} declared`)
        if (open) assert.equal(config.models[id].open, true, id)
      }
    }
  }
})

test('out of credit, a named model falls back to free models and says so', async () => {
  const { fetchImpl } = outOfCredit()
  const r = await complete('hi', { env: OR, fetchImpl, model: 'openai/gpt-6-sol' })
  assert.equal(r.outOfCredit, true)
  assert.ok(r.models.every((id) => id === 'openrouter/free' || id.endsWith(':free')), r.models.join())
  assert.match(r.reason, /openai\/gpt-6-sol is out of credit/)
})

test('with strict, a named model is never swapped for a free one', async () => {
  const { fetchImpl } = outOfCredit()
  await assert.rejects(complete('hi', { env: OR, fetchImpl, model: 'openai/gpt-6-sol', strict: true }), /402/)
})

test('complete flags an answer cut short by max_tokens', async () => {
  const finished = (finish_reason) => async () => ({ ok: true, json: async () => ({ model: 'x/y', choices: [{ message: { content: 'Hello there, my' }, finish_reason }] }) })
  const opts = { env: OR, jev: false, category: 'quick', prefer: 'cheap' }
  assert.equal((await complete('hi', { ...opts, fetchImpl: finished('length') })).truncated, true)
  assert.equal((await complete('hi', { ...opts, fetchImpl: finished('stop') })).truncated, false)
})

test('plan skips Jev once category and tier are both given', async () => {
  const noCall = () => assert.fail('no call expected')
  const decision = await plan('hi', { env: OR, fetchImpl: noCall, category: 'code', prefer: 'cheap' })
  assert.equal(decision.category, 'code')
  assert.deepEqual(decision.models, route('hi', { category: 'code', prefer: 'cheap' }).models)
  assert.match(decision.reason, /decided by flags/)
  assert.match((await plan('hi', { env: OR, fetchImpl: noCall, category: 'code', free: true })).reason, /decided by flags/)
})

test('sweep runs every category × tier route and reports each one', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    // The code/quality route falls back; everything else answers with its first choice.
    const model = body.model === route('x', { category: 'code', prefer: 'quality' }).models[0] ? 'someone/else' : body.model
    return { ok: true, json: async () => ({ model, choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }) }
  }
  const rows = await sweep('x', { env: OR, fetchImpl })
  assert.equal(rows.length, Object.keys(config.routes).length * 3)
  assert.equal(requests.length, rows.length, 'one request per route, no Jev calls')
  const code = rows.find((r) => r.category === 'code' && r.tier === 'quality')
  assert.equal(code.fallbackFrom, code.first)
  assert.equal(rows.filter((r) => r.fallbackFrom).length, rows.filter((r) => r.first === code.first).length)

  const narrowed = await sweep('x', { env: OR, fetchImpl, category: 'writing' })
  assert.deepEqual(narrowed.map((r) => r.tier), ['quality', 'balanced', 'cheap'])
  const failing = await sweep('x', { env: OR, category: 'quick', prefer: 'cheap', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }) })
  assert.equal(failing.length, 1)
  assert.match(failing[0].error, /500: boom/)
})

test('complete treats an error inside a 200 response as a failure', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 503, message: 'Upstream error from Nvidia: Service temporarily overloaded' } }) })
  await assert.rejects(complete('hi', { env: OR, fetchImpl, category: 'general', prefer: 'quality', retryDelayMs: 0 }), /OpenRouter 503: Upstream error/)
  const [row] = await sweep('hi', { env: OR, fetchImpl, category: 'general', prefer: 'quality', retryDelayMs: 0 })
  assert.match(row.error, /503/)
})

// Answers the chat endpoint from a list of canned replies, one per call; GETs (credit checks) from `credit`.
const scripted = (replies, credit = {}) => {
  const chats = []
  const fetchImpl = async (url, init) => {
    if (!init.body) {
      const data = url.endsWith('/credits') ? credit.credits : url.endsWith('/key') ? credit.key : undefined
      return data ? { ok: true, json: async () => ({ data }) } : { ok: false, json: async () => ({}) }
    }
    chats.push(JSON.parse(init.body))
    const [status, body] = replies[Math.min(chats.length, replies.length) - 1]
    return { ok: status < 400, status, json: async () => body }
  }
  return { chats, fetchImpl }
}
const answer = (model, content = 'hi') => [200, { model, choices: [{ message: { content }, finish_reason: 'stop' }] }]
const QUICK = { env: OR, jev: false, category: 'quick', prefer: 'cheap', retryDelayMs: 0 }
const firstQuick = route('x', QUICK).models[0]

test('a brief provider error is retried once, and only once', async () => {
  const ok = scripted([[429, { error: { code: 429, message: 'Provider returned error' } }], answer(firstQuick)])
  const result = await complete('hi', { ...QUICK, fetchImpl: ok.fetchImpl })
  assert.equal(result.retried, true)
  assert.equal(ok.chats.length, 2)

  const inBody = scripted([[200, { error: { code: 504, message: 'Provider timed out' } }], answer(firstQuick)])
  assert.equal((await complete('hi', { ...QUICK, fetchImpl: inBody.fetchImpl })).retried, true)

  const down = scripted([[503, { error: { code: 503, message: 'overloaded' } }]])
  await assert.rejects(complete('hi', { ...QUICK, fetchImpl: down.fetchImpl }), /503: overloaded/)
  assert.equal(down.chats.length, 2)

  const bad = scripted([[400, { error: { code: 400, message: 'bad request' } }]])
  await assert.rejects(complete('hi', { ...QUICK, fetchImpl: bad.fetchImpl }), /400/)
  assert.equal(bad.chats.length, 1, 'not a brief error: no retry')
})

test('creditStatus tells an empty account from a spent key', async () => {
  const check = (credit) => creditStatus({ env: OR, fetchImpl: scripted([], credit).fetchImpl })
  assert.equal((await check({ credits: { total_credits: 0, total_usage: 0.16 }, key: { limit_remaining: 49.99 } })).short, 'account')
  assert.equal((await check({ credits: { total_credits: 10, total_usage: 2 }, key: { limit_remaining: 0 } })).short, 'key')
  assert.equal((await check({ credits: { total_credits: 10, total_usage: 2 }, key: { limit_remaining: null } })).short, null)
  assert.deepEqual(await check({}), { account: null, keyLeft: null, short: null })
})

test('a fallback or a 402 reports which credit ran out', async () => {
  const empty = { credits: { total_credits: 0, total_usage: 0.16 }, key: { limit_remaining: 49.99 } }
  const fell = await complete('hi', { ...QUICK, fetchImpl: scripted([answer('someone/else')], empty).fetchImpl })
  assert.equal(fell.fallbackFrom, firstQuick)
  assert.equal(fell.creditShort, 'account')
  const free = await complete('hi', { ...QUICK, free: true, fetchImpl: scripted([answer('someone/else:free')], empty).fetchImpl })
  assert.ok(free.fallbackFrom)
  assert.equal(free.creditShort, null, 'free models cost nothing: credit is not the cause')
  const clean = await complete('hi', { ...QUICK, fetchImpl: scripted([answer(firstQuick)], empty).fetchImpl })
  assert.equal(clean.creditShort, null, 'no fallback, no credit check')
  const named = scripted([[402, { error: { code: 402, message: 'This request requires more credits' } }]], empty)
  await assert.rejects(complete('hi', { env: OR, model: 'moonshotai/kimi-k3', strict: true, fetchImpl: named.fetchImpl }), /account has no credit left/)
})

test('sweep runs at most `concurrency` routes at once and checks credit once', async () => {
  let inFlight = 0, peak = 0, creditChecks = 0
  const fetchImpl = async (url, init) => {
    if (!init.body) { creditChecks++; return { ok: false, json: async () => ({}) } }
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight--
    return { ok: true, status: 200, json: async () => ({ model: 'someone/else', choices: [{ message: { content: ' hi ' } }] }) }
  }
  const rows = await sweep('x', { env: OR, fetchImpl, concurrency: 2 })
  assert.equal(rows.length, Object.keys(config.routes).length * 3)
  assert.equal(peak, 2)
  assert.equal(creditChecks, 2, 'one /key and one /credits read for the whole sweep')
  assert.ok(rows.every((r) => r.category && r.tier), 'rows keep their order and labels')
  await assert.rejects(sweep('x', { env: OR, fetchImpl, concurrency: 0 }), /concurrency/)
})

test('sweepRoutes lists every route without calling anything', () => {
  const rows = sweepRoutes('x', { open: true })
  assert.equal(rows.length, Object.keys(config.routes).length * 3)
  for (const r of rows) assert.deepEqual(r.models, route('x', { category: r.category, prefer: r.tier, open: true }).models)
  assert.deepEqual(sweepRoutes('x', { free: true, category: 'code' }), [{ category: 'code', tier: 'free', models: route('x', { category: 'code', free: true }).models }])
})

test('open cheap and balanced routes never top up with a quality-only model', () => {
  for (const [category, tiers] of Object.entries(config.routes)) {
    const qualityOnly = tiers.quality.filter((id) => !tiers.balanced.includes(id) && !tiers.cheap.includes(id))
    for (const prefer of ['balanced', 'cheap']) {
      const { models } = route('x', { category, prefer, open: true })
      for (const id of models) assert.ok(!qualityOnly.includes(id), `${id} in ${category}/${prefer}`)
    }
  }
})

test('every free route keeps three models under --open', () => {
  for (const category of Object.keys(config.free))
    assert.equal(route('x', { category, free: true, open: true }).models.length, 3, category)
})

// A fake Ollama: /api/tags lists `pulled`; chat answers from `replies` (model -> [status, body]).
const ollama = (pulled, replies = {}) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} })
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: pulled.map((name) => ({ name })) }) }
    const { model } = JSON.parse(init.body)
    const [status, body] = replies[model] ?? [200, { model, message: { role: 'assistant', content: `hi from ${model}` }, done: true, done_reason: 'stop' }]
    return { ok: status < 400, status, json: async () => body }
  }
  return { calls, fetchImpl }
}
const LOCAL = { env: {}, local: true, jev: false }
// The local tests use a fixed route table, not whatever models routes.json names today.
const SAMPLE_LOCAL = {
  code: ['qwen3-coder', 'qwen3', 'llama3.3'], reasoning: ['deepseek-r1', 'qwen3', 'llama3.3'],
  long_context: ['qwen3', 'llama3.3', 'gemma3'], writing: ['llama3.3', 'gemma3', 'qwen3'],
  quick: ['gemma3', 'llama3.2', 'qwen3'], general: ['llama3.3', 'qwen3', 'gemma3'],
}
const sampleLocal = (t) => {
  const real = { ...config.local }
  Object.assign(config.local, SAMPLE_LOCAL)
  t.after(() => {
    for (const key of Object.keys(config.local)) delete config.local[key]
    Object.assign(config.local, real)
  })
}

test('ollamaBase: OLLAMA_BASE_URL, then OLLAMA_HOST, then localhost', () => {
  assert.equal(ollamaBase({}), 'http://localhost:11434')
  assert.equal(ollamaBase({ OLLAMA_HOST: '0.0.0.0:11434' }), 'http://0.0.0.0:11434')
  assert.equal(ollamaBase({ OLLAMA_BASE_URL: 'http://gpu-box:11434/v1/', OLLAMA_HOST: 'x:1' }), 'http://gpu-box:11434')
})

test('pickInstalled: untagged names match any tag, tagged names match exactly', () => {
  const installed = ['qwen3:8b', 'llama3.3:latest', 'gemma3:4b']
  assert.deepEqual(pickInstalled(['qwen3-coder', 'qwen3', 'llama3.3'], installed), { models: ['qwen3:8b', 'llama3.3:latest'], missing: ['qwen3-coder'] })
  assert.deepEqual(pickInstalled(['gemma3:27b', 'gemma3:4b'], installed), { models: ['gemma3:4b'], missing: ['gemma3:27b'] })
})

test('--local routes to Ollama only: the pulled models, in order, no OpenRouter call or key', async (t) => {
  sampleLocal(t)
  const { calls, fetchImpl } = ollama(['qwen3:8b', 'llama3.3:latest'])
  const result = await complete('fix this bug', { ...LOCAL, category: 'code', fetchImpl, maxTokens: 300 })
  assert.equal(result.model, 'qwen3:8b')
  assert.equal(result.text, 'hi from qwen3:8b')
  assert.deepEqual(result.models, ['qwen3:8b', 'llama3.3:latest'])
  assert.deepEqual(result.missing, ['qwen3-coder'])
  assert.equal(result.fallbackFrom, null)
  assert.ok(calls.every((c) => c.url.startsWith('http://localhost:11434/')), 'nothing leaves the machine')
  const chat = calls.find((c) => c.url.endsWith('/api/chat'))
  assert.equal(chat.url, 'http://localhost:11434/api/chat')
  assert.equal(chat.body.options.num_predict, 300)
  assert.equal(chat.body.think, false, 'thinking off by default')
  assert.equal(chat.body.stream, false)
  assert.equal(chat.headers.Authorization, undefined)
})

test('--local falls back through pulled models, and says when all fail', async (t) => {
  sampleLocal(t)
  const flaky = ollama(['qwen3:8b', 'llama3.3:latest'], { 'qwen3:8b': [500, { error: { message: 'out of memory' } }] })
  const result = await complete('fix this bug', { ...LOCAL, category: 'code', fetchImpl: flaky.fetchImpl })
  assert.equal(result.model, 'llama3.3:latest')
  assert.equal(result.fallbackFrom, 'qwen3:8b')
  const dead = ollama(['qwen3:8b'], { 'qwen3:8b': [500, { error: { message: 'out of memory' } }] })
  await assert.rejects(complete('x', { ...LOCAL, category: 'code', fetchImpl: dead.fetchImpl }), /no local model answered \(qwen3:8b: out of memory\)/)
})

test('--local uses any pulled model when none of the route is, and explains an empty or stopped Ollama', async (t) => {
  sampleLocal(t)
  const other = ollama(['mistral:7b'])
  const result = await complete('x', { ...LOCAL, category: 'quick', fetchImpl: other.fetchImpl })
  assert.equal(result.model, 'mistral:7b')
  assert.equal(result.standIn, 'mistral:7b')
  await assert.rejects(complete('x', { ...LOCAL, category: 'quick', fetchImpl: ollama([]).fetchImpl }), /has no chat models\. Pull one first, e\.g\. `ollama pull gemma3`/)
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  await assert.rejects(localModels({ env: {}, fetchImpl: down }), /Can't reach Ollama at http:\/\/localhost:11434 \(ECONNREFUSED\)\. Start it with `ollama serve`/)
})

test('--local sweeps every category one at a time, and skips Jev once the category is set', async (t) => {
  sampleLocal(t)
  let inFlight = 0, peak = 0
  const { fetchImpl } = ollama(['qwen3:8b'])
  const slow = async (url, init) => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 2))
    try { return await fetchImpl(url, init) } finally { inFlight-- }
  }
  const rows = await sweep('x', { env: {}, local: true, fetchImpl: slow })
  assert.deepEqual(rows.map((r) => r.tier), Array(Object.keys(config.local).length).fill('local'))
  assert.ok(rows.every((r) => r.model === 'qwen3:8b' && !r.error))
  assert.deepEqual(rows.find((r) => r.category === 'code').missing, ['qwen3-coder', 'llama3.3'])
  assert.equal(peak, 1)
  const decision = await plan('x', { env: OR, local: true, category: 'code', fetchImpl: () => assert.fail('no Jev call') })
  assert.deepEqual(decision.models, config.local.code)
  assert.deepEqual(sweepRoutes('x', { local: true, category: 'code' }), [{ category: 'code', tier: 'local', models: config.local.code }])
})

test('every category has a local route: an override, or built automatically', () => {
  for (const category of Object.keys(config.routes)) {
    const { models, auto } = route('x', { local: true, category })
    assert.ok(models.length > 0 || auto, category)
  }
})

test('the daily free-model limit is not retried, and a sweep stops sending free routes once it hits', async () => {
  const capped = [429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }]
  const one = scripted([capped])
  await assert.rejects(complete('hi', { ...QUICK, free: true, fetchImpl: one.fetchImpl }), /free-models-per-day.*\(free requests are used up for today; the limit resets at 00:00 UTC\)/)
  assert.equal(one.chats.length, 1, 'no retry')

  const all = scripted([capped])
  const rows = await sweep('hi', { env: OR, free: true, concurrency: 1, retryDelayMs: 0, fetchImpl: all.fetchImpl })
  assert.equal(all.chats.length, 1, 'only the first free route is sent')
  assert.equal(rows.length, Object.keys(config.free).length)
  assert.ok(rows.slice(1).every((r) => r.skipped && /^not sent: free requests are used up/.test(r.error)))
})

test('embedding models never answer: not as a stand-in, and alone they count as no chat model', async (t) => {
  sampleLocal(t)
  for (const name of ['nomic-embed-text:latest', 'mxbai-embed-large', 'all-minilm:l6-v2', 'bge-m3']) assert.ok(isEmbeddingModel(name), name)
  for (const name of ['qwen3.5:9b', 'llama3.3', 'gemma3:4b']) assert.ok(!isEmbeddingModel(name), name)
  // The embedding model is listed first, as Ollama may list it; the chat model still stands in.
  const mixed = ollama(['nomic-embed-text:latest', 'mistral:7b'])
  assert.equal((await complete('x', { ...LOCAL, category: 'code', fetchImpl: mixed.fetchImpl })).standIn, 'mistral:7b')
  await assert.rejects(complete('x', { ...LOCAL, category: 'code', fetchImpl: ollama(['nomic-embed-text:latest']).fetchImpl }), /no chat models \(only embedding models: nomic-embed-text:latest\)/)
  // An automatic route leaves the embedding model out too.
  delete config.local.code
  assert.equal((await complete('x', { ...LOCAL, category: 'code', fetchImpl: mixed.fetchImpl })).model, 'mistral:7b')
})

// What `check --local` reported on the owner's machine.
const OWNER_PULLED = ['qwen3.5:2b', 'qwen3.5:0.8b', 'qwen3.5:9b', 'nomic-embed-text:latest', 'qwen3.5:4b'].map((name) => ({ name }))

test('modelSize reads parameter_size, else the tag', () => {
  assert.equal(modelSize({ name: 'qwen3.5:9b' }), 9)
  assert.equal(modelSize({ name: 'qwen3.5:0.8b' }), 0.8)
  assert.equal(modelSize({ name: 'gemma3n:e4b' }), 4)
  assert.equal(modelSize({ name: 'llama3.3:latest', details: { parameter_size: '70.6B' } }), 70.6)
  assert.equal(modelSize({ name: 'smollm2:latest', details: { parameter_size: '360M' } }), 0.36)
  assert.equal(modelSize({ name: 'mystery:latest' }), null)
})

test("autoLocalRoute ranks the owner's models by size per category, skipping embedding models", () => {
  const big = ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:2b']
  for (const category of ['code', 'reasoning', 'long_context', 'writing']) assert.deepEqual(autoLocalRoute(category, OWNER_PULLED), big, category)
  assert.deepEqual(autoLocalRoute('general', OWNER_PULLED), ['qwen3.5:4b', 'qwen3.5:9b', 'qwen3.5:2b'])
  assert.deepEqual(autoLocalRoute('quick', OWNER_PULLED), ['qwen3.5:2b', 'qwen3.5:4b', 'qwen3.5:9b'])
  // Unknown sizes go after known ones; an embedding family is skipped even without "embed" in the name.
  const mixed = [{ name: 'mystery:latest' }, { name: 'tiny:0.5b' }, { name: 'vec:latest', details: { family: 'nomic-bert' } }, { name: 'mid:7b' }]
  assert.deepEqual(autoLocalRoute('code', mixed), ['mid:7b', 'tiny:0.5b', 'mystery:latest'])
  assert.deepEqual(autoLocalRoute('quick', mixed), ['mid:7b', 'mystery:latest', 'tiny:0.5b'])
  assert.deepEqual(autoLocalRoute('code', [{ name: 'nomic-embed-text:latest' }]), [])
})

test('with no override, --local builds the route from what is pulled', async () => {
  assert.deepEqual(config.local, {}, 'routes.json ships no local lists')
  assert.equal(route('x', { local: true, category: 'code' }).auto, true)
  const { fetchImpl } = ollama(OWNER_PULLED.map((m) => m.name))
  const result = await complete('fix this', { ...LOCAL, category: 'code', fetchImpl })
  assert.equal(result.model, 'qwen3.5:9b')
  assert.deepEqual(result.models, ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:2b'])
  assert.deepEqual(result.missing, [])
  assert.equal(result.standIn, null)
  const rows = await sweep('x', { env: {}, local: true, fetchImpl })
  assert.deepEqual(rows.map((r) => r.first), rows.map((r) => autoLocalRoute(r.category, OWNER_PULLED)[0]))
  assert.deepEqual(sweepRoutes('x', { local: true, category: 'quick' }), [{ category: 'quick', tier: 'local', models: [], auto: true }])
})

test('a local model that takes too long is cancelled, and the next one answers', async () => {
  assert.equal(LOCAL_TIMEOUT_MS, 180_000)
  // Model "hang" never answers; "stall" answers headers but never finishes its body; "fast" answers.
  const aborted = []
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'hang:9b' }, { name: 'stall:4b' }, { name: 'fast:2b' }] }) }
    const { model } = JSON.parse(init.body)
    const waitForAbort = () => new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      aborted.push(model)
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    }))
    if (model === 'hang:9b') return waitForAbort()
    if (model === 'stall:4b') return { ok: true, status: 200, json: waitForAbort }
    return { ok: true, status: 200, json: async () => ({ model, choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }) }
  }
  const result = await complete('x', { ...LOCAL, category: 'code', fetchImpl, timeoutMs: 20 })
  assert.equal(result.model, 'fast:2b')
  assert.equal(result.fallbackFrom, 'hang:9b')
  assert.deepEqual(result.skipped, ['hang:9b: no answer within 0.02s', 'stall:4b: no answer within 0.02s'])
  assert.deepEqual(aborted, ['hang:9b', 'stall:4b'], 'both slow requests were cancelled')

  const allSlow = async (url, init = {}) => url.endsWith('/api/tags')
    ? { ok: true, status: 200, json: async () => ({ models: [{ name: 'hang:9b' }] }) }
    : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  await assert.rejects(complete('x', { ...LOCAL, category: 'code', fetchImpl: allSlow, timeoutMs: 20 }), /no local model answered \(hang:9b: no answer within 0\.02s\)/)
  await assert.rejects(complete('x', { ...LOCAL, category: 'code', fetchImpl: allSlow, timeoutMs: 0 }), /timeout must be a positive number of seconds/)
})

test('track record: stored per model, last 20 kept, older than 7 days ignored, off switch honoured', () => {
  const file = tempStats()
  const now = Date.parse('2026-09-26T12:00:00Z')
  recordOutcomes(Array.from({ length: 25 }, (_, i) => ({ model: 'a', ok: i % 5 !== 0, ms: 1000 + i })), { statsFile: file, now })
  assert.equal(loadStats(file).models.a.length, 20)
  recordOutcomes([{ model: 'openrouter/free', ok: true }], { statsFile: file, now })
  assert.equal(loadStats(file).models['openrouter/free'], undefined, 'routers are not models')
  assert.deepEqual(trackRecord('a', loadStats(file), now + 8 * 24 * 3600 * 1000), { attempts: 0, answered: 0, score: 0.5, medianMs: null })
  const record = trackRecord('a', loadStats(file), now)
  assert.equal(record.attempts, 20)
  assert.equal(record.answered, 16)
  assert.equal(statsFilePath(), null, 'ROUTER_STATS=off')
  recordOutcomes([{ model: 'b', ok: true }], { statsFile: null })
})

test('rankByTrackRecord: reliable first, then faster; unknown models keep their place; routers keep their slot', () => {
  const now = Date.now()
  const stats = { models: {
    flaky: [false, false, true].map((ok) => ({ t: now, ok, ms: 500 })),
    steady: [true, true, true].map((ok) => ({ t: now, ok, ms: 3000 })),
    quick: [true, true, true].map((ok) => ({ t: now, ok, ms: 800 })),
  } }
  assert.deepEqual(rankByTrackRecord(['flaky', 'new', 'steady', 'openrouter/free', 'quick'], stats, now),
    { models: ['quick', 'steady', 'new', 'openrouter/free', 'flaky'], reordered: true })
  assert.deepEqual(rankByTrackRecord(['x', 'y', 'openrouter/free'], { models: {} }, now), { models: ['x', 'y', 'openrouter/free'], reordered: false })
  // One or two results aren't enough to move a model.
  const thin = { models: { x: [{ t: now, ok: false }, { t: now, ok: false }], y: [{ t: now, ok: true, ms: 100 }] } }
  assert.deepEqual(rankByTrackRecord(['x', 'y'], thin, now), { models: ['x', 'y'], reordered: false })
})

test('free routes follow the track record, and requests keep it up to date', async () => {
  const file = tempStats()
  const [first, second] = config.free.code
  // No record yet: the routes.json order.
  assert.deepEqual(route('x', { category: 'code', free: true, statsFile: file }).models, config.free.code.slice(0, 3))
  // The first choice keeps failing over to the second.
  const fellBack = async () => ({ ok: true, status: 200, json: async () => ({ model: second, choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }) })
  for (let i = 0; i < 3; i++) await complete('x', { env: OR, jev: false, category: 'code', free: true, statsFile: file, fetchImpl: fellBack })
  assert.equal(trackRecord(first, loadStats(file)).answered, 0)
  assert.equal(trackRecord(second, loadStats(file)).answered, 3)
  const ranked = route('x', { category: 'code', free: true, statsFile: file })
  assert.equal(ranked.models[0], second)
  assert.match(ranked.reason, /ranked by track record/)

  // The account's limits aren't the models' fault: not recorded.
  const before = readFileSync(file, 'utf8')
  const capped = async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }) })
  await assert.rejects(complete('x', { env: OR, jev: false, category: 'code', free: true, statsFile: file, fetchImpl: capped }))
  assert.equal(readFileSync(file, 'utf8'), before)
  // A real failure counts against every model tried.
  const down = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 400, message: 'bad' } }) })
  await assert.rejects(complete('x', { env: OR, jev: false, category: 'code', free: true, statsFile: file, fetchImpl: down }))
  assert.equal(trackRecord(second, loadStats(file)).attempts, 4)
})

test('modelOverview: every model with its routes, first choices and record; unused and routers handled', () => {
  const now = Date.now()
  const stats = { models: { 'nvidia/nemotron-3-ultra-550b-a55b:free': [{ t: now, ok: true, ms: 1600 }] } }
  const rows = modelOverview({ stats, pulled: [{ name: 'qwen3.5:9b' }, { name: 'nomic-embed-text:latest' }], now })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.ok(!byId['openrouter/auto'] && !byId['openrouter/free'], 'routers are not models')
  // Paid: the code/quality route's first choice is listed as such.
  const codeFirst = route('x', { category: 'code', prefer: 'quality' }).models[0]
  assert.ok(byId[codeFirst].first.includes('code/quality'))
  assert.equal(byId[codeFirst].kind, 'paid')
  // Free: kind, routes and record.
  const ultra = byId['nvidia/nemotron-3-ultra-550b-a55b:free']
  assert.equal(ultra.kind, 'free')
  assert.ok(ultra.routes.includes('reasoning/free'))
  assert.deepEqual([ultra.answered, ultra.attempts, ultra.medianMs], [1, 1, 1600])
  // Local: from what's pulled, embedding models left out.
  assert.equal(byId['qwen3.5:9b'].kind, 'local')
  assert.equal(byId['qwen3.5:9b'].routes.length, Object.keys(config.routes).length)
  assert.ok(!byId['nomic-embed-text:latest'])
  // No Ollama: no local rows. Every declared model appears, used or not.
  const offline = modelOverview({ stats, pulled: null, now })
  assert.ok(offline.every((r) => r.kind !== 'local'))
  for (const id of Object.keys(config.models)) if (id !== 'openrouter/auto' && id !== 'openrouter/free') assert.ok(offline.some((r) => r.id === id), id)
  // First choice only with --open is starred: writing/balanced leads with a closed model, --open with an open one.
  const closedFirst = route('x', { category: 'writing', prefer: 'balanced' }).models[0]
  const openFirst = route('x', { category: 'writing', prefer: 'balanced', open: true }).models[0]
  assert.notEqual(closedFirst, openFirst)
  assert.ok(byId[closedFirst].first.includes('writing/balanced'))
  assert.ok(byId[openFirst].first.includes('writing/balanced*'))
  // Ordered paid, then free, then local.
  const kinds = rows.map((r) => r.kind)
  assert.deepEqual(kinds, [...kinds].sort((a, b) => ['paid', 'free', 'local'].indexOf(a) - ['paid', 'free', 'local'].indexOf(b)))
})

test('local requests default to a 4000-token cap; OpenRouter keeps 1000; --max-tokens overrides both', async () => {
  assert.equal(LOCAL_MAX_TOKENS, 4000)
  const { calls, fetchImpl } = ollama(['qwen3.5:2b'])
  await complete('x', { ...LOCAL, category: 'quick', fetchImpl })
  assert.equal(calls.at(-1).body.options.num_predict, 4000)
  await complete('x', { ...LOCAL, category: 'quick', fetchImpl, maxTokens: 500 })
  assert.equal(calls.at(-1).body.options.num_predict, 500)
  const remote = openRouter({ chat: 'hi' })
  await complete('x', { env: OR, jev: false, category: 'quick', prefer: 'cheap', fetchImpl: remote.fetchImpl })
  assert.equal(remote.calls.at(-1).body.max_tokens, DEFAULT_MAX_TOKENS)
})

test('exploration: now and then an under-tested free model goes first; the usual pick backs it up', async () => {
  assert.equal(EXPLORE_RATE, 0.1)
  const file = tempStats()
  const now = Date.now()
  const [leader, second, third] = config.free.code.filter((id) => id !== 'openrouter/free')
  // The leader has a long record; the others have little or none.
  recordOutcomes(Array.from({ length: 5 }, () => ({ model: leader, ok: true, ms: 1000 })), { statsFile: file, now })
  recordOutcomes([{ model: second, ok: true, ms: 900 }, { model: second, ok: true, ms: 900 }], { statsFile: file, now })
  const base = route('x', { category: 'code', free: true, statsFile: file })
  const dice = (value) => () => value
  // Rolled above the rate: unchanged.
  assert.equal(explore(base, { statsFile: file, explore: true, random: dice(0.5) }), base)
  // Rolled below: the thinnest record (no requests at all) goes first, the leader second.
  const tried = explore(base, { statsFile: file, explore: true, random: dice(0.05) })
  assert.equal(tried.explored, third)
  assert.equal(tried.models[0], third)
  assert.equal(tried.models[1], base.models[0])
  assert.equal(tried.models.length, base.models.length)
  if (base.models.includes('openrouter/free')) assert.ok(tried.models.includes('openrouter/free'), 'the catch-all keeps its place')
  assert.match(tried.reason, new RegExp(`exploring ${third}`))
  // Off, or nothing under-tested: unchanged.
  assert.equal(explore(base, { statsFile: file, explore: false, random: dice(0) }), base)
  const seasoned = { models: Object.fromEntries(config.free.code.map((id) => [id, Array.from({ length: 3 }, () => ({ t: now, ok: true }))])) }
  const seasonedFile = tempStats()
  for (const [model, history] of Object.entries(seasoned.models)) recordOutcomes(history.map(() => ({ model, ok: true })), { statsFile: seasonedFile, now })
  assert.equal(explore(base, { statsFile: seasonedFile, explore: true, random: dice(0) }), base)

  // Through complete(): the request goes to the explored model first, and the result says so.
  const requests = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    return { ok: true, status: 200, json: async () => ({ model: body.model, choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }) }
  }
  const result = await complete('x', { env: OR, jev: false, category: 'code', free: true, statsFile: file, explore: true, random: dice(0), fetchImpl })
  assert.equal(requests[0].model, third)
  assert.equal(result.explored, third)
  assert.equal(result.fallbackFrom, null)
  // Paid routes never explore.
  const paid = await complete('x', { env: OR, jev: false, category: 'code', prefer: 'cheap', statsFile: file, explore: true, random: dice(0), fetchImpl })
  assert.equal(paid.explored, undefined)
})

test("local requests use Ollama's /api/chat with thinking off; --think turns it on; a model without it is asked again", async () => {
  const think = ollama(['qwen3.5:2b'])
  await complete('x', { ...LOCAL, category: 'quick', fetchImpl: think.fetchImpl, think: true })
  assert.equal(think.calls.at(-1).body.think, true)

  // Ollama refuses the setting for a model with no thinking mode: sent again without it.
  const plain = ollama(['llama3.2:3b'])
  const sent = []
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(init.body)
      sent.push(body)
      if ('think' in body) return { ok: false, status: 400, json: async () => ({ error: '"llama3.2:3b" does not support thinking' }) }
    }
    return plain.fetchImpl(url, init)
  }
  const result = await complete('x', { ...LOCAL, category: 'quick', fetchImpl })
  assert.equal(result.text, 'hi from llama3.2:3b')
  assert.deepEqual(sent.map((b) => 'think' in b), [true, false])

  // Ollama's own error format ({ error: "text" }) and its cut-off marker.
  const oom = ollama(['qwen3.5:9b', 'qwen3.5:4b'], {
    'qwen3.5:9b': [500, { error: 'model requires more system memory' }],
    'qwen3.5:4b': [200, { model: 'qwen3.5:4b', message: { content: 'Hello the' }, done: true, done_reason: 'length' }],
  })
  const cut = await complete('x', { ...LOCAL, category: 'code', fetchImpl: oom.fetchImpl })
  assert.deepEqual(cut.skipped, ['qwen3.5:9b: model requires more system memory'])
  assert.equal(cut.truncated, true)
  assert.equal(cut.text, 'Hello the')
})

test('callRecord keeps the routing facts and never the prompt text', () => {
  const result = {
    category: 'code', models: ['a/x', 'b/y'], model: 'b/y', fallbackFrom: 'a/x', outOfCredit: false, truncated: false,
    reason: 'code · decided by Jev (openrouter) · balanced', usage: { prompt_tokens: 12, completion_tokens: 30, cost: 0.0004 }, id: 'gen-1',
  }
  const record = callRecord('secret prompt', { prefer: 'cheap' }, result, 850, null, { CLAUDE_CODE_SESSION_ID: 's1' })
  assert.equal(record.kind, 'router.call')
  assert.equal(record.session, 's1')
  assert.equal(record.promptChars, 13)
  assert.equal(record.decidedBy, 'decided by Jev (openrouter)')
  assert.equal(record.costUsd, 0.0004)
  assert.equal(record.generationId, 'gen-1')
  assert.ok(!JSON.stringify(record).includes('secret'))
  const failed = callRecord('x', { model: 'a/x' }, null, 5, new Error('OpenRouter 500'), {})
  assert.equal(failed.requested, 'a/x')
  assert.equal(failed.error, 'OpenRouter 500')
})

// ---- owned providers (already paid for by subscription) ----

const OWNED = ['openai', 'google']

test('ownedFamilies reads routes.json, and ROUTER_OWNED overrides it', () => {
  assert.deepEqual(config.owned.families, OWNED)
  assert.deepEqual(ownedFamilies({}), OWNED)
  assert.deepEqual(ownedFamilies({ ROUTER_OWNED: 'none' }), [])
  assert.deepEqual(ownedFamilies({ ROUTER_OWNED: ' openai , x-ai ' }), ['openai', 'x-ai'])
  assert.ok(isOwned('openai/gpt-6-luna', OWNED) && !isOwned('qwen/qwen3.8-flash', OWNED))
})

test('paid routes never carry owned models or openrouter/auto, and stay full', () => {
  for (const [category, tiers] of Object.entries(config.routes)) for (const prefer of Object.keys(tiers)) {
    const r = route('x', { category, prefer, owned: OWNED })
    assert.ok(r.models.length > 0 && r.models.length <= 3, `${category}/${prefer}`)
    assert.ok(r.models.every((m) => !isOwned(m, OWNED) && m !== 'openrouter/auto'), `${category}/${prefer}: ${r.models}`)
  }
  const plain = route('x', { category: 'code', prefer: 'cheap', owned: [] })
  const guarded = route('x', { category: 'code', prefer: 'cheap', owned: OWNED })
  if (plain.models.some((m) => isOwned(m, OWNED) || m === 'openrouter/auto')) assert.match(guarded.reason, /skipped openai, google \(already paid for\)/)
  // --allow-owned gives the route as written.
  assert.deepEqual(route('x', { category: 'code', prefer: 'cheap', owned: OWNED, allowOwned: true }).models, plain.models)
})

test('an owned model named explicitly is refused unless allowed; free routes are left alone', () => {
  assert.throws(() => route('x', { model: 'openai/gpt-6-sol', owned: OWNED }), /already pay for by subscription/)
  assert.throws(() => route('x', { model: 'openrouter/auto', owned: OWNED }), /can pick/)
  assert.deepEqual(route('x', { model: 'openai/gpt-6-sol', owned: OWNED, allowOwned: true }).models, ['openai/gpt-6-sol'])
  assert.deepEqual(route('x', { model: 'qwen/qwen3.8-flash', owned: OWNED }).models, ['qwen/qwen3.8-flash'])
  const free = route('x', { category: 'code', free: true, owned: OWNED })
  assert.deepEqual(free.models, route('x', { category: 'code', free: true, owned: [] }).models)
})

test('the stand-in decider moves off an owned default', async () => {
  const asked = []
  const fetchImpl = async (_url, init) => {
    asked.push(JSON.parse(init.body).model)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"category":"code","tier":"cheap","confidence":0.9}' } }] }) }
  }
  await askDecider('fix this', { env: { OPENROUTER_API_KEY: 'k', ROUTER_OWNED: 'openai,google' }, fetchImpl })
  await askDecider('fix this', { env: { OPENROUTER_API_KEY: 'k', ROUTER_OWNED: 'none' }, fetchImpl })
  assert.deepEqual(asked, isOwned(config.decider.default, OWNED) ? [config.decider.open, config.decider.default] : [config.decider.default, config.decider.default])
})
