// Judgement quotient (JQ) log, shared by the model router (Node) and the
// jev-skill-suggestion hook (a function-hooks mod, which has no Node): one
// place for the record format, so `node tools/jq/jq.mjs report` in the
// owner's own repo scores calls from both.
//
// The format is tc-ventures' tools/jq/jq.mjs, field for field: one JSON object
// per line,
//   {"kind":"decision","id":"<8 hex>","t":<ms>,"tool":"…","question":"…","answer":"…","confidence":<0..1>}
//   {"kind":"outcome","id":"<8 hex>","t":<ms>,"outcome":"kept|overruled|asked","answer":"…"?}
// jq.mjs reads only these fields and ignores any others; this module may add
// `decidedBy` and `basis` (what the confidence rests on) to a decision, and
// never the prompt's text.
//
// Dependency-free and Node-free on purpose: every function here is pure or
// takes its file access as an argument (`io`), so the hook passes `$.fs` and
// the router passes node:fs.

/** The owner's shared project folder: when it exists, the log lives there so it outlives a session (as jq.mjs). */
export const SHARED_DIR = '/mnt/project-files'

/**
 * Where the log lives, by jq.mjs's own rule: nothing when JQ_LOG=off, else
 * JQ_LOG_FILE, else nothing inside a `node --test` run (NODE_TEST_CONTEXT) so
 * tests never pad the record, else the shared folder's
 * judgement-quotient/decisions.jsonl when that folder exists, else
 * ~/.jq/decisions.jsonl. Null means "don't log".
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ home?: string, sharedDirExists?: boolean }} where
 */
export function jqLogPath(env, { home, sharedDirExists = false } = {}) {
  if (env.JQ_LOG === 'off') return null
  if (env.JQ_LOG_FILE) return env.JQ_LOG_FILE
  if (env.NODE_TEST_CONTEXT) return null
  if (sharedDirExists) return `${SHARED_DIR}/judgement-quotient/decisions.jsonl`
  const base = home || env.HOME
  return base ? `${base.replace(/\/+$/, '')}/.jq/decisions.jsonl` : null
}

/** A call's id, as jq.mjs makes it: the first 8 characters of a random UUID. */
export function newJqId() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID().slice(0, 8)
  const bytes = new Uint8Array(4)
  c.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * One judgment call as jq.mjs logs it, or null when there is nothing honest
 * to log: no answer, or no stated probability (a figure is never filled in).
 *
 * @param {{ tool: string, question: string, answer: unknown, confidence: unknown, decidedBy?: string, basis?: string }} call
 * @param {{ id?: string, now: number }} stamp
 */
export function decisionEntry({ tool, question, answer, confidence, decidedBy, basis }, { id = newJqId(), now }) {
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null
  if (answer === undefined || answer === null) return null
  const entry = { kind: 'decision', id, t: now, tool, question, answer: String(answer), confidence }
  if (decidedBy) entry.decidedBy = decidedBy
  if (basis) entry.basis = basis
  return entry
}

export const OUTCOMES = ['kept', 'overruled', 'asked']

/** What happened to a logged call, as `jq.mjs outcome` records it. */
export function outcomeEntry(id, outcome, { answer, now }) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`)
  const entry = { kind: 'outcome', id, t: now, outcome }
  if (answer !== undefined) entry.answer = String(answer)
  return entry
}

/**
 * The file's next content with one entry added: what was there, byte for
 * byte (a missing final newline supplied), then the entry. Nothing is dropped:
 * the log is the record.
 */
export function appendLine(existing, entry) {
  const kept = existing ? (existing.endsWith('\n') ? existing : `${existing}\n`) : ''
  return `${kept}${JSON.stringify(entry)}\n`
}

/**
 * Appends one entry. `io.append(path, text)` when the caller has a real append
 * (Node); else read the whole file and write it back (`$.fs` in the hook has
 * no append). A file that exists but can't be read is never overwritten.
 * Returns whether the entry was written; never throws, since keeping score
 * never gets in the way of the call itself.
 *
 * @param {object | null} entry
 * @param {string | null} path
 * @param {{ append?: (path: string, text: string) => unknown, exists?: (path: string) => Promise<boolean> | boolean, read?: (path: string) => Promise<unknown> | unknown, write?: (path: string, text: string) => Promise<void> | void }} io
 */
export async function writeEntry(entry, path, io) {
  if (!entry || !path) return false
  try {
    if (io.append) {
      await io.append(path, `${JSON.stringify(entry)}\n`)
      return true
    }
    const existing = (await io.exists(path)) ? String(await io.read(path)) : null
    await io.write(path, appendLine(existing, entry))
    return true
  } catch {
    return false
  }
}
