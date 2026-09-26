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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHARED_DIR, decisionEntry, jqLogPath, writeEntry } from './jq-log.mjs'

const API = 'https://openrouter.ai/api/v1'
const AUTO = 'openrouter/auto'
// OpenRouter rejects a `models` fallback list longer than this.
const MAX_MODELS = 3
const TIERS = ['quality', 'balanced', 'cheap']
const NEAREST_TIERS = { quality: ['quality', 'balanced', 'cheap'], balanced: ['balanced', 'cheap', 'quality'], cheap: ['cheap', 'balanced', 'quality'] }
const JEV_TIMEOUT_MS = 2000
const DECIDER_TIMEOUT_MS = 5000
// Below this confidence a pick is ignored and the heuristics decide.
const JEV_MIN_CONFIDENCE = 0.35
// Output cap sent with every completion. Without one, OpenRouter reserves the
// model's whole output limit (often 128k tokens) against the key's credit limit
// and refuses the request up front when that doesn't fit. 1000 leaves room for
// reasoning models, which spend a few hundred tokens thinking before they answer.
export const DEFAULT_MAX_TOKENS = 1000
// Local models cost nothing, so there's no credit reservation to keep small, and
// reasoning models (qwen3.5) can think past 1000 tokens before they answer. The
// local timeout still stops one that runs on.
export const LOCAL_MAX_TOKENS = 4000
// Brief provider failures (rate limit, bad gateway, overloaded, timed out) get one retry.
const RETRYABLE = new Set([429, 502, 503, 504])
// A 429 for the daily free-model allowance: no retry helps until it resets.
const DAILY_FREE_LIMIT = /free-models-per-day/i
const DAILY_FREE_HINT = 'free requests are used up for today; the limit resets at 00:00 UTC'
const RETRY_DELAY_MS = 2000
// How many routes a sweep runs at once; more trips providers' rate limits.
export const SWEEP_CONCURRENCY = 4
// How long a local model gets to answer before the router moves on to the next
// one. Generous: on a laptop the first request also loads the model, and
// reasoning models think before they answer.
export const LOCAL_TIMEOUT_MS = 180_000

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
// Track record: how each model has done lately, kept on this machine.
const HISTORY = 20
const HISTORY_WINDOW_MS = 7 * 24 * 3600 * 1000
// Fewer requests than this on record and a model is ranked as if it had none: one
// bad (or lucky) request says little about a free model.
const MIN_ATTEMPTS = 3
// Share of free requests that try an under-tested model first. Once a route's first
// choice keeps answering, nothing else on it gets tried and its record can't grow;
// exploring now and then lets a better (or faster) backup show itself.
export const EXPLORE_RATE = 0.1
const ROUTERS = new Set([AUTO, 'openrouter/free'])

/**
 * Where track records live: `statsFile` if given (null turns them off), else
 * nothing when ROUTER_STATS=off, else ROUTER_STATS_FILE, else ~/.model-router/stats.json.
 */
export function statsFilePath(statsFile) {
  if (statsFile !== undefined) return statsFile
  if (process.env.ROUTER_STATS === 'off') return null
  return process.env.ROUTER_STATS_FILE || join(homedir(), '.model-router', 'stats.json')
}

export function loadStats(statsFile) {
  const path = statsFilePath(statsFile)
  if (!path) return { models: {} }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { models: {} }
  }
}

