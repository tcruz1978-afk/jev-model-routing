#!/usr/bin/env node
/**
 * Builds the usage dashboard: one self-contained HTML page from usage events.
 *
 *   node dashboard.mjs [--input events.jsonl|export.json] [--out dashboard.html] [--days 90]
 *
 * Input is the collector's ~/.claude/usage-telemetry/events.jsonl by default,
 * or a JSON array exported from claude_usage.events (see ../README.md). The
 * page filters by host and time range in the browser; nothing is fetched.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dedupe } from './lib.mjs'
import { turnsFrom } from './turns.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Events from a JSONL file or a JSON array (a Supabase export). */
export function readEvents(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed)
  return trimmed
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/**
 * The compact rows the page carries: short keys, sessions as indexes, the
 * `data` payload only where a view reads it. Turns (one prompt and all the
 * work until the next one, see turns.mjs) are computed here, once, so the
 * page only filters them by time and host and never re-derives them.
 */
export function compact(events, { days = 90, now = Date.now() } = {}) {
  const since = now - days * 86400000
  const sessions = []
  const sessionIndex = new Map()
  const rows = []
  for (const event of dedupe(events)) {
    const t = event.ts ? Date.parse(event.ts) : NaN
    if (!Number.isFinite(t) || t < since) continue
    let s = -1
    if (event.session) {
      if (!sessionIndex.has(event.session)) {
        sessionIndex.set(event.session, sessions.length)
        sessions.push(event.session)
      }
      s = sessionIndex.get(event.session)
    }
    const row = { k: event.kind, t, s, h: event.host ?? '' }
    if (event.project) row.p = event.project
    if (event.agent) row.a = event.agent
    if (event.model) row.m = event.model
    if (event.input_tokens) row.i = Number(event.input_tokens)
    if (event.output_tokens) row.o = Number(event.output_tokens)
    if (event.cache_read_tokens) row.cr = Number(event.cache_read_tokens)
    if (event.cache_write_tokens) row.cw = Number(event.cache_write_tokens)
    if (event.cost_usd !== null && event.cost_usd !== undefined) row.c = Number(event.cost_usd)
    if (event.tool) row.tl = event.tool
    if (event.skill) row.sk = event.skill
    if (event.mcp_server) row.mc = event.mcp_server
    if (event.ok !== null && event.ok !== undefined) row.ok = event.ok
    const data = event.data ?? {}
    if (event.kind === 'tool') {
      if (data.ms !== undefined && data.ms !== null) row.ms = data.ms
      if (data.subagent_type) row.st = data.subagent_type
      if (data.workflow) row.wf = data.workflow
    } else if (event.kind === 'jev.decision' || event.kind === 'router.call' || event.kind === 'openrouter.key') {
      row.d = data
    } else if (event.kind === 'prompt') {
      if (data.slash) row.sl = 1
      if (data.category) row.cat = data.category
      if (data.correction) row.cx = 1
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.t - b.t)
  return { sessions, rows, turns: turnsFrom(rows) }
}

export function render(payload, generatedAt = new Date()) {
  const template = readFileSync(join(here, 'dashboard.html'), 'utf8')
  const json = JSON.stringify({ ...payload, generatedAt: generatedAt.toISOString() }).replace(/</g, '\\u003c')
  return template.replace('/*__DATA__*/null', json)
}

function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude')
  const input = opt('--input', join(claudeDir, 'usage-telemetry', 'events.jsonl'))
  const out = opt('--out', join(claudeDir, 'usage-telemetry', 'dashboard.html'))
  const days = Number(opt('--days', 90))
  const payload = compact(readEvents(readFileSync(input, 'utf8')), { days })
  writeFileSync(out, render(payload))
  console.log(`${payload.rows.length} events from ${payload.sessions.length} sessions → ${out}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
