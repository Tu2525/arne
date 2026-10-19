import type { Tier, Effort, Verdict } from './route'

const TIERS: Tier[] = ['S', 'M', 'L']
// ponytail: the judge never picks above high. xhigh and max are reached only by a pin or a floor, so a
// judge's answer cannot raise the cost of a turn past what the person allowed.
const EFFORTS: Effort[] = ['low', 'medium', 'high']

export const SYSTEM = `You route a coding-assistant prompt to a model tier. Reply with JSON only:
{"tier":"S|M|L","effort":"low|medium|high","reason":"<6 words>"}
S = trivial lookup or edit. M = normal coding. L = design, debugging a race, security, or long reasoning.`

// Pure: a model reply to a verdict, or undefined when it is not one.
export function parseVerdict(text: string): Verdict | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0])
    if (!TIERS.includes(v.tier) || !EFFORTS.includes(v.effort)) return undefined
    return { tier: v.tier, effort: v.effort, reason: String(v.reason ?? '').slice(0, 80) }
  } catch {
    return undefined
  }
}

export const LAYA_URL = 'http://127.0.0.1:8000'

// Request body for laya-serve POST /v1/systemone: two typed questions in one call.
// min_confidence is untuned; step 8 measures it.
export function layaBody(text: string): string {
  return JSON.stringify({
    state: { prompt: text.slice(0, 4000) },
    min_confidence: 0.5,
    questions: {
      tier: {
        type: 'choice',
        instructions: 'How hard is this coding-assistant request?',
        criteria: {
          S: 'trivial lookup, typo, rename, format, one-line answer',
          M: 'normal coding task, a bounded change in one or two files',
          L: 'design, architecture, debugging a race, security, long reasoning',
        },
      },
      effort: {
        type: 'score',
        instructions: 'How much thinking does it need?',
        criteria: ['low', 'medium', 'high'],
      },
    },
  })
}

// Pure: laya's answers to a verdict. An abstained or missing answer is undefined,
// so the chain falls through to the next backend.
export function layaVerdict(answers: any): Verdict | undefined {
  const t = answers?.tier
  const e = answers?.effort
  if (!t || !e || t.abstention || e.abstention) return undefined
  const tier = t.choice
  const effort = typeof e.score === 'number' ? EFFORTS[e.score] : e.score
  if (!TIERS.includes(tier) || !EFFORTS.includes(effort)) return undefined
  return { tier, effort, reason: 'laya' }
}
