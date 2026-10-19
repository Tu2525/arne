import { expect, test } from 'claude-code/testing'

import { parseUsage, periodStart, priceOn, savedText, summarize, usageRow } from './stats'
import type { UsageRow } from './stats'

const close = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9).toBe(true)
const row = (over: Partial<UsageRow>): UsageRow => ({ type: 'usage', at: 0, kind: 'turn', model: 'claude-haiku-5-5', input: 1000, read: 100_000, write: 0, out: 2000, ...over })

test('a known usage row prices to the expected dollars on both sides (17q)', () => {
  // 1000 in + 100k read × 0.1 + 2000 out × 5 = 21k input units; × $3/M on Sonnet, × 2 on Opus, ÷ 3 on Haiku.
  const r = row({})
  close(priceOn(r, 'M'), 0.063)
  close(priceOn(r, 'L'), 0.126)
  close(priceOn(r, 'S'), 0.021)
  const s = summarize([r], 0)
  close(s.spent, 0.021)
  close(s.sonnet, 0.063)
  close(s.opus, 0.126)
  expect(savedText(s.spent, s.opus)).toEqual({ headline: 'Saved $0.10', sub: '83% less than $0.13' })
  expect(savedText(0.2, 0.1).headline).toBe('$0.10 more')
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
