// Pure cost model, in units of one Sonnet uncached input token.
// Ratios from effortless 1.71.0 (MIT, HeyCubit): MODEL_PRICE, WEIGHT and the measured 1h cache write.
import type { Tier } from './route'

export const PRICE: Record<Tier, number> = { S: 1 / 3, M: 1, L: 2 }
export const READ = 0.1 // cache read, × input price
export const WRITE = 2 // Claude Code writes the 1h cache: 2× input price (measured)
export const OUT = 5 // output, × input price

/** First request of the next prompt when staying on `m`: a read when warm, a full re-write when cold. */
export const costContinue = (C: number, m: Tier, warm: boolean) => C * PRICE[m] * (warm ? READ : WRITE)

/** First request after moving to `to`. */
export const costSwitch = (C: number, to: Tier, warmTo: boolean) => costContinue(C, to, warmTo)

/** Haiku reads the chat once (uncached), writes summary S, then `m` writes S to its cache. */
export const costCompact = (C: number, S: number, m: Tier) => C * PRICE.S + OUT * S * PRICE.S + WRITE * S * PRICE[m]

/** Whether moving one prompt from `inUse` to `to` is cheaper than staying (effortless's routeWorth). */
export function routeWorth(to: Tier, inUse: Tier, C: number, warm: { to: boolean; inUse: boolean }): boolean {
  if (!(C > 0)) return true
  return costSwitch(C, to, warm.to) < costContinue(C, inUse, warm.inUse)
}

export type Row = { action: 'continue' | 'switch' | 'compact' | 'handoff'; to?: Tier; first: number; after: number }

/**
 * The options for the next prompt on a chat of C tokens on model m, cheapest first.
 * `first` is the first request's cost, `after` each later request's. S is the expected summary size;
 * a handoff also carries HANDOFF.md (`doc` tokens).
 */
export function coldAdvice(
  C: number,
  m: Tier,
  warmUntil: Partial<Record<Tier, number>>,
  now: number,
  S = 4000,
  doc = 2000,
): { best: Row; rows: Row[] } {
  const warm = (t: Tier) => (warmUntil[t] ?? 0) > now
  const rows: Row[] = [
    { action: 'continue', first: costContinue(C, m, warm(m)), after: C * PRICE[m] * READ },
    ...(['S', 'M', 'L'] as Tier[])
      .filter(t => t !== m && PRICE[t] < PRICE[m])
      .map(t => ({ action: 'switch' as const, to: t, first: costSwitch(C, t, warm(t)), after: C * PRICE[t] * READ })),
    { action: 'compact', first: costCompact(C, S, m), after: S * PRICE[m] * READ },
    { action: 'handoff', first: costCompact(C, S + doc, m), after: (S + doc) * PRICE[m] * READ },
  ]
  rows.sort((a, b) => a.first - b.first)
  return { best: rows[0], rows }
}

/** Units to dollars: Sonnet 5.5 input is $3 per million tokens. ponytail: fixed rate, read real prices if they change. */
export const dollars = (units: number) => (units * 3) / 1e6

// --- Cache clock helpers (ported from effortless cacheTtlOf / mostlyCached) ---

export const CACHE_TTL = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
export type Ttl = keyof typeof CACHE_TTL
type Usage = {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
}

