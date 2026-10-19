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
const HARD = /\b(architect\w*|design|plan|why does|race|security)\b/i
const EASY = /\b(typo|rename|format|what is)\b/i
const LONG = 2000
const EASY_MAX = 300 // a long prompt that says "rename" is rarely just a rename
// A short follow-up with none of these words carries on the work in hand ("looks good, next one"):
// it keeps the previous tier and effort and the judge is not asked (17p).
const FOLLOW_MAX = 80
const TASK = /\b(add|build|write|fix|implement|create|refactor|make|change|remove|delete|test|debug|explain|why|how|update|rename|move|review|design|plan|migrate|install|deploy|port|rewrite|find|search|list|show|check|run|look|read|summari[sz]e|compare|convert|generate|setup|set up)\b/i

const fast = (text: string): Verdict | 'keep' | undefined => {
  if (text.trim() === '' || CONTINUE.test(text)) return 'keep'
  if (text.trim().length < FOLLOW_MAX && !TASK.test(text) && !HARD.test(text) && !EASY.test(text)) return 'keep'
  if (text.length > LONG || HARD.test(text)) return { tier: 'L', effort: 'high', reason: 'fast: hard' }
  if (text.length < EASY_MAX && EASY.test(text)) return { tier: 'S', effort: 'low', reason: 'fast: easy' }
}

const DEFAULT: Verdict = { tier: 'M', effort: 'medium', reason: 'default' }

// Precedence: pin > paused > fast path > backends > prev > default.
// undefined = leave the request alone (paused).
export async function route(text: string, ctx: Ctx = {}): Promise<Decision | undefined> {
  if (ctx.pin) return { ...ctx.pin, reason: 'pinned', source: 'pin' }
  if (ctx.paused && !ctx.agentType) return undefined

  const prior = ctx.agentType ? PRIORS[ctx.agentType] : undefined
  if (prior?.tier === 'L') return { ...prior, source: 'prior' }

  const f = fast(text)
  if (f === 'keep') {
    if (ctx.prev) return { ...ctx.prev, reason: 'continuation', source: 'prev' }
  } else if (f) {
    return prior && f.tier !== 'L' ? { ...prior, source: 'prior' } : { ...f, source: 'fast' }
  }

  for (const b of ctx.backends ?? []) {
    const v = await b.ask(text).catch(() => undefined)
    if (v) return prior && v.tier !== 'L' ? { ...prior, source: 'prior' } : { ...v, source: b.name }
  }
  if (prior) return { ...prior, source: 'prior' }
  if (ctx.prev) return { ...ctx.prev, source: 'prev' }
  return { ...DEFAULT, source: 'default' }
}
