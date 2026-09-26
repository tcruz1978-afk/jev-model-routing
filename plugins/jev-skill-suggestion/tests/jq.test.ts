import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  decide,
  injectionBlock,
  jevLine,
  jqConfidence,
  jqOutcomeFor,
  jqMissForNone,
  looksLikeCorrection,
  readRerank,
  readWide,
  suggestionBlock,
  withJevLine,
} from '../hooks/policy.ts'
import type { PolicyConfig, Rerank, Skill, Wide } from '../hooks/policy.ts'
import { register } from '../hooks/jev-skill-suggestion.ts'

const config: PolicyConfig = { shortlist: 3, gateThreshold: 0.3, fitsThreshold: 0.55, decisiveRank: 0.9 }
const skills: Skill[] = [
  { name: 'workflow-design', description: 'Design process workflows as flowcharts' },
  { name: 'pdf', description: 'Read and write PDFs' },
  { name: 'commit', description: 'Create a git commit' },
]
const wide = (gate: number | null, ranked: [string, number | null][]): Wide => ({
  ranked: ranked.map(([name, probability]) => ({ name, probability })),
  gate,
  gateValues: {},
})
const rerank = (winner: string, fits: Record<string, number>): Rerank => ({ winner, confidence: null, fits })
const confidenceOf = (w: Wide | null, r: Rerank | null, attempted = r !== null) =>
  jqConfidence(w, r, skills, config, attempted, decide(w, r, skills, config, attempted))

test("a pick's confidence is the winner's own fits; a pick with no rerank, its ranking", () => {
  const w = wide(0.8, [['workflow-design', 0.7], ['pdf', 0.2], ['commit', 0.1]])
  expect(confidenceOf(w, rerank('workflow-design', { 'workflow-design': 0.91, pdf: 0.6, commit: 0.1 }))).toEqual({ confidence: 0.91, basis: 'fits' })
  expect(confidenceOf(w, null, false)).toEqual({ confidence: 0.7, basis: 'rank' })
  // The built-in classifier's bare label has no probability: nothing to log.
  expect(confidenceOf(wide(null, [['pdf', null]]), null, false)).toBeNull()
})

test('"none" rests on the gate (1 − gate) or on the fits (1 − the best fits); nothing else is scored', () => {
  const closed = wide(0.12, [['pdf', 0.4]])
  expect(confidenceOf(closed, null, false)?.basis).toBe('gate')
  expect(confidenceOf(closed, null, false)?.confidence).toBeCloseTo(0.88)
  const w = wide(0.8, [['workflow-design', 0.7], ['pdf', 0.2], ['commit', 0.1]])
  // Nothing fits well enough.
  expect(confidenceOf(w, rerank('pdf', { 'workflow-design': 0.3, pdf: 0.4, commit: 0.1 }))).toEqual({ confidence: 1 - 0.4, basis: 'fits' })
  // The winner itself fits badly, though another fits better: P(none right) is at most 1 − the best.
  const bad = confidenceOf(w, rerank('pdf', { 'workflow-design': 0.6, pdf: 0.2, commit: 0.1 }))
  expect(bad?.basis).toBe('fits')
  expect(bad?.confidence).toBeCloseTo(0.4)
  // No answer, a failed rerank, a winner off the shortlist: no probability.
  expect(confidenceOf(null, null)).toBeNull()
  expect(confidenceOf(w, null, true)).toBeNull()
  expect(confidenceOf(w, rerank('elsewhere', { 'workflow-design': 0.9 }))).toBeNull()
})