/** The cache lifetime a response's writes got, when it says. */
export function cacheTtlOf(usage: unknown): Ttl | undefined {
  const c = (usage as Usage | null)?.cache_creation
  if ((c?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
  if ((c?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
  return undefined
}

/** Most of the prompt came from the cache: it was still warm. */
export function mostlyCached(usage: unknown): boolean {
  const u = (usage ?? {}) as Usage
  const r = u.cache_read_input_tokens ?? 0
  const all = r + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return all > 0 && r / all > 0.5
}

/** Context size C: everything the request sent. */
export const contextOf = (usage: unknown) => {
  const u = (usage ?? {}) as Usage
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/**
 * The TTL after a response. A read back after more than 5 minutes proves 1h; once 1h is seen,
 * a short 5m tail write never pulls it back down.
 */
export function nextTtl(prev: Ttl, usage: unknown, sinceLastMs: number | undefined): Ttl {
  const seen = cacheTtlOf(usage) ?? (sinceLastMs !== undefined && sinceLastMs > CACHE_TTL['5m'] && mostlyCached(usage) ? '1h' : undefined)
  if (!seen || (seen === '5m' && prev === '1h' && mostlyCached(usage))) return prev
  return seen
}

export const tierOf = (model: string): Tier | undefined =>
  /haiku/.test(model) ? 'S' : /sonnet/.test(model) ? 'M' : /opus/.test(model) ? 'L' : undefined

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type SwitchPlan = { tier: Tier; real: boolean; why: 'same' | 'boundary' | 'worth' | 'sticky' }

/**
 * Where this prompt's requests go, and whether the real /model moves.
 * The real model changes only at a cache boundary (chat model cold, or right after a compact).
 * While warm, requests stay on the chat's model unless routeWorth says the move pays.
 */
export function planSwitch(p: {
  decided: Tier
  chat: Tier
  C: number
  warmUntil: Partial<Record<Tier, number>>
  now: number
  afterCompact: boolean
}): SwitchPlan {
  const { decided, chat, C, warmUntil, now } = p
  if (decided === chat) return { tier: chat, real: false, why: 'same' }
  const warm = (t: Tier) => (warmUntil[t] ?? 0) > now
  if (p.afterCompact || !warm(chat)) return { tier: decided, real: true, why: 'boundary' }
  if (routeWorth(decided, chat, C, { to: warm(decided), inUse: true })) return { tier: decided, real: false, why: 'worth' }
  return { tier: chat, real: false, why: 'sticky' }
}

/** The prompt for Haiku's summary: the transcript as text, the last part if it is long. */
export function summaryPrompt(messages: readonly { role: string; text: string }[], maxChars = 300_000): string {
  const all = messages.map(m => `${m.role}: ${m.text}`).join('\n\n')
  return all.length > maxChars ? all.slice(-maxChars) : all
}

/** The last turn stopped mid-task: it did not end on an answer, or the compact summary names a next step. */
export const midTask = (reason: string | undefined, summary: string) =>
  (reason !== undefined && reason !== 'answer') || /next step[^\n:]*:\s*(?!none|n\/a|nothing)\S/i.test(summary)

// --- Band indicator (step 14) ---

export const WINDOW = 200_000 // context window used for the ◔ fill; ponytail: fixed, read the model's limit if it changes
export const HEAVY_TOKENS = 150_000 // over this, the band warns that the chat is large
export type BandState = 'routing' | 'off' | 'paused' | 'cold' | 'heavy' | 'normal'
export type BandInput = {
  off: boolean
  paused: boolean
  routing: boolean
  model: string // full model id of the last decision
  effort?: string
  warmLeftMs: number // ms until the chat's model cache goes cold; 0 or less = cold
  C: number
  flash?: boolean
  heavyTokens?: number
}

const SHORT: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
const EFFORT_SHORT: Record<string, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhi', max: 'max' }
export const shortModel = (model: string) => SHORT[(/haiku|sonnet|opus/.exec(model)?.[0] ?? '')] ?? model
export const shortEffort = (effort?: string) => (effort ? EFFORT_SHORT[effort] ?? effort : '-')

/** The band's state and its two texts: `text` for the band, `short` for the status line. */
export function bandText(i: BandInput): { state: BandState; text: string; short: string } {
  const label = `${shortModel(i.model)} · ${shortEffort(i.effort)}`
  const k = `${Math.round(i.C / 1000)}k`
  const pct = `${Math.round((i.C / WINDOW) * 100)}%`
  const flash = i.flash ? ' ▲' : ''
  // `short` goes to the status line, which the footer already labels with the plugin's name.
  if (i.off) return { state: 'off', text: `off · ${label}`, short: 'off' }
  if (i.routing) return { state: 'routing', text: 'routing…', short: '…' }
  if (i.paused) return { state: 'paused', text: `paused · ${label} (you picked it; /arne on resumes)`, short: `paused · you picked ${shortModel(i.model)}` }
  if (i.C > 0 && i.warmLeftMs <= 0) return { state: 'cold', text: `cold · ${k} · see the offer below`, short: `cold ${k}` }
  if (i.C >= (i.heavyTokens ?? HEAVY_TOKENS)) return { state: 'heavy', text: `${label} · heavy ${k} · ◔ ${pct}`, short: `${shortModel(i.model)}·${shortEffort(i.effort)} heavy` }
  return {
    state: 'normal',
    text: `${label} · cache ${mmss(i.warmLeftMs)} · ◔ ${pct}${flash}`,
    short: `${shortModel(i.model)}·${shortEffort(i.effort)}${flash}`,
  }
}

// --- Settings clamps (step 15) ---

const TIER_NAME: Record<string, Tier> = { haiku: 'S', sonnet: 'M', opus: 'L' }
const TIER_RANK: Record<Tier, number> = { S: 0, M: 1, L: 2 }
export const EFFORT_RANK: Record<string, number> ={ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

/** A tier kept between the floor and ceiling model names (haiku|sonnet|opus). */
export function clampTier(tier: Tier, floor: string, ceiling: string): Tier {
  const lo = TIER_RANK[TIER_NAME[floor] ?? 'S']
  const hi = TIER_RANK[TIER_NAME[ceiling] ?? 'L']
  const r = Math.min(Math.max(TIER_RANK[tier], lo), Math.max(lo, hi))
  return (['S', 'M', 'L'] as Tier[])[r]
}

/** An effort kept between the floor and ceiling names. */
export function clampEffort<E extends string>(effort: E, floor: string, ceiling: string): E {
  const lo = EFFORT_RANK[floor] ?? 0
  const hi = EFFORT_RANK[ceiling] ?? 4
  const r = Math.min(Math.max(EFFORT_RANK[effort] ?? 1, lo), Math.max(lo, hi))
  return (Object.keys(EFFORT_RANK).find(k => EFFORT_RANK[k] === r) ?? effort) as E
}
