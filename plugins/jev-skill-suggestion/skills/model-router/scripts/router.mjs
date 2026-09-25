#!/usr/bin/env node
// Routes a prompt to a model on OpenRouter. TypeSafe's Jev decides what kind
// of task it is and how much model it deserves; routes.json turns that into an
// ordered list of models, sent with OpenRouter's `models` fallback so a model
// that is down or retired is skipped. If Jev cannot answer, a small, cheap
// OpenRouter chat model answers the same questions in its place; if that fails
// too (or both are unsure), keyword heuristics decide.
// Keys come from the environment (never this file). OPENROUTER_API_KEY alone is
// enough: OpenRouter serves Jev itself on its System One API. TYPESAFE_API_KEY
// or AI_GATEWAY_API_KEY, when set, reach Jev directly instead.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const API = 'https://openrouter.ai/api/v1'
const AUTO = 'openrouter/auto'
// OpenRouter rejects a `models` fallback list longer than this.
const MAX_MODELS = 3
const TIERS = ['quality', 'balanced', 'cheap']
const JEV_TIMEOUT_MS = 2000
const DECIDER_TIMEOUT_MS = 5000
// Below this confidence a pick is ignored and the heuristics decide.
const JEV_MIN_CONFIDENCE = 0.35
// Output cap sent with every completion. Without one, OpenRouter reserves the
// model's whole output limit (often 128k tokens) against the key's credit limit
// and refuses the request up front when that doesn't fit. 1000 leaves room for
// reasoning models, which spend a few hundred tokens thinking before they answer.
export const DEFAULT_MAX_TOKENS = 1000

// What Jev chooses between.
const CATEGORIES = {
  code: 'Writing, reading, debugging, reviewing or explaining source code, scripts, queries or configuration.',
  reasoning: 'Maths, logic, multi-step analysis, planning or weighing trade-offs where careful step-by-step thinking matters.',
  writing: 'Drafting or editing prose for people: emails, posts, copy, stories, summaries in a particular voice.',
  long_context: 'Working over a very long input: whole documents, transcripts, codebases or many files at once.',
  quick: 'A short, simple question or small transformation a fast small model answers well.',
  general: 'General knowledge, explanation or conversation that fits none of the other kinds.',
}
const TIER_CRITERIA = {
  quality: 'Hard, high-stakes or subtle: worth the strongest and most expensive model.',
  balanced: 'Ordinary difficulty: a capable mid-priced model does it well.',
  cheap: 'Easy or routine: the cheapest adequate model is fine.',
}

export const config = JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8'))

