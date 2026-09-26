/**
 * Finds likely Jev misroutes so they can become routing test cases.
 *
 * Each finished turn (a prompt whose next prompt exists) is checked against
 * the Jev decision made for it and what happened next:
 *
 *   typed-after           you typed /S on the next prompt, and Jev had not picked S
 *   claude-loaded-other   Claude loaded skill S itself during the turn, Jev had not picked S
 *   picked-then-corrected Jev picked a skill and your next message pushed back
 *   dropped-decisive      Jev ranked a skill >= 0.9 first, then suggested nothing
 *
 * The prompt's words never leave this machine. A flagged turn becomes two
 * records: a `jev.miss` event with no text (signal, Jev's pick, its top
 * three, the skill that looks right), shipped like any other event; and a
 * local line in ~/.claude/usage-telemetry/misses.jsonl with the words and
 * the previous prompt's, which a session on this machine turns into test
 * cases. Local lines older than 7 days are dropped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const DECISIVE = 0.9
const MATCH_MS = 120_000
const KEEP = 50
const WEEK_MS = 7 * 86400000

const trim = (list) => list.slice(-KEEP)

/**
 * Folds this run's events into the per-session detector state (kept in the
 * collector's local state file). `promptTexts` maps prompt uuid → words.
 */
export function remember(state, events, promptTexts = {}) {
  for (const event of events) {
    if (!event.session || !event.ts) continue
    const s = (state[event.session] ??= { prompts: [], decisions: [], loads: [], checked: [] })
    const t = Date.parse(event.ts)
    if (event.kind === 'prompt' && event.agent === 'main') {
      const uuid = event.id.slice('prompt:'.length)
      if (s.prompts.some((p) => p.uuid === uuid)) continue
      s.prompts = trim([...s.prompts, { uuid, t, text: promptTexts[uuid] ?? null, slash: event.skill ?? null, correction: Boolean(event.data?.correction) }].sort((a, b) => a.t - b.t))
    } else if (event.kind === 'jev.decision' || event.kind === 'jev.suggested') {
      if (s.decisions.some((d) => d.id === event.id)) continue
      s.decisions = trim([...s.decisions, { id: event.id, t, pick: event.skill ?? null, full: event.kind === 'jev.decision', top: event.data?.top ?? [], gate: event.data?.gate ?? null, reason: event.data?.reason ?? null }].sort((a, b) => a.t - b.t))
    } else if (event.kind === 'tool' && event.tool === 'Skill' && event.skill) {
      s.loads = trim([...s.loads, { t, skill: event.skill, ok: event.ok !== false }])
    }
  }
  return state
}

/** The decision made for a prompt: the closest within two minutes, a full decision over a transcript suggestion. */
export function decisionFor(decisions, prompt) {
  const near = decisions.filter((d) => Math.abs(d.t - prompt.t) <= MATCH_MS)
  near.sort((a, b) => Number(b.full) - Number(a.full) || Math.abs(a.t - prompt.t) - Math.abs(b.t - prompt.t))
  return near[0] ?? null
}

/** The signal a finished turn raises, or null. */
export function judgeTurn(prompt, next, decision, loads) {
  if (!decision || prompt.slash) return null
  const pick = decision.pick
  if (next.slash && next.slash !== pick) return { signal: 'typed-after', expected: next.slash }
  const own = loads.find((l) => l.ok && l.t >= prompt.t && l.t < next.t && l.skill !== pick)
  if (own) return { signal: 'claude-loaded-other', expected: own.skill }
  if (pick && next.correction) return { signal: 'picked-then-corrected', expected: null }
  const top = decision.top?.[0]
  if (!pick && top && (top.probability ?? 0) >= DECISIVE) return { signal: 'dropped-decisive', expected: top.name }
  return null
}

/**
 * Checks every finished turn not checked before. Returns `{ events, local }`:
 * the text-free `jev.miss` events to ship, and the local lines with words.
 */
export function detectMisses(state, host, now = Date.now()) {
  const events = []
  const local = []
  for (const [session, s] of Object.entries(state)) {
    for (let i = 0; i + 1 < s.prompts.length; i++) {
      const prompt = s.prompts[i]
      if (s.checked.includes(prompt.uuid)) continue
      s.checked = trim([...s.checked, prompt.uuid])
      const decision = decisionFor(s.decisions, prompt)
      const verdict = judgeTurn(prompt, s.prompts[i + 1], decision, s.loads)
      if (!verdict) continue
      const ts = new Date(prompt.t).toISOString()
      const details = {
        signal: verdict.signal,
        jevPick: decision.pick,
        top: (decision.top ?? []).slice(0, 3),
        gate: decision.gate,
        reason: decision.reason,
      }
      events.push({
        id: `miss:${prompt.uuid}`, kind: 'jev.miss', ts, session, host, project: null, agent: 'main',
        model: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
        cost_usd: null, tool: null, skill: verdict.expected, mcp_server: null, ok: false, data: details,
      })
      if (prompt.text) {
        const previous = s.prompts[i - 1]
        local.push({ id: `miss:${prompt.uuid}`, ts, session, expected: verdict.expected, ...details, prompt: prompt.text, previous: previous?.text ?? null, previousSkill: previous?.slash ?? null })
      }
    }
    // The words are only needed until the next prompt arrives.
    for (const p of s.prompts.slice(0, -1)) if (s.checked.includes(p.uuid)) p.text = null
  }
  for (const [session, s] of Object.entries(state)) {
    const last = Math.max(0, ...s.prompts.map((p) => p.t), ...s.decisions.map((d) => d.t))
    if (now - last > WEEK_MS) delete state[session]
  }
  return { events, local }
}

/** Adds local miss lines to the file, dropping any older than 7 days. */
export function saveLocalMisses(path, lines, now = Date.now()) {
  const existing = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
    : []
  const fresh = [...existing, ...lines].filter((record) => now - Date.parse(record.ts) <= WEEK_MS)
  const byId = new Map(fresh.map((record) => [record.id, record]))
  writeFileSync(path, [...byId.values()].map((record) => JSON.stringify(record)).join('\n') + (byId.size ? '\n' : ''))
  return byId.size
}