/** Adds outcomes ({ model, ok, ms? }) to the track record, keeping each model's last 20. */
export function recordOutcomes(outcomes, { statsFile, now = Date.now() } = {}) {
  const path = statsFilePath(statsFile)
  const real = outcomes.filter((o) => !ROUTERS.has(o.model))
  if (!path || !real.length) return
  const stats = loadStats(statsFile)
  stats.models ??= {}
  for (const { model, ok, ms } of real) {
    const history = (stats.models[model] ??= [])
    history.push({ t: now, ok, ...(ok && ms !== undefined ? { ms } : {}) })
    if (history.length > HISTORY) history.splice(0, history.length - HISTORY)
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(stats)}\n`)
  } catch {
    // A track record is a nicety: never fail a request over it.
  }
}

/** A model's record over the last 7 days: answers, attempts, a score (success rate, smoothed), median secs. */
export function trackRecord(model, stats, now = Date.now()) {
  const recent = (stats.models?.[model] ?? []).filter((e) => now - e.t < HISTORY_WINDOW_MS)
  const ok = recent.filter((e) => e.ok)
  const times = ok.map((e) => e.ms).filter((ms) => ms !== undefined).sort((a, b) => a - b)
  return {
    attempts: recent.length,
    answered: ok.length,
    // (answered + 1) / (attempts + 2): a model with no record sits at 0.5, and one lucky answer doesn't top the list.
    score: (ok.length + 1) / (recent.length + 2),
    medianMs: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
  }
}

/**
 * Now and then (EXPLORE_RATE of free requests) puts the free model with the
 * thinnest record (under MIN_ATTEMPTS requests) at the front of the route. The
 * usual first choice becomes second and routers keep their place, so a failed
 * try still falls back. Off with `explore: false` or ROUTER_EXPLORE=off.
 */
export function explore(decision, { open, statsFile, explore: on = process.env.ROUTER_EXPLORE !== 'off', exploreRate = EXPLORE_RATE, random = Math.random } = {}) {
  if (!on || !config.free[decision.category] || random() >= exploreRate) return decision
  const stats = loadStats(statsFile)
  const thin = config.free[decision.category]
    .filter((id) => !ROUTERS.has(id) && (!open || config.models[id]?.open) && id !== decision.models[0])
    .map((id) => ({ id, attempts: trackRecord(id, stats).attempts }))
    .filter((c) => c.attempts < MIN_ATTEMPTS)
    .sort((a, b) => a.attempts - b.attempts)
  if (!thin.length) return decision
  const pick = thin[0].id
  const rest = decision.models.filter((id) => id !== pick)
  if (rest.length >= MAX_MODELS) rest.splice(rest.map((id) => !ROUTERS.has(id)).lastIndexOf(true), 1)
  return { ...decision, models: [pick, ...rest], explored: pick, reason: `${decision.reason} · exploring ${pick}` }
}

/**
 * Orders models by track record: higher score first, then faster; models with no
 * record, or fewer than 3 requests on it, keep their place relative to each other. Routers (openrouter/free) keep
 * their position, so a list that has the catch-all third still has it third.
 */
export function rankByTrackRecord(ids, stats, now = Date.now()) {
  const models = ids.filter((id) => !ROUTERS.has(id))
  const records = new Map(models.map((id) => {
    const r = trackRecord(id, stats, now)
    return [id, r.attempts >= MIN_ATTEMPTS ? r : { ...r, score: 0.5, medianMs: null }]
  }))
  const ranked = [...models].sort((a, b) => {
    const ra = records.get(a), rb = records.get(b)
    if (ra.score !== rb.score) return rb.score - ra.score
    if (ra.medianMs !== null && rb.medianMs !== null) return ra.medianMs - rb.medianMs
    return models.indexOf(a) - models.indexOf(b)
  })
  let next = 0
  const result = ids.map((id) => (ROUTERS.has(id) ? id : ranked[next++]))
  return { models: result, reordered: result.some((id, i) => id !== ids[i]) }
}

export function route(prompt, { model, prefer = 'balanced', open = false, free = false, local = false, category, statsFile } = {}) {
  if (!TIERS.includes(prefer)) throw new Error(`prefer must be one of ${TIERS.join(', ')}`)
  const picked = category ?? classify(prompt)
  if (model) return { category: picked, models: [model], reason: 'model named explicitly' }
  if (!config.routes[picked]) throw new Error(`unknown category "${picked}"`)
  if (local) {
    // An override in routes.json names the Ollama models; otherwise complete() builds
    // the route from what's pulled (autoLocalRoute), so there's nothing to maintain.
    const override = config.local?.[picked]
    return override?.length
      ? { category: picked, models: [...override], reason: `${picked} / local (Ollama)` }
      : { category: picked, models: [], auto: true, reason: `${picked} / local (Ollama, auto)` }
  }
  if (free) {
    // Zero-cost models only (open weights, except the openrouter/free router),
    // the ones answering reliably lately first.
    const candidates = config.free[picked].filter((id) => !open || config.models[id]?.open)
    const { models: ranked, reordered } = rankByTrackRecord(candidates, loadStats(statsFile))
    const models = ranked.slice(0, MAX_MODELS)
    return { category: picked, models, reason: `${picked} / free models${open ? ' / open only' : ''}${reordered ? ' / ranked by track record' : ''}` }
  }
  let models = config.routes[picked][prefer]
  if (open) {
    models = models.filter((id) => config.models[id]?.open)
    // Top up from the category's other tiers, nearest (and cheaper) first, so the
    // list is never empty and a cheap route never tops up with a quality model.
    for (const tier of NEAREST_TIERS[prefer]) for (const id of config.routes[picked][tier])
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

// Judgement quotient (JQ). A team's JQ level (1 to 5, set by the owner, kept
// in a private teams file) says how often its work must be right; the router
// turns that into a floor on the tier and a bar Jev's picks must clear.

// Defects per million opportunities at each JQ level, copied from tc-ventures'
// tools/jq/jq.mjs (`DPMO`), which cites the standard Six Sigma conversion table
// (ISO 13053-1:2011; Harry and Schroeder, Six Sigma, 2000). Keep the two equal:
// jq-log.test.mjs compares them when that repo is checked out beside this one.
export const DPMO = { 1: 691462, 2: 308538, 3: 66807, 4: 6210, 5: 233 }

/** A JQ level (1 to 5) as the share of answers that must be right (jq.mjs's accuracyNeed). */
export function accuracyNeed(level) {
  if (!Number.isInteger(level) || !(level in DPMO)) throw new Error('a JQ level is a whole number from 1 to 5')
  return 1 - DPMO[level] / 1e6
}

// The least capable tier each JQ level may use: the more often a team's work
// must be right, the more capable the model.
export const JQ_MIN_TIER = { 1: 'cheap', 2: 'cheap', 3: 'balanced', 4: 'quality', 5: 'quality' }

const TEAMS_FORMAT = '{"teams": {"<name>": {"level": <1-5>, "source": "<who set it, and where>"}}, "default": {"level": <1-5>, "source": "..."}}'

/**
 * Where the teams file is: JQ_TEAMS_FILE, else ./tools/jq/teams.json in the
 * current directory, else ~/.jq/teams.json. The file is the owner's and
 * private: teams and their levels are never written into this repository.
 * Returns the paths looked at and the first that exists (or null).
 */
export function teamsFilePath({ env = process.env, cwd = process.cwd(), home = env.HOME || homedir() } = {}) {
  const tried = env.JQ_TEAMS_FILE ? [env.JQ_TEAMS_FILE] : [resolve(cwd, 'tools/jq/teams.json'), join(home, '.jq', 'teams.json')]
  return { path: tried.find((p) => existsSync(p)) ?? null, tried }
}

/** The teams file's teams and default level, or null when there is no file. */
export function loadTeams(where = {}) {
  const { path, tried } = teamsFilePath(where)
  if (!path) return { path: null, tried, teams: null, fallback: null }
  let json
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`could not read the teams file ${path}: ${error.message}`)
  }
  return { path, tried, teams: json.teams ?? {}, fallback: json.default ?? null }
}

/**
 * The JQ bar for a task: a level given directly (`jq`), else the named team's
 * level, else the teams file's default level (only when the file sets one).
 * No bar when none of these applies. `teams` (a loadTeams() result) is read
 * from disk when not given.
 */
export function jqBar({ jq, team, teams } = {}) {
  const bar = (level, label) => {
    const n = Number(level)
    return { level: n, need: accuracyNeed(n), minTier: JQ_MIN_TIER[n], label }
  }
  if (jq !== undefined) return bar(jq, `JQ ${Number(jq)}`)
  const file = teams ?? loadTeams()
  if (team) {
    if (!file.path) throw new Error(`--team needs a teams file, and there is none: put one at ${file.tried.join(' or ')} (or point JQ_TEAMS_FILE at one), in the form ${TEAMS_FORMAT}`)
    const entry = file.teams[team]
    if (!entry) throw new Error(`unknown team "${team}"; teams in ${file.path}: ${Object.keys(file.teams).join(', ') || 'none yet'}`)
    return bar(entry.level, `team ${team} (JQ ${Number(entry.level)})`)
  }
  if (file.fallback?.level !== undefined) return bar(file.fallback.level, `default JQ ${Number(file.fallback.level)}`)
  return null
}

/** Where JQ entries go (jq-log.mjs's rule), and a real append for Node. */
const jqPath = (logFile) => (logFile !== undefined ? logFile : jqLogPath(process.env, { home: homedir(), sharedDirExists: isDir(SHARED_DIR) }))
const nodeAppend = {
  append: (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, text)
  },
}
function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Decides the route: Jev, else its stand-in, else heuristics for what is left. */
export async function plan(prompt, options = {}) {
  if (options.model) return route(prompt, options)
  // Category and tier both given (a free or local route has no tier): nothing left for Jev to decide.
  const settled = options.category && (options.prefer || options.free || options.local)
  // Read before Jev is asked, so an unknown team fails before any call.
  const bar = jqBar(options)
  let jev = null
  if (options.jev !== false && !settled) {
    jev = await askJev(prompt, options)
    if (!jev?.category && !jev?.tier) jev = (await askDecider(prompt, options)) ?? jev
  }
  // Judgement quotient: log each pick with the confidence it came with, so its
  // outcome can be scored (`jq.mjs outcome <jqId> ...`). Never the prompt's text.
  const path = jqPath(options.jqLogFile)
  for (const question of ['category', 'tier']) {
    const pick = jev?.[question]
    if (!pick) continue
    const tool = `model-router ${jev.backend.startsWith('stand-in') ? 'stand-in' : 'Jev'}`
    const entry = decisionEntry({ tool, question, answer: pick.choice, confidence: pick.confidence, decidedBy: jev.backend }, { now: Date.now() })
    if (entry && (await writeEntry(entry, path, nodeAppend))) pick.jqId = entry.id
  }
  // The JQ bar: a pick less sure than the level's accuracy isn't acted on, and
  // the tier is never below the level's floor.
  const trusted = (pick) => (pick && (!bar || (pick.confidence ?? 0) >= bar.need) ? pick : null)
  const category = options.category ?? trusted(jev?.category)?.choice
  let prefer = options.prefer ?? trusted(jev?.tier)?.choice ?? 'balanced'
  if (bar && !options.prefer && TIERS.indexOf(prefer) > TIERS.indexOf(bar.minTier)) prefer = bar.minTier
  const result = route(prompt, { ...options, category, prefer })
  const decidedBy = settled ? 'flags' : trusted(jev?.category) || trusted(jev?.tier) ? (jev.backend.startsWith('stand-in') ? jev.backend : `Jev (${jev.backend})`) : 'heuristics'
  return { ...result, reason: `${result.reason} · decided by ${decidedBy}${bar ? ` · ${bar.label}` : ''}`, jev }
}

/** The jqIds a decision's picks were logged under, for the output line. */
export function jqIdsOf(decision) {
  return ['category', 'tier'].map((q) => decision?.jev?.[q]?.jqId && `${q} ${decision.jev[q].jqId}`).filter(Boolean)
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
  const { env = process.env, fetchImpl = fetch, maxTokens = options.local ? LOCAL_MAX_TOKENS : DEFAULT_MAX_TOKENS, retryDelayMs = RETRY_DELAY_MS } = options
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('max tokens must be a positive integer')
  const creditCheck = options.creditCheck ?? (() => creditStatus({ env, fetchImpl }))
  let decision = await plan(prompt, options)
  if (options.local) return completeLocal(prompt, options, decision)
  if (options.free) decision = explore(decision, options)
  let outOfCredit = false
  let credit = null
  const send = async (models) => {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now()
      const response = await fetchImpl(`${API}/chat/completions`, {
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
          messages: messagesFor(prompt, options),
        }),
      })
      const body = await response.json().catch(() => ({}))
      // OpenRouter can answer 200 and still carry an upstream error in the body (it has already sent headers).
      const status = body.error?.code ?? response.status
      const dailyLimit = status === 429 && DAILY_FREE_LIMIT.test(body.error?.message ?? '')
      if (attempt === 0 && RETRYABLE.has(status) && !dailyLimit) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        continue
      }
      recordAttempt(models, body, status, dailyLimit, Date.now() - started)
      return { response, body, status, retried: attempt > 0 }
    }
  }
  // Every model the request passed over failed; the one that answered succeeded. Credit
  // and the daily free limit are the account's doing, not the models', so they don't count.
  const recordAttempt = (models, body, status, dailyLimit, ms) => {
    if (status === 402 || dailyLimit) return
    const served = body.error ? -1 : models.findIndex((id) => !fellBack(id, body.model))
    const outcomes = models.map((model, i) => (served === -1 || i < served ? { model, ok: false } : i === served ? { model, ok: true, ms } : null))
    if (served === -1 && body.model && !body.error) outcomes.push({ model: body.model, ok: true, ms })
    recordOutcomes(outcomes.filter(Boolean), { statsFile: options.statsFile })
  }
  let { response, body, status, retried } = await send(decision.models)
  if (status === 402) credit = await creditCheck()
  // Out of credit: the same category on free models, unless a model was named.
  if (status === 402 && !options.free && !options.model) {
    outOfCredit = true
    const decidedBy = decision.reason.split(' · ').find((part) => part.startsWith('decided by'))
    decision = { ...route(prompt, { ...options, category: decision.category, free: true }), jev: decision.jev }
    decision.reason = [decision.reason, decidedBy, 'out of credit, switched to free models'].filter(Boolean).join(' · ')
    decision = explore(decision, options)
    ;({ response, body, status, retried } = await send(decision.models))
  }
  if (!response.ok || body.error) {
    const hint = status === 402 && credit?.short ? ` (${CREDIT_HINT[credit.short]})`
      : status === 429 && DAILY_FREE_LIMIT.test(body.error?.message ?? '') ? ` (${DAILY_FREE_HINT})` : ''
    throw new Error(`OpenRouter ${status}: ${body.error?.message ?? JSON.stringify(body)}${hint}`)
  }
  const first = decision.models[0]
  const fallbackFrom = fellBack(first, body.model) ? first : null
  // OpenRouter doesn't say why it skipped a model; the credit balance is the one cause it can report.
  // Free models cost nothing, so credit can't explain a fallback among them.
  const onFree = options.free || outOfCredit
  if (fallbackFrom && !credit && !onFree) credit = await creditCheck()
  return {
    ...decision,
    model: body.model,
    fallbackFrom,
    outOfCredit,
    // 'account' (no credit left), 'key' (its spending limit is used up), or null.
    creditShort: credit?.short ?? null,
    retried,
    text: body.choices?.[0]?.message?.content ?? '',
    // The model hit max_tokens: the answer is cut short, or empty if thinking used it all.
    truncated: body.choices?.[0]?.finish_reason === 'length',
    usage: body.usage,
    id: body.id,
  }
}

const messagesFor = (prompt, { system } = {}) => [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }]

/** Where Ollama listens: OLLAMA_BASE_URL, else Ollama's own OLLAMA_HOST, else localhost:11434. */
export function ollamaBase(env = process.env) {
  const raw = env.OLLAMA_BASE_URL || env.OLLAMA_HOST || 'http://localhost:11434'
  return (/^https?:\/\//.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, '').replace(/\/v1$/, '')
}

// Embedding models (nomic-embed-text, mxbai-embed-large, all-minilm, bge-m3…) can't chat.
export const isEmbeddingModel = (name, family = '') => /embed|minilm|(^|\/)bge/i.test(name) || /bert/i.test(family)
const isChatModel = (m) => !isEmbeddingModel(m.name, m.details?.family)

/**
 * A pulled model's size in billions of parameters: Ollama's parameter_size
 * ("8.0B", "567M"), else the tag ("qwen3.5:9b", "gemma3n:e4b"); null if neither says.
 */
export function modelSize({ name, details } = {}) {
  const parse = (text) => {
    const hit = /(\d+(?:\.\d+)?)\s*([bm])\b/i.exec(text ?? '')
    return hit ? Number(hit[1]) / (hit[2].toLowerCase() === 'm' ? 1000 : 1) : null
  }
  return parse(details?.parameter_size) ?? parse(name?.split(':')[1]) ?? null
}

/**
 * A local route built from what's pulled, ranked by size: the largest first for
 * code, reasoning, long_context and writing; a mid-size one first for general;
 * the smallest of at least 1B first for quick. Embedding models are left out,
 * and models of unknown size come after the sized ones.
 */
export function autoLocalRoute(category, pulled) {
  const sized = pulled.filter(isChatModel).map((m) => ({ name: m.name, size: modelSize(m) }))
  const known = sized.filter((m) => m.size !== null).sort((a, b) => b.size - a.size)
  const unknown = sized.filter((m) => m.size === null)
  let order
  if (category === 'quick') {
    const ascending = [...known].reverse()
    order = [...ascending.filter((m) => m.size >= 1), ...unknown, ...ascending.filter((m) => m.size < 1)]
  } else if (category === 'general') {
    const mid = Math.floor((known.length - 1) / 2)
    order = [...known.slice(mid, mid + 1), ...known.slice(0, mid), ...known.slice(mid + 1), ...unknown]
  } else {
    order = [...known, ...unknown]
  }
  return order.slice(0, MAX_MODELS).map((m) => m.name)
}

/** The models pulled into the local Ollama, as /api/tags reports them ({ name, details }). */
export async function ollamaModels({ env = process.env, fetchImpl = fetch } = {}) {
  const base = ollamaBase(env)
  let response
  try {
    response = await fetchImpl(`${base}/api/tags`, {})
  } catch (error) {
    throw new Error(`Can't reach Ollama at ${base} (${error.cause?.code ?? error.message}). Start it with \`ollama serve\`, or set OLLAMA_BASE_URL.`)
  }
  if (!response.ok) throw new Error(`Ollama at ${base} answered ${response.status} listing models`)
  return (await response.json()).models ?? []
}

