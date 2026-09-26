/**
 * usage-telemetry — turns Claude Code's own records into flat usage events.
 *
 * Sources, all already on disk:
 *   ~/.claude/projects/<project>/<session>.jsonl        the main conversation
 *   ~/.claude/projects/<project>/<session>/subagents/…  every subagent and workflow agent,
 *                                                       with an agent-<id>.meta.json naming its type
 *   ~/.claude/jev-log/<session>.jsonl                   Jev's skill decisions (jev-skill-suggestion)
 *   ~/.claude/jev-log/router.jsonl                      model-router's OpenRouter calls
 *
 * Every event has a stable `id`, so reading a line twice, or shipping an
 * event twice, only ever overwrites it. Prompt and tool text is never kept:
 * names, counts, tokens and timings only.
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const PRICES = JSON.parse(readFileSync(join(here, 'prices.json'), 'utf8')).claude

/** The price row for a Claude model id, by its longest matching prefix, or null. */
export function priceOf(model, prices = PRICES) {
  if (!model) return null
  const key = Object.keys(prices)
    .filter((prefix) => model === prefix || model.startsWith(`${prefix}-`) || model.startsWith(`${prefix}@`))
    .sort((a, b) => b.length - a.length)[0]
  return key ? prices[key] : null
}

/**
 * What one API response would cost at API list prices, in USD, or null for
 * a model with no price. On a subscription this is what the same work would
 * have cost on the API, not a bill.
 */
export function costOf(model, usage, prices = PRICES) {
  const price = priceOf(model, prices)
  if (!price || !usage) return null
  const fast = usage.speed === 'fast' && price.fastInput
  const input = fast ? price.fastInput : price.input
  const output = fast ? price.fastOutput : price.output
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const fiveMin = usage.cache_creation
    ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0)
    : (usage.cache_creation_input_tokens ?? 0)
  const dollars =
    (usage.input_tokens ?? 0) * input +
    fiveMin * input * 1.25 +
    oneHour * input * 2 +
    (usage.cache_read_input_tokens ?? 0) * input * price.cacheRead +
    (usage.output_tokens ?? 0) * output
  return dollars / 1e6
}

/** `mcp__Server_Name__tool` → `Server_Name`; null for a built-in tool. */
export function mcpServerOf(tool) {
  const match = /^mcp__(.+?)__/.exec(tool ?? '')
  return match ? match[1] : null
}

/**
 * Where a transcript file sits: its session, and for a subagent its id.
 * `<project>/<session>.jsonl` is a main conversation;
 * `<project>/<session>/subagents/[…/]agent-<id>.jsonl` a subagent's.
 */
export function transcriptOf(path, projectsDir) {
  const rel = path.slice(projectsDir.length).replace(/^[\\/]+/, '').split(/[\\/]/)
  const file = rel.at(-1) ?? ''
  if (rel.length === 2 && file.endsWith('.jsonl')) return { project: rel[0], session: file.slice(0, -6), agentId: null }
  const agent = /^agent-(.+)\.jsonl$/.exec(file)
  if (rel.length >= 4 && rel[2] === 'subagents' && agent) return { project: rel[0], session: rel[1], agentId: agent[1] }
  return null
}

/**
 * Why the Skill tool refused, as a category (the message itself is not
 * kept): 'not-installed' (no such skill in this chat), 'blocked'
 * (disabled, denied or not allowed), or 'failed' (anything else).
 */
export function skillRefusalOf(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ') : ''
  if (/unknown skill|not found|no skill named/i.test(text)) return 'not-installed'
  if (/disabled|denied|not allowed|blocked|refus|permission/i.test(text)) return 'blocked'
  return 'failed'
}

/** Skill named by a typed `/name` in a user message, or null. */
export function slashCommandOf(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : ''
  const match = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text)
  return match ? match[1] : null
}

/** The skill a `<skill_relevance>` block (Jev's pick) named, or null. */
export function suggestedSkillOf(text) {
  const match = /Relevant to the current request:\s*([^\s.]+(?:\.[^\s.]+)*)\./.exec(String(text ?? ''))
  return match ? match[1] : null
}

/**
 * What kind of work a request asks for, from its words alone: the first rule
 * that matches wins, so the order matters. Only the category is kept, never
 * the text. Coarse on purpose: good enough to see which kinds of work a model
 * handles well, and the same for every model, so the comparison is fair.
 */
