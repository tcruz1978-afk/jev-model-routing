/**
 * jev-skill-suggestion — pure decision logic.
 *
 * No `$` and no I/O here: this module reads the engine's skill listing, builds
 * the two requests the decision API takes, reads their answers, and turns them
 * into at most one skill name and the text that suggests it. The hooks module
 * does every call on `$` at its own call site.
 *
 * The shape follows TypeSafe's "Skill suggestion" cookbook
 * (https://docs.typesafe.ai/cookbooks/skill_suggestion):
 *
 *   request 1  rank every skill (`which`, a Choice with each skill's one-line
 *              description as its criterion) and ask three Nouls about the
 *              request itself — whether it wants an action taken rather than
 *              an explanation given. Their mean is the gate.
 *   request 2  re-read the top few (`which` again, now with each skill's full
 *              description and the opening of its SKILL.md) and ask one Noul
 *              per candidate: does this skill do the specific thing asked?
 *              Every `fits` may come back low, and then nothing is suggested.
 *
 * Two backends speak to the same model with different wire shapes:
 *
 *   typesafe  POST https://api.typesafe.ai/v1/systemone
 *             `{ model, state, questions }`; a yes/no question is a `noul`
 *             and every answer carries its own `confidence`.
 *   gateway   POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
 *             `{ state, questions }` with the model in a header; a yes/no
 *             question is a `boolean` answered as `probability`.
 *
 * The Gateway shape is not documented publicly; it was read from
 * @ai-sdk/gateway and @ai-sdk/provider.
 */

export type Provider = 'typesafe' | 'gateway'

/** One skill as the model could be told about it: its name and one line. */
export interface Skill {
  name: string
  description: string
}

/** A shortlisted skill with the longer text the second request reads. */
export interface Candidate extends Skill {
  /** The full description and the opening of the skill's body, joined. */
  detail: string
}

/** What the first request answered. */
export interface Wide {
  /** Every skill with the probability it was given, surest first. */
  ranked: { name: string; probability: number | null }[]
  /** The mean of the oriented gate nouls, or null when none was answered. */
  gate: number | null
  /** Each gate noul as answered, for the log. */
  gateValues: Record<string, number>
}

/** What the second request answered. */
export interface Rerank {
  /** The candidate the Choice named. */
  winner: string
  /** Confidence in that choice, or null when the backend reported none. */
  confidence: number | null
  /** P(true) per candidate that it does the specific thing asked. */
  fits: Record<string, number>
}

/** The label the built-in classifier answers when no skill applies. */
export const NONE = 'none'

export const DEFAULT_BASE_URL: Record<Provider, string> = {
  typesafe: 'https://api.typesafe.ai',
  gateway: 'https://ai-gateway.vercel.sh/v4/ai',
}

/** OpenRouter's System One API, which serves Jev with TypeSafe's request shape. */
export const OPENROUTER_SYSTEM_ONE_BASE_URL = 'https://openrouter.ai/api'

/**
 * Stands in for the OpenRouter key when the cloud environment's agent proxy
 * adds it (an "API credential" for openrouter.ai, OPENROUTER_AUTH=proxy):
 * requests then go out with no Authorization header of their own.
 */
export const PROXY_INJECTED = 'proxy-injected'

/** The Authorization header for a key, or none when the proxy adds it. */
export function authHeader(apiKey: string): Record<string, string> {
  return apiKey === PROXY_INJECTED ? {} : { authorization: `Bearer ${apiKey}` }
}

/** Whether a URL is on openrouter.ai: the only host the OpenRouter key is sent to. */
export function isOpenRouterUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai'))
  } catch {
    return false
  }
}

export const DEFAULT_MODEL: Record<Provider, string> = {
  typesafe: 'jev-latest',
  gateway: 'typesafe-ai/jev',
}

/**
 * Which backend a configuration asks for, or null for the built-in
 * classifier. `auto` prefers TypeSafe, since it is the only one that reports
 * a calibrated confidence; a forced backend whose key is missing resolves to
 * null rather than falling through to the other one's key.
 */
export function selectProvider(forced: string, typesafeKey: string, gatewayKey: string): Provider | null {
  if (forced === 'builtin') return null
  if (forced === 'typesafe') return typesafeKey ? 'typesafe' : null
  if (forced === 'gateway') return gatewayKey ? 'gateway' : null
  if (typesafeKey) return 'typesafe'
  if (gatewayKey) return 'gateway'
  return null
}

/** The full endpoint a backend posts to. */
export function endpoint(provider: Provider, baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return provider === 'typesafe' ? `${root}/v1/systemone` : `${root}/evaluation-model`
}

/** A comma-separated option as a set of trimmed, non-empty names. */
export function parseNames(option: string): Set<string> {
  return new Set(
    option
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
}

/**
 * Reads the engine's `skill_listing` attachment: a header line, then one
 * `- name: description` per skill. A description may run over several lines,
 * and an entry the engine trimmed to fit its budget has no description at
 * all. Anything before the first entry is the header and is skipped.
 */
export function parseListing(text: string): Skill[] {
  const skills: Skill[] = []
  let current: Skill | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    // A name has no spaces, so it runs up to the first `: `; a name that
    // itself contains `:` (`engineering:code-review`) is kept whole.
    const entry = /^- (\S+?)(?::\s(.*))?$/.exec(line)
    if (entry) {
      current = { name: entry[1] as string, description: (entry[2] ?? '').trim() }
      skills.push(current)
    } else if (current && line.trim()) {
      current.description = `${current.description} ${line.trim()}`.trim()
    }
  }
  return skills
}

/**
 * The skills the decision model is offered: every command the person can run
 * that the model may also call, less the built-ins (`/help`, `/clear`) and the
 * names configured out. When the engine's listing has been seen, only skills
 * it listed are offered: the listing is the engine's word on which skills the
 * model is allowed to invoke.
 */
export function catalog(
  commands: readonly { name: string; description: string; source: string }[],
  listed: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): Skill[] {
  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const command of commands) {
    if (command.source === 'builtin') continue
    if (listed.size > 0 && !listed.has(command.name)) continue
    if (excluded.has(command.name) || seen.has(command.name)) continue
    seen.add(command.name)
    skills.push({ name: command.name, description: command.description.trim() })
  }
  return skills
}

/**
 * The listing with only `keep` left in it, or null when nothing is kept: what
 * the model reads in place of the engine's full listing.
 */