/** The names of the models pulled into the local Ollama (`ollama list`). */
export async function localModels(options) {
  return (await ollamaModels(options)).map((m) => m.name)
}

/**
 * Matches a route's model names against what's pulled. A name without a tag
 * ("qwen3") matches any tag of it ("qwen3:8b"); a tagged name must match exactly.
 */
export function pickInstalled(wanted, installed) {
  const models = []
  const missing = []
  for (const id of wanted) {
    const hit = installed.find((name) => name === id || (!id.includes(':') && name.startsWith(`${id}:`)))
    if (hit) { if (!models.includes(hit)) models.push(hit) } else missing.push(id)
  }
  return { models, missing }
}

// Ollama has no fallback list of its own, so the router tries each pulled model in turn.
// Requests go to Ollama's own /api/chat, which takes `think`: off by default, because
// small reasoning models (qwen3.5:2b) can think past any token cap without answering.
async function completeLocal(prompt, options, decision) {
  const { env = process.env, fetchImpl = fetch, maxTokens = LOCAL_MAX_TOKENS, timeoutMs = LOCAL_TIMEOUT_MS } = options
  if (!(timeoutMs > 0)) throw new Error('timeout must be a positive number of seconds')
  const base = ollamaBase(env)
  const pulled = await ollamaModels({ env, fetchImpl })
  const installed = pulled.map((m) => m.name)
  const chat = pulled.filter(isChatModel).map((m) => m.name)
  if (chat.length === 0) throw new Error(`Ollama at ${base} has no chat models${installed.length ? ` (only embedding models: ${installed.join(', ')})` : ''}. Pull one first, e.g. \`ollama pull ${decision.models[0] ?? 'qwen3.5:4b'}\`.`)
  let { models, missing } = decision.auto
    ? { models: autoLocalRoute(decision.category, pulled), missing: [] }
    : pickInstalled(decision.models, installed)
  // None of the route's models is pulled: use what is, rather than fail.
  const standIn = models.length === 0 ? chat[0] : null
  if (standIn) models = [standIn]
  const errors = []
  for (const model of models) {
    let response, body
    // Cancelling the request also stops Ollama generating for it.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const send = (think) => fetchImpl(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: messagesFor(prompt, options),
          stream: false,
          ...(think === undefined ? {} : { think }),
          options: { num_predict: maxTokens },
        }),
        signal: controller.signal,
      })
      response = await send(options.think ?? false)
      body = await response.json().catch(() => ({}))
      // A model without a thinking mode may refuse the setting: ask again without it.
      if (!response.ok && /think/i.test(errorText(body))) {
        response = await send(undefined)
        body = await response.json().catch(() => ({}))
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        errors.push(`${model}: ${error.cause?.code ?? error.message}`)
        continue
      }
    } finally {
      clearTimeout(timer)
    }
    if (controller.signal.aborted) {
      errors.push(`${model}: no answer within ${timeoutMs / 1000}s`)
      continue
    }
    if (!response.ok || body.error) {
      errors.push(`${model}: ${errorText(body) || `HTTP ${response.status}`}`)
      continue
    }
    return {
      ...decision,
      models,
      model: body.model ?? model,
      local: true,
      thinking: options.think ?? false,
      fallbackFrom: model === models[0] ? null : models[0],
      // Why each model before this one didn't answer.
      skipped: errors,
      missing,
      standIn,
      outOfCredit: false,
      creditShort: null,
      retried: false,
      text: body.message?.content ?? '',
      truncated: body.done_reason === 'length',
      usage: { prompt_tokens: body.prompt_eval_count, completion_tokens: body.eval_count },
    }
  }
  throw new Error(`Ollama: no local model answered (${errors.join('; ')})`)
}