export const REQUEST_RULES = [
  ['fix', /\b(fix|bug|broken|error|fail(s|ed|ing)?|crash|not working|doesn'?t work|isn'?t working|debug|stack ?trace|exception)\b/i],
  ['review', /\b(review|audit|check (the|my|this)|look over|critique|security review|code review)\b/i],
  ['ship', /\b(merge|pull request|\bpr\b|commit|push|deploy|release|ci\b|pipeline|branch)\b/i],
  ['setup', /\b(set ?up|install|configure|config|environment|settings|permission|hook|plugin|connector|mcp|api key|credential)\b/i],
  ['design', /\b(design|layout|ui\b|ux\b|mockup|figma|canva|slide|deck|poster|landing page|visual|diagram|flowchart|chart|dashboard)\b/i],
  ['data', /\b(analy[sz]e|analytics|data|metrics|report|spreadsheet|csv|sql|query|forecast|trend|numbers|spend|budget)\b/i],
  ['build', /\b(build|create|make|implement|add|write (a|the|some) (script|function|component|test|app|page)|scaffold|generate|code)\b/i],
  ['writing', /\b(write|draft|rewrite|email|post|copy|blog|summar(y|ise|ize)|tone|message)\b/i],
  ['research', /\b(how (do|does|can|to)|what (is|are|does)|why|explain|find|search|look up|compare|which|research)\b/i],
]

export function classifyRequest(text) {
  const t = String(text ?? '')
  for (const [category, pattern] of REQUEST_RULES) if (pattern.test(t)) return category
  return t.length < 60 ? 'reply' : 'other'
}

/**
 * Whether a message reads as the person correcting or pushing back on the
 * previous answer. A heuristic, stated as one on the dashboard: it is the
 * only signal of "that did not land" a transcript carries.
 */
export function looksLikeCorrection(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  return /^(no\b|nope|wrong|not (that|what)|that'?s (not|wrong)|stop\b|why (the fuck|tf|is|isn'?t|did|didn'?t|are)|wtf|what the)/i.test(t) ||
    /\b(still (not|broken|failing|doesn'?t|isn'?t|wrong)|doesn'?t work|isn'?t working|not working|didn'?t work|you (didn'?t|missed|forgot|ignored)|i (already|just) (said|told)|that is what i said|how is that not clear|fuck|wtf|\?{3,})/i.test(t)
}

/** A user message's own words, or null for tool results and system-inserted turns. */
export function promptText(content) {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : ''
  const trimmed = text.trim()
  if (!trimmed) return null
  // Notifications, reminders and hook output are inserted as user turns.
  if (/^<(task-notification|system-reminder|local-command|bash-|user-memory|command-message)/.test(trimmed) && !/<command-name>/.test(trimmed)) return null
  return trimmed
}

/**
 * The project a session belongs to: the folder it started in. A session
 * started in the home folder has no project, so it reads "~" rather than the
 * user's name (`/home/user` used to show as a project called "user").
 */
export function projectLabel(cwd, home = null) {
  if (!cwd) return null
  const clean = String(cwd).replace(/[\\/]+$/, '')
  if (home && clean === String(home).replace(/[\\/]+$/, '')) return '~'
  return basename(clean) || null
}

const base = (fields) => ({
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: null,
  tool: null,
  skill: null,
  mcp_server: null,
  ok: null,
  data: {},
  ...fields,
})

/**
 * Reads one transcript's new lines into events.
 *
 * `ctx`: { session, project, agentId, agentType, host, startCwd, home } for
 * the file. The project is where the session started (`startCwd`, the main
 * transcript's first `cwd`), not where the shell happens to be: a `cd` moves
 * every later line's `cwd`. The caller keeps `ctx.startCwd` between runs and
 * hands a subagent its session's, so both carry the same project.
 * `pending`: tool uses seen without their result yet, by tool_use id; carried
 * between runs, so a tool is recorded once, with whether it failed.
 * Returns the events; `pending` is updated in place.
 */
