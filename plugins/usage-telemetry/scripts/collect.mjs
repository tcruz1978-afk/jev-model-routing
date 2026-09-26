#!/usr/bin/env node
/**
 * Reads what Claude Code's transcripts and the jev-log gained since the last
 * run, turns it into usage events, keeps them in
 * ~/.claude/usage-telemetry/events.jsonl and, when USAGE_INGEST_URL is set,
 * ships them there (the Supabase `claude-usage` function).
 *
 *   node collect.mjs            collect, ship, print a one-line summary
 *   node collect.mjs --hook     the same, silent and never failing (Stop hook)
 *   node collect.mjs --flush    also record tool calls still waiting on a result
 *   node collect.mjs --rescan   forget the offsets and read everything again
 *
 * Environment:
 *   USAGE_INGEST_URL     https://<ref>.supabase.co/functions/v1/claude-usage
 *   USAGE_INGEST_TOKEN   the token that function checks (x-usage-token);
 *                        unset, the agent proxy may add it (cloud credential)
 *   OPENROUTER_API_KEY   read-only use: the key's spend and limit, hourly
 *   CLAUDE_CONFIG_DIR    defaults to ~/.claude
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { eventFromLog, eventsFromTranscript, flushPending, keySnapshot, transcriptOf } from './lib.mjs'

const args = new Set(process.argv.slice(2))
const hookMode = args.has('--hook')
const env = process.env
const claudeDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude')
const projectsDir = join(claudeDir, 'projects')
const jevDir = join(claudeDir, 'jev-log')
const outDir = join(claudeDir, 'usage-telemetry')
const statePath = join(outDir, 'state.json')
const eventsPath = join(outDir, 'events.jsonl')
const outboxPath = join(outDir, 'outbox.jsonl')
const lockPath = join(outDir, 'collect.lock')
const host = env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : `local:${hostname()}`
// A tool call with no result after this long is recorded as it stands.
const STALE_PENDING_MS = 30 * 60 * 1000

/** Every .jsonl under a directory, recursively. */
function jsonlFiles(dir) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  walk(dir)
  return found
}

/** The complete lines added to a file since `offset`, and the new offset. */
function newLines(path, offset) {
  const size = statSync(path).size
  if (size < offset) offset = 0 // rewritten or truncated: start over, ids keep it idempotent
  if (size === offset) return { lines: [], offset }
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size - offset)
    readSync(fd, buffer, 0, buffer.length, offset)
    const end = buffer.lastIndexOf(0x0a)
    if (end < 0) return { lines: [], offset }
    return { lines: buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean), offset: offset + end + 1 }
  } finally {
    closeSync(fd)
  }
}

function agentTypeOf(transcriptPath) {
  try {
    return JSON.parse(readFileSync(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? null
  } catch {
    return null
  }
}

async function openRouterSnapshot(state) {
  const auth = env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : env.OPENROUTER_AUTH === 'proxy' ? {} : null
  if (!auth) return []
  const hour = new Date().toISOString().slice(0, 13)
  if (state.openRouterHour === hour) return []
  const get = async (path) => {
    const response = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers: auth, signal: AbortSignal.timeout(5000) })
    return response.ok ? (await response.json()).data : null
  }
  try {
    const [key, credits] = await Promise.all([get('key'), get('credits').catch(() => null)])
    if (!key) return []
    state.openRouterHour = hour
    return [keySnapshot(key, credits, host)]
  } catch {
    return []
  }
}

