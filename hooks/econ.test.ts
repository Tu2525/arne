import { expect, test } from 'claude-code/testing'

import { cacheTtlOf, coldAdvice, contextOf, costCompact, costContinue, mmss, nextTtl, planSwitch, routeWorth, summaryPrompt, tierOf, bandText, clampEffort, clampTier, midTask, fillOf, fitRest, fitTier, plainReason } from './econ'

const near = (got: number, want: number) => expect(Math.abs(got - want) / want <= 0.05).toBe(true)

test('worked example: cold Opus chat, C = 150k, S = 4k', () => {
  near(costContinue(150_000, 'L', false), 600_000)
  near(costCompact(150_000, 4000, 'L'), 73_000)
  near(costContinue(150_000, 'L', true), 30_000)
  const { best } = coldAdvice(150_000, 'L', {}, 0)
  expect(best.action).toBe('compact')
  near(best.after, 800)
})

test('warm Opus chat: compact pays back in about 3 requests', () => {
  const perReq = costContinue(150_000, 'L', true) - 800
  near(costCompact(150_000, 4000, 'L') / perReq, 2.5)
  expect(coldAdvice(150_000, 'L', { L: 10 }, 0).best.action).toBe('continue')
})

test('routeWorth: warm 80k Opus to cold Haiku does not pay', () => {
  expect(routeWorth('S', 'L', 80_000, { to: false, inUse: true })).toBe(false)
  expect(routeWorth('S', 'L', 80_000, { to: false, inUse: false })).toBe(true)
  expect(routeWorth('S', 'L', 0, { to: false, inUse: true })).toBe(true)
})

test('cache clock helpers', () => {
  expect(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 5 } })).toBe('1h')
  expect(cacheTtlOf({})).toBe(undefined)
  const warmRead = { cache_read_input_tokens: 90, input_tokens: 10 }
  expect(nextTtl('5m', warmRead, 10 * 60_000)).toBe('1h')
  expect(nextTtl('1h', { ...warmRead, cache_creation: { ephemeral_5m_input_tokens: 3 } }, 1000)).toBe('1h')
  expect(contextOf({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 })).toBe(6)
  expect(tierOf('claude-sonnet-5-5')).toBe('M')
  expect(mmss(60 * 60_000)).toBe('60:00')
  expect(mmss(61_500)).toBe('1:02')
})

test('planSwitch: real /model moves only at a boundary', () => {
  const base = { decided: 'M' as const, chat: 'L' as const, C: 80_000, now: 1000 }
  expect(planSwitch({ ...base, warmUntil: {} })).toEqual({ tier: 'M', real: true, why: 'boundary' })
  expect(planSwitch({ ...base, warmUntil: { L: 5000 } })).toEqual({ tier: 'L', real: false, why: 'sticky' })
  expect(planSwitch({ ...base, C: 0, warmUntil: { L: 5000 } }).why).toBe('worth')
  expect(planSwitch({ ...base, decided: 'L', warmUntil: {} }).why).toBe('same')
})

test('summaryPrompt keeps the tail when long', () => {
  expect(summaryPrompt([{ role: 'user', text: 'hi' }])).toBe('user: hi')
  expect(summaryPrompt([{ role: 'user', text: 'abcdef' }], 3)).toBe('def')
})

test('bandText states', () => {
  const base = { off: false, paused: false, routing: false, model: 'claude-sonnet-5-5', effort: 'medium', warmLeftMs: 38 * 60_000 + 10_000, C: 80_000 }
  expect(bandText(base).text).toBe('Sonnet · med · cache warm 38:10 · 80k')
  expect(bandText(base).short).toBe('Sonnet·med')
  // The footer already names the plugin: no status text repeats "arne".
  for (const s of [{ off: true }, { paused: true }, { routing: true }, { C: 160_000 }, { warmLeftMs: 0, C: 120_000 }]) {
    expect(bandText({ ...base, ...s }).short.startsWith('arne')).toBe(false)
  }
  // Paused shows the model the person picked, not arne's last decision.
  expect(bandText({ ...base, paused: true, model: 'claude-opus-5-5' }).short).toBe('paused · you picked Opus')
  expect(bandText({ ...base, routing: true }).state).toBe('routing')
  expect(bandText({ ...base, paused: true }).state).toBe('paused')
  expect(bandText({ ...base, warmLeftMs: 0, C: 120_000 }).state).toBe('cold')
  expect(bandText({ ...base, C: 160_000 }).state).toBe('heavy')
  expect(bandText({ ...base, off: true }).state).toBe('off')
})

test('midTask: resume after /compact only when the work stopped mid-way', () => {
  expect(midTask('answer', 'Goal: x\nNext step: none')).toBe(false)
  expect(midTask('answer', 'Goal: x\nNext step: run the tests')).toBe(true)
  expect(midTask('aborted', '')).toBe(true)
  expect(midTask(undefined, 'no steps listed')).toBe(false)
})

test('clamps keep tiers and efforts inside the floor and ceiling', () => {
  expect(clampTier('S', 'sonnet', 'opus')).toBe('M')
  expect(clampTier('L', 'haiku', 'sonnet')).toBe('M')
  expect(clampTier('M', 'haiku', 'opus')).toBe('M')
  expect(clampEffort('low', 'medium', 'high')).toBe('medium')
  expect(clampEffort('max', 'low', 'high')).toBe('high')
  expect(clampEffort('max', 'low', 'max')).toBe('max')
  expect(clampEffort('xhigh', 'low', 'high')).toBe('high')
})

test('the context fill uses the routed tier window and never passes 100 (17i)', () => {
  expect(fillOf(263_000, 'S')).toBe(100) // Haiku's 200k window: capped, not 132
  expect(fillOf(263_000, 'M')).toBe(26)
  expect(fillOf(132_000, 'S')).toBe(66)
  const base = { off: false, paused: false, routing: false, model: 'claude-haiku-5-5', effort: 'medium', warmLeftMs: 60_000, C: 263_000 }
  expect(bandText(base).text).not.toMatch(/132%/)
})

test('a chat too big for a tier moves to the next, never below the asked tier (17i)', () => {
  expect(fitTier('S', 263_000)).toBe('M')
  expect(fitTier('S', 150_000)).toBe('S')
  expect(fitTier('L', 2_000_000)).toBe('L') // no window fits: the largest tier
  expect(fitTier('M', 10)).toBe('M')
})

test('internal reason codes read as plain words (17i)', () => {
  expect(plainReason('fast: hard')).toBe('this looks hard')
  expect(plainReason('prior: Explore')).toBe('Explore is a fixed rule')
  expect(plainReason('continuation')).toBe('it continues the last turn')
  expect(plainReason('Looks like a rename')).toBe('Looks like a rename')
})

test('the resting line keeps arne and the model, cuts the reason first, and steps the cache down (17i)', () => {
  const caches = ['cache warm 42m · 263k', 'cache 42m', '42m']
  const head = 'arne  Haiku · medium'
  const reason = 'Opus fits better; switching waits for the cache'
  const wide = fitRest(100, head, reason, caches)
  expect(wide.cache).toBe(caches[0])
  expect(wide.reason).toBe(reason)
  const mid = fitRest(50, head, reason, caches)
  expect(mid.head).toBe(head)
  expect(mid.cache).toBe(caches[1])
  expect(mid.reason.endsWith('…')).toBe(true)
  expect(`${mid.head}  ${mid.reason}  ${mid.cache}`.length).toBeLessThanOrEqual(50)
  expect(fitRest(30, head, 'x', caches).cache).toBe('42m')
})
