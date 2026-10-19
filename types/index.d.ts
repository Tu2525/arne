export type Row = {
  key: string // turnId, plus agentId for subagent runs
  model: string
  effort: string
  reason: string
  source: string
  out: number // output tokens, summed over the turn's steps
  cacheRead: number // cache-read input tokens, summed
}

export type Cache = {
  ttl: '5m' | '1h'
  C: number // context tokens of the last main response
  model: 'S' | 'M' | 'L' // the tier that answered last
  warmUntil: Partial<Record<'S' | 'M' | 'L', number>> // epoch ms, per tier
}

declare module 'claude-code' {
  interface PluginState {
    arne: { last: Row | null; log: Row[]; cache: Cache | null; now: number; coldDismissed: number; routing: boolean; isOff: boolean; shown: { state: string; until: number } | null }
  }
}