async function ship(events) {
  const url = env.USAGE_INGEST_URL
  if (!url || events.length === 0) return { shipped: 0, error: null }
  const headers = { 'content-type': 'application/json' }
  if (env.USAGE_INGEST_TOKEN) headers['x-usage-token'] = env.USAGE_INGEST_TOKEN
  let shipped = 0
  for (let i = 0; i < events.length; i += 500) {
    const chunk = events.slice(i, i + 500)
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ events: chunk }), signal: AbortSignal.timeout(10000) })
      if (!response.ok) return { shipped, error: `${response.status} ${(await response.text()).slice(0, 200)}` }
      shipped += chunk.length
    } catch (error) {
      return { shipped, error: String(error.cause?.message ?? error.message ?? error) }
    }
  }
  return { shipped, error: null }
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  // One run at a time: a Stop hook can fire while the last run still ships.
  try {
    if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs < 60_000) return { skipped: 'another run is in progress' }
  } catch {}
  writeFileSync(lockPath, String(process.pid))
  try {
    let state = { files: {} }
    if (!args.has('--rescan')) {
      try {
        state = JSON.parse(readFileSync(statePath, 'utf8'))
      } catch {}
    }
    state.files ??= {}
    const events = []

    for (const path of jsonlFiles(projectsDir)) {
      const where = transcriptOf(path, projectsDir)
      if (!where) continue
      const file = (state.files[path] ??= { offset: 0, pending: {} })
      const { lines, offset } = newLines(path, file.offset)
      if (offset < file.offset) file.pending = {}
      file.offset = offset
      if (lines.length === 0 && Object.keys(file.pending).length === 0) continue
      const ctx = { ...where, host, agentType: where.agentId ? agentTypeOf(path) : null, startCwd: file.startCwd ?? null }
      events.push(...eventsFromTranscript(lines, ctx, file.pending))
      if (ctx.startCwd) file.startCwd = ctx.startCwd
      const stale = Object.fromEntries(
        Object.entries(file.pending).filter(([, use]) => args.has('--flush') || Date.now() - Date.parse(use.ts ?? 0) > STALE_PENDING_MS),
      )
      for (const id of Object.keys(stale)) delete file.pending[id]
      events.push(...flushPending(stale))
    }

    for (const path of jsonlFiles(jevDir)) {
      const file = (state.files[path] ??= { offset: 0 })
      const { lines, offset } = newLines(path, file.offset)
      file.offset = offset
      for (const line of lines) {
        const event = eventFromLog(line, host)
        if (event) events.push(event)
      }
    }

    events.push(...(await openRouterSnapshot(state)))

    // Files that are gone take their offsets with them.
    for (const path of Object.keys(state.files)) if (!existsSync(path)) delete state.files[path]
    writeFileSync(statePath, JSON.stringify(state))

    if (events.length > 0) {
      const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
      appendFileSync(eventsPath, text)
      if (env.USAGE_INGEST_URL) appendFileSync(outboxPath, text)
    }
    // The outbox holds whatever has not reached Supabase yet, this run's and earlier ones'.
    let outbox = []
    if (env.USAGE_INGEST_URL && existsSync(outboxPath)) {
      outbox = readFileSync(outboxPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    }
    const { shipped, error } = await ship(outbox)
    if (shipped === outbox.length && outbox.length > 0) rmSync(outboxPath, { force: true })
    else if (shipped > 0) writeFileSync(outboxPath, outbox.slice(shipped).map((event) => JSON.stringify(event)).join('\n') + '\n')
    return { collected: events.length, shipped, waiting: outbox.length - shipped, error }
  } finally {
    rmSync(lockPath, { force: true })
  }
}

main()
  .then((result) => {
    if (hookMode) return
    if (result.skipped) return console.log(`skipped: ${result.skipped}`)
    const shipping = env.USAGE_INGEST_URL
      ? ` · shipped ${result.shipped}${result.waiting ? `, ${result.waiting} waiting` : ''}${result.error ? ` (ship failed: ${result.error})` : ''}`
      : ' · USAGE_INGEST_URL not set, kept locally only'
    console.log(`collected ${result.collected} events into ${eventsPath}${shipping}`)
  })
  .catch((error) => {
    if (!hookMode) {
      console.error(error.stack ?? String(error))
      process.exitCode = 1
    }
  })
