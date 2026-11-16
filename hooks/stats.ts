// Stats (17q): what arne saved, from the usage rows in arne's log. An estimate: each turn's real
// tokens priced again as if it ran on a baseline model. Effort has no price of its own here: a different
// effort or model would have written different output, and that cannot be known, so the tokens stay as they were.
import { dollars, OUT, priceAt, READ, tierOf, WRITE } from './econ'
import type { Tier } from './route'

export type UsageRow = {
  type: 'usage'
  at: number
  kind: 'turn' | 'agent' | 'summary' | 'jev' | 'judge' // jev: one Jev judge call, its tokens only (17s); judge: one Haiku judge call
  model: string
  input: number
  read: number
  write: number
  out: number
  switched?: boolean // the turn right after arne's own /model: its cache writes are the switch's cost
  own?: string // the model without arne: a subagent's named one or Explore's Haiku; a pinned turn's own (set by parseUsage)
}

export type Period = 'today' | 'week' | 'all'
export const PERIODS: [Period, string][] = [['today', 'Today'], ['week', '7 days'], ['all', 'All time']]

/** The first timestamp a period takes in: local midnight today, seven days back, or the beginning. */
export function periodStart(period: Period, now: number): number {
  if (period === 'all') return 0
  if (period === 'week') return now - 7 * 24 * 60 * 60_000
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** A usage row from turn.complete's usage, or undefined when the turn reported none. */
export function usageRow(
  kind: UsageRow['kind'],
  at: number,
  usage: { model?: string; input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } | undefined,
  model?: string,
  switched?: boolean,
): UsageRow | undefined {
  const m = usage?.model ?? model
  if (!usage || !m || !tierOf(m)) return undefined
  return {
    type: 'usage',
    at,
    kind,
    model: m,
    input: usage.input_tokens ?? 0,
    read: usage.cache_read_input_tokens ?? 0,
    // The usage carries no 5m/1h split; Claude Code writes the 1h cache (econ.ts WRITE).
    write: usage.cache_creation_input_tokens ?? 0,
    out: usage.output_tokens ?? 0,
    ...(switched ? { switched: true } : {}),
  }
}

/**
 * Dollars for a row's tokens on a tier. `asRead` prices the cache writes as reads (no switch happened).
 * ponytail: a row is a whole turn, so its tokens are summed over the turn's requests; Haiku's over-100k rate
 * is applied when that sum passes 100k, which overprices a many-step Haiku turn. Log per-request sizes to fix it.
 */
export const priceOn = (r: UsageRow, t: Tier, asRead = false) =>
  dollars(priceAt(t, r.input + r.read + r.write) * (r.input + r.read * READ[t] + r.write * (asRead ? READ[t] : WRITE) + r.out * OUT))

export type Line = { label: string; count: number; cost: number; tokens?: number } // tokens: a line with no known price (Jev)
export type Summary = { spent: number; opus: number; sonnet: number; lines: Line[]; turns: number }

/** Totals for the rows at or after `since`. Rows without usage never get here (usageRow drops them). */
export function summarize(rows: UsageRow[], since: number): Summary {
  const picked = rows.filter(r => r.at >= since && tierOf(r.model))
  // Jev's prices are not published (17s): its calls count in tokens, on their own line, outside the dollars.
  const jevRows = rows.filter(r => r.at >= since && r.kind === 'jev')
  const jev: Line = { label: 'Jev judge', count: jevRows.length, cost: 0, tokens: jevRows.reduce((n, r) => n + r.input + r.out, 0) }
  const tiers: [Tier, string][] = [['S', 'Haiku'], ['M', 'Sonnet'], ['L', 'Opus']]
  const byTier = new Map<Tier, Line>(tiers.map(([t, label]) => [t, { label, count: 0, cost: 0 }]))
  const agents: Line = { label: 'Subagents', count: 0, cost: 0 }
  const extra: Line = { label: 'Switches and summaries', count: 0, cost: 0 }
  const judge: Line = { label: 'Haiku judge', count: 0, cost: 0 }
  let spent = 0
  let opus = 0
  let sonnet = 0
  for (const r of picked) {
    const t = tierOf(r.model)!
    const cost = priceOn(r, t)
    spent += cost
    if (r.kind === 'summary') {
      // A summary is arne's own spend: the default would not have made one.
      extra.count++
      extra.cost += cost
      continue
    }
    if (r.kind === 'judge') {
      // So is the judge: no baseline asks a model which model to use.
      judge.count++
      judge.cost += cost
      continue
    }
    // The default stays on one model, so it never pays a switch's cache rewrite: its writes read as reads.
    // A subagent with a model of its own (Explore's Haiku) runs on that in every baseline.
    const own = r.own ? tierOf(r.own) : undefined
    opus += priceOn(r, own ?? 'L', r.switched)
    sonnet += priceOn(r, own ?? 'M', r.switched)
    const switchCost = r.switched ? cost - priceOn(r, t, true) : 0
    if (r.switched) {
      extra.count++
      extra.cost += switchCost
    }
    const line = r.kind === 'agent' ? agents : byTier.get(t)!
    line.count++
    line.cost += cost - switchCost
  }
  const lines = [...byTier.values(), agents, extra, judge, jev].filter(l => l.count > 0)
  return { spent, opus, sonnet, lines, turns: picked.filter(r => r.kind !== 'summary' && r.kind !== 'judge').length }
}

/** "Saved $X" against a baseline, or "$X more" when arne cost more; with the percent of the baseline. */
export function savedText(spent: number, base: number): { headline: string; sub: string } {
  // Cents first: a -$0.003 gap must not read '$0.00 more'.
  const raw = base - spent
  const diff = Math.round(raw * 100) / 100
  const pct = base > 0 ? Math.round((Math.abs(raw) / base) * 100) : 0
  const usd = (v: number) => `$${v.toFixed(2)}`
  return {
    headline: diff >= 0 ? `Saved ${usd(diff)}` : `${usd(-diff)} more`,
    sub: `${pct}% ${diff >= 0 ? 'less' : 'more'} than ${usd(base)}`,
  }
}

/**
 * The usage rows of a log text; broken lines are skipped. A turn that follows a pin decision gets `own`: the
 * person picked that model, so every baseline runs it there too.
 * ponytail: the match is by order in the text (a prompt's decision row, then its turn row). The old single
 * log file mixes chats, so two chats at once there can mismatch; write `own` on the row at turn.complete if it matters.
 */
export function parseUsage(text: string): UsageRow[] {
  const rows: UsageRow[] = []
  let pinned = false
  for (const line of text.split('\n')) {
    const usage = line.includes('"type":"usage"')
    if (!usage && !line.includes('"source":"')) continue
    try {
      const r = JSON.parse(line)
      if (!usage) {
        // The chat's own decision row: no type (not feedback), and not a subagent's.
        if (!r.type && !String(r.key).startsWith('agent:')) pinned = r.source === 'pin'
      } else if (r.type === 'usage' && typeof r.at === 'number' && typeof r.model === 'string') {
        const mine = pinned && r.kind === 'turn' && !r.own
        rows.push(mine ? { ...r, own: r.model } : r)
        if (r.kind === 'turn') pinned = false // one decision, one turn
      }
    } catch {
      // a torn line: skipped
    }
  }
  return rows
}
