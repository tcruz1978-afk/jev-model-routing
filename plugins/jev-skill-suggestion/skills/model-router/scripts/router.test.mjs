import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, route, plan, complete, fellBack, config, DEFAULT_MAX_TOKENS } from './router.mjs'

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
