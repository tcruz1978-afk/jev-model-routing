#!/usr/bin/env node
/**
 * Builds the usage dashboard: one self-contained HTML page from usage events,
 * with the refresh machinery around it.
 *
 *   node dashboard.mjs [--input events.jsonl|export.json] [--source local|supabase]
 *                      [--out dashboard.html] [--state-dir dir] [--days 180] [--force]
 *                      [--now ISO-time] [--tiers jev-tiers.json] [--help]
 *
 * Input is the collector's ~/.claude/usage-telemetry/events.jsonl by default
 * (`--source local`, this machine only), or a JSON array exported from
 * claude_usage.events (`--source supabase`, every host). The page filters by
 * host and range in the browser. Opened inside Claude, the page reads the
 * same rows live from Supabase through the viewer's connector (live.mjs) and
 * keeps this build's DATA as the fallback snapshot. It offers ranges up to
 * 90 days, so it carries 180 (each range is compared with the one before it).
 *
 * The optional Jev benchmark (`--tiers`, default
 * ~/.claude/usage-telemetry/jev-tiers.json: the same test prompts put to Jev,
 * a paid and a free decider) is inlined as DATA.jevTiers, or null.
 *
 * Every run:
 *   1. snapshots the DATA of the page it is about to replace to
 *      ~/.claude/usage-telemetry/snapshots/YYYY-MM-DDTHH.json (keeps 30);
 *   2. builds, then checks the guards (see GUARDS) against that snapshot and
 *      refuses to write the page, exiting 2 and naming each guard, when one
 *      trips (`--force` publishes anyway);
 *   3. appends one line to ~/.claude/usage-telemetry/runs.log.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DAY, readTierBenchmark, runChecks, usd } from './checks.mjs'
import { compact } from './live.mjs'

// The compact rows moved to live.mjs, which the page also runs on live rows.
export { compact }

const here = dirname(fileURLToPath(import.meta.url))

/** Keys the page reads from DATA. A build missing one would render blank or wrong. */
export const REQUIRED_KEYS = { generatedAt: 'string', source: 'string', firstEventAt: 'any', lastEventAt: 'any', sessions: 'array', rows: 'array', turns: 'array', prices: 'object', summary: 'object', jevTiers: 'any' }
export const SNAPSHOTS_KEPT = 30

/** Events from a JSONL file or a JSON array (a Supabase export), with a count of lines that did not parse. */
export function parseEvents(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { events: [], bad: 0, lines: 0 }
  if (trimmed.startsWith('[')) {
    try {
      const events = JSON.parse(trimmed)
      return { events: Array.isArray(events) ? events : [], bad: Array.isArray(events) ? 0 : 1, lines: Array.isArray(events) ? events.length : 1 }
    } catch {
      return { events: [], bad: 1, lines: 1 }
    }
  }
  const lines = trimmed.split('\n').filter(Boolean)
  let bad = 0
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      bad++
      return []
    }
  })
  return { events, bad, lines: lines.length }
}

export const readEvents = (text) => parseEvents(text).events

/** Why an input cannot be built from, or null. */
export function sourceProblem(parsed, source) {
  if (!parsed) return 'the input file could not be read'
  if (!parsed.events.length) return parsed.lines ? 'no line of the input parsed as an event' : 'the input is empty'
  if (parsed.bad / parsed.lines > 0.05) return `${parsed.bad} of ${parsed.lines} lines did not parse`
  const dated = parsed.events.filter((e) => Number.isFinite(Date.parse(e?.ts)))
  if (!dated.length) return 'no event carries a timestamp'
  if (source === 'supabase' && !parsed.events.every((e) => e && typeof e.id === 'string' && typeof e.kind === 'string')) return 'the Supabase export is missing id or kind on some rows'
  return null
}

/** Where the Claude prices came from, for the page's provenance note. */
export function pricesProvenance(path = join(here, 'prices.json')) {
  try {
    const source = JSON.parse(readFileSync(path, 'utf8'))._source ?? ''
    return { url: /https?:\/\/\S+/.exec(source)?.[0] ?? null, date: /(\d{4}-\d{2}-\d{2})/.exec(source)?.[1] ?? null }
  } catch {
    return { url: null, date: null }
  }
}

/**
 * The run's headline figures (7 days, all hosts, from the build time): what
 * the guards compare and runs.log records.
 */