// Cheap keyword heuristics; first match wins, so the order matters.
const RULES = [
  ['code', /```|\b(code|function|bug|debug|refactor|typescript|javascript|python|swift|sql|regex|compile|stack ?trace|unit test|api endpoint)\b/i],
  ['reasoning', /\b(prove|proof|math|calculate|solve|equation|step[- ]by[- ]step|logic|puzzle|analy[sz]e|trade-?offs?|plan)\b/i],
  ['writing', /\b(write|draft|rewrite|essay|story|poem|blog|email|copy|tagline|tone|caption|script)\b/i],
]

export function classify(prompt) {
  if (prompt.length > 40000) return 'long_context'
  for (const [category, pattern] of RULES) if (pattern.test(prompt)) return category
  if (prompt.length < 200) return 'quick'
  return 'general'
}

/** Picks the category and the ordered model list, without calling anything. */
export function route(prompt, { model, prefer = 'balanced', open = false, free = false, category } = {}) {
  if (!TIERS.includes(prefer)) throw new Error(`prefer must be one of ${TIERS.join(', ')}`)
  const picked = category ?? classify(prompt)
  if (model) return { category: picked, models: [model], reason: 'model named explicitly' }
  if (!config.routes[picked]) throw new Error(`unknown category "${picked}"`)
  if (free) {
    // Zero-cost models only (open weights, except the openrouter/free router).
    const models = config.free[picked].filter((id) => !open || config.models[id]?.open).slice(0, MAX_MODELS)
    return { category: picked, models, reason: `${picked} / free models${open ? ' / open only' : ''}` }
  }
  let models = config.routes[picked][prefer]
  if (open) {
    models = models.filter((id) => config.models[id]?.open)
    // Top up from any open model in the category so the list is never empty.
    for (const tier of TIERS) for (const id of config.routes[picked][tier])
      if (config.models[id]?.open && !models.includes(id)) models.push(id)
    models = models.slice(0, MAX_MODELS)
    if (models.length === 0) throw new Error(`no open models configured for "${picked}"`)
  } else {
    // OpenRouter accepts at most 3 entries in `models`, auto included.
    models = [...models.slice(0, MAX_MODELS - 1), AUTO]
  }
  return { category: picked, models, reason: `${picked} / ${prefer}${open ? ' / open models only' : ''}` }
}

/** OpenRouter's Authorization header, empty when the agent proxy adds the key; null when there is no key at all. */
function openRouterAuth(env = process.env) {
  if (env.OPENROUTER_API_KEY) return { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }
  if (env.OPENROUTER_AUTH === 'proxy') return {}
  return null
}

function jevBackend(env = process.env) {
  if (env.TYPESAFE_API_KEY) {
    const base = (env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, '')
    return { kind: 'typesafe', key: env.TYPESAFE_API_KEY, url: `${base}/v1/systemone` }
  }
  if (env.AI_GATEWAY_API_KEY) return { kind: 'gateway', key: env.AI_GATEWAY_API_KEY, url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model' }
  // OpenRouter's System One API takes TypeSafe's request shape unchanged.
  if (openRouterAuth(env)) return { kind: 'openrouter', auth: openRouterAuth(env), url: `${API.replace(/\/v1$/, '')}/v1/systemone` }
  return null
}

/**
 * Asks Jev which category the prompt is and, unless `prefer` is fixed, which
 * tier it deserves. Returns null when no key is set, or on error or timeout.
 */
export async function askJev(prompt, { prefer, env = process.env, fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const backend = jevBackend(env)
  if (!backend) return null
  const questions = {
    category: { type: 'choice', instructions: 'What kind of task is the user asking for?', criteria: CATEGORIES },
  }
  if (!prefer) {
    questions.tier = {
      type: 'choice',
      instructions: 'How capable a model does this request need to be answered well?',
      criteria: TIER_CRITERIA,
    }
  }
  const state = { request: prompt.slice(0, 8000), recent_context: '' }
  const headers = { 'content-type': 'application/json', ...(backend.auth ?? { authorization: `Bearer ${backend.key}` }) }
  let body
  if (backend.kind !== 'gateway') body = { model: 'jev-latest', state, questions }
  else {
    body = { state, questions }
    Object.assign(headers, {
      'ai-gateway-auth-method': 'api-key',
      'ai-model-id': 'typesafe-ai/jev',
      'ai-evaluation-model-specification-version': '4',
    })
  }
  try {
    const response = await fetchImpl(backend.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const answers = (await response.json()).answers ?? {}
    const pick = (answer, allowed) => {
      if (!answer || !(answer.choice in allowed)) return null
      const confidence = typeof answer.confidence === 'number' ? answer.confidence : answer.probabilities?.[answer.choice] ?? null
      return confidence === null || confidence >= JEV_MIN_CONFIDENCE ? { choice: answer.choice, confidence } : null
    }
    return { backend: backend.kind, category: pick(answers.category, CATEGORIES), tier: pick(answers.tier, TIER_CRITERIA) }
  } catch {
    return null
  }
}

/**
 * Jev's stand-in when Jev cannot answer: a small OpenRouter chat model
 * answers the same two questions as JSON. `--open` uses an open-weight one.
 * Returns null without an OpenRouter key, or on error, timeout or bad JSON.
 */
export async function askDecider(prompt, { prefer, open, free = false, env = process.env, fetchImpl = fetch, timeoutMs = DECIDER_TIMEOUT_MS } = {}) {
  const auth = openRouterAuth(env)
  if (!auth) return null
  const paid = env.ROUTER_DECIDER_MODEL || (open ? config.decider.open : config.decider.default)
  const list = (criteria) => Object.entries(criteria).map(([name, text]) => `- ${name}: ${text}`).join('\n')
  const system = [
    'You route requests to AI models. Classify the user request; do not answer it.',
    `Categories:\n${list(CATEGORIES)}`,
    prefer ? null : `Tiers:\n${list(TIER_CRITERIA)}`,
    `Reply with JSON only: {"category": "<category>",${prefer ? '' : ' "tier": "<tier>",'} "confidence": <0 to 1>}`,
  ].filter(Boolean).join('\n\n')
  // Out of credit (402), or asked for free models: the free decider instead.
  const candidates = free ? [config.decider.free] : [paid, config.decider.free]
  try {
    let response
    let model
    for (model of candidates) {
      response = await fetchImpl(`${API}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'X-Title': 'tc-ventures model-router' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt.slice(0, 8000) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status !== 402) break
    }
    if (!response.ok) return null
    const text = (await response.json()).choices?.[0]?.message?.content ?? ''
    const answer = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
    if (!answer) return null
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : null
    if (confidence !== null && confidence < JEV_MIN_CONFIDENCE) return null
    const pick = (choice, allowed) => (choice in allowed ? { choice, confidence } : null)
    return {
      backend: `stand-in ${model}`,
      category: pick(String(answer.category), CATEGORIES),
      tier: prefer ? null : pick(String(answer.tier), TIER_CRITERIA),
    }
  } catch {
    return null
  }
}