export function eventsFromTranscript(lines, ctx, pending = {}) {
  const events = []
  const api = new Map()
  const agent = ctx.agentId ? `subagent:${ctx.agentType ?? 'unknown'}` : 'main'
  const common = (line) => {
    if (!ctx.startCwd && line.cwd) ctx.startCwd = line.cwd
    return {
      ts: line.timestamp ?? null,
      session: line.sessionId ?? ctx.session,
      host: ctx.host,
      project: ctx.startCwd ? projectLabel(ctx.startCwd, ctx.home) : ctx.project,
      agent,
    }
  }
  for (const raw of lines) {
    let line
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    if (line.type === 'assistant' && line.message) {
      const message = line.message
      // One API response is written as several lines (one per content block),
      // each carrying the same usage: the last one wins.
      if (message.id && message.usage && message.model && message.model !== '<synthetic>') {
        const usage = message.usage
        api.set(
          message.id,
          base({
            id: `api:${message.id}`,
            kind: 'api',
            ...common(line),
            model: message.model,
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_tokens: usage.cache_read_input_tokens ?? 0,
            cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
            cost_usd: costOf(message.model, usage),
            data: {
              speed: usage.speed ?? null,
              thinking_tokens: usage.output_tokens_details?.thinking_tokens ?? null,
              web_searches: usage.server_tool_use?.web_search_requests || null,
              effort: line.effort ?? null,
              entrypoint: line.entrypoint ?? null,
            },
          }),
        )
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== 'tool_use') continue
        const input = block.input ?? {}
        pending[block.id] = base({
          id: `tool:${block.id}`,
          kind: 'tool',
          ...common(line),
          model: message.model ?? null,
          tool: block.name,
          skill: block.name === 'Skill' ? (input.skill ?? null) : null,
          mcp_server: mcpServerOf(block.name),
          data: {
            ...(block.name === 'Agent' || block.name === 'Task'
              ? { subagent_type: input.subagent_type ?? 'general-purpose', background: input.run_in_background !== false, description: input.description ?? null }
              : {}),
            ...(block.name === 'Workflow' ? { workflow: input.name ?? 'inline' } : {}),
          },
        })
      }
    } else if (line.type === 'user' && line.message) {
      const content = line.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result' || !pending[block.tool_use_id]) continue
          const use = pending[block.tool_use_id]
          delete pending[block.tool_use_id]
          const done = line.timestamp && use.ts ? Date.parse(line.timestamp) - Date.parse(use.ts) : null
          const refusal = use.tool === 'Skill' && block.is_error === true ? skillRefusalOf(block.content) : null
          events.push({ ...use, ok: block.is_error !== true, data: { ...use.data, ms: Number.isFinite(done) ? done : null, ...(refusal ? { refusal } : {}) } })
        }
      }
      // A person's prompt (not a tool result): counted, its kind of work and
      // whether it pushes back on the last answer kept, the words dropped.
      const text = !ctx.agentId && !line.isMeta ? promptText(content) : null
      if (text !== null && line.uuid) {
        // Held locally for the miss detector (misses.mjs); never shipped.
        if (ctx.promptTexts) ctx.promptTexts[line.uuid] = text
        const slash = slashCommandOf(content)
        events.push(base({
          id: `prompt:${line.uuid}`,
          kind: 'prompt',
          ...common(line),
          skill: slash,
          data: { slash: Boolean(slash), category: slash ? 'command' : classifyRequest(text), correction: looksLikeCorrection(text), chars: text.length },
        }))
      }
    } else if (line.type === 'attachment' && line.attachment?.type === 'hook_additional_context' && line.uuid) {
      const text = [].concat(line.attachment.content ?? []).join('\n')
      const skill = suggestedSkillOf(text)
      if (skill) events.push(base({ id: `suggested:${line.uuid}`, kind: 'jev.suggested', ...common(line), skill }))
    }
  }
  return [...api.values(), ...events]
}

/** Tool uses left without a result (the session ended, or the call is still running). */
export function flushPending(pending) {
  const events = Object.values(pending).map((use) => ({ ...use, ok: null }))
  for (const key of Object.keys(pending)) delete pending[key]
  return events
}