export function trimListing(text: string, keep: ReadonlySet<string>): string | null {
  if (keep.size === 0) return null
  const kept = parseListing(text).filter((skill) => keep.has(skill.name))
  if (kept.length === 0) return null
  const header = text.split('\n').find((line) => line.trim() && !line.startsWith('- ')) ?? ''
  return [header.trim(), '', ...kept.map(line)].join('\n')
}

function line(skill: Skill): string {
  return skill.description ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`
}

/**
 * Whether a skill or plugin name may be spliced into a path: the engine's
 * names are directory basenames, so anything with a path separator or a
 * `..` segment is refused rather than resolved.
 */
function safeName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.split(':').includes('..')
}

/**
 * The relative files a skill's body may live in, project or user level, by
 * how Claude Code lays skills and commands out. A plugin's are under its
 * install path instead, with the plugin prefix taken off the name.
 */
export function skillFileCandidates(name: string, plugin?: string): string[] {
  if (!safeName(name) || (plugin !== undefined && !safeName(plugin))) return []
  const short = plugin && name.startsWith(`${plugin}:`) ? name.slice(plugin.length + 1) : name
  const asPath = short.replace(/:/g, '/')
  const files = [
    `.claude/skills/${short}/SKILL.md`,
    `.claude/commands/${asPath}.md`,
    `.claude/skills/${asPath}/SKILL.md`,
  ]
  if (plugin) {
    // A plugin auto-loaded from a skills dir keeps its own `skills/` inside.
    files.push(`.claude/skills/${plugin}/skills/${short}/SKILL.md`)
    files.push(`.claude/skills/${plugin}/commands/${asPath}.md`)
  }
  return files
}

/** Whether a name is one the engine would run as `/name`: no whitespace. */
export function commandLike(name: string): boolean {
  return name.length > 0 && !/\s/.test(name)
}

/** The `name:` a SKILL.md's frontmatter declares, or null. */
export function frontmatterName(markdown: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!frontmatter) return null
  const field = /^name:\s*(.*)$/m.exec(frontmatter[1] as string)
  if (!field) return null
  const value = (field[1] as string).trim().replace(/^["']|["']$/g, '')
  return value || null
}

/**
 * Display name → directory name, from the skills found on disk: only the
 * ones whose frontmatter `name:` differs from their directory, since those
 * are the ones `$.command.list()` reports under a name the engine will not
 * run, list or override. First found wins.
 */
export function displayIds(found: readonly { dir: string; markdown: string }[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const { dir, markdown } of found) {
    const declared = frontmatterName(markdown)
    if (declared && declared !== dir && !ids.has(declared)) ids.set(declared, dir)
  }
  return ids
}

/** Commands with every display name replaced by the engine's id. */
export function canonical<T extends { name: string }>(commands: readonly T[], ids: ReadonlyMap<string, string>): T[] {
  if (ids.size === 0) return [...commands]
  return commands.map((command) => (ids.has(command.name) ? { ...command, name: ids.get(command.name) as string } : command))
}

/**
 * A claude.ai-synced skill's file: Claude Code keeps them under
 * `~/.claude/skills/synced/<account>/<skill>/SKILL.md`, listed to the model
 * with a prefix (`anthropic-skills:pptx`) that is not on disk.
 */
export function syncedFileCandidates(home: string, accounts: readonly string[], name: string): string[] {
  if (!safeName(name)) return []
  const short = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
  return accounts.filter(safeName).map((account) => `${home}/.claude/skills/synced/${account}/${short}/SKILL.md`)
}

/**
 * The same files under a plugin's install path, as
 * `~/.claude/plugins/installed_plugins.json` records it.
 */
export function pluginFileCandidates(installPath: string, name: string, plugin: string): string[] {
  if (!safeName(name) || !safeName(plugin)) return []
  const short = name.startsWith(`${plugin}:`) ? name.slice(plugin.length + 1) : name
  const root = installPath.replace(/\/+$/, '')
  return [`${root}/skills/${short}/SKILL.md`, `${root}/commands/${short.replace(/:/g, '/')}.md`]
}

/**
 * The install paths `installed_plugins.json` records for a plugin name, any
 * marketplace: the keys are `name@marketplace`.
 */
export function installPathsOf(installedJson: string, plugin: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(installedJson)
  } catch {
    return []
  }
  const plugins = (parsed as { plugins?: Record<string, { installPath?: string }[]> }).plugins
  if (!plugins) return []
  const paths: string[] = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (key !== plugin && !key.startsWith(`${plugin}@`)) continue
    for (const entry of entries ?? []) {
      if (typeof entry?.installPath === 'string') paths.push(entry.installPath)
    }
  }
  return paths
}

/**
 * What the second request reads for one skill: its full frontmatter
 * description, then the opening of its body with the frontmatter taken off.
 * With no file found, the one-line description alone.
 */
export function detailOf(skill: Skill, markdown: string | null, excerptChars: number): string {
  if (!markdown) return skill.description || `A skill named ${skill.name}.`
  let body = markdown
  let description = skill.description
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (frontmatter) {
    body = markdown.slice(frontmatter[0].length)
    const field = /^description:\s*(.*)$/m.exec(frontmatter[1] as string)
    if (field) {
      const value = (field[1] as string).trim().replace(/^["']|["']$/g, '')
      if (value.length > description.length) description = value
    }
  }
  const excerpt = body.trim().slice(0, Math.max(0, excerptChars))
  if (!excerpt) return description || `A skill named ${skill.name}.`
  return description ? `${description} — ${excerpt}` : excerpt
}

/**
 * Whether a skill's own frontmatter lets the model invoke it. A skill with
 * `disable-model-invocation: true` is left out of the engine's listing and
 * refused by the Skill tool, so it must never be suggested; before the
 * listing has been seen, this is the only way to tell. No file, or no such
 * field, reads as invocable.
 */
/** A skill's body with its frontmatter taken off. */
export function bodyOf(markdown: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  return (frontmatter ? markdown.slice(frontmatter[0].length) : markdown).trim()
}

/** The directory a skill file lives in, for `${CLAUDE_SKILL_DIR}`. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : '.'
}

/**
 * The block attached to the prompt when the mod loads the skill itself: the
 * cookbook's line, then the skill's instructions as the engine would have
 * rendered them, with the paths the engine substitutes. The Skill tool is
 * not needed, and may refuse the skill when it is `user-invocable-only`, so
 * the model is told not to reach for it. A skill already injected earlier in
 * the session is only named again: the engine does the same on a byte-identical
 * re-invocation.
 */
export function injectionBlock(
  suggested: Skill,
  markdown: string | null,
  path: string | null,
  projectDir: string,
  alreadyLoaded: boolean,
): string {
  const lines = [
    '<skill_relevance>',
    `Relevant to the current request: ${suggested.name}. Ignore this if it does not fit what the user actually asked for.`,
  ]
  if (alreadyLoaded) {
    lines.push(`Skill /${suggested.name} is already loaded above; instructions unchanged.`)
  } else if (markdown && path) {
    const dir = dirOf(path)
    // Callbacks, so a path holding `$&` or `$1` goes in verbatim.
    const body = bodyOf(markdown)
      .replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => dir)
      .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => projectDir)
    lines.push(
      `Its instructions follow: follow them now, including any setup steps. Do not load it with the Skill tool (it is already loaded here, and the tool may refuse it). Its files are in ${dir}.`,
      `<skill name="${suggested.name}" dir="${dir}">`,
      body,
      '</skill>',
    )
  } else {
    // No file on disk (a synced or bundled skill the mod cannot read): the
    // name and the way to load it are all there is.
    lines.push(
      `${line(suggested)}`,
      `Load it with the Skill tool (skill: "${suggested.name}") before you start; if the tool refuses it, tell the user to type /${suggested.name}.`,
    )
  }
  lines.push('</skill_relevance>')
  return lines.join('\n')
}

export function modelInvocable(markdown: string | null): boolean {
  if (!markdown) return true
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!frontmatter) return true
  return !/^disable-model-invocation:\s*true\s*$/m.test(frontmatter[1] as string)
}

/**
 * The three questions about the request, each asking a different way whether
 * it wants an action taken rather than an explanation given. Questions about
 * subject matter would not separate "explain what a monad is" from a task
 * that needs a skill, since both are software.
 */
export const GATE_QUESTIONS: Record<string, string> = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure:
    'Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?',
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
}

/** Gate questions where a yes points away from needing a skill. */
const INVERTED = new Set(['prose_suffices'])

/** The same yes/no question under two names. */
function yesNo(provider: Provider, instructions: string): Record<string, unknown> {
  return { type: provider === 'typesafe' ? 'noul' : 'boolean', instructions }
}

/** The first request's `questions`: the ranking and the gate. */
export function wideQuestions(provider: Provider, skills: readonly Skill[]): Record<string, unknown> {
  const criteria: Record<string, string> = {}
  for (const skill of skills) criteria[skill.name] = skill.description || `A skill named ${skill.name}.`
  const questions: Record<string, unknown> = {
    which: {
      type: 'choice',
      instructions:
        "Which of these skills, if any, is the right one to load to help with the user's latest request?",
      criteria,
    },
  }
  for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
    questions[`gate::${key}`] = yesNo(provider, text)
  }
  return questions
}

/** The second request's `questions`: the shortlist re-read, one `fits` each. */
export function rerankQuestions(
  provider: Provider,
  candidates: readonly Candidate[],
): Record<string, unknown> {
  const criteria: Record<string, string> = {}
  for (const candidate of candidates) criteria[candidate.name] = candidate.detail
  const questions: Record<string, unknown> = {
    which: {
      type: 'choice',
      instructions:
        "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
      criteria,
    },
  }
  for (const candidate of candidates) {
    questions[`fits::${candidate.name}`] = yesNo(provider, fitsQuestion(candidate))
  }
  return questions
}

/**
 * The rerank's per-candidate `noul`. It names the state's fields in
 * backticks, the way TypeSafe's docs have questions refer to a structured
 * state, and says outright that a vague go-ahead, thanks or complaint is a
 * no. The cookbook's shorter wording ("does this skill do the specific thing
 * the request asks for?") scored such replies 0.61–0.70 for whichever skill
 * ranked first ("yes merge all three when green" → pdf, "yes finish the
 * dashboard" → unlazy); this one scores them 0.51 or less while right picks
 * stay at 0.63 or more (scripts/jev-routing in tc-ventures, 210 runs).
 */
export function fitsQuestion(candidate: Skill & { detail?: string }): string {
  return (
    `Is \`request\` clearly asking for the specific kind of work the skill '${candidate.name}' does, so that its instructions are needed to carry it out? ` +
    'Read `request` against `recent_context` only when it is a short follow-up. ' +
    'Answer no when `request` is too vague to tell what task it wants, is only a go-ahead, thanks or complaint, or wants something this skill does not do. ' +
    `The skill is described as: ${candidate.description || candidate.detail || `a skill named ${candidate.name}`}`
  )
}

