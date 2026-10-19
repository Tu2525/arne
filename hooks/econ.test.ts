import { expect, test } from 'claude-code/testing'

import { coldAdvice, costCompact, costContinue, routeWorth } from './econ'

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
