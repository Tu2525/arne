export type Row = {
  key: string // turnId, plus agentId for subagent runs
  model: string
  effort: string
  reason: string
  source: string
  out: number // output tokens, summed over the turn's steps
  cacheRead: number // cache-read input tokens, summed
}

declare module 'claude-code' {
  interface PluginState {
    arne: { last: Row | null; log: Row[] }
  }
}