/**
 * What Jev reads as `recent_context`: the previous prompt, cut to a length
 * that keeps the request small, and the skill it was given. A follow-up like
 * "run it on DeepDiagram too" names no skill on its own; with this, it is
 * read against the request it continues. Empty when there was no previous
 * prompt.
 */
export function recentContextOf(previousPrompt: string, previousSkill: string | null, maxChars = 600): string {
  const prompt = previousPrompt.trim()
  if (!prompt) return ''
  const cut = prompt.length > maxChars ? `${prompt.slice(0, maxChars)}…` : prompt
  const skill = previousSkill ? `the skill /${previousSkill} was loaded for it` : 'no skill was loaded for it'
  return `Previous request: ${cut}\n(${skill})`
}

/** A request body. The Gateway carries the model in a header instead. */
export function requestBody(
  provider: Provider,
  prompt: string,
  questions: Record<string, unknown>,
  model: string,
  /** The previous prompt and the skill it got, so a follow-up ("do the same
   * for X") can be read against what it refers to. */
  recentContext = '',
): string {
  const state = { request: prompt, recent_context: recentContext }
  const body = provider === 'typesafe' ? { model, state, questions } : { state, questions }
  return JSON.stringify(body)
}

/** The request headers. */
export function requestHeaders(provider: Provider, apiKey: string, model: string): Record<string, string> {
  const common = { 'content-type': 'application/json', ...authHeader(apiKey) }
  if (provider === 'typesafe') return common
  return {
    ...common,
    'ai-gateway-auth-method': 'api-key',
    'ai-model-id': model,
    'ai-evaluation-model-specification-version': '4',
  }
}

type Answers = Record<string, Record<string, unknown>>

function answersOf(responseText: string): Answers | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }
  const answers = (parsed as { answers?: Answers }).answers
  return answers && typeof answers === 'object' ? answers : null
}