test('the Jev line: two decimals, inside the block, after the line the usage dashboard reads', () => {
  expect(jevLine('workflow-design', 0.9123)).toBe('Jev: workflow-design (0.91)')
  const skill = skills[0] as Skill
  for (const block of [suggestionBlock(skill, true) as string, injectionBlock(skill, '---\nname: x\n---\nDo it.', '/s/SKILL.md', '/p', false)]) {
    const shown = withJevLine(block, jevLine(skill.name, 0.91))
    expect(shown).toContain('Start your reply with this one line, exactly as written')
    expect(shown).toContain('Jev: workflow-design (0.91)')
    expect(shown.trimEnd().endsWith('</skill_relevance>')).toBe(true)
    // plugins/usage-telemetry reads the suggested skill with this pattern.
    expect(/Relevant to the current request:\s*([^\s.]+(?:\.[^\s.]+)*)\./.exec(shown)?.[1]).toBe('workflow-design')
  }
  expect(withJevLine('<skill_relevance>\nx\n</skill_relevance>', null)).toBe('<skill_relevance>\nx\n</skill_relevance>')
})

test('outcome rule: /other overrules, a correction records nothing, anything else keeps', () => {
  const isSkill = (name: string) => ['pdf', 'workflow-design', 'plugin:model-router'].includes(name) || name === 'model-router'
  expect(jqOutcomeFor('workflow-design', '/pdf make it a PDF', isSkill)).toEqual({ outcome: 'overruled', answer: 'pdf' })
  expect(jqOutcomeFor('workflow-design', '/workflow-design again', isSkill)).toEqual({ outcome: 'kept' })
  expect(jqOutcomeFor('plugin:model-router', '/model-router hi', isSkill)).toEqual({ outcome: 'kept' })
  expect(jqOutcomeFor('workflow-design', '/clear', isSkill)).toBeNull() // a built-in command, not a skill
  expect(jqOutcomeFor('workflow-design', 'no, that is not what I asked', isSkill)).toBeNull()
  expect(jqOutcomeFor('workflow-design', "it still doesn't work", isSkill)).toBeNull()
  expect(jqOutcomeFor('workflow-design', 'great, now add a rejection branch', isSkill)).toEqual({ outcome: 'kept' })
  expect(jqOutcomeFor('workflow-design', '   ', isSkill)).toBeNull()
  expect(looksLikeCorrection('wrong skill')).toBe(true)
  expect(looksLikeCorrection('now do the same for billing')).toBe(false)
})

// The hook end to end, against a fake engine and a fake Jev (Gateway-shaped answers).
const wideReply = JSON.stringify({
  answers: {
    which: { type: 'choice', choice: 'workflow-design', probabilities: { 'workflow-design': 0.8, pdf: 0.15, commit: 0.05 }, confidence: 0.9 },
    'gate::acts_on_user_system': { type: 'boolean', probability: 0.8 },
    'gate::would_follow_documented_procedure': { type: 'boolean', probability: 0.9 },
    'gate::prose_suffices': { type: 'boolean', probability: 0.1 },
  },
})
const rerankReply = JSON.stringify({
  answers: {
    which: { type: 'choice', choice: 'workflow-design' },
    'fits::workflow-design': { type: 'boolean', probability: 0.87 },
    'fits::pdf': { type: 'boolean', probability: 0.1 },
    'fits::commit': { type: 'boolean', probability: 0.02 },
  },
})

function harness(env: Record<string, string>) {
  const handlers: Record<string, Function> = {}
  const on: any = (name: string, a: any, b?: any) => {
    handlers[name] = b ?? a
  }
  register(on, { gatewayApiKey: 'test-key', inject: 'suggest' })
  const logs: string[] = []
  const status: string[] = []
  const $: any = {
    env: { get: async (k: string) => env[k] },
    ui: { log: (t: string) => logs.push(t), status: (t: string) => status.push(t) },
    fs: {
      exists: async (p: string) => existsSync(p),
      read: async (p: string) => readFileSync(p, 'utf8'),
      write: async (p: string, t: string) => {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, t)
      },
      list: async () => [],
    },
    http: {
      fetch: async (_url: string, init: { body: string }) => ({ ok: true, status: 200, text: init.body.includes('fits::') ? rerankReply : wideReply }),
    },
    clock: { now: async () => 1_000, sleep: () => new Promise(() => {}) },
    session: { cwd: async () => '/nowhere', root: async () => '/nowhere', id: async () => 'jq-test' },
    command: { list: async () => [...skills.map((s) => ({ ...s, source: 'user' })), { name: 'clear', description: 'Clear', source: 'builtin' }] },
    model: { classify: async () => 'none' },
  }
  const submit = (text: string) => handlers['prompt.submit']($, { text, context: [] }, async (e: any) => e)
  return { submit, logs, status }
}

