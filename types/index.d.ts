// Self-contained (the validator allows no import): kept equal to hooks/route.ts and hooks/stats.ts by hand.
export type Tier = 'S' | 'M' | 'L'
export type Decision = { tier: Tier; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; reason: string; source: string; keepEffort?: boolean; above?: boolean }
export type Line = { label: string; count: number; cost: number; tokens?: number }
export type Summary = { spent: number; opus: number; sonnet: number; lines: Line[]; turns: number }

export type Row = {
  key: string // turnId, plus agentId for subagent runs
  model: string
  effort: string
  reason: string
  source: string
  out: number // output tokens, summed over the turn's steps
  cacheRead: number // cache-read input tokens, summed
  waitFor?: string // full model id the decision wanted, when the chat stays on another model until the cache cools
}

export type Cache = {
  ttl: '5m' | '1h'
  C: number // context tokens of the last main response
  model: 'S' | 'M' | 'L' // the tier that answered last
  warmUntil: Partial<Record<'S' | 'M' | 'L', number>> // epoch ms, per tier
}

declare module 'claude-code' {
  interface PluginState {
    arne: { last: Row | null; log: Row[]; cache: Cache | null; now: number; coldDismissed: number; routing: boolean; isOff: boolean; isPaused: boolean; appEffort: string | null; sessionModel: string | null; held: string | null; shown: { state: string; until: number } | null; effortless: boolean; whyOpen: boolean; thanked: string | null; layaDown: boolean; jevNoKey: boolean; appPicker: string | null; statsPeriod: string; liveRev: number; pinRev: number; heavyDismissed: number; compacting: boolean; disabling: boolean; effortlessOff: boolean; current: Decision | null; expected: string | null; compactSending: boolean; handedOff: Tier | null; handoffMenu: boolean; panelView: 'main' | 'settings' | 'stats'; subCount: Partial<Record<Tier | 'kept' | 'asked' | 'capped', number>> | null; stats: Record<string, Summary> | null; untiered: { chat: string; pick: 'stay' | 'route' } | null; route: { prev: Decision | null; hold: { tier: Tier; left: number } | null; failures: number } }
  }
}