/** P(true) of a yes/no answer: `noul` on TypeSafe, `probability` on the Gateway. */
function yesNoOf(answer: Record<string, unknown> | undefined): number | null {
  if (!answer) return null
  if (typeof answer.noul === 'number') return answer.noul
  if (typeof answer.probability === 'number') return answer.probability
  return null
}

/**
 * Reads the first request's answer. The ranking is the Choice's probability
 * distribution, surest first; a backend that sends none ranks the named
 * choice alone, at the reported confidence or none. The gate is the mean of
 * the oriented nouls that were answered, or null when none was.
 */
export function readWide(responseText: string): Wide | null {
  const answers = answersOf(responseText)
  const which = answers?.which
  if (!answers || !which || typeof which.choice !== 'string') return null

  const probabilities = which.probabilities as Record<string, number> | undefined
  const ranked: Wide['ranked'] = []
  if (probabilities) {
    for (const [name, probability] of Object.entries(probabilities)) {
      if (typeof probability === 'number') ranked.push({ name, probability })
    }
    ranked.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
  }
  if (ranked.length === 0) {
    ranked.push({
      name: which.choice,
      probability: typeof which.confidence === 'number' ? which.confidence : null,
    })
  }

  const gateValues: Record<string, number> = {}
  const oriented: number[] = []
  for (const key of Object.keys(GATE_QUESTIONS)) {
    const value = yesNoOf(answers[`gate::${key}`])
    if (value === null) continue
    gateValues[key] = value
    oriented.push(INVERTED.has(key) ? 1 - value : value)
  }
  const gate = oriented.length > 0 ? oriented.reduce((a, b) => a + b, 0) / oriented.length : null
  return { ranked, gate, gateValues }
}

/** Reads the second request's answer. */
export function readRerank(responseText: string): Rerank | null {
  const answers = answersOf(responseText)
  const which = answers?.which
  if (!answers || !which || typeof which.choice !== 'string') return null
  const fits: Record<string, number> = {}
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith('fits::')) continue
    const value = yesNoOf(answer)
    if (value !== null) fits[key.slice('fits::'.length)] = value
  }
  return {
    winner: which.choice,
    confidence: typeof which.confidence === 'number' ? which.confidence : null,
    fits,
  }
}

/** The first request's answer as the built-in classifier can give it: one label, no gate. */
export function builtinWide(label: string | undefined): Wide | null {
  if (!label) return null
  return {
    ranked: label === NONE ? [] : [{ name: label, probability: null }],
    gate: null,
    gateValues: {},
  }
}

/**
 * The text the built-in classifier reads: the prompt and the catalog it must
 * choose from, since `$.model.classify` takes bare labels and the descriptions
 * are the whole point.
 */
export function classifyText(prompt: string, skills: readonly Skill[], recentContext = ''): string {
  return [
    'Which skill, going by its description, should be loaded before working on the prompt below? Answer "none" unless the prompt is clearly the kind of task a description names.',
    '',
    'Skills:',
    ...skills.map(line),
    `- ${NONE}: no listed skill is about this prompt`,
    '',
    ...(recentContext ? ['Earlier in the conversation (a short follow-up usually continues it):', recentContext, ''] : []),
    'Prompt:',
    prompt,
  ].join('\n')
}

/**
 * The backup between Jev and the built-in classifier: an OpenAI-compatible
 * chat endpoint (OpenRouter by default) asked the built-in classifier's
 * question, answering with one skill name as JSON.
 */