/** Decides the route: Jev, else its stand-in, else heuristics for what is left. */
export async function plan(prompt, options = {}) {
  if (options.model) return route(prompt, options)
  let jev = null
  if (options.jev !== false) {
    jev = await askJev(prompt, options)
    if (!jev?.category && !jev?.tier) jev = (await askDecider(prompt, options)) ?? jev
  }
  const category = options.category ?? jev?.category?.choice
  const prefer = options.prefer ?? jev?.tier?.choice ?? 'balanced'
  const result = route(prompt, { ...options, category, prefer })
  const decidedBy = jev?.category || jev?.tier ? (jev.backend.startsWith('stand-in') ? jev.backend : `Jev (${jev.backend})`) : 'heuristics'
  return { ...result, reason: `${result.reason} · decided by ${decidedBy}`, jev }
}

function apiAuth(env = process.env) {
  const auth = openRouterAuth(env)
  if (!auth) throw new Error('OPENROUTER_API_KEY is not set (or set OPENROUTER_AUTH=proxy when the environment adds the key)')
  return auth
}

/**
 * Whether OpenRouter answered with something other than the first choice.
 * OpenRouter may report a dated variant of the ID (`…-20251001`), and
 * `openrouter/auto` always answers as some other model, so neither counts.
 */
export function fellBack(requested, served) {
  if (!served || requested === AUTO) return false
  return served !== requested && !served.startsWith(`${requested}-`)
}

