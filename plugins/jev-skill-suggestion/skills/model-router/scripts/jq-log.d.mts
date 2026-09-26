// Types for jq-log.mjs, so the TypeScript hook can import it.
export const SHARED_DIR: string
export function jqLogPath(env: Record<string, string | undefined>, where?: { home?: string; sharedDirExists?: boolean }): string | null
export function newJqId(): string
export interface JqDecision {
  kind: 'decision'
  id: string
  t: number
  tool: string
  question: string
  answer: string
  confidence: number
  decidedBy?: string
  basis?: string
}
export interface JqOutcome {
  kind: 'outcome'
  id: string
  t: number
  outcome: 'kept' | 'overruled' | 'asked'
  answer?: string
}
export function decisionEntry(
  call: { tool: string; question: string; answer: unknown; confidence: unknown; decidedBy?: string; basis?: string },
  stamp: { id?: string; now: number },
): JqDecision | null
export const OUTCOMES: readonly ['kept', 'overruled', 'asked']
export function outcomeEntry(id: string, outcome: 'kept' | 'overruled' | 'asked', options: { answer?: string; now: number }): JqOutcome
export function appendLine(existing: string | null, entry: object): string
export interface JqIo {
  append?: (path: string, text: string) => unknown
  exists?: (path: string) => Promise<boolean> | boolean
  read?: (path: string) => Promise<unknown> | unknown
  write?: (path: string, text: string) => Promise<void> | void
}
export function writeEntry(entry: object | null, path: string | null, io: JqIo): Promise<boolean>