/** One line of a jev-log file (decisions, skill loads, router calls) as an event. */
export function eventFromLog(raw, host) {
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    return null
  }
  const common = { ts: record.ts ?? null, session: record.session ?? null, host, project: null, agent: 'main' }
  if (record.kind === 'jev.decision') {
    return base({
      id: `jev:${record.session}:${record.ts}`,
      kind: 'jev.decision',
      ...common,
      model: record.model ?? null,
      cost_usd: Number.isFinite(record.costUsd) ? record.costUsd : null,
      skill: record.pick ?? null,
      ok: record.pick !== null,
      data: {
        decidedBy: record.decidedBy,
        provider: record.provider,
        via: record.via ?? null,
        gate: record.gate,
        top: record.top,
        rerank: record.rerank,
        reason: record.reason,
        candidates: record.candidates,
        wideMs: record.wideMs,
        rerankMs: record.rerankMs,
        injected: record.injected,
      },
    })
  }
  if (record.kind === 'jev.arm' && ['on', 'no-router', 'off'].includes(record.arm)) {
    return base({ id: `jevarm:${record.session}`, kind: 'jev.arm', ...common, data: { arm: record.arm, shares: record.shares ?? null } })
  }
  if (record.kind === 'jev.skill_load') {
    return base({
      id: `jevload:${record.session}:${record.ts}:${record.skill}`,
      kind: 'jev.skill_load',
      ...common,
      skill: record.skill,
      ok: record.asSuggested,
      data: { suggested: record.suggested },
    })
  }
  if (record.kind === 'router.call') {
    return base({
      id: `router:${record.generationId ?? `${record.session}:${record.ts}`}`,
      kind: 'router.call',
      ...common,
      model: record.model ?? record.requested,
      input_tokens: record.promptTokens,
      output_tokens: record.completionTokens,
      cost_usd: record.costUsd,
      ok: !record.error,
      data: {
        category: record.category,
        prefer: record.prefer,
        via: record.via,
        tried: record.tried,
        decidedBy: record.decidedBy,
        requested: record.requested,
        fallbackFrom: record.fallbackFrom,
        offload: Boolean(record.offload),
        outOfCredit: record.outOfCredit,
        truncated: record.truncated,
        ms: record.ms,
        error: record.error,
      },
    })
  }
  return null
}

/**
 * One line of a judgement-quotient (JQ) log (jev-skill-suggestion's
 * jq-log.mjs format) as an event: a decision with its tool, answer and
 * stated confidence, or an outcome (kept, overruled, asked). The question is
 * never sent: it can hold the prompt's words.
 */
export function eventFromJq(raw, host) {
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    return null
  }
  const id = typeof record?.id === 'string' && /^[0-9a-f]{4,32}$/i.test(record.id) ? record.id : null
  const ts = Number.isFinite(record?.t) ? new Date(record.t).toISOString() : null
  if (!id || !ts) return null
  const common = { ts, session: null, host, project: null, agent: null }
  if (record.kind === 'decision') {
    const confidence = Number.isFinite(record.confidence) ? record.confidence : null
    return base({
      id: `jq:${id}`,
      kind: 'jq.decision',
      ...common,
      tool: typeof record.tool === 'string' ? record.tool.slice(0, 80) : null,
      data: { jq: id, answer: record.answer === undefined || record.answer === null ? null : String(record.answer).slice(0, 80), confidence, decidedBy: typeof record.decidedBy === 'string' ? record.decidedBy.slice(0, 80) : null },
    })
  }
  if (record.kind === 'outcome' && ['kept', 'overruled', 'asked'].includes(record.outcome)) {
    return base({ id: `jqo:${id}:${record.t}`, kind: 'jq.outcome', ...common, ok: record.outcome === 'kept', data: { jq: id, outcome: record.outcome } })
  }
  return null
}

/** Where JQ logs live, by jq-log.mjs's rule: JQ_LOG_FILE, the shared project folder, ~/.jq. */
export function jqLogPaths(env, home) {
  if (env.JQ_LOG === 'off') return []
  return [...new Set([env.JQ_LOG_FILE, '/mnt/project-files/judgement-quotient/decisions.jsonl', home ? join(home, '.jq', 'decisions.jsonl') : null].filter(Boolean))]
}

/** OpenRouter's /key answer as one snapshot event per key per hour. */
export function keySnapshot(key, credits, host, now = new Date()) {
  const hour = now.toISOString().slice(0, 13)
  return base({
    id: `orkey:${key.label ?? 'key'}:${hour}`,
    kind: 'openrouter.key',
    ts: now.toISOString(),
    session: null,
    host,
    project: null,
    agent: null,
    cost_usd: key.usage ?? null,
    data: {
      label: key.label ?? null,
      limit: key.limit ?? null,
      limit_reset: key.limit_reset ?? null,
      limit_remaining: key.limit_remaining ?? null,
      usage_daily: key.usage_daily ?? null,
      usage_weekly: key.usage_weekly ?? null,
      usage_monthly: key.usage_monthly ?? null,
      free_daily: key.free_model_daily_requests ?? null,
      is_free_tier: key.is_free_tier ?? null,
      expires_at: key.expires_at ?? null,
      total_credits: credits?.total_credits ?? null,
      total_usage: credits?.total_usage ?? null,
    },
  })
}

/** Keeps the last copy of each event id, in first-seen order. */
export function dedupe(events) {
  const byId = new Map()
  for (const event of events) byId.set(event.id, event)
  return [...byId.values()]
}