export const DEFAULT_FALLBACK = { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna', freeModel: 'openrouter/free' }

/** The backup's chat-completions URL. */
export function fallbackEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** The backup's request body. */
export function fallbackBody(prompt: string, skills: readonly Skill[], model: string, recentContext = ''): string {
  return JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 60,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You pick which skill an AI assistant should load. Reply with JSON only: {"skill": "<one skill name from the list, or ${NONE}>"}`,
      },
      { role: 'user', content: classifyText(prompt, skills, recentContext) },
    ],
  })
}

/**
 * The backup's answer as a label, or undefined when it named nothing on the
 * list: a made-up name is no answer, not a pick.
 */
export function readFallback(responseText: string, skills: readonly Skill[]): string | undefined {
  let content: unknown
  try {
    content = (JSON.parse(responseText) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message
      ?.content
  } catch {
    return undefined
  }
  if (typeof content !== 'string') return undefined
  let named: unknown = content.trim()
  const json = content.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      named = (JSON.parse(json[0]) as { skill?: unknown }).skill
    } catch {
      return undefined
    }
  }
  if (typeof named !== 'string') return undefined
  const name = named.trim().replace(/^\//, '')
  if (name === NONE) return NONE
  return skills.some((skill) => skill.name === name) ? name : undefined
}

/**
 * The defaults, set from tc-ventures' routing cases (scripts/jev-routing),
 * not the cookbook's 0.3/0.3:
 *
 * - `fitsThreshold` 0.55: over 210 runs of the cases with `fitsQuestion`'s
 *   wording, right picks scored 0.63 or more (0.68 on the cases that require
 *   them) and wrong ones 0.51 or less; 0.50 let "we need to fix and improve
 *   that" through to skill-creator, 0.60 would sit 0.03 under right picks.
 * - `decisiveRank` 0.9: requests that name their deliverable ("design the
 *   approval workflow as a flowchart", "have Gemini answer this") ranked the
 *   right skill at 1.00 yet failed the gate (0.08–0.23), because a flowchart
 *   or an answer *could* be written in prose. No wrong pick ranked that high
 *   with the gate closed, and `fits` still rejects a decisive but wrong one
 *   ("that is what i said to do already" → session-start-hook 0.99, fits 0.16).
 */
export const DEFAULT_POLICY = { shortlist: 3, gateThreshold: 0.3, fitsThreshold: 0.55, decisiveRank: 0.9 } as const

export interface PolicyConfig {
  /** How many of the ranking the second request re-reads. */
  shortlist: number
  /** The gate mean under which nothing is suggested. */
  gateThreshold: number
  /** The best `fits` under which the whole shortlist is dropped. */
  fitsThreshold: number
  /**
   * A ranking whose top probability reaches this opens the gate on its own:
   * the rerank's `fits` still has the last word. Above 1 turns it off.
   */
  decisiveRank: number
}

/** The shortlist the second request reads: the top of the ranking, by name. */
export function shortlistOf(wide: Wide, skills: readonly Skill[], count: number): Skill[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const picked: Skill[] = []
  for (const entry of wide.ranked) {
    const skill = byName.get(entry.name)
    if (skill) picked.push(skill)
    if (picked.length >= count) break
  }
  return picked
}

/** The ranking's top probability, or null when the backend gave none. */
export function topProbability(wide: Wide): number | null {
  return wide.ranked[0]?.probability ?? null
}

/** Whether the ranking alone is sure enough to open the gate. */
export function decisive(wide: Wide, config: PolicyConfig): boolean {
  const top = topProbability(wide)
  return top !== null && top >= config.decisiveRank
}

/**
 * Whether the first request's answer is worth a second look at all: the
 * gate says the request wants a skill, or the ranking is decisive about which.
 */
export function passesGate(wide: Wide, config: PolicyConfig): boolean {
  return wide.gate === null || wide.gate >= config.gateThreshold || decisive(wide, config)
}

export interface Suggestion {
  /** The one skill to suggest, or null for "nothing here applies". */
  name: string | null
  /** Why, for the log line. */
  reason: string
}

/**
 * At most one skill name for a request. With the second request switched
 * off, the top of the ranking stands, which is what the first request alone
 * can say; a second request that was attempted and failed suggests nothing.
 */
export function decide(
  wide: Wide | null,
  rerank: Rerank | null,
  skills: readonly Skill[],
  config: PolicyConfig,
  /**
   * Whether a second request was made: with one attempted and no answer,
   * nothing is suggested, since the first request's winner has not had its
   * false-positive check. Off means the second request was never meant to
   * run, and the top of the ranking is the whole answer.
   */
  rerankAttempted = false,
): Suggestion {
  if (!wide) return { name: null, reason: 'no answer' }
  if (!passesGate(wide, config)) {
    return {
      name: null,
      reason: `needs a skill ${(wide.gate as number).toFixed(2)} < ${config.gateThreshold}`,
    }
  }
  const shortlist = shortlistOf(wide, skills, config.shortlist)
  if (shortlist.length === 0) return { name: null, reason: 'nothing ranked' }

  if (!rerank && rerankAttempted) return { name: null, reason: 'rerank gave no answer; no suggestion' }

  // A closed gate opened by a decisive ranking is said, so the log shows why.
  const opened =
    wide.gate !== null && wide.gate < config.gateThreshold
      ? ` (gate ${wide.gate.toFixed(2)}, opened by a decisive ranking ${(topProbability(wide) as number).toFixed(2)})`
      : ''
  if (rerank) {
    const values = Object.values(rerank.fits)
    const best = values.length > 0 ? Math.max(...values) : null
    if (best !== null && best < config.fitsThreshold) {
      return { name: null, reason: `nothing fits, best ${best.toFixed(2)} < ${config.fitsThreshold}${opened}` }
    }
    if (shortlist.some((skill) => skill.name === rerank.winner)) {
      const fit = rerank.fits[rerank.winner]
      // The choice settles which, the winner's own noul whether: another
      // candidate's high fit does not carry a winner that itself fits badly.
      if (fit !== undefined && fit < config.fitsThreshold) {
        return { name: null, reason: `rerank named ${rerank.winner}, but it fits ${fit.toFixed(2)} < ${config.fitsThreshold}${opened}` }
      }
      return {
        name: rerank.winner,
        reason: `rerank of ${shortlist.length}${fit === undefined ? '' : `, fits ${fit.toFixed(2)}`}${opened}`,
      }
    }
    return { name: null, reason: `rerank named ${rerank.winner}, not on the shortlist` }
  }

  const top = shortlist[0] as Skill
  const probability = wide.ranked.find((entry) => entry.name === top.name)?.probability ?? null
  return {
    name: top.name,
    reason: `top of ${wide.ranked.length}${probability === null ? '' : ` (${probability.toFixed(2)})`}, no rerank`,
  }
}

/**
 * The block attached to the prompt, in the cookbook's words. It can be
 * ignored, because pushing harder wins compliance on wrong suggestions too.
 * When the listing is still in place, a turn with nothing to suggest says so:
 * sending nothing would leave "err on the side of loading" unopposed. With
 * the listing withheld there is nothing to oppose, so nothing is sent.
 */
export function suggestionBlock(suggested: Skill | null, hidden: boolean): string | null {
  if (!suggested) {
    return hidden
      ? null
      : '<skill_relevance>\nNo skill in the roster appears relevant to this request.\n</skill_relevance>'
  }
  const lines = [
    '<skill_relevance>',
    `Relevant to the current request: ${suggested.name}. Ignore this if it does not fit what the user actually asked for.`,
  ]
  if (hidden) {
    // The model has no listing to look the name up in, so the line it would
    // have found there and the way to load it come along.
    lines.push(
      `${line(suggested)}`,
      'Load it with the Skill tool (skill: "' +
        suggested.name +
        '") before you start. The full skill listing is withheld from your context; the user can invoke any skill by typing /name.',
    )
  }
  lines.push('</skill_relevance>')
  return lines.join('\n')
}

/** A number for the log, or `n/d` when the backend reported none. */
function reported(value: number | null): string {
  return value === null ? 'n/d' : value.toFixed(2)
}

/**
 * The one-time line that says the mod is alive, which backend answers it,
 * and whether the listing is being withheld.
 */
export function describeSetup(
  provider: Provider | null,
  url: string,
  hideListing: boolean,
  builtinByChoice = false,
): string {
  const backend = provider
    ? `${provider} (${url})`
    : builtinByChoice
      ? 'the built-in classifier, by choice'
      : 'the built-in classifier, no key set'
  const listing = hideListing ? 'withholding the skill listing' : 'leaving the skill listing in place'
  return `ready on ${backend}; ${listing}`
}

/** What the first request answered: the gate and the top of the ranking. */
export function describeWide(wide: Wide | null, candidates: number, ms: number | null): string {
  const took = ms === null ? '' : ` · ${Math.round(ms)}ms`
  if (!wide) return `no answer from ${candidates} candidates${took}`
  const top = wide.ranked
    .slice(0, 3)
    .map((entry) => `${entry.name} (${reported(entry.probability)})`)
    .join(', ')
  return `needs a skill ${reported(wide.gate)} · top of ${candidates}: ${top || 'none'}${took}`
}

/** What the second request answered: the winner and every `fits`. */
export function describeRerank(rerank: Rerank | null, ms: number | null): string {
  const took = ms === null ? '' : ` · ${Math.round(ms)}ms`
  if (!rerank) return `rerank: no answer${took}`
  const fits = Object.entries(rerank.fits)
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(', ')
  return `rerank → ${rerank.winner} (${reported(rerank.confidence)}) · fits ${fits || 'n/d'}${took}`
}

/**
 * The persistent status line: the last thing the mod did, short enough to
 * sit on screen beside the engine's own notices.
 */
export function describeStatus(suggested: string | null, decidedBy = 'jev'): string {
  // Only Jev's own answer is labelled "jev": a pick from the backup or the
  // built-in classifier says so, or a Jev outage goes unnoticed.
  const who = decidedBy === 'jev' ? 'jev' : `jev offline · ${decidedBy}`
  return suggested ? `${who} · skill: ${suggested}` : `${who} · no skill`
}

/**
 * The one-time notice for a Jev response that no retry will fix (no credit,
 * bad or missing key), or null for anything else (timeouts, 5xx, 429).
 */
export function jevUnavailable(status: number, provider: Provider, onOpenRouter: boolean): string | null {
  if (status !== 401 && status !== 402 && status !== 403) return null
  const where = onOpenRouter ? 'OpenRouter' : provider === 'typesafe' ? 'TypeSafe' : 'the AI Gateway'
  const why = status === 402 ? 'has no credit' : 'was refused'
  const fix = onOpenRouter
    ? 'add credit at openrouter.ai/settings/credits, or set TYPESAFE_API_KEY'
    : 'check the key, or set OPENROUTER_API_KEY'
  return `Jev is unavailable: the ${where} key ${why} (${status}). Skills are being picked by the fallback until then; ${fix}.`
}

/** The name of the plugin's own setup command, as the engine runs it. */
export const SETUP_COMMAND = 'jev-skill-suggestion:setup'

/** The project's short name for the setup command (`.claude/commands/jev.md`). */
export const SETUP_ALIAS = 'jev'

/** A user settings file's parts the setup touches. */
export interface SkillSettings {
  skillOverrides: Record<string, string>
  disableBundledSkills: boolean | undefined
}

/** Reads the two fields from `~/.claude/settings.json`; malformed reads as empty. */
export function readSkillSettings(json: string | null): SkillSettings {
  let parsed: unknown = null
  try {
    parsed = json ? JSON.parse(json) : null
  } catch {
    parsed = null
  }
  const settings = (parsed ?? {}) as { skillOverrides?: unknown; disableBundledSkills?: unknown }
  const overrides: Record<string, string> = {}
  if (settings.skillOverrides && typeof settings.skillOverrides === 'object') {
    for (const [name, value] of Object.entries(settings.skillOverrides as Record<string, unknown>)) {
      if (typeof value === 'string') overrides[name] = value
    }
  }
  return {
    skillOverrides: overrides,
    disableBundledSkills: typeof settings.disableBundledSkills === 'boolean' ? settings.disableBundledSkills : undefined,
  }
}

/**
 * Whether a file is this mod's backup: `skillOverrides` an object of
 * strings and `disableBundledSkills` a boolean or null. Anything else is
 * not something `restore` could apply, so a setup must not build on it.
 */
export function validBackup(json: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const { skillOverrides, disableBundledSkills } = parsed as Record<string, unknown>
  if (!skillOverrides || typeof skillOverrides !== 'object' || Array.isArray(skillOverrides)) return false
  if (!Object.values(skillOverrides as Record<string, unknown>).every((value) => typeof value === 'string')) return false
  return disableBundledSkills === null || typeof disableBundledSkills === 'boolean'
}

export interface SetupPlan {
  /** User and project skills the setup hides from the model (`user-invocable-only`). */
  hide: string[]
  /** Of those, the ones already hidden or off: nothing to change. */
  alreadyHidden: string[]
  /** A plugin's skills: `skillOverrides` cannot touch them, only `/plugin` can. */
  locked: string[]
  /**
   * Whether bundled skills are on. They stay on: they live inside Claude
   * Code, not on disk, so the mod could never inject one it had hidden.
   */
  bundledStillOn: boolean
}

/**
 * What the setup has to change, from the roster and the settings as they
 * are. Every user-level command is listed, so the person sees the whole set
 * before anything is written.
 */
export function setupPlan(
  commands: readonly { name: string; source: string }[],
  settings: SkillSettings,
  excluded: ReadonlySet<string>,
): SetupPlan {
  const hide: string[] = []
  const alreadyHidden: string[] = []
  const locked: string[] = []
  const seen = new Set<string>()
  for (const command of commands) {
    if (seen.has(command.name) || excluded.has(command.name)) continue
    seen.add(command.name)
    if (command.source === 'plugin') locked.push(command.name)
    else if (command.source === 'user') {
      const state = settings.skillOverrides[command.name] ?? 'on'
      if (state === 'user-invocable-only' || state === 'off') alreadyHidden.push(command.name)
      else hide.push(command.name)
    }
  }
  return { hide, alreadyHidden, locked, bundledStillOn: settings.disableBundledSkills !== true }
}

/**
 * The prompt the model reads for `/jev-skill-suggestion:setup`: the plan in
 * full, the exact edit, and the rule that nothing is written before the
 * person has seen the list and said yes. The model edits the file with its
 * own tools, so the change shows as a diff and asks permission like any edit.
 */
export function setupInstructions(
  mode: 'apply' | 'restore',
  plan: SetupPlan,
  settings: SkillSettings,
  settingsPath: string,
  backupPath: string,
  /**
   * Whether a backup from an earlier run is already there. It holds the
   * values from before the first run, which the current settings no longer
   * do, so a rerun must leave it alone.
   */
  backupExists = false,
): string {
  const lines: string[] = ['<jev_skill_suggestion_setup>']
  if (mode === 'restore') {
    lines.push(
      `The user asked to undo jev-skill-suggestion's setup: put their skills back the way they were before it ran.`,
      `1. Read ${backupPath}. It holds {"skillOverrides": {...}, "disableBundledSkills": ...} as they were before the setup.`,
      `   If it does not exist, say so and stop: there is nothing to restore.`,
      `2. Show the user what will change in ${settingsPath}: the "skillOverrides" entries that go back to their saved value (an entry not in the backup is removed), and "disableBundledSkills" back to its saved value (removed when the backup says null).`,
      `3. Ask the user to confirm. Only after a clear yes, edit ${settingsPath} with the Edit tool, changing nothing else in the file, then remove the backup by running exactly this command with the Bash tool: rm ~/.claude/jev-skill-suggestion.skill-overrides.backup.json`,
      `4. Tell the user to restart Claude Code for /skills and /context to show the change.`,
      '</jev_skill_suggestion_setup>',
    )
    return lines.join('\n')
  }
  const overrides: Record<string, string> = { ...settings.skillOverrides }
  for (const name of plan.hide) overrides[name] = 'user-invocable-only'
  // Bundled skills (artifact-design, dataviz, claude-api, simplify, ...) have
  // no SKILL.md the mod can read, so turning them off takes them away for good.
  const after = JSON.stringify({ skillOverrides: overrides, disableBundledSkills: false }, null, 2)
  const backup = JSON.stringify(
    { skillOverrides: settings.skillOverrides, disableBundledSkills: settings.disableBundledSkills ?? null },
    null,
    2,
  )
  lines.push(
    `The user asked jev-skill-suggestion to take over skill selection: every skill is hidden from the model's listing (state "user-invocable-only": the user can still type /name) and the mod injects the one skill each prompt needs. Nothing here is written until the user has seen the list and said yes.`,
    '',
    `Skills that will be hidden from the model (${plan.hide.length}):`,
    ...(plan.hide.length > 0 ? plan.hide.map((name) => `- ${name}`) : ['- (none)']),
  )
  if (plan.alreadyHidden.length > 0) {
    lines.push('', `Already hidden, left as they are (${plan.alreadyHidden.length}):`, ...plan.alreadyHidden.map((name) => `- ${name}`))
  }
  lines.push(
    '',
    plan.bundledStillOn
      ? `Claude Code's bundled skills (artifact-design, dataviz, simplify, ...) stay on: they are not files the mod can inject, so hiding them would take them away.`
      : `Claude Code's bundled skills are disabled ("disableBundledSkills": true); this turns them back on, since the mod cannot inject them and they would otherwise be unusable.`,
  )
  if (plan.locked.length > 0) {
    lines.push(
      '',
      `Plugin skills cannot be hidden by skillOverrides; they stay listed unless the plugin is disabled in /plugin (${plan.locked.length}):`,
      ...plan.locked.map((name) => `- ${name}`),
    )
  }
  lines.push(
    '',
    'Steps:',
    `1. Show the user the lists above, in their language, and say the change goes to ${settingsPath} (their user settings) and can be undone with /${SETUP_COMMAND} restore.`,
    '2. Ask them to confirm. Do not edit anything before a clear yes.',
    ...(backupExists
      ? [
          `3. ${backupPath} already exists from an earlier run and holds the values from before the first setup: do NOT overwrite or modify it.`,
        ]
      : [`3. After the yes, first write ${backupPath} with exactly this content (it is what restore reads):`, backup]),
    `4. Then edit ${settingsPath} with the Edit tool (read it first; create it as {} if it does not exist) so that its top-level "skillOverrides" and "disableBundledSkills" become exactly:`,
    after,
    '   Change nothing else in the file. Keep every other top-level key as it is.',
    '5. Tell the user to restart Claude Code: /skills will then show these skills as user-only and /context will count them at 0, while the mod keeps injecting the one skill a prompt needs.',
    '</jev_skill_suggestion_setup>',
  )
  return lines.join('\n')
}

