/**
 * jev-skill-suggestion — Claude Mod (EARLY ACCESS)
 *
 * Takes the skill listing out of the context window and has TypeSafe's Jev,
 * a System One decision model, suggest at most one skill per prompt, going
 * by the skills' descriptions. The skills stay installed and loadable; what
 * goes away is the listing the engine sends the model every session, one
 * line per skill, whether the prompt has anything to do with any of them.
 *
 * The decision follows TypeSafe's "Skill suggestion" cookbook: two requests
 * per prompt, one to rank every skill and ask whether the prompt needs a
 * skill at all, one to re-read the top few with their full text and let each
 * be rejected on its own. Either may come back empty-handed.
 *
 * Three hooks:
 *   prompt.attachment  — the engine's `skill_listing` attachment is answered
 *                        with `{ text: null }` (left out) or trimmed to the
 *                        names in `alwaysListed`. Its names are remembered:
 *                        they are the engine's word on which skills the model
 *                        may invoke.
 *   prompt.submit      — the two requests run, and the winner (if any) is
 *                        attached to the prompt as a `<skill_relevance>`
 *                        block: with the skill's own SKILL.md inside it
 *                        (`inject: "content"`, the default), so the skill
 *                        loads even when `skillOverrides` hides it from the
 *                        model, or with its name for the Skill tool
 *                        (`inject: "suggest"`).
 *   skill.prompt       — observation: whether the model took the suggestion,
 *                        or loaded a skill on its own. Also writes the prompt
 *                        of the plugin's own `/jev-skill-suggestion:setup`,
 *                        which hides every skill from the engine's listing
 *                        (user-invocable-only) once the person has seen the
 *                        list and said yes; the model makes the edit with its
 *                        own tools, so it shows and asks like any other.
 *
 * Jev is reached one of two ways, whichever key is configured: TypeSafe's
 * own API (`typesafeApiKey`), which reports a calibrated confidence, or the
 * Vercel AI Gateway (`gatewayApiKey`), which does not. With neither, the
 * engine's own `$.model.classify` stands in with a single request and no
 * gate, so the mod is useful without any account.
 *
 * The candidates come from `$.command.list()`, not from the listing: the
 * listing is only rendered at the turn's first request, after `prompt.submit`
 * has run, so the first prompt of a session would otherwise have nothing to
 * choose from. The listing, once seen, narrows the candidates to what the
 * engine itself would have shown.
 *
 * The second request reads the opening of each shortlisted skill's SKILL.md,
 * found on disk by how Claude Code lays skills out (project and user
 * `.claude/skills` and `.claude/commands`, a plugin's install path from
 * `~/.claude/plugins/installed_plugins.json`). A body that cannot be found
 * leaves that skill with its one-line description; nothing fails over it.
 *
 * Only the main conversation is handled. A subagent's own listing is left as
 * the engine renders it: its prompt is a tool call's argument, not a
 * `prompt.submit`, so nothing here could suggest for it.
 *
 * Every failure path is fail-open: a request that errors or runs past the
 * latency budget lets the prompt through with no suggestion, and the listing
 * hook always answers the same way, so the model's prompt cache holds.
 *
 * The API key comes from the plugin's options (userConfig "typesafeApiKey"
 * or "gatewayApiKey"). Never hardcode it in this file.
 *
 * Needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 and Claude Code >= 2.1.278: the
 * `prompt.attachment` event is that release's. Typed against Anthropic's
 * declarations: https://github.com/anthropics/claude-code/tree/main/mods
 *
 * Judgement quotient (JQ): each decision is also appended to the JQ log
 * (~/.jq/decisions.jsonl; JQ_LOG_FILE moves it, JQ_LOG=off stops it) in the
 * format tc-ventures' `tools/jq/jq.mjs report` scores, with the probability
 * the decision rested on (`jqConfidence`), never the prompt's text. A pick is
 * shown to the user as a `Jev: <skill> (<confidence>)` line Claude is asked to
 * start its reply with; the next prompt then records what the user did about
 * it (`jqOutcomeFor`): kept, overruled by a typed `/other-skill`, or nothing
 * when it reads as a correction.
 *
 * Privacy: with a key set, the prompt text, every candidate skill's name and
 * description, and the opening of each shortlisted skill's SKILL.md are sent
 * to whichever backend the key belongs to.
 */
import type { Register } from 'claude-code'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  NONE,
  SETUP_ALIAS,
  SETUP_COMMAND,
  builtinWide,
  catalog,
  classifyText,
  commandLike,
  decide,
  describeRerank,
  describeSetup,
  describeStatus,
  describeStillListed,
  describeWide,
  detailOf,
  displayIds,
  canonical,
  endpoint,
  injectionBlock,
  installPathsOf,
  parseListing,
  parseNames,
  passesGate,
  pluginFileCandidates,
  readRerank,
  readSkillSettings,
  modelInvocable,
  readWide,
  costOf,
  armOf,
  DEFAULT_ARM_SHARES,
  rerankQuestions,
  requestBody,
  requestHeaders,
  selectProvider,
  setupAborted,
  setupInstructions,
  setupPlan,
  shortlistOf,
  validBackup,
  skillFileCandidates,
  suggestionBlock,
  syncedFileCandidates,
  trimListing,
  wideQuestions,
  DEFAULT_FALLBACK,
  OPENROUTER_SYSTEM_ONE_BASE_URL,
  isOpenRouterUrl,
  PROXY_INJECTED,
  authHeader,
  fallbackBody,
  fallbackEndpoint,
  readFallback,
  appendRecord,
  decisionLogPath,
  DEFAULT_POLICY,
  recentContextOf,
  jevUnavailable,
  jqConfidence,
  jqOutcomeFor,
  jqMissForNone,
  jevLine,
  withJevLine,
  offloadable,
  offloadContext,
  offloadShown,
  readRoute,
  FOR_CLAUDE,
  skippedDecision,
} from './policy.ts'
import { SHARED_DIR, appendLine, decisionEntry, jqLogPath, outcomeEntry } from '../skills/model-router/scripts/jq-log.mjs'
import type { Arm, Candidate, LogRecord, UnstampedRecord, PolicyConfig, Provider, Rerank, Route, Skill, Wide } from './policy.ts'