export function summarize(payload) {
  const end = Date.parse(payload.generatedAt)
  const { checks, verdict, cur, tcur } = runChecks({ rows: payload.rows, turns: payload.turns, generatedAt: end, days: 7, host: 'all', since: payload.firstEventAt })
  const cost = (from) => payload.rows.filter((r) => r.k === 'api' && r.t > from && r.t <= end).reduce((a, r) => a + (Number.isFinite(r.c) ? r.c : 0), 0)
  const priced = cur.filter((r) => r.k === 'api' && Number.isFinite(r.c)).length
  const or = checks.find((c) => c.id === 'openrouter')
  return {
    window: '7 days to the build, all hosts',
    verdict: verdict.text + (verdict.tail ? ` · ${verdict.tail}` : ''),
    checks: Object.fromEntries(checks.map((c) => [c.id, { state: c.state, value: c.value ?? null, n: c.n ?? null }])),
    headline: {
      prompts: cur.filter((r) => r.k === 'prompt' && (!r.a || r.a === 'main')).length,
      decisions: cur.filter((r) => r.k === 'jev.decision').length,
      apiCalls: cur.filter((r) => r.k === 'api').length,
      turns: tcur.length,
      pricedCalls: priced,
    },
    cost: { claude24h: Math.round(cost(end - DAY) * 1e4) / 1e4, claude7d: Math.round(cost(end - 7 * DAY) * 1e4) / 1e4 },
    openrouter: or.state === 'untracked' ? null : { asOf: new Date(or.reconciliation.to).toISOString(), creditShare: or.value ?? null, usageWeekly: or.reconciliation.usage },
    hosts: [...new Set(cur.map((r) => r.h))].sort(),
  }
}

/** What you pay for Claude (plan.json), or null when it is missing or malformed. */
export function readPlan(path = join(here, 'plan.json')) {
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8'))
    return typeof plan.name === 'string' && Number.isFinite(plan.monthlyUsd) && plan.monthlyUsd >= 0 ? { name: plan.name, monthlyUsd: plan.monthlyUsd } : null
  } catch {
    return null
  }
}

/** Claude's list prices per million tokens (prices.json), for pricing routed calls as if Claude had answered them. */
export function claudeRates(path = join(here, 'prices.json')) {
  try {
    const claude = JSON.parse(readFileSync(path, 'utf8')).claude ?? {}
    return Object.fromEntries(Object.entries(claude).map(([model, p]) => [model, { input: p.input, output: p.output }]))
  } catch {
    return {}
  }
}

/** The full DATA object for the page. */
export function buildPayload(events, { source = 'local', now = Date.now(), days = 180, tiers = null } = {}) {
  const payload = compact(events, { days, now })
  const last = payload.rows[payload.rows.length - 1]
  const first = payload.rows[0]
  const full = { source, generatedAt: new Date(now).toISOString(), firstEventAt: first ? new Date(first.t).toISOString() : null, lastEventAt: last ? new Date(last.t).toISOString() : null, prices: pricesProvenance(), plan: readPlan(), rates: claudeRates(), jevTiers: readTierBenchmark(tiers), ...payload }
  full.summary = summarize(full)
  return full
}

export function render(payload, generatedAt) {
  const template = readFileSync(join(here, 'dashboard.html'), 'utf8')
  // The page runs the same arithmetic (checks.mjs), live loader (turns.mjs, live.mjs), words (present.mjs), explorer (explore.mjs) and rankings (rankings.mjs) the tests do.
  const inline = (file) => readFileSync(join(here, file), 'utf8').replace(/^import [^\n]*\n/gm, '').replace(/^export \{[^}]*\}[^\n]*\n/gm, '').replace(/^export /gm, '')
  const checks = ['checks.mjs', 'turns.mjs', 'live.mjs', 'present.mjs', 'explore.mjs', 'rankings.mjs'].map(inline).join('\n')
  const data = { ...payload, generatedAt: payload.generatedAt ?? (generatedAt ?? new Date()).toISOString() }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  // Functions, not strings: `$` in the inserted text must stay literal.
  return template.replace('/*__CHECKS__*/', () => checks.replace(/<\/script/gi, '<\\/script')).replace('/*__DATA__*/null', () => json)
}

/** The DATA object a built page inlines (brace-matched, strings respected), or throws. */
export function extractData(html) {
  // A live page inlines its build as SNAPSHOT; older pages as DATA.
  const marker = html.includes('const SNAPSHOT = ') ? 'const SNAPSHOT = ' : 'const DATA = '
  const start = html.indexOf(marker)
  if (start < 0) throw new Error('no DATA in the page')
  let i = start + marker.length
  if (html[i] !== '{') throw new Error('DATA is not an object')
  let depth = 0, inString = false
  for (let j = i; j < html.length; j++) {
    const c = html[j]
    if (inString) {
      if (c === '\\') j++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(i, j + 1))
  }
  throw new Error('DATA never closes')
}