/**
 * What the model reads when the setup cannot be planned: the roster or the
 * settings could not be read, so no edit is proposed — an edit planned from
 * a partial roster or empty settings would hide too little or back up the
 * wrong values.
 */
export function setupAborted(reason: string): string {
  return [
    '<jev_skill_suggestion_setup>',
    `The jev-skill-suggestion setup could not be prepared: ${reason}.`,
    'Tell the user, and do not edit any settings file. They can fix the cause and run the command again.',
    '</jev_skill_suggestion_setup>',
  ].join('\n')
}

/** The hint logged while skills are still listed and the mod is meant to be the only source of them. */
export function describeStillListed(count: number): string {
  return `${count} skill${count === 1 ? ' is' : 's are'} still listed for the model (withheld here, but /context counts them); run /${SETUP_COMMAND} to hand their selection to the mod for good`
}

/**
 * One prompt's decision as the decision log keeps it, for the usage
 * dashboard. The prompt's text is never stored, only its length.
 */
export interface DecisionRecord {
  kind: 'jev.decision'
  ts: string
  session: string
  /** `jev`, `backup <model>` or `built-in classifier`. */
  decidedBy: string
  /** The backend Jev was asked on (`typesafe`/`gateway`), or null with no key. */
  provider: Provider | null
  /** Who served the decision: `openrouter` (TypeSafe's API as OpenRouter serves it), `typesafe`, `gateway`, `backup` or `builtin`. */
  via: string
  model: string | null
  promptChars: number
  /** Whether the previous prompt went with it as `recent_context`. */
  withContext: boolean
  candidates: number
  gate: number | null
  top: { name: string; probability: number | null }[]
  rerank: { winner: string; confidence: number | null; fits: Record<string, number> } | null
  pick: string | null
  reason: string
  wideMs: number | null
  rerankMs: number | null
  injected: boolean
  /** The judgement-quotient record this decision was logged under, or null when none was (see `jqConfidence`). */
  jqId: string | null
}