// Ollama's own API reports errors as { error: "text" }.
const errorText = (body) => (typeof body?.error === 'string' ? body.error : body?.error?.message ?? '')

const CREDIT_HINT = {
  account: 'the OpenRouter account has no credit left: add credits',
  key: "the API key's spending limit is used up: raise it in the key's settings",
}

/**
 * Whether the account or the key is out of credit. Reads OpenRouter's free
 * /credits and /key endpoints; anything it cannot read counts as unknown.
 */
export async function creditStatus({ env = process.env, fetchImpl = fetch } = {}) {
  const get = async (path) => {
    try {
      const response = await fetchImpl(`${API}${path}`, { headers: apiAuth(env) })
      return response.ok ? (await response.json()).data ?? null : null
    } catch {
      return null
    }
  }
  const [key, credits] = await Promise.all([get('/key'), get('/credits')])
  const account = credits ? credits.total_credits - credits.total_usage : null
  const keyLeft = key?.limit_remaining ?? null
  const short = account !== null && account <= 0 ? 'account' : keyLeft !== null && keyLeft <= 0 ? 'key' : null
  return { account, keyLeft, short }
}

function sweepJobs(options) {
  const categories = options.category ? [options.category] : Object.keys(config.routes)
  const tiers = options.local ? ['local'] : options.free ? ['free'] : options.prefer ? [options.prefer] : TIERS
  return categories.flatMap((category) => tiers.map((tier) => ({
    category, tier, opts: { ...options, category, jev: false, ...(TIERS.includes(tier) ? { prefer: tier } : {}) },
  })))
}