test('the hook logs each decision to JQ, shows the pick, and records the next prompt as its outcome', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jq-hook-'))
  const jqFile = join(home, 'jq', 'decisions.jsonl')
  const { submit, logs } = harness({ HOME: home, JQ_LOG_FILE: jqFile })
  const first = await submit('Design the approval workflow for vendor onboarding as a flowchart')
  const block = (first.context ?? []).join('\n')
  expect(block).toContain('Jev: workflow-design (0.87)')
  let lines = readFileSync(jqFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(lines).toHaveLength(1)
  const [decision] = lines
  expect(decision).toMatchObject({ kind: 'decision', t: 1000, tool: 'jev-skill-suggestion', question: 'skill', answer: 'workflow-design', confidence: 0.87, decidedBy: 'jev', basis: 'fits' })
  expect(decision.id).toMatch(/^[0-9a-f]{8}$/)
  // Never the prompt's text, in either log; the decision log carries the jqId.
  expect(readFileSync(jqFile, 'utf8')).not.toContain('vendor')
  const jevLog = readFileSync(join(home, '.claude', 'jev-log', 'jq-test.jsonl'), 'utf8')
  const logged = jevLog.trim().split('\n').map((line) => JSON.parse(line))
  // The session's comparison group comes first ("jq-test" is in the "on" group), then the decision.
  expect(logged[0]).toMatchObject({ kind: 'jev.arm', arm: 'on' })
  expect(logged.find((r) => r.kind === 'jev.decision').jqId).toBe(decision.id)
  expect(jevLog).not.toContain('vendor')

  // A correction: nothing recorded for the shown pick.
  await submit('no, that is not what I meant')
  lines = readFileSync(jqFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(lines.filter((l) => l.kind === 'outcome')).toHaveLength(0)

  // The correction was itself a decision; the next plain prompt keeps that one.
  const second = lines.at(-1)
  await submit('ok, add a rejection branch too')
  lines = readFileSync(jqFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(lines.filter((l) => l.kind === 'outcome')).toEqual([{ kind: 'outcome', id: second.id, t: 1000, outcome: 'kept' }])

  // A typed /other-skill overrules the pick before it.
  const third = lines.at(-1)
  await submit('/pdf export it')
  lines = readFileSync(jqFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(lines.at(-1)).toEqual({ kind: 'outcome', id: third.id, t: 1000, outcome: 'overruled', answer: 'pdf' })
  expect(logs.some((l) => l.includes(`JQ ${third.id}: /workflow-design overruled`))).toBe(true)
})

test('JQ_LOG=off logs nothing and records no outcome; the pick is still shown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jq-hook-off-'))
  const { submit } = harness({ HOME: home, JQ_LOG: 'off' })
  const first = await submit('Design the approval workflow as a flowchart')
  expect((first.context ?? []).join('\n')).toContain('Jev: workflow-design (0.87)')
  await submit('/pdf')
  expect(existsSync(join(home, '.jq'))).toBe(false)
})

test('a skill typed right after a "none" is a Jev miss (owner rule, 2026-09-26)', () => {
  const isSkill = (name: string) => ['pdf', 'workflow-design', 'jev-skill-suggestion:model-router'].includes(name) || name === 'model-router'
  expect(jqMissForNone('/pdf merge these', isSkill)).toEqual({ outcome: 'overruled', answer: 'pdf' })
  expect(jqMissForNone('/model-router ask gemini', isSkill)).toEqual({ outcome: 'overruled', answer: 'model-router' })
  expect(jqMissForNone('/clear', isSkill)).toBeNull()
  expect(jqMissForNone('thanks, carry on', isSkill)).toBeNull()
  expect(jqMissForNone('/home/user/file.txt is the input', isSkill)).toBeNull()
})
