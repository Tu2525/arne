import { expect, test } from 'claude-code/testing'

import { parseUsage, periodStart, priceOn, savedText, summarize, usageRow } from './stats'
import type { UsageRow } from './stats'

const close = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9).toBe(true)
const row = (over: Partial<UsageRow>): UsageRow => ({ type: 'usage', at: 0, kind: 'turn', model: 'claude-haiku-5-5', input: 1000, read: 100_000, write: 0, out: 2000, ...over })

test('a known usage row prices to the expected dollars on both sides (17q)', () => {
  // 1000 in + 100k read × 0.05 + 2000 out × 5 = 16k input units; × $2/M on Sonnet, × 2 on Opus.
  // Haiku reads at 0.1× (21k units) and the prompt is past 100k, so × 0.25; under 100k it is × 0.05.
  const r = row({})
  close(priceOn(r, 'M'), 0.032)
  close(priceOn(r, 'L'), 0.064)
  close(priceOn(r, 'S'), 0.0105)
  close(priceOn(row({ read: 50_000 }), 'S'), 0.0016)
  const s = summarize([r], 0)
  close(s.spent, 0.0105)
  close(s.opus, 0.064)
  expect(savedText(s.spent, s.opus)).toEqual({ headline: 'Saved $0.05', sub: '84% less than $0.06' })
  expect(savedText(0.2, 0.1).headline).toBe('$0.10 more')
  expect(savedText(0.103, 0.1).headline).toBe('Saved $0.00')
})

test('a switch and a summary count against arne, in their own line (17q)', () => {
  const switched = row({ model: 'claude-opus-5-5', write: 100_000, read: 0, switched: true })
  const summary = row({ kind: 'summary', read: 0, input: 100_000, out: 1000 })
  const s = summarize([switched, summary], 0)
  // The default never rewrote the cache: its side prices those writes as reads.
  close(s.opus, priceOn(switched, 'L', true))
  const extra = s.lines.find(l => l.label === 'Switches and summaries')!
  expect(extra.count).toBe(2)
  close(extra.cost, priceOn(switched, 'L') - priceOn(switched, 'L', true) + priceOn(summary, 'S'))
  close(s.lines.find(l => l.label === 'Opus')!.cost, priceOn(switched, 'L', true))
})

test('a period filter keeps rows on fixed timestamps only from its start (17q)', () => {
  const now = new Date(2026, 9, 19, 15, 0).getTime()
  const midnight = new Date(2026, 9, 19).getTime()
  expect(periodStart('today', now)).toBe(midnight)
  expect(periodStart('week', now)).toBe(now - 7 * 86_400_000)
  expect(periodStart('all', now)).toBe(0)
  const rows = [row({ at: midnight - 1 }), row({ at: midnight }), row({ at: now - 8 * 86_400_000 })]
  expect(summarize(rows, periodStart('today', now)).turns).toBe(1)
  expect(summarize(rows, periodStart('week', now)).turns).toBe(2)
  expect(summarize(rows, periodStart('all', now)).turns).toBe(3)
})

test('a row without usage is skipped, not guessed (17q)', () => {
  expect(usageRow('turn', 1, undefined, 'claude-opus-5-5')).toBe(undefined)
  const text = [
    JSON.stringify({ key: 't1', model: 'claude-opus-5-5', effort: 'high' }), // an older decision row
    JSON.stringify(usageRow('turn', 5, { model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })),
    '{"type":"usage", torn',
  ].join('\n')
  const rows = parseUsage(text)
  expect(rows.length).toBe(1)
  expect(rows[0]!.model).toBe('claude-sonnet-5-5')
})

test('a pinned turn is priced on the pinned model in both baselines; the turn after a routed prompt is not', () => {
  const dec = (source: string, key = 'm1') => JSON.stringify({ key, model: 'claude-opus-5-5', effort: 'high', reason: source, source, out: 0, cacheRead: 0, text: 'x' })
  const opus = JSON.stringify(row({ model: 'claude-opus-5-5' }))
  const text = [
    dec('pin'),
    dec('haiku', 'agent:a1'), // a subagent's decision between the prompt and its turn changes nothing
    JSON.stringify({ type: 'feedback', key: 'm0', verdict: 'good', source: 'haiku' }),
    opus, // pinned
    opus, // no decision of its own: not pinned
    dec('escalate'),
    opus, // arne's pick
  ].join('\n')
  const rows = parseUsage(text)
  expect(rows.map(r => r.own)).toEqual(['claude-opus-5-5', undefined, undefined])
  const s = summarize(rows, 0)
  const r = rows[1]!
  close(s.spent, 3 * priceOn(r, 'L'))
  close(s.opus, 3 * priceOn(r, 'L'))
  close(s.sonnet, priceOn(r, 'L') + 2 * priceOn(r, 'M'))
})

test('the judge counts against arne, and a subagent with its own model keeps it in both baselines', () => {
  const turn = row({})
  const judge = row({ kind: 'judge', read: 0, input: 3000, out: 20 })
  const explore = row({ kind: 'agent', own: 'claude-haiku-5-5' })
  const s = summarize([turn, judge, explore], 0)
  // Explore runs on Haiku with or without arne: it adds the same dollars to every side.
  close(s.opus, priceOn(turn, 'L') + priceOn(explore, 'S'))
  close(s.sonnet, priceOn(turn, 'M') + priceOn(explore, 'S'))
  close(s.spent, priceOn(turn, 'S') + priceOn(judge, 'S') + priceOn(explore, 'S'))
  expect(s.lines.find(l => l.label === 'Haiku judge')!.count).toBe(1)
  expect(s.turns).toBe(2)
})