/** A skill the model loaded, and whether it was the one suggested. */
export interface SkillLoadRecord {
  kind: 'jev.skill_load'
  ts: string
  session: string
  skill: string
  suggested: string | null
  asSuggested: boolean
}

export type LogRecord = DecisionRecord | SkillLoadRecord

/** A record before the hook stamps its time and session. */
export type UnstampedRecord = Omit<DecisionRecord, 'ts' | 'session'> | Omit<SkillLoadRecord, 'ts' | 'session'>

/** Where a session's decision log lives: one JSONL file per session. */
export function decisionLogPath(home: string, session: string): string {
  return `${home}/.claude/jev-log/${session.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`
}

/**
 * The log's next content. `$.fs.write` replaces a file whole, so the lines
 * already there are kept, and a torn last line (a write cut short) dropped.
 */
export function appendRecord(existing: string | null, record: LogRecord): string {
  const kept = (existing ?? '')
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false
      try {
        JSON.parse(line)
        return true
      } catch {
        return false
      }
    })
  return [...kept, JSON.stringify(record)].join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Judgement quotient (JQ): each decision is logged with the probability it
// rested on, and what the user did about a pick they saw is its outcome.
// Record format: skills/model-router/scripts/jq-log.mjs (tc-ventures' jq.mjs).

