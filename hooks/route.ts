export type Tier = 'S' | 'M' | 'L'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Verdict = { tier: Tier; effort: Effort; reason: string }
// keepEffort: a model-only pin; the request keeps the effort the app sends, whatever `effort` says.
export type Decision = Verdict & { source: string; keepEffort?: boolean }
export type Backend = { name: string; ask: (text: string) => Promise<Verdict | undefined> }
export type Ctx = {
  prev?: Decision
  pin?: { tier: Tier; effort: Effort }
  paused?: boolean
  agentType?: string // set for subagent runs, absent on the main loop
  backends?: Backend[] // fallback chain, first verdict wins
  failed?: boolean // the last attempt failed (failedAttempt): the prompt goes one tier up from prev
}

export const MODEL: Record<Tier, string> = {
  S: 'claude-haiku-5-5',
  M: 'claude-sonnet-5-5',
  L: 'claude-opus-5-5',
}

const PRIORS: Record<string, Verdict> = {
  Explore: { tier: 'S', effort: 'low', reason: 'prior: Explore' },
  'cavecrew-investigator': { tier: 'S', effort: 'low', reason: 'prior: investigator' },
  'statusline-setup': { tier: 'S', effort: 'low', reason: 'prior: statusline-setup' },
  Plan: { tier: 'L', effort: 'high', reason: 'prior: Plan' },
}

const CONTINUE = /^\W*(y|yes|ok|okay|continue|go on|go ahead|proceed|sure|ok do it|do it)\W*$/i
// A short follow-up with none of these words carries on the work in hand ("looks good, next one"):
// it keeps the previous tier and effort and the judge is not asked (17p).
// No keyword or length sends a prompt to a tier: the judge reads every new task, since a word is
// a poor guess ("add a security note" is no Opus job) and a judge call costs far less than a wrong tier.
const FOLLOW_MAX = 80
const TASK = /\b(add|build|write|fix|implement|create|refactor|make|change|remove|delete|test|debug|explain|why|how|what|update|rename|move|review|design|plan|migrate|install|deploy|port|rewrite|find|search|list|show|check|run|look|read|summari[sz]e|compare|convert|generate|setup|set up|typo|format|security|architect\w*|race)\b/i

const keep = (text: string) => text.trim() === '' || CONTINUE.test(text) || (text.trim().length < FOLLOW_MAX && !TASK.test(text))

const DEFAULT: Verdict = { tier: 'M', effort: 'medium', reason: 'default' }

const UP_TIER: Record<Tier, Tier> = { S: 'M', M: 'L', L: 'L' }
// The judge's own ceiling: escalation does not reach xhigh or max either.
const UP_EFFORT: Record<Effort, Effort> = { low: 'medium', medium: 'high', high: 'high', xhigh: 'xhigh', max: 'max' }

// The person says the last attempt did not work.
export const RETRY = /\b(did ?n[o']?t work|does ?n[o']?t work|not working|still (?:fail\w*|broken|wrong|not \w+|does ?n[o']?t \w+)|try again|that'?s (?:wrong|not right)|wrong (?:answer|number|result|output)|same error)\b/i

type ApiMessage = { role: string; content: unknown }
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const blocksOf = (c: unknown): any[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [])
const textOf = (c: unknown): string => blocksOf(c).map(b => (b.type === 'text' ? b.text : '')).join('\n')
// Line numbers, timings and counts change between runs of the same error.
const signature = (b: any) => textOf(b.content).replace(/\d+/g, '#').trim().slice(0, 300)

// Pure: whether the attempt since the last prompt the person typed failed. After claude-router (MIT): the same
// tool error twice with an edit between them. Or the new prompt says so (RETRY).
export function failedAttempt(messages: readonly ApiMessage[], text: string): boolean {
  if (RETRY.test(text)) return true
  const isTyped = (m: ApiMessage) => m.role === 'user' && !blocksOf(m.content).some(b => b.type === 'tool_result')
  let typed = messages.findLastIndex(isTyped)
  // The new prompt may already be in the transcript: then the attempt is the one before it.
  if (typed >= 0 && textOf(messages[typed].content).trim() === text.trim()) typed = messages.slice(0, typed).findLastIndex(isTyped)
  const errors: { at: number; sig: string }[] = []
  const edits: number[] = []
  messages.forEach((m, at) => {
    if (at <= typed) return
    for (const b of blocksOf(m.content)) {
      if (m.role === 'user' && b.type === 'tool_result' && b.is_error) errors.push({ at, sig: signature(b) })
      if (m.role === 'assistant' && b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) edits.push(at)
    }
  })
  return errors.some((a, i) => errors.slice(i + 1).some(b => b.sig === a.sig && edits.some(e => e > a.at && e < b.at)))
}

// Precedence: pin > paused > failed attempt goes up from prev > follow-up keeps prev > backends > prev > default.
// undefined = leave the request alone (paused).
export async function route(text: string, ctx: Ctx = {}): Promise<Decision | undefined> {
  if (ctx.pin) return { ...ctx.pin, reason: 'pinned', source: 'pin' }
  if (ctx.paused && !ctx.agentType) return undefined

  const prior = ctx.agentType ? PRIORS[ctx.agentType] : undefined
  if (prior?.tier === 'L') return { ...prior, source: 'prior' }

  // A failed attempt is not asked again at the tier that failed it: one tier and one effort up.
  if (!ctx.agentType && ctx.prev && ctx.failed)
    return { tier: UP_TIER[ctx.prev.tier], effort: UP_EFFORT[ctx.prev.effort], reason: 'last attempt failed', source: 'escalate' }

  // A subagent's brief is a new task every time, so it never just continues the last turn (17x).
  if (!ctx.agentType && ctx.prev && keep(text)) return { ...ctx.prev, reason: 'continuation', source: 'prev' }

  for (const b of ctx.backends ?? []) {
    const v = await b.ask(text).catch(() => undefined)
    if (v) return prior && v.tier !== 'L' ? { ...prior, source: 'prior' } : { ...v, source: b.name }
  }
  if (prior) return { ...prior, source: 'prior' }
  if (ctx.prev) return { ...ctx.prev, source: 'prev' }
  return { ...DEFAULT, source: 'default' }
}