/** Keys the page reads that are missing or the wrong type. */
export function missingKeys(data) {
  return Object.entries(REQUIRED_KEYS).filter(([key, type]) => {
    if (!data || !(key in data)) return true
    const v = data[key]
    return type === 'array' ? !Array.isArray(v) : type === 'object' ? !v || typeof v !== 'object' : type === 'string' ? typeof v !== 'string' : false
  }).map(([key]) => key)
}

/** Saves the previous DATA as snapshots/YYYY-MM-DDTHH.json (its own build hour, UTC), keeping the newest `keep`. */
export function snapshot(previous, dir, keep = SNAPSHOTS_KEPT) {
  mkdirSync(dir, { recursive: true })
  const at = Date.parse(previous?.generatedAt)
  const name = `${(Number.isFinite(at) ? new Date(at) : new Date()).toISOString().slice(0, 13)}.json`
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(previous))
  const all = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(f)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old), { force: true })
  return path
}

/** The newest snapshot's DATA, or null. */
export function latestSnapshot(dir) {
  if (!existsSync(dir)) return null
  const all = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(f)).sort()
  for (const f of all.reverse()) {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {}
  }
  return null
}

/**
 * The guards. Loose on purpose: they catch a broken pull, not a bad week.
 * Returns [{ guard, message }] for each one tripped.
 */
export function checkGuards(current, previous, { problem = null, previousUnreadable = null } = {}) {
  const tripped = []
  if (problem) tripped.push({ guard: 'source-unusable', message: `the source is unusable: ${problem}` })
  if (previousUnreadable) tripped.push({ guard: 'previous-page-unreadable', message: `the page being replaced could not be read (${previousUnreadable}), so there is nothing to snapshot or compare against` })
  if (current) {
    const missing = missingKeys(current)
    if (missing.length) tripped.push({ guard: 'missing-key', message: `DATA is missing keys the page reads: ${missing.join(', ')}` })
  }
  const now = current?.summary, before = previous?.summary
  if (now?.headline && before?.headline) {
    for (const [key, value] of Object.entries(now.headline)) {
      if (key === 'pricedCalls') continue
      const was = before.headline[key]
      if (value === 0 && was > 0) tripped.push({ guard: 'headline-zero', message: `${key} (7 days) came back 0; the previous build had ${was}` })
    }
  }
  // Model calls with no cost: the price table or the cost field broke, whatever the previous build said.
  if (now?.headline?.apiCalls > 0 && (!now.cost || !Number.isFinite(now.cost.claude7d) || now.cost.claude7d === 0 || now.headline.pricedCalls === 0)) {
    tripped.push({ guard: 'headline-zero', message: `Claude cost (7 days) came back ${now.cost && Number.isFinite(now.cost.claude7d) ? usd(now.cost.claude7d) : 'missing'} across ${now.headline.apiCalls} model calls` })
  }
  const a = now?.cost?.claude24h, b = before?.cost?.claude24h
  if (a > 0 && b > 0 && Math.max(a, b) >= 1 && Math.max(a / b, b / a) > 5) {
    tripped.push({ guard: 'cost-5x', message: `Claude cost for the last 24 h moved from ${usd(b)} to ${usd(a)} (more than 5x) since the previous build` })
  }
  return tripped
}

/** What moved since the previous build, for the refresh report: check states and headline counts. */
export function whatMoved(current, previous) {
  const now = current?.summary, before = previous?.summary
  if (!now || !before) return ['no previous build to compare with']
  const out = []
  for (const [id, c] of Object.entries(now.checks)) {
    const was = before.checks?.[id]
    if (!was) continue
    if (was.state !== c.state) out.push(`${id}: ${was.state} → ${c.state}`)
    else if (Number.isFinite(c.value) && Number.isFinite(was.value) && c.value <= 1 && Math.abs(c.value - was.value) >= 0.05) out.push(`${id}: ${Math.round(was.value * 100)}% → ${Math.round(c.value * 100)}% (${Math.round((c.value - was.value) * 100)} pp)`)
  }
  return out
}

/** One runs.log line: date, headline values, sources answered, guards tripped. */
export function runLine({ at, payload, events, guards, published }) {
  const s = payload?.summary
  const h = s?.headline ?? {}
  const answered = payload ? [`${payload.source}-file(${events} events)`] : []
  if (s?.openrouter) answered.push(`openrouter-key(as of ${s.openrouter.asOf.slice(0, 16)}Z)`)
  const untracked = s ? Object.entries(s.checks).filter(([, c]) => c.state === 'untracked').map(([id]) => id) : []
  return [
    new Date(at).toISOString(),
    `source=${payload?.source ?? '-'}`,
    `verdict="${s?.verdict ?? 'not built'}"`,
    `prompts7d=${h.prompts ?? '-'} decisions7d=${h.decisions ?? '-'} apiCalls7d=${h.apiCalls ?? '-'} turns7d=${h.turns ?? '-'}`,
    `claude24h=${s ? usd(s.cost.claude24h) : '-'} claude7d=${s ? usd(s.cost.claude7d) : '-'}`,
    `answered=${answered.join(',') || '-'}`,
    `hosts=${s?.hosts?.join(',') || '-'}`,
    `untracked=${untracked.join(',') || '-'}`,
    `guards=${guards.map((g) => g.guard).join(',') || 'none'}`,
    `published=${published}`,
  ].join(' ')
}