/** What a logged decision's confidence rests on. */
export type JqBasis = 'fits' | 'rank' | 'gate'

/**
 * The most honest probability for the decision `decide` made, or null when
 * the decision did not rest on one (and so nothing is logged: a figure is
 * never filled in). Walks `decide`'s own path:
 *
 * - a pick the rerank confirmed: the winner's own `fits` noul, P(it does the
 *   specific thing asked);
 * - a pick with no rerank (`rerank: false`): its probability in the ranking;
 * - "none" because the gate stayed closed: 1 − gate (the gate is the mean
 *   P(the request needs a skill));
 * - "none" because nothing fits (the best `fits` under the threshold, or the
 *   winner's own under it): 1 − the best `fits` of the shortlist, the
 *   probability that no candidate does the thing;
 * - anything else (no answer, a failed rerank, a winner off the shortlist,
 *   the built-in classifier's bare label): null.
 */
export function jqConfidence(
  wide: Wide | null,
  rerank: Rerank | null,
  skills: readonly Skill[],
  config: PolicyConfig,
  rerankAttempted: boolean,
  decision: Suggestion,
): { confidence: number; basis: JqBasis } | null {
  const probability = (value: number | null | undefined, basis: JqBasis) =>
    typeof value === 'number' && value >= 0 && value <= 1 ? { confidence: value, basis } : null
  if (!wide) return null
  if (!passesGate(wide, config)) return decision.name === null ? probability(wide.gate === null ? null : 1 - wide.gate, 'gate') : null
  const shortlist = shortlistOf(wide, skills, config.shortlist)
  if (shortlist.length === 0) return null
  if (!rerank) {
    if (rerankAttempted || decision.name === null) return null
    return probability(wide.ranked.find((entry) => entry.name === decision.name)?.probability, 'rank')
  }
  const values = Object.values(rerank.fits)
  const best = values.length > 0 ? Math.max(...values) : null
  if (decision.name === null) {
    const onShortlist = shortlist.some((skill) => skill.name === rerank.winner)
    const restedOnFits = (best !== null && best < config.fitsThreshold) || (onShortlist && (rerank.fits[rerank.winner] ?? 1) < config.fitsThreshold)
    return restedOnFits && best !== null ? probability(1 - best, 'fits') : null
  }
  return decision.name === rerank.winner ? probability(rerank.fits[rerank.winner], 'fits') : null
}

/** The one line Claude starts its reply with, so the user sees Jev's pick. */
export function jevLine(skill: string, confidence: number): string {
  return `Jev: ${skill} (${confidence.toFixed(2)})`
}

/**
 * The instruction added inside the <skill_relevance> block (after the
 * "Relevant to the current request" line, which the usage dashboard reads)
 * so the pick is on screen, in the reply, and not only on the status line.
 */
export function showPickInstruction(line: string): string {
  return `Start your reply with this one line, exactly as written, so the user can see which skill Jev picked: ${line}`
}

/** Adds the show-the-pick instruction to a block, just before its closing tag. */
export function withJevLine(block: string, line: string | null): string {
  if (!line) return block
  const close = '</skill_relevance>'
  const at = block.lastIndexOf(close)
  return at === -1 ? `${block}\n${showPickInstruction(line)}` : `${block.slice(0, at)}${showPickInstruction(line)}\n${block.slice(at)}`
}

/**
 * Whether a message reads as pushback or a correction. The same test as the
 * usage dashboard's (plugins/usage-telemetry/scripts/lib.mjs).
 */
export function looksLikeCorrection(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  return (
    /^(no\b|nope|wrong|not (that|what)|that'?s (not|wrong)|stop\b|why (the fuck|tf|is|isn'?t|did|didn'?t|are)|wtf|what the)/i.test(t) ||
    /\b(still (not|broken|failing|doesn'?t|isn'?t|wrong)|doesn'?t work|isn'?t working|not working|didn'?t work|you (didn'?t|missed|forgot|ignored)|i (already|just) (said|told)|that is what i said|how is that not clear|fuck|wtf|\?{3,})/i.test(t)
  )
}

/**
 * What the user's next prompt says about a "none" decision (Jev suggested no
 * skill). "None" is never shown, so it can never be "kept"; but by the
 * owner's rule (2026-09-26) a skill the user types right after it is a Jev
 * miss: overruled, and the typed skill was right. A typed `/name` that is not
 * a skill (`/clear`) and anything else record nothing.
 */
export function jqMissForNone(
  nextPrompt: string,
  isSkill: (name: string) => boolean,
): { outcome: 'overruled'; answer: string } | null {
  const typed = /^\/([\w:.-]+)(?:\s|$)/.exec(nextPrompt.trim())
  if (!typed) return null
  const name = typed[1] as string
  return isSkill(name) ? { outcome: 'overruled', answer: name } : null
}

/** A skill's name without its plugin prefix (`plugin:skill` → `skill`). */
const bare = (name: string) => name.slice(name.lastIndexOf(':') + 1)

/**
 * What the user's next prompt says about a pick they were shown (the
 * `Jev: …` line), by the owner's rule (2026-09-26):
 *
 * - they typed `/X`, X a skill other than the pick → overruled, X was right;
 * - the message reads as pushback or a correction → nothing: the complaint
 *   may be about the work, not the skill;
 * - a typed `/name` that is not a skill (`/clear`, `/model`) → nothing;
 * - otherwise → kept: they saw the pick and let it stand.
 *
 * Only ever called for a pick that was shown; a "none" is never shown, so
 * it can't be kept — see `jqMissForNone` for how a "none" can be overruled.
 */
export function jqOutcomeFor(
  pick: string,
  nextPrompt: string,
  isSkill: (name: string) => boolean,
): { outcome: 'kept' } | { outcome: 'overruled'; answer: string } | null {
  const text = nextPrompt.trim()
  if (!text) return null
  const typed = /^\/([\w:.-]+)(?:\s|$)/.exec(text)
  if (typed) {
    const name = typed[1] as string
    if (!isSkill(name)) return null
    return name === pick || bare(name) === bare(pick) ? { outcome: 'kept' } : { outcome: 'overruled', answer: name }
  }
  if (looksLikeCorrection(text)) return null
  return { outcome: 'kept' }
}
