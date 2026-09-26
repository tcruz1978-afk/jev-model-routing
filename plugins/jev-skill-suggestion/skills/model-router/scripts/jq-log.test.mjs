import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendLine, decisionEntry, jqLogPath, newJqId, outcomeEntry, writeEntry } from './jq-log.mjs'
import { DPMO } from './router.mjs'

const temp = () => join(mkdtempSync(join(tmpdir(), 'jq-log-')), 'decisions.jsonl')

// The hook's $.fs has no append: read the whole file and write it back.
const wholeFileIo = {
  exists: async (p) => existsSync(p),
  read: async (p) => readFileSync(p, 'utf8'),
  write: async (p, text) => writeFileSync(p, text),
}
const appendIo = { append: (p, text) => appendFileSync(p, text) }

test('the log path follows jq.mjs: off, JQ_LOG_FILE, test runs, shared folder, ~/.jq', () => {
  assert.equal(jqLogPath({ JQ_LOG: 'off', JQ_LOG_FILE: '/x' }), null)
  assert.equal(jqLogPath({ JQ_LOG_FILE: '/x/d.jsonl', NODE_TEST_CONTEXT: 'child' }), '/x/d.jsonl')
  assert.equal(jqLogPath({ NODE_TEST_CONTEXT: 'child' }, { home: '/h' }), null)
  assert.equal(jqLogPath({}, { home: '/h', sharedDirExists: true }), '/mnt/project-files/judgement-quotient/decisions.jsonl')
  assert.equal(jqLogPath({}, { home: '/h/' }), '/h/.jq/decisions.jsonl')
  assert.equal(jqLogPath({ HOME: '/e' }), '/e/.jq/decisions.jsonl')
  assert.equal(jqLogPath({}), null)
})

test('entries: 8-hex ids, no figure filled in, outcomes limited to what jq.mjs knows', () => {
  assert.match(newJqId(), /^[0-9a-f]{8}$/)
  assert.equal(decisionEntry({ tool: 't', question: 'q', answer: 'a', confidence: null }, { now: 1 }), null)
  assert.equal(decisionEntry({ tool: 't', question: 'q', answer: 'a', confidence: 1.2 }, { now: 1 }), null)
  assert.equal(decisionEntry({ tool: 't', question: 'q', answer: null, confidence: 0.5 }, { now: 1 }), null)
  assert.deepEqual(decisionEntry({ tool: 't', question: 'q', answer: 3, confidence: 0.5 }, { id: 'abcd1234', now: 1 }), {
    kind: 'decision', id: 'abcd1234', t: 1, tool: 't', question: 'q', answer: '3', confidence: 0.5,
  })
  assert.deepEqual(outcomeEntry('abcd1234', 'overruled', { answer: 'x', now: 2 }), { kind: 'outcome', id: 'abcd1234', t: 2, outcome: 'overruled', answer: 'x' })
  assert.throws(() => outcomeEntry('abcd1234', 'maybe', { now: 2 }), /kept, overruled, asked/)
})

test('appending keeps every existing byte, and an unreadable log is never overwritten', async () => {
  assert.equal(appendLine('{"a":1}', { b: 2 }), '{"a":1}\n{"b":2}\n')
  assert.equal(appendLine(null, { b: 2 }), '{"b":2}\n')
  const path = temp()
  writeFileSync(path, 'not json but kept\n')
  assert.equal(await writeEntry({ kind: 'decision' }, path, wholeFileIo), true)
  assert.equal(readFileSync(path, 'utf8'), 'not json but kept\n{"kind":"decision"}\n')
  let wrote = false
  const broken = { exists: async () => true, read: async () => { throw new Error('too big') }, write: async () => { wrote = true } }
  assert.equal(await writeEntry({ kind: 'decision' }, path, broken), false)
  assert.equal(wrote, false)
  assert.equal(await writeEntry(null, path, wholeFileIo), false)
  assert.equal(await writeEntry({ kind: 'decision' }, null, wholeFileIo), false)
})

// tc-ventures' tools/jq/jq.mjs, when it is checked out: as this folder's
// synced copy there (tools/model-router → ../jq), inside its synced plugin
// copy (.claude/skills/jev-skill-suggestion/...), or beside jev-model-routing.
const here = fileURLToPath(new URL('.', import.meta.url))
const jqMjs = [process.env.JQ_MJS, join(here, '../jq/jq.mjs'), join(here, '../../../../../../tools/jq/jq.mjs'), join(here, '../../../../../../tc-ventures/tools/jq/jq.mjs')]
  .filter(Boolean)
  .find((p) => existsSync(p))

test("jq.mjs reads and scores what this module writes, from the hook's I/O and the router's", { skip: jqMjs ? false : 'tc-ventures tools/jq/jq.mjs not checked out here' }, async () => {
  const jq = await import(pathToFileURL(jqMjs).href)
  const path = temp()
  const hook = decisionEntry({ tool: 'jev-skill-suggestion', question: 'skill', answer: 'workflow-design', confidence: 0.9, decidedBy: 'jev', basis: 'fits' }, { now: 1000 })
  const router = decisionEntry({ tool: 'model-router Jev', question: 'tier', answer: 'cheap', confidence: 0.6, decidedBy: 'openrouter' }, { now: 1001 })
  assert.equal(await writeEntry(hook, path, wholeFileIo), true)
  assert.equal(await writeEntry(router, path, appendIo), true)
  assert.equal(await writeEntry(outcomeEntry(hook.id, 'kept', { now: 1002 }), path, wholeFileIo), true)
  // jq.mjs's own outcome command accepts the id this module made.
  jq.recordOutcome(router.id, 'overruled', { answer: 'quality', logFile: path, now: 1003 })
  const entries = jq.readLog(path)
  assert.equal(entries.length, 4)
  const { byTool } = jq.report(entries)
  assert.deepEqual(
    { calls: byTool['jev-skill-suggestion · skill'].calls, scored: byTool['jev-skill-suggestion · skill'].scored, rightRate: byTool['jev-skill-suggestion · skill'].rightRate },
    { calls: 1, scored: 1, rightRate: 1 },
  )
  assert.equal(byTool['model-router Jev · tier'].actedWrong, 1)
  assert.ok(Math.abs(byTool['jev-skill-suggestion · skill'].brier - 0.01) < 1e-12)
  // The same levels, the same path rule.
  assert.deepEqual(DPMO, jq.DPMO)
  for (const env of [{ JQ_LOG: 'off' }, { JQ_LOG_FILE: '/x/d.jsonl' }, { NODE_TEST_CONTEXT: 'child' }, { HOME: '/nonexistent-home' }]) {
    const theirs = jq.logFilePath(undefined, env, '/nonexistent-shared')
    const ours = jqLogPath(env, { sharedDirExists: false })
    if (env.HOME) assert.ok(theirs.endsWith('/.jq/decisions.jsonl') && ours === '/nonexistent-home/.jq/decisions.jsonl')
    else assert.equal(ours, theirs)
  }
})