/** Every route a sweep would take (narrowed like `sweep`), without calling anything. */
export function sweepRoutes(prompt, options = {}) {
  return sweepJobs(options).map(({ category, tier, opts }) => {
    const { models, auto } = route(prompt, opts)
    return { category, tier, models, ...(auto ? { auto } : {}) }
  })
}

/**
 * Sends one prompt down every category × tier route (narrowed by `category`,
 * `prefer` or `free`), `concurrency` at a time, and returns one row per route.
 * A route that fails gets `error` instead of failing the sweep.
 */
export async function sweep(prompt, options = {}) {
  // A local Ollama runs one model at a time, so a local sweep goes one route at a time.
  const { concurrency = options.local ? 1 : SWEEP_CONCURRENCY, env = process.env, fetchImpl = fetch } = options
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer')
  // One credit check for the whole sweep.
  let credit
  const creditCheck = options.creditCheck ?? (() => (credit ??= creditStatus({ env, fetchImpl })))
  const jobs = sweepJobs(options)
  const rows = new Array(jobs.length)
  let next = 0
  // Once the daily free limit is hit, the other free routes would hit it too: don't send them.
  let dailyLimit = null
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      const { category, tier, opts } = jobs[i]
      const first = route(prompt, opts).models[0]
      if (dailyLimit && tier === 'free') {
        rows[i] = { category, tier, first, error: `not sent: ${dailyLimit}`, skipped: true, ms: 0 }
        continue
      }
      const started = Date.now()
      try {
        const { model, models, fallbackFrom, outOfCredit, creditShort, retried, truncated, text, standIn, missing, explored } = await complete(prompt, { ...opts, creditCheck })
        rows[i] = { category, tier, first: explored ?? first ?? models?.[0], model, fallbackFrom, outOfCredit, creditShort, retried, truncated, standIn, missing, explored, text, ms: Date.now() - started }
      } catch (error) {
        if (DAILY_FREE_LIMIT.test(error.message)) dailyLimit ??= DAILY_FREE_HINT
        rows[i] = { category, tier, first: first ?? 'auto', error: error.message, ms: Date.now() - started }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  return rows
}

const KINDS = ['paid', 'free', 'local']

/**
 * Every model the router can use: paid and free from routes.json, local from
 * `pulled` (Ollama's /api/tags, when given). For each, the routes that use it
 * (category/tier, with or without --open), the ones it's first choice for, and
 * its track record. Models routes.json lists but no route reaches come back
 * with no routes. Routers (openrouter/auto, openrouter/free) aren't models.
 */
export function modelOverview({ stats = loadStats(), pulled = null, now = Date.now() } = {}) {
  const uses = new Map()
  const add = (id, label, first, open, kind) => {
    if (ROUTERS.has(id)) return
    const use = uses.get(id) ?? { kind, routes: new Set(), first: new Set(), firstOpen: new Set() }
    use.routes.add(label)
    if (first) (open ? use.firstOpen : use.first).add(label)
    uses.set(id, use)
  }
  const each = (models, label, kind, open = false) => models.forEach((id, i) => add(id, label, i === 0, open, kind))
  for (const category of Object.keys(config.routes)) {
    for (const prefer of TIERS)
      for (const open of [false, true]) each(route('x', { category, prefer, open }).models, `${category}/${prefer}`, 'paid', open)
    for (const open of [false, true]) each(route('x', { category, free: true, open }).models, `${category}/free`, 'free', open)
    if (pulled) {
      const pinned = config.local?.[category]
      each(pinned?.length ? pickInstalled(pinned, pulled.map((m) => m.name)).models : autoLocalRoute(category, pulled), `${category}/local`, 'local')
    }
  }
  for (const id of Object.keys(config.models))
    if (!uses.has(id) && !ROUTERS.has(id)) uses.set(id, { kind: id.endsWith(':free') ? 'free' : 'paid', routes: new Set(), first: new Set(), firstOpen: new Set() })
  return [...uses]
    .map(([id, use]) => ({
      id,
      kind: use.kind,
      routes: [...use.routes],
      // First choice with or without --open; a trailing * means only with --open.
      first: [...new Set([...use.first, ...[...use.firstOpen].map((label) => (use.first.has(label) ? label : `${label}*`))])],
      ...trackRecord(id, stats, now),
    }))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.first.length - a.first.length || b.routes.length - a.routes.length || a.id.localeCompare(b.id))
}