/** Routes and sends one prompt; returns the answer and the model that served it. */
export async function complete(prompt, options = {}) {
  const { env = process.env, fetchImpl = fetch, maxTokens = DEFAULT_MAX_TOKENS } = options
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('max tokens must be a positive integer')
  let decision = await plan(prompt, options)
  let outOfCredit = false
  const send = (models) => fetchImpl(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      ...apiAuth(env),
      'Content-Type': 'application/json',
      'X-Title': 'tc-ventures model-router',
    },
    body: JSON.stringify({
      model: models[0],
      ...(models.length > 1 ? { models } : {}),
      max_tokens: maxTokens,
      messages: [...(options.system ? [{ role: 'system', content: options.system }] : []), { role: 'user', content: prompt }],
    }),
  })
  let response = await send(decision.models)
  // Out of credit: the same category on free models, unless a model was named.
  if (response.status === 402 && !options.free && !options.model) {
    outOfCredit = true
    const decidedBy = decision.reason.split(' · ').find((part) => part.startsWith('decided by'))
    decision = { ...route(prompt, { ...options, category: decision.category, free: true }), jev: decision.jev }
    decision.reason = [decision.reason, decidedBy, 'out of credit, switched to free models'].filter(Boolean).join(' · ')
    response = await send(decision.models)
  }
  const first = decision.models[0]
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${body.error?.message ?? JSON.stringify(body)}`)
  return {
    ...decision,
    model: body.model,
    fallbackFrom: fellBack(first, body.model) ? first : null,
    outOfCredit,
    text: body.choices?.[0]?.message?.content ?? '',
    // The model hit max_tokens: the answer is cut short, or empty if thinking used it all.
    truncated: body.choices?.[0]?.finish_reason === 'length',
    usage: body.usage,
  }
}

/** OpenRouter's live model catalog (public; no key needed). */
export async function listModels() {
  const response = await fetch(`${API}/models`)
  if (!response.ok) throw new Error(`OpenRouter ${response.status} listing models`)
  return (await response.json()).data
}

const USAGE = `Usage:
  node router.mjs "prompt" [--prefer quality|balanced|cheap] [--open] [--model <id>]
                           [--category <name>] [--system "..."] [--max-tokens <n>]
                           [--no-jev] [--free] [--dry-run] [--json]
  node router.mjs check           verify every model in routes.json still exists
  node router.mjs models [text]   list OpenRouter's models, optionally filtered`

function parse(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open') opts.open = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-jev') opts.jev = false
    else if (a === '--free') opts.free = true
    else if (a === '--json') opts.json = true
    else if (['--prefer', '--model', '--category', '--system'].includes(a)) opts[a.slice(2)] = argv[++i]
    else if (a === '--max-tokens') opts.maxTokens = Number(argv[++i])
    else if (a === '-h' || a === '--help') opts.help = true
    else opts._.push(a)
  }
  return opts
}

async function main(argv) {
  const opts = parse(argv)
  const [first, ...rest] = opts._
  if (opts.help || !first) return console.log(USAGE)
  if (first === 'check') {
    const live = new Set((await listModels()).map((m) => m.id))
    const missing = Object.keys(config.models).filter((id) => !live.has(id))
    console.log(missing.length ? `Not on OpenRouter any more:\n  ${missing.join('\n  ')}` : 'All configured models exist.')
    process.exitCode = missing.length ? 1 : 0
    return
  }
  if (first === 'models') {
    const filter = rest.join(' ').toLowerCase()
    for (const m of await listModels())
      if (!filter || m.id.toLowerCase().includes(filter)) console.log(`${m.id}\t${m.context_length ?? ''}`)
    return
  }
  const prompt = opts._.join(' ')
  if (opts.dryRun) {
    const decision = await plan(prompt, opts)
    return console.log(opts.json ? JSON.stringify(decision, null, 2) : `${decision.reason}\n→ ${decision.models.join(' → ')}`)
  }
  const result = await complete(prompt, opts)
  if (opts.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${result.text}\n\n[${result.model} · ${result.reason}]`)
    if (result.outOfCredit)
      console.error('note: the OpenRouter key is out of credit; answered by a free model (rate-limited: 20/min, 50/day)')
    if (result.fallbackFrom)
      console.error(`note: ${result.fallbackFrom} did not answer (down, refused, or over the key's credit limit); served by a fallback`)
    if (result.truncated)
      console.error(`note: the answer hit the ${opts.maxTokens ?? DEFAULT_MAX_TOKENS}-token cap and was cut short; raise it with --max-tokens`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
