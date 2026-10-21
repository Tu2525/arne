import type { Tier, Effort, Verdict } from './route'

const TIERS: Tier[] = ['S', 'M', 'L']
// ponytail: the judge never picks above high. xhigh and max are reached only by a pin or a floor, so a
// judge's answer cannot raise the cost of a turn past what the person allowed.
const EFFORTS: Effort[] = ['low', 'medium', 'high']

export const SYSTEM = `You route a coding-assistant prompt to a model tier. Reply with JSON only:
{"tier":"S|M|L","effort":"low|medium|high","reason":"<6 words>"}
S = trivial lookup or edit, or a search, read or list (a subagent's brief to find or map code is S).
M = normal coding, including multi-step or multi-file chores: edits, re-renders, commits, running tools.
L = only when the hard part is the thinking: architecture, a race or subtle bug, a security review.
Many steps is not L: the model hands searches and grunt work to cheap subagents. When unsure, pick M.`

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

// System One (17s): laya-serve here and Jev at TypeSafe speak the same POST /v1/systemone.
export const LAYA_URL = 'http://127.0.0.1:8000'
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
export const SYSTEM_ONE_TIMEOUT_MS = 1500
// Below this an answer falls through to the next judge. ponytail: untuned; step 8 measures it.
export const MIN_CONFIDENCE = 0.5

// Request body: two typed questions in one call, read against the task card and the prompt.
export function systemOneBody(text: string, task = '', model?: string): string {
  return JSON.stringify({
    state: { ...(task ? { task } : {}), prompt: text.slice(0, 4000) },
    ...(model ? { model } : {}),
    min_confidence: MIN_CONFIDENCE,
    questions: {
      tier: {
        type: 'choice',
        instructions: 'How hard is this coding-assistant request?',
        criteria: {
          S: 'trivial lookup, typo, rename, format, one-line answer, a search or read of the code',
          M: 'normal coding, including multi-step or multi-file chores: edits, re-renders, commits, running tools',
          L: 'only when the hard part is the thinking: architecture, a race or subtle bug, a security review',
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

// The most likely key of an answer's probabilities: an option name for a choice, a level index for a score.
function argmax(p: unknown): string | undefined {
  if (!p || typeof p !== 'object') return undefined
  let best: [string, number] | undefined
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && (!best || v > best[1])) best = [k, v]
  return best?.[0]
}

// Pure: System One's answers to a verdict, by argmax over each answer's probabilities. A score is an
// expectation (0.67 between two levels), never an index. An abstained, unsure or missing answer is
// undefined, so the chain falls through to the next judge.
export function systemOneVerdict(answers: any, reason = 'system one'): Verdict | undefined {
  const t = answers?.tier
  const e = answers?.effort
  if (!t || !e || t.abstention || e.abstention) return undefined
  if ((typeof t.confidence === 'number' && t.confidence < MIN_CONFIDENCE) || (typeof e.confidence === 'number' && e.confidence < MIN_CONFIDENCE)) return undefined
  const tier = argmax(t.probabilities) ?? t.choice
  const level = argmax(e.probabilities)
  // No probabilities (an older laya-serve): a whole-number score is still a level.
  const effort = level !== undefined ? EFFORTS[Number(level)] : Number.isInteger(e.score) ? EFFORTS[e.score] : undefined
  if (!TIERS.includes(tier) || !effort) return undefined
  return { tier, effort, reason }
}