// "reasoning/quality, reasoning/balanced*" → "reasoning(q,b*)", to fit a terminal.
function compactRoutes(labels) {
  const byCategory = new Map()
  for (const label of labels) {
    const [category, rest] = label.split('/')
    const star = rest.endsWith('*') ? '*' : ''
    const tier = rest.replace('*', '')
    const short = { quality: 'q', balanced: 'b', cheap: 'c' }[tier] ?? tier
    byCategory.set(category, [...(byCategory.get(category) ?? []), `${short}${star}`])
  }
  return [...byCategory].map(([category, tiers]) => `${category}(${tiers.join(',')})`).join(' ')
}

function overviewTable(rows) {
  const record = (r) => r.attempts ? `${r.answered}/${r.attempts} ${Math.round((100 * r.answered) / r.attempts)}%${r.medianMs === null ? '' : ` ${(r.medianMs / 1000).toFixed(1)}s`}` : '-'
  return table([['model', 'kind', 'routes', 'first choice for', 'record (7 days)']].concat(rows.map((r) => [
    r.id, r.kind, r.routes.length ? String(r.routes.length) : 'unused', compactRoutes(r.first) || '-', record(r),
  ])))
}

function table(lines) {
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)))
  return lines.map((l) => l.map((cell, i) => (i === l.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')).join('\n')
}

const oneLine = (text) => (text ?? '').replace(/\s+/g, ' ').trim()

function sweepTable(rows) {
  const note = (r) => r.error ? 'error' : [
    r.outOfCredit && `out of credit${r.creditShort ? ` (${r.creditShort})` : ''}`,
    r.fallbackFrom && `fallback${r.creditShort && !r.outOfCredit ? ` (${r.creditShort} credit)` : ''}`,
    r.explored && 'exploring',
    r.retried && 'retried',
    r.standIn ? 'none pulled, stand-in' : r.missing?.length && `not pulled: ${r.missing.join(', ')}`,
    r.truncated && 'cut off',
  ].filter(Boolean).join(', ') || 'ok'
  return table([['category', 'tier', 'first choice', 'answered by', 'secs', 'note', 'answer or error']].concat(rows.map((r) => [
    r.category, r.tier, r.first, r.model ?? '-', (r.ms / 1000).toFixed(1), note(r),
    r.error ? oneLine(r.error) : JSON.stringify(oneLine(r.text).slice(0, 40)),
  ])))
}

function routesTable(rows) {
  const shown = (r) => r.models.length ? `${r.models.join(' → ')}${r.auto ? '  (auto)' : ''}` : 'auto: the pulled models, by size (Ollama not reachable to list them)'
  return table([['category', 'tier', 'route']].concat(rows.map((r) => [r.category, r.tier, shown(r)])))
}

/**
 * One routed call as the usage dashboard reads it: which category and tier,
 * who decided, what was asked for and what answered, tokens and cost.
 * Never the prompt's text, only its length.
 */
export function callRecord(prompt, opts, result, ms, error, env = process.env) {
  return {
    kind: 'router.call',
    ts: new Date().toISOString(),
    session: env.CLAUDE_CODE_SESSION_ID || null,
    promptChars: prompt.length,
    category: result?.category ?? opts.category ?? null,
    prefer: opts.prefer ?? (opts.free ? 'free' : opts.local ? 'local' : null),
    open: Boolean(opts.open),
    decidedBy: result ? (result.reason.split(' · ').find((part) => part.startsWith('decided by')) ?? null) : null,
    requested: result?.models?.[0] ?? opts.model ?? null,
    model: result?.model ?? null,
    fallbackFrom: result?.fallbackFrom ?? null,
    outOfCredit: Boolean(result?.outOfCredit),
    truncated: Boolean(result?.truncated),
    promptTokens: result?.usage?.prompt_tokens ?? null,
    completionTokens: result?.usage?.completion_tokens ?? null,
    costUsd: typeof result?.usage?.cost === 'number' ? result.usage.cost : null,
    generationId: result?.id ?? null,
    jqIds: result ? jqIdsOf(result) : [],
    ms,
    error: error ? String(error.message ?? error).slice(0, 300) : null,
  }
}

/** Appends a call to ~/.claude/jev-log/router.jsonl; a failed write costs only the record. */
export function logCall(record, env = process.env) {
  if (env.MODEL_ROUTER_LOG === '0') return
  try {
    const dir = join(env.HOME || homedir(), '.claude', 'jev-log')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'router.jsonl'), JSON.stringify(record) + '\n')
  } catch {}
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
                           [--jq <1-5> | --team <name>] [--no-jev] [--free] [--no-explore] [--local] [--think] [--timeout <seconds>]
                           [--dry-run] [--json]
  node router.mjs sweep "prompt"  send it down every category × tier route, 4 at a time
                           (accepts --open, --free, --local, --category, --prefer, --max-tokens,
                           --concurrency <n>, --json; --dry-run lists the routes, no calls)
  node router.mjs stats           each model's track record (answers, failures, speed)
  node router.mjs overview        every model (paid, free, local): its routes and track record
  node router.mjs check           verify every model in routes.json still exists
  node router.mjs check --local   which local routes' Ollama models are pulled
  node router.mjs models [text]   list OpenRouter's models, optionally filtered`

function parse(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open') opts.open = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-jev') opts.jev = false
    else if (a === '--no-explore') opts.explore = false
    else if (a === '--think') opts.think = true
    else if (a === '--free') opts.free = true
    else if (a === '--local') opts.local = true
    else if (a === '--json') opts.json = true
    else if (['--prefer', '--model', '--category', '--system', '--team', '--jq'].includes(a)) opts[a.slice(2)] = argv[++i]
    else if (a === '--max-tokens') opts.maxTokens = Number(argv[++i])
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i])
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000
    else if (a === '-h' || a === '--help') opts.help = true
    else opts._.push(a)
  }
  return opts
}

