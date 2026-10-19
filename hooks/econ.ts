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