/** Prompt origins that are not a task of the person's: nothing to suggest for. */
const NOT_A_TASK = new Set([
  'task-notification',
  'peer',
  'peer-send-message',
  'projects-relay',
  'observer',
  'observer-activity',
])

// The decision log the usage dashboard reads: one JSONL line per prompt
// decided and per skill loaded, under ~/.claude/jev-log/. Never the
// prompt's text. Best effort: a write that fails only costs the record.
async function record(
  $: { fs: { read: (path: string) => Promise<unknown>; write: (path: string, text: string) => Promise<void>; exists: (path: string) => Promise<boolean> }; env: { get: (name: string) => Promise<string | undefined> }; session: { id: () => Promise<string> }; clock: { now: () => Promise<number> } },
  entry: UnstampedRecord,
  logDecisions: boolean,
): Promise<void> {
  if (!logDecisions) return
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const session = await $.session.id()
    if (!home || !session) return
    const path = decisionLogPath(home, session)
    const existing = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
    const ts = new Date(await $.clock.now()).toISOString()
    await $.fs.write(path, appendRecord(existing, { ...entry, ts, session } as LogRecord))
  } catch {
    // The dashboard misses one line; the prompt is never held up over it.
  }
}

// The judgement-quotient log (see jq-log.mjs): where it is, by jq.mjs's rule.
async function jqAppend(
  $: { fs: { read: (path: string) => Promise<unknown>; write: (path: string, text: string) => Promise<void>; exists: (path: string) => Promise<boolean> }; env: { get: (name: string) => Promise<string | undefined> } },
  entry: object | null,
): Promise<boolean> {
  if (!entry) return false
  try {
    const env: Record<string, string | undefined> = {}
    env.JQ_LOG = await $.env.get('JQ_LOG')
    env.JQ_LOG_FILE = await $.env.get('JQ_LOG_FILE')
    env.NODE_TEST_CONTEXT = await $.env.get('NODE_TEST_CONTEXT')
    env.HOME = await $.env.get('HOME')
    const path = jqLogPath(env, { sharedDirExists: await $.fs.exists(SHARED_DIR) })
    if (!path) return false
    // writeEntry's read-then-write, spelled out: the engine reads $ only as $.noun.method(...).
    const existing = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
    await $.fs.write(path, appendLine(existing, entry))
    return true
  } catch {
    // Keeping score never holds up the prompt.
    return false
  }
}

// Where project skills can live. A cloud session with several repositories
// runs in their parent (/home/user) with each repo added beside it, so the
// working directory alone has no `.claude/skills`: every direct child with
// a `.claude/` folder counts as a project too. Read once per session.
async function findProjectRoots($: { session: { cwd: () => Promise<string>; root: () => Promise<string> }; fs: { exists: (path: string) => Promise<boolean>; list: (path?: string) => Promise<{ name: string; kind: string }[]> } }): Promise<string[]> {
  const found: string[] = []
  for (const base of [await $.session.cwd(), await $.session.root()]) {
    if (!base || found.includes(base)) continue
    found.push(base)
    try {
      for (const entry of await $.fs.list(base)) {
        const child = `${base}/${entry.name}`
        if (entry.kind === 'dir' && !entry.name.startsWith('.') && !found.includes(child) && (await $.fs.exists(`${child}/.claude`))) found.push(child)
      }
    } catch {
      // An unreadable directory only narrows the search.
    }
  }
  return found
}

/**
 * Runs the model router's offload (local Ollama, then free models) on the
 * prompt; the answer, or null (a failure is logged and Claude answers).
 */
async function offload(
  $: { plugin: { root: string }; process: { run: (argv: readonly string[], init?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> }; ui: { status: (text: string | undefined) => void; log: (text: string) => void } },
  prompt: string,
  route: Route,
  timeoutMs: number,
  logDecisions: boolean,
): Promise<{ text: string; model: string; via: string } | null> {
  const root = $.plugin.root
  if (!root || !route.category || !route.tier) return null
  $.ui.status('Jev: answering with the model router…')
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['node', `${root}/skills/model-router/scripts/router.mjs`, prompt, '--offload', '--no-jev', '--category', route.category, '--tier-hint', route.tier, '--timeout', '30', '--json'],
      // Node's fetch honours HTTPS_PROXY only with this; without a proxy it changes nothing.
      { env: { NODE_USE_ENV_PROXY: '1' }, timeoutMs },
    )
    if (exitCode !== 0) {
      if (logDecisions) $.ui.log(`[jev-skill-suggestion] router could not answer; Claude answers: ${String(stderr).trim().split('\n').filter((l) => !/UNDICI|trace-warnings/.test(l)).pop() ?? `exit ${exitCode}`}`)
      return null
    }
    const result = JSON.parse(stdout) as { text?: string; model?: string; via?: string }
    if (!result.text?.trim()) return null
    return { text: result.text, model: result.model ?? 'unknown model', via: result.via ?? 'router' }
  } catch (error) {
    if (logDecisions) $.ui.log(`[jev-skill-suggestion] router failed; Claude answers: ${String(error)}`)
    return null
  }
}