export const USAGE = `Build the Claude usage dashboard.

  node dashboard.mjs [options]

  --input <file>      events: collector JSONL (default ~/.claude/usage-telemetry/events.jsonl)
                      or a JSON array exported from claude_usage.events
  --source <s>        local (default; this machine only) or supabase (every host)
  --out <file>        page to write (default <state-dir>/dashboard.html)
  --state-dir <dir>   snapshots/ and runs.log (default ~/.claude/usage-telemetry)
  --days <n>          days of events the page carries (default 180)
  --force             publish even when a guard trips
  --tiers <file>      Jev benchmark, paid against free (default
                      ~/.claude/usage-telemetry/jev-tiers.json; shown as "not run yet" when absent)
  --now <ISO time>    testing only: build as if at this time
  --help              print this and exit without building

Exits 2 without writing the page when a guard trips (it names each one).`

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const opt = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude')
  const stateDir = opt('--state-dir', join(claudeDir, 'usage-telemetry'))
  const input = opt('--input', join(claudeDir, 'usage-telemetry', 'events.jsonl'))
  const out = opt('--out', join(stateDir, 'dashboard.html'))
  const source = opt('--source', 'local')
  const days = Number(opt('--days', 180))
  // Testing only: build as if at this time.
  const now = opt('--now', null) ? Date.parse(opt('--now')) : Date.now()
  const force = argv.includes('--force')
  if (!['local', 'supabase'].includes(source)) {
    console.error(`--source must be local or supabase, not ${source}`)
    process.exitCode = 1
    return
  }
  mkdirSync(stateDir, { recursive: true })
  const snapDir = join(stateDir, 'snapshots')

  // 1. Snapshot what is about to be replaced.
  let previous = null, previousUnreadable = null
  if (existsSync(out)) {
    try {
      previous = extractData(readFileSync(out, 'utf8'))
      console.log(`snapshot → ${snapshot(previous, snapDir)}`)
    } catch (error) {
      previousUnreadable = error.message
    }
  } else {
    previous = latestSnapshot(snapDir)
  }

  // 2. Build and guard.
  let parsed = null
  try {
    parsed = parseEvents(readFileSync(input, 'utf8'))
  } catch {}
  const problem = sourceProblem(parsed, source)
  const tiersFile = opt('--tiers', join(claudeDir, 'usage-telemetry', 'jev-tiers.json'))
  let tiers = null
  if (existsSync(tiersFile)) {
    try {
      tiers = JSON.parse(readFileSync(tiersFile, 'utf8'))
      if (!readTierBenchmark(tiers)) console.error(`${tiersFile} is not a Jev benchmark ({ranAt, cases, tiers: {jev|paid|free: {right, of}}}); left out`)
    } catch (error) {
      console.error(`${tiersFile} could not be read (${error.message}); left out`)
    }
  }
  const payload = problem ? null : buildPayload(parsed.events, { source, now, days, tiers })
  const guards = checkGuards(payload, previous, { problem, previousUnreadable })
  const publish = payload && (!guards.length || force)
  appendFileSync(join(stateDir, 'runs.log'), runLine({ at: now, payload, events: parsed?.events.length ?? 0, guards, published: publish ? (guards.length ? 'forced' : 'yes') : 'no' }) + '\n')
  if (!publish) {
    for (const g of guards) console.error(`guard ${g.guard}: ${g.message}`)
    console.error(payload ? 'Not published. Fix the source, or re-run with --force if the change is real.' : 'Not published: nothing could be built.')
    process.exitCode = 2
    return
  }
  for (const g of guards) console.error(`guard ${g.guard} overridden by --force: ${g.message}`)
  writeFileSync(out, render(payload))
  console.log(`${payload.rows.length} events from ${payload.sessions.length} sessions (${source}) → ${out}`)
  console.log(`verdict (7 days, all hosts): ${payload.summary.verdict}`)
  const moved = whatMoved(payload, previous)
  for (const line of moved.length ? moved : ['nothing moved by 5 pp or changed state']) console.log(`moved: ${line}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