async function main(argv) {
  const opts = parse(argv)
  const [first, ...rest] = opts._
  if (opts.help || !first) return console.log(USAGE)
  if (first === 'overview') {
    // Local models are listed when Ollama answers; a stopped Ollama just leaves them out.
    const pulled = await ollamaModels().catch(() => null)
    const rows = modelOverview({ pulled })
    if (opts.json) return console.log(JSON.stringify(rows, null, 2))
    console.log(overviewTable(rows))
    const unused = rows.filter((r) => !r.routes.length).length
    return console.log(`\n${rows.length} models${unused ? `, ${unused} listed in routes.json but on no route` : ''}. ${
      pulled ? `Local: Ollama at ${ollamaBase()}.` : `Local models not shown (no Ollama at ${ollamaBase()}).`}
Tiers: q quality, b balanced, c cheap. * first choice only with --open. Route counts include --open variants.`)
  }
  if (first === 'stats') {
    const stats = loadStats()
    const rows = Object.keys(stats.models ?? {})
      .map((id) => ({ id, ...trackRecord(id, stats) }))
      .filter((r) => r.attempts)
      .sort((a, b) => b.score - a.score || b.attempts - a.attempts)
    if (!rows.length) return console.log(`No track record yet (${statsFilePath() ?? 'ROUTER_STATS=off'}). It fills in as the router runs.`)
    console.log(table([['model', 'answered', 'of', 'success', 'median secs']].concat(rows.map((r) => [
      r.id, String(r.answered), String(r.attempts), `${Math.round((100 * r.answered) / r.attempts)}%`, r.medianMs === null ? '-' : (r.medianMs / 1000).toFixed(1),
    ]))))
    return console.log(`\nLast 7 days, up to 20 requests per model. Kept in ${statsFilePath()}; delete it to start over.`)
  }
  if (first === 'check' && opts.local) {
    const pulled = await ollamaModels()
    const installed = pulled.map((m) => m.name)
    console.log(`Ollama at ${ollamaBase()}: ${pulled.length ? pulled.map((m) => (isChatModel(m) ? m.name : `${m.name} (embedding, not used)`)).join(', ') : 'no models pulled'}`)
    let empty = 0
    for (const category of Object.keys(config.routes)) {
      const override = config.local?.[category]
      const { models, missing } = override?.length ? pickInstalled(override, installed) : { models: autoLocalRoute(category, pulled), missing: [] }
      if (!models.length) empty++
      console.log(`  ${category.padEnd(12)} ${models.length ? `uses ${models.join(' → ')}` : 'none pulled'}  (${override?.length ? 'routes.json' : 'auto'})${missing.length ? `  (not pulled: ${missing.join(', ')})` : ''}`)
    }
    process.exitCode = empty ? 1 : 0
    return
  }
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
  if (first === 'sweep') {
    if (opts.dryRun) {
      let rows = sweepRoutes(rest.join(' '), opts)
      if (opts.local && rows.some((r) => r.auto)) {
        const pulled = await ollamaModels().catch(() => null)
        if (pulled) rows = rows.map((r) => (r.auto ? { ...r, models: autoLocalRoute(r.category, pulled) } : r))
      }
      return console.log(opts.json ? JSON.stringify(rows, null, 2) : routesTable(rows))
    }
    const rows = await sweep(rest.join(' '), opts)
    console.log(opts.json ? JSON.stringify(rows, null, 2) : sweepTable(rows))
    process.exitCode = rows.some((r) => r.error) ? 1 : 0
    return
  }
  const prompt = opts._.join(' ')
  if (opts.dryRun) {
    // A dry run makes no real call, so it isn't logged for the judgement quotient.
    const decision = await plan(prompt, { ...opts, jqLogFile: null })
    return console.log(opts.json ? JSON.stringify(decision, null, 2) : `${decision.reason}\n→ ${decision.models.join(' → ')}`)
  }
  const startedAt = Date.now()
  let result
  try {
    result = await complete(prompt, opts)
  } catch (error) {
    logCall(callRecord(prompt, opts, null, Date.now() - startedAt, error))
    throw error
  }
  logCall(callRecord(prompt, opts, result, Date.now() - startedAt, null))
  if (opts.json) console.log(JSON.stringify(result, null, 2))
  else {
    const ids = jqIdsOf(result)
    console.log(`${result.text.trim()}\n\n[${result.model} · ${result.reason}${ids.length ? ` · jqId ${ids.join(', ')}` : ''}]`)
    const why = result.creditShort ? CREDIT_HINT[result.creditShort] : null
    if (result.outOfCredit)
      console.error(`note: out of credit${why ? ` (${why})` : ''}; answered by a free model (rate-limited: 20/min, 50/day)`)
    if (result.standIn)
      console.error(`note: none of this route's Ollama models is pulled (${result.missing.join(', ')}); used ${result.standIn}`)
    else if (result.missing?.length)
      console.error(`note: not pulled, skipped: ${result.missing.join(', ')} (\`ollama pull ${result.missing[0]}\`)`)
    if (result.fallbackFrom && result.local)
      console.error(`note: skipped ${result.skipped.join('; ')}; served by ${result.model}`)
    else if (result.fallbackFrom)
      console.error(`note: ${result.fallbackFrom} did not answer; served by a fallback. ${
        why && !result.outOfCredit ? `Likely cause: ${why}.` : 'It was down, rate-limited, or refused the request.'}`)
    if (result.explored)
      console.error(`note: tried ${result.explored} first to build its track record (about 1 in ${Math.round(1 / EXPLORE_RATE)} free requests; --no-explore to skip)`)
    if (result.retried) console.error('note: the first attempt hit a brief provider error and was retried once')
    const cap = opts.maxTokens ?? (opts.local ? LOCAL_MAX_TOKENS : DEFAULT_MAX_TOKENS)
    if (result.truncated && result.local && result.thinking && !result.text.trim())
      console.error(`note: the model spent the whole ${cap}-token cap thinking and never answered; try without --think`)
    else if (result.truncated)
      console.error(`note: the answer hit the ${cap}-token cap and was cut short; raise it with --max-tokens`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