/** This session's group of the on/off comparison, logged the first time it is asked for. */
async function armFor(
  $: Parameters<typeof record>[0] & { ui: { log: (text: string) => void } },
  arms: Map<string, Arm>,
  armShares: { off: number; noRouter: number },
  logDecisions: boolean,
): Promise<Arm> {
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    id = ''
  }
  if (!id) return 'on'
  const known = arms.get(id)
  if (known) return known
  const arm = armOf(id, armShares)
  arms.set(id, arm)
  if (arm !== 'on' && logDecisions) $.ui.log(`[jev-skill-suggestion] this session is in the ${arm === 'off' ? '"off"' : '"no router"'} group of the on/off comparison`)
  await record($, { kind: 'jev.arm', arm, shares: armShares }, logDecisions)
  return arm
}

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  // TypeSafe's own API is preferred when both keys are set: it is the only
  // one that reports a calibrated confidence. `provider` forces one,
  // including "builtin" to use neither. With neither key in the options, an
  // OPENROUTER_API_KEY in the environment reaches Jev through OpenRouter's
  // System One API, which takes TypeSafe's requests unchanged; that is read
  // once, in whichever hook runs first (see `resolve`).
  let typesafeKey = text('typesafeApiKey', '')
  const gatewayKey = text('gatewayApiKey', '')
  const forced = text('provider', 'auto')
  let active: Provider | null = null
  let apiKey = ''
  let modelId = ''
  let url = ''
  let typesafeBase = text('typesafeBaseUrl', DEFAULT_BASE_URL.typesafe)

  // Each backend keeps its own URL and model, so an override written for one
  // can never be sent to the other when `auto` picks differently than expected.
  const pickBackend = () => {
    active = selectProvider(forced, typesafeKey, gatewayKey)
    apiKey = active === 'typesafe' ? typesafeKey : active === 'gateway' ? gatewayKey : ''
    modelId = !active
      ? ''
      : active === 'typesafe'
        ? text('typesafeModel', DEFAULT_MODEL.typesafe)
        : text('gatewayModel', DEFAULT_MODEL.gateway)
    url = !active
      ? ''
      : active === 'typesafe'
        ? endpoint('typesafe', typesafeBase)
        : endpoint('gateway', text('gatewayBaseUrl', DEFAULT_BASE_URL.gateway))
  }
  pickBackend()

  // The backup when Jev gives no answer: a chat model on an OpenAI-compatible
  // endpoint (OpenRouter by default), before the engine's built-in classifier.
  // Its key also falls back to OPENROUTER_API_KEY.
  let fallbackKey = text('fallbackApiKey', '')
  const fallbackUrl = fallbackEndpoint(text('fallbackBaseUrl', DEFAULT_FALLBACK.baseUrl))
  const fallbackModel = text('fallbackModel', DEFAULT_FALLBACK.model)
  // Asked instead when the paid backup answers 402 (out of credit); empty turns it off.
  const fallbackFreeModel = typeof options.fallbackFreeModel === 'string' ? options.fallbackFreeModel : DEFAULT_FALLBACK.freeModel

  // A backend named in the options but missing its key degrades to the
  // built-in classifier, which is silent; say so once, when a hook first runs.
  let unusableReported = true

  /** Applies OPENROUTER_API_KEY, read once, to whatever the options left unset. */
  let resolved = false
  const resolve = (envKey: string, auth: string) => {
    // With OPENROUTER_AUTH=proxy and no key in the environment, the agent
    // proxy adds the key to requests for openrouter.ai.
    const openrouterKey = envKey || (auth === 'proxy' ? PROXY_INJECTED : '')
    resolved = true
    // The OpenRouter key only ever goes to OpenRouter: a typesafeBaseUrl or
    // fallbackBaseUrl pointing elsewhere keeps it out.
    const configuredBase = text('typesafeBaseUrl', '')
    const typesafeOnOpenRouter = !configuredBase || isOpenRouterUrl(configuredBase)
    if (openrouterKey && !typesafeKey && !gatewayKey && typesafeOnOpenRouter && (forced === 'auto' || forced === 'typesafe')) {
      typesafeKey = openrouterKey
      if (!configuredBase) typesafeBase = OPENROUTER_SYSTEM_ONE_BASE_URL
      pickBackend()
    }
    if (!fallbackKey && isOpenRouterUrl(fallbackUrl)) fallbackKey = openrouterKey
    unusableReported = forced === 'auto' || forced === 'builtin' || active !== null
  }

  const hideListing = flag('hideListing', true)
  // "content": the mod reads the chosen skill's SKILL.md and attaches it, so
  // the skill loads even when the engine lists it as user-invocable-only or
  // off. "suggest": the cookbook's block alone, and the model loads the skill
  // with the Skill tool, which honours the engine's skillOverrides.
  const injectContent = text('inject', 'content') !== 'suggest'
  const alwaysListed = parseNames(text('alwaysListed', ''))
  const neverSuggested = parseNames(text('neverSuggested', ''))
  const rerankEnabled = flag('rerank', true)
  const excerptChars = number('excerptChars', 700)
  const timeoutMs = number('timeoutMs', 800)
  const logDecisions = flag('logDecisions', true)
  // The model router on every prompt: Jev's skill request also asks whether the
  // prompt needs Claude Code's tools, and a prompt that plainly doesn't is
  // answered by the router's local and free models instead of starting a turn.
  const offloadOn = flag('offload', true)
  const offloadTimeoutMs = number('offloadTimeoutMs', 60000)
  // The on/off comparison (see `armOf`): the share of sessions with neither
  // Jev nor the router, and with Jev but no router. 0 and 0 turns it off.
  const armShares = { off: number('compareOff', DEFAULT_ARM_SHARES.off), noRouter: number('compareNoRouter', DEFAULT_ARM_SHARES.noRouter) }
  const arms = new Map<string, Arm>()
  const policy: PolicyConfig = {
    shortlist: Math.max(1, Math.round(number('shortlist', DEFAULT_POLICY.shortlist))),
    gateThreshold: number('gateThreshold', DEFAULT_POLICY.gateThreshold),
    fitsThreshold: number('fitsThreshold', DEFAULT_POLICY.fitsThreshold),
    decisiveRank: number('decisiveRank', DEFAULT_POLICY.decisiveRank),
  }

  // The names every skill_listing attachment carried so far. Once non-empty,
  // only these are offered to the decision model: the listing is the engine's
  // word on which skills the model is allowed to invoke, and `$.command.list()`
  // also names commands the model may not.
  const listed = new Set<string>()
  // The skill suggested for the current prompt, so a skill.prompt that loads
  // it can be told apart from one the model reached for on its own.
  let suggested: string | null = null
  // Each skill's SKILL.md as first found, with where, or null when nowhere:
  // read once per session, since the second request wants it on every prompt
  // it is on, and the injection wants it whole.
  const files = new Map<string, { path: string; markdown: string } | null>()
  // The skills whose instructions were already attached this session: a
  // second time, the block only names the skill again.
  const injected = new Set<string>()
  // Said once, the first time a hook runs. A mod that loaded and one that
  // never loaded are otherwise told apart only by the absence of later lines,
  // and absence is not evidence: with the listing gone, silence is the norm.
  let announced = false
  // The setup hint, once per session.
  let hintedSetup = false


  // The last pick the user was shown (the `Jev: …` line), waiting for the
  // next prompt to say what they did about it.
  let shown: { skill: string; jqId: string } | null = null
  // A logged "none" decision: a skill the user types next is a Jev miss (owner, 2026-09-26).
  let unpicked: { jqId: string } | null = null
  // The router's answers since the last prompt that reached Claude, handed to
  // Claude with the next one so a follow-up has them.
  let routerAnswers: { prompt: string; text: string; model: string }[] = []
  // The last offload's JQ entry: a `claude:` prompt next overrules it, anything else keeps it.
  let offloaded: { jqId: string } | null = null
  /** The prompt on its way to Claude, carrying the router's answers in between. */
  const toClaude = (e: { context?: readonly string[] }) => {
    const note = offloadContext(routerAnswers)
    routerAnswers = []
    return note ? { ...e, context: [...(e.context ?? []), note] } : e
  }

  // The previous prompt of the main conversation and the skill it got, sent
  // as Jev's recent_context: "run it on X too" names no skill on its own.
  let previous: { prompt: string; skill: string | null } | null = null
  // A Jev refusal no retry fixes (no credit, bad key) is said once, loudly.
  let outageReported = false

  // A skill whose frontmatter `name:` has spaces ("PocketBase API Rules") is
  // reported by `$.command.list()` under that name, but the engine lists,
  // runs and overrides it by its directory name (`pb-api-rules`). The map
  // from one to the other is read from disk once per session, in whichever
  // hook first needs it.
  let displayToId: Map<string, string> | null = null
  // Where project skills can live (findProjectRoots), read once per session.
  let roots: string[] | null = null


  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (!resolved) {
      resolved = true
      resolve((await $.env.get('OPENROUTER_API_KEY')) ?? '', (await $.env.get('OPENROUTER_AUTH')) ?? '')
    }
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(`[jev-skill-suggestion] ${describeSetup(active, url, hideListing, forced === 'builtin')}`)
      }
    }

    // The "off" group of the on/off comparison: the listing stays as Claude Code sends it.
    if ((await armFor($, arms, armShares, logDecisions)) === 'off') return next(e)

    const skills = parseListing(e.text)
    for (const skill of skills) listed.add(skill.name)

    // With the mod loading skills itself, a listing that still names any is
    // context the setup command would have saved: say so once.
    if (injectContent && !hintedSetup && skills.length > 0 && !e.agentId) {
      hintedSetup = true
      if (logDecisions) $.ui.log(`[jev-skill-suggestion] ${describeStillListed(skills.length)}`)
    }

    // A subagent's listing is not ours: nothing here suggests for a subagent,
    // so hiding its listing would leave it with no skills at all.
    if (!hideListing || e.agentId) return next(e)

    const kept = trimListing(e.text, alwaysListed)
    if (logDecisions) {
      const keptNames = kept
        ? parseListing(kept)
            .map((skill) => skill.name)
            .join(', ')
        : 'none'
      $.ui.log(
        `[jev-skill-suggestion] withheld the skill listing (${skills.length} skills, ${e.text.length} characters); kept listed: ${keptNames}`,
      )
    }
    // Answered without `next`: the engine's text never reaches the model.
    return { text: kept }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!resolved) {
      resolved = true
      resolve((await $.env.get('OPENROUTER_API_KEY')) ?? '', (await $.env.get('OPENROUTER_AUTH')) ?? '')
    }
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(`[jev-skill-suggestion] ${describeSetup(active, url, hideListing, forced === 'builtin')}`)
      }
    }
    suggested = null
    // The "off" group of the on/off comparison: no Jev, no router, the prompt as typed.
    const arm = await armFor($, arms, armShares, logDecisions)
    if (arm === 'off') return next(e)

    // The user's answer to the pick they were shown last time, if this prompt
    // is theirs: a typed `/other-skill` overrules it, a correction says nothing
    // for sure, anything else lets it stand (the JQ rule for "kept": they saw
    // the call and let it stand).
    if (unpicked && !(e.origin && NOT_A_TASK.has(e.origin.kind)) && e.text.trim()) {
      const was = unpicked
      unpicked = null
      if (/^\/\S/.test(e.text.trim())) {
        let names: Set<string> | null = null
        try {
          names = new Set((await $.command.list()).filter((c) => c.source !== 'builtin').map((c) => c.name))
        } catch {
          names = null
        }
        const miss = jqMissForNone(e.text, (name) => names !== null && (names.has(name) || [...names].some((n) => n.endsWith(`:${name}`))))
        if (miss) {
          const ok = await jqAppend($, outcomeEntry(was.jqId, miss.outcome, { answer: miss.answer, now: await $.clock.now() }))
          if (ok && logDecisions) $.ui.log(`[jev-skill-suggestion] JQ ${was.jqId}: none overruled (the user ran /${miss.answer})`)
        }
      }
    }
    if (offloaded && !(e.origin && NOT_A_TASK.has(e.origin.kind)) && e.text.trim()) {
      const was = offloaded
      offloaded = null
      const outcome = FOR_CLAUDE.test(e.text) ? 'overruled' : 'kept'
      const ok = await jqAppend($, outcomeEntry(was.jqId, outcome, { answer: outcome === 'overruled' ? 'claude' : undefined, now: await $.clock.now() }))
      if (ok && logDecisions) $.ui.log(`[jev-skill-suggestion] JQ ${was.jqId}: router answer ${outcome}`)
    }
    if (shown && !(e.origin && NOT_A_TASK.has(e.origin.kind)) && e.text.trim()) {
      const was = shown
      shown = null
      let names: Set<string> | null = null
      const isSkill = (name: string) => names !== null && (names.has(name) || [...names].some((n) => n.endsWith(`:${name}`)))
      try {
        if (/^\/\S/.test(e.text.trim())) names = new Set((await $.command.list()).filter((c) => c.source !== 'builtin').map((c) => c.name))
      } catch {
        names = null
      }
      const verdict = jqOutcomeFor(was.skill, e.text, isSkill)
      if (verdict) {
        const answer = verdict.outcome === 'overruled' ? verdict.answer : undefined
        const ok = await jqAppend($, outcomeEntry(was.jqId, verdict.outcome, { answer, now: await $.clock.now() }))
        if (ok && logDecisions) $.ui.log(`[jev-skill-suggestion] JQ ${was.jqId}: /${was.skill} ${verdict.outcome}${answer ? ` (the user ran /${answer})` : ''}`)
      }
    }

    // Notifications and peer messages are not tasks; a typed `/name` already
    // names its skill. Neither gets a suggestion, but a typed `/name` is what
    // the next prompt's follow-up will refer to.
    if (e.origin && NOT_A_TASK.has(e.origin.kind)) return next(e)
    if (!e.text.trim()) return next(e)
    if (/^\/\S/.test(e.text.trim())) {
      // Only a command-shaped name is remembered as the skill; a pasted path
      // ("/home/…") is still passed through untouched, with no skill.
      const typed = /^\/([\w:.-]+)(?:\s|$)/.exec(e.text.trim())
      previous = { prompt: e.text, skill: typed ? (typed[1] as string) : null }
      return next(toClaude(e))
    }
    const context = previous ? recentContextOf(previous.prompt, previous.skill) : ''

    // What this decision's calls cost, as OpenRouter reports it (null: nothing reported).
    let costUsd: number | null = null
    const addCost = (text: string) => {
      const cost = costOf(text)
      if (cost !== null) costUsd = (costUsd ?? 0) + cost
    }

    /** One request to the active backend, or null on timeout, error or a non-2xx. */
    const ask = async (
      prompt: string,
      questions: Record<string, unknown>,
      what: string,
    ): Promise<string | null> => {
      if (!active) return null
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(active, prompt, questions, modelId, context),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) {
          addCost(response.text)
          return response.text
        }
        if (response) {
          $.ui.log(`[jev-skill-suggestion] ${active} responded ${response.status} to the ${what}`)
          const outage = jevUnavailable(response.status, active, isOpenRouterUrl(url))
          if (outage && !outageReported) {
            outageReported = true
            $.ui.log(`[jev-skill-suggestion] ${outage}`)
          }
        }
        else $.ui.log(`[jev-skill-suggestion] ${what} passed ${timeoutMs}ms; no suggestion`)
      } catch (error) {
        $.ui.log(`[jev-skill-suggestion] ${what} failed: ${String(error)}`)
      }
      return null
    }

    /** A skill's file, found on disk by Claude Code's layout, or null. */
    const fileOf = async (
      skill: Skill,
      plugin: string | undefined,
    ): Promise<{ path: string; markdown: string } | null> => {
      const cached = files.get(skill.name)
      if (cached !== undefined) return cached
      let found: { path: string; markdown: string } | null = null
      try {
        const home = (await $.env.get('HOME')) ?? ''
        const relative = skillFileCandidates(skill.name, plugin)
        // The project's `.claude/` (each project root, see `findProjectRoots`)
        // and the user's.
        const projects = (roots ??= await findProjectRoots($))
        const candidates = [
          ...projects.flatMap((root) => relative.map((file) => `${root}/${file}`)),
          ...(home ? relative.map((file) => `${home}/${file}`) : []),
        ]
        // A plugin loaded from a folder (CLAUDE_CODE_PLUGIN_DIRS, --plugin-dir,
        // this mod's own) is in no installed_plugins.json: its folder is
        // named by the variable, or is this plugin's root.
        if (plugin) {
          const dirs = ((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '').split(':').filter(Boolean)
          if ($.plugin.root) dirs.push($.plugin.root)
          for (const dir of dirs) {
            const trimmed = dir.replace(/\/+$/, '')
            if (trimmed.endsWith(`/${plugin}`) || trimmed === $.plugin.root) candidates.push(...pluginFileCandidates(trimmed, skill.name, plugin))
          }
        }
        if (plugin && home) {
          const installed = `${home}/.claude/plugins/installed_plugins.json`
          if (await $.fs.exists(installed)) {
            for (const path of installPathsOf(await $.fs.read(installed), plugin)) {
              candidates.push(...pluginFileCandidates(path, skill.name, plugin))
            }
          }
        }
        // A claude.ai-synced skill sits under an account directory only
        // `$.fs.list` can name.
        if (home) {
          const synced = `${home}/.claude/skills/synced`
          if (await $.fs.exists(synced)) {
            const accounts = (await $.fs.list(synced)).filter((entry) => entry.kind === 'dir').map((entry) => entry.name)
            candidates.push(...syncedFileCandidates(home, accounts, skill.name))
          }
        }
        for (const file of candidates) {
          if (await $.fs.exists(file)) {
            found = { path: file, markdown: await $.fs.read(file) }
            break
          }
        }
      } catch (error) {
        $.ui.log(`[jev-skill-suggestion] could not read /${skill.name}: ${String(error)}`)
      }
      files.set(skill.name, found)
      return found
    }
    /** The opening of a skill's body, or null when its file is nowhere. */
    const bodyOf = async (skill: Skill, plugin: string | undefined): Promise<string | null> =>
      (await fileOf(skill, plugin))?.markdown ?? null

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-skill-suggestion] provider "${forced}" has no key set; using the built-in classifier`)
    }

    let commands: Awaited<ReturnType<typeof $.command.list>>
    try {
      commands = await $.command.list()
      if (!displayToId && commands.some((command) => !commandLike(command.name))) {
        const found: { dir: string; markdown: string }[] = []
        for (const root of [...((roots ??= await findProjectRoots($))), (await $.env.get('HOME')) ?? '']) {
          const dir = root && `${root}/.claude/skills`
          if (!dir || !(await $.fs.exists(dir))) continue
          for (const entry of await $.fs.list(dir)) {
            const file = `${dir}/${entry.name}/SKILL.md`
            if (entry.kind === 'dir' && (await $.fs.exists(file))) found.push({ dir: entry.name, markdown: await $.fs.read(file) })
          }
        }
        displayToId = displayIds(found)
      }
      commands = canonical(commands, displayToId ?? new Map())
    } catch (error) {
      $.ui.log(`[jev-skill-suggestion] could not list the skills: ${String(error)}`)
      await record($, skippedDecision(e.text, 0, `could not list the skills: ${String(error).slice(0, 120)}`), logDecisions)
      return next(toClaude(e))
    }
    // Loading the skill itself, the mod is not bound to what the engine would
    // list: a skill hidden with skillOverrides is still a candidate.
    const skills = catalog(commands, injectContent ? new Set() : listed, neverSuggested)
    if (skills.length === 0) {
      if (logDecisions) $.ui.log('[jev-skill-suggestion] no candidate skills; nothing to suggest')
      await record($, skippedDecision(e.text, 0, 'no candidate skills'), logDecisions)
      return next(toClaude(e))
    }
    const pluginOf = new Map(commands.map((command) => [command.name, command.plugin]))

    // Request 1: rank everything, and ask whether the prompt wants a skill at all.
    const startedAt = await $.clock.now()
    let wide: Wide | null = null
    let route: Route | null = null
    let decidedBy = 'jev'
    // The router's questions ride on this request only for a prompt the user typed while idle.
    const routing = offloadOn && arm === 'on' && !e.turnId
    if (active) {
      const answer = await ask(e.text, wideQuestions(active, skills, routing), 'ranking')
      if (answer) wide = readWide(answer)
      if (answer && routing) route = readRoute(answer)
    }
    // Jev gave no answer (no key, error or timeout): the backup chat model
    // answers the built-in classifier's question. One label, no gate, no rerank.
    if (!wide && fallbackKey) {
      // Out of credit (402) on the paid backup: the same question to a free
      // model (rate-limited by OpenRouter, but zero-cost).
      for (const model of [fallbackModel, fallbackFreeModel]) {
        decidedBy = `backup ${model}`
        try {
          const response = await Promise.race([
            $.http.fetch(fallbackUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...authHeader(fallbackKey) },
              body: fallbackBody(e.text, skills, model, context),
            }),
            $.clock.sleep(Math.max(timeoutMs, 3000)),
          ])
          if (response && response.ok) {
            addCost(response.text)
            wide = builtinWide(readFallback(response.text, skills))
          }
          else if (response) $.ui.log(`[jev-skill-suggestion] backup ${model} responded ${response.status}`)
          else $.ui.log(`[jev-skill-suggestion] backup ${model} timed out`)
          if (!response || response.status !== 402 || !fallbackFreeModel || model === fallbackFreeModel) break
          $.ui.log('[jev-skill-suggestion] out of OpenRouter credit; asking a free model')
        } catch (error) {
          $.ui.log(`[jev-skill-suggestion] backup failed: ${String(error)}`)
          break
        }
      }
    }
    if (!wide) {
      // Last resort: the engine's own small-model classifier answers the same
      // question, with the descriptions folded into the text it reads. One
      // label, no gate, no rerank.
      decidedBy = 'built-in classifier'
      try {
        const label = await $.model.classify(classifyText(e.text, skills, context), [
          NONE,
          ...skills.map((skill) => skill.name),
        ])
        wide = builtinWide(label)
      } catch (error) {
        $.ui.log(`[jev-skill-suggestion] built-in classifier failed: ${String(error)}`)
      }
    }
    // What the decision model actually answered, whatever the policy then
    // does with it. This is the line that proves the ranking ran.
    const wideMs = (await $.clock.now()) - startedAt
    if (logDecisions) {
      $.ui.log(`[jev-skill-suggestion] ${decidedBy}: ${describeWide(wide, skills.length, wideMs)}`)
    }

    // Request 2: re-read the shortlist with each skill's full text, and let
    // every candidate be rejected on its own.
    let rerank: Rerank | null = null
    let rerankAttempted = false
    let rerankMs: number | null = null
    // Before the listing has been seen, `$.command.list()` may name a skill
    // the model is not allowed to invoke; its own frontmatter tells.
    const barred: string[] = []
    if (active && decidedBy === 'jev' && rerankEnabled && wide && passesGate(wide, policy)) {
      const candidates: Candidate[] = []
      for (const skill of shortlistOf(wide, skills, policy.shortlist)) {
        const body = await bodyOf(skill, pluginOf.get(skill.name))
        if (!modelInvocable(body)) {
          barred.push(skill.name)
          continue
        }
        candidates.push({ ...skill, detail: detailOf(skill, body, excerptChars) })
      }
      if (candidates.length > 0) {
        const rerankStartedAt = await $.clock.now()
        rerankAttempted = true
        const answer = await ask(e.text, rerankQuestions(active, candidates), 'rerank')
        if (answer) rerank = readRerank(answer)
        rerankMs = (await $.clock.now()) - rerankStartedAt
        if (logDecisions) {
          const ms = rerankMs
          const read = candidates.filter((candidate) => files.get(candidate.name)).length
          $.ui.log(
            `[jev-skill-suggestion] jev: ${describeRerank(rerank, ms)} · ${read}/${candidates.length} bodies read`,
          )
        }
      }
    }

    const offered = barred.length > 0 ? skills.filter((skill) => !barred.includes(skill.name)) : skills
    let decision = decide(wide, rerank, offered, policy, rerankAttempted)
    // The probability the decision rested on, for the judgement quotient.
    let jq = jqConfidence(wide, rerank, offered, policy, rerankAttempted, decision)
    let pick = decision.name ? (skills.find((skill) => skill.name === decision.name) ?? null) : null
    // The winner's own frontmatter has the last word, whichever path picked it.
    if (pick && !barred.includes(pick.name) && !modelInvocable(await bodyOf(pick, pluginOf.get(pick.name)))) {
      barred.push(pick.name)
      decision = { name: null, reason: `/${pick.name} has disable-model-invocation` }
      pick = null
      // A rule, not a judgment: nothing to score.
      jq = null
    }
    if (logDecisions && barred.length > 0) {
      $.ui.log(
        `[jev-skill-suggestion] not model-invocable, left out: ${barred.map((name) => `/${name}`).join(', ')}`,
      )
    }
    // A row in the transcript scrolls away; this line stays on screen.
    if (logDecisions) $.ui.status(describeStatus(pick?.name ?? null, decidedBy))
    if (logDecisions) {
      $.ui.log(
        pick
          ? `[jev-skill-suggestion] suggesting /${pick.name}: ${decision.reason}`
          : `[jev-skill-suggestion] no suggestion: ${decision.reason}`,
      )
    }

    suggested = pick?.name ?? null
    previous = { prompt: e.text, skill: suggested }
    // One JQ record per decision: the pick, or "none", with its probability.
    // Nothing when the decision rested on no probability (see jqConfidence).
    const jqEntry = jq
      ? decisionEntry(
          { tool: 'jev-skill-suggestion', question: 'skill', answer: pick?.name ?? 'none', confidence: jq.confidence, decidedBy, basis: jq.basis },
          { now: await $.clock.now() },
        )
      : null
    const jqId = (await jqAppend($, jqEntry)) && jqEntry ? jqEntry.id : null
    // A pick with a stated probability is shown to the user in Claude's reply,
    // so what they do next is a verdict on a call they saw.
    const line = pick && jq ? jevLine(pick.name, jq.confidence) : null
    shown = pick && line && jqId ? { skill: pick.name, jqId } : null
    unpicked = !pick && jqId ? { jqId } : null
    let block: string | null
    if (injectContent && pick) {
      const file = await fileOf(pick, pluginOf.get(pick.name))
      const projectDir = await $.session.cwd()
      block = injectionBlock(pick, file?.markdown ?? null, file?.path ?? null, projectDir, injected.has(pick.name))
      if (logDecisions) {
        $.ui.log(
          file
            ? injected.has(pick.name)
              ? `[jev-skill-suggestion] /${pick.name} already injected this session; named again`
              : `[jev-skill-suggestion] injected /${pick.name} from ${file.path} (${file.markdown.length} characters)`
            : `[jev-skill-suggestion] no file found for /${pick.name}; suggested by name only`,
        )
      }
      if (file) injected.add(pick.name)
    } else {
      block = suggestionBlock(pick, hideListing)
    }
    await record($, {
      kind: 'jev.decision',
      decidedBy,
      provider: decidedBy === 'jev' ? active : null,
      via:
        decidedBy === 'jev'
          ? isOpenRouterUrl(url) ? 'openrouter' : (active ?? 'builtin')
          : decidedBy.startsWith('backup ') ? (isOpenRouterUrl(fallbackUrl) ? 'openrouter' : 'backup') : 'builtin',
      model: decidedBy === 'jev' ? modelId || null : decidedBy.startsWith('backup ') ? decidedBy.slice(7) : null,
      promptChars: e.text.length,
      withContext: context !== '',
      candidates: skills.length,
      gate: wide?.gate ?? null,
      top: (wide?.ranked ?? []).slice(0, 3),
      rerank,
      pick: pick?.name ?? null,
      reason: decision.reason,
      wideMs,
      rerankMs,
      injected: injectContent && pick !== null,
      jqId,
      costUsd,
    }, logDecisions)
    if (routing && decidedBy === 'jev') {
      const verdict = offloadable(route, e.text, { pickedSkill: pick !== null, attachments: Boolean(e.attachments?.length) })
      if (logDecisions) $.ui.log(`[jev-skill-suggestion] router: ${verdict.ok ? 'answering without Claude' : 'Claude answers'} (${verdict.reason})`, { to: verdict.ok ? 'transcript' : 'debug' })
      const answer = verdict.ok && route ? await offload($, e.text, route, offloadTimeoutMs, logDecisions) : null
      if (verdict.ok && logDecisions) $.ui.status(answer ? `Jev: answered by ${answer.model} (${answer.via})` : describeStatus(pick?.name ?? null, decidedBy))
      if (answer) {
        const entry = decisionEntry(
          { tool: 'jev-skill-suggestion', question: 'offload', answer: 'router', confidence: 1 - (route?.needsTools ?? 1), decidedBy },
          { now: await $.clock.now() },
        )
        offloaded = (await jqAppend($, entry)) && entry ? { jqId: entry.id } : null
        routerAnswers.push({ prompt: e.text, text: answer.text, model: answer.model })
        // Not entered: the answer is shown in place of Claude's turn, as the
        // drop reason, which the apps show too (a ui.log line doesn't reach them).
        const shownAnswer = offloadShown(answer)
        return { drop: shownAnswer.shown }
      }
    }
    if (block) block = withJevLine(block, line)
    if (!block) return next(toClaude(e))
    // Attached on the way down: one block after the prompt as typed, read by
    // the model and never shown to the person.
    return next(toClaude({ ...e, context: [...(e.context ?? []), block] }))
  })

  // An injected skill lives in the conversation, not the process: `/clear`
  // or a resume starts another under the same worker, and a compaction may
  // summarize the block away. Either way the next pick goes in whole again.
  on('session.end', async ($, e, next) => {
    injected.clear()
    roots = null
    files.clear()
    suggested = null
    previous = null
    shown = null
    unpicked = null
    routerAnswers = []
    offloaded = null
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    if (!e.agentId) injected.clear()
    return next(e)
  })

  // The setup's prompt, written for `/jev-skill-suggestion:setup` and for the
  // project's `/jev` shortcut (`.claude/commands/jev.md`) alike.
  on('skill.prompt', async ($, e, next) => {
    if (e.skill !== SETUP_COMMAND && e.skill !== SETUP_ALIAS) {
      // Observation only: whether the model took the suggestion, or reached for
      // a skill it was never told about, is the one measure of this mod's worth.
      if (logDecisions) {
        const how =
          suggested === e.skill
            ? 'as suggested'
            : suggested
              ? `suggested was /${suggested}`
              : 'nothing was suggested'
        $.ui.log(`[jev-skill-suggestion] skill /${e.skill} loaded (${how})`)
      }
      await record($, { kind: 'jev.skill_load', skill: e.skill, suggested, asSuggested: suggested === e.skill }, logDecisions)
      return next(e)
    }
    // The plugin's own setup command: its markdown is a placeholder, and the
    // prompt the model reads is written here, from the roster as the engine
    // has it and the user settings as they are. The model does the editing
    // with its own tools, so the change shows as a diff and asks permission.
    const mode = /\brestore\b/i.test(e.text) ? 'restore' : 'apply'
    // No plan from a partial roster or unreadable settings: the edit would
    // hide too little, and the backup would save the wrong values.
    let commands: Awaited<ReturnType<typeof $.command.list>> = []
    try {
      commands = await $.command.list()
      if (!displayToId && commands.some((command) => !commandLike(command.name))) {
        const found: { dir: string; markdown: string }[] = []
        for (const root of [...((roots ??= await findProjectRoots($))), (await $.env.get('HOME')) ?? '']) {
          const dir = root && `${root}/.claude/skills`
          if (!dir || !(await $.fs.exists(dir))) continue
          for (const entry of await $.fs.list(dir)) {
            const file = `${dir}/${entry.name}/SKILL.md`
            if (entry.kind === 'dir' && (await $.fs.exists(file))) found.push({ dir: entry.name, markdown: await $.fs.read(file) })
          }
        }
        displayToId = displayIds(found)
      }
      commands = canonical(commands, displayToId ?? new Map())
    } catch (error) {
      $.ui.log(`[jev-skill-suggestion] setup: could not list the skills: ${String(error)}`)
      return next({ ...e, text: setupAborted(`the skills could not be listed (${String(error)})`) })
    }
    const home = (await $.env.get('HOME')) ?? '~'
    const settingsPath = `${home}/.claude/settings.json`
    const backupPath = `${home}/.claude/jev-skill-suggestion.skill-overrides.backup.json`
    let json: string | null = null
    try {
      if (await $.fs.exists(settingsPath)) json = await $.fs.read(settingsPath)
    } catch (error) {
      $.ui.log(`[jev-skill-suggestion] setup: could not read ${settingsPath}: ${String(error)}`)
      return next({ ...e, text: setupAborted(`${settingsPath} exists but could not be read (${String(error)})`) })
    }
    const settings = readSkillSettings(json)
    const plan = setupPlan(commands, settings, new Set([SETUP_COMMAND, SETUP_ALIAS]))
    // An earlier run's backup is reused only if it is one: a file that is
    // not this mod's, or is corrupt, is nothing restore could apply, so no
    // setup is built on top of it.
    let backupExists = false
    try {
      backupExists = await $.fs.exists(backupPath)
      if (backupExists && !validBackup(await $.fs.read(backupPath))) {
        $.ui.log(`[jev-skill-suggestion] setup: ${backupPath} is not a valid backup`)
        return next({
          ...e,
          text: setupAborted(
            `${backupPath} exists but is not a backup this mod wrote (expected {"skillOverrides": {...}, "disableBundledSkills": true|false|null}); ask the user to inspect it and move it away, or fix it, before running the setup again`,
          ),
        })
      }
    } catch (error) {
      $.ui.log(`[jev-skill-suggestion] setup: could not read ${backupPath}: ${String(error)}`)
      return next({ ...e, text: setupAborted(`${backupPath} could not be read (${String(error)})`) })
    }
    if (logDecisions) {
      $.ui.log(
        `[jev-skill-suggestion] setup (${mode}): ${plan.hide.length} to hide, ${plan.alreadyHidden.length} already hidden, ${plan.locked.length} locked by a plugin`,
      )
    }
    return next({ ...e, text: setupInstructions(mode, plan, settings, settingsPath, backupPath, backupExists) })
  })
}
