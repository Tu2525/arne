process.env.TZ = 'Pacific/Auckland' // the holiday bug only shows east of UTC
import test from 'node:test'
import assert from 'node:assert/strict'
import { addBusinessDays, isBusinessDay } from './business.mjs'

const ymd = d => [d.getFullYear(), d.getMonth() + 1, d.getDate()]

test('skips weekends', () => {
  assert.deepEqual(ymd(addBusinessDays(new Date(2025, 11, 12), 1)), [2025, 12, 15])
})
test('skips a holiday', () => {
  assert.deepEqual(ymd(addBusinessDays(new Date(2025, 11, 24), 1)), [2025, 12, 26])
})
test('holiday on a Friday', () => {
  assert.deepEqual(ymd(addBusinessDays(new Date(2026, 3, 2), 1)), [2026, 4, 6])
})
test('negative n goes back', () => {
  assert.deepEqual(ymd(addBusinessDays(new Date(2026, 0, 6), -1)), [2026, 1, 5])
})
test('negative n skips the new year holiday', () => {
  assert.deepEqual(ymd(addBusinessDays(new Date(2026, 0, 5), -2)), [2025, 12, 31])
})
test('zero returns the same day and does not mutate', () => {
  const d = new Date(2025, 11, 12)
  assert.deepEqual(ymd(addBusinessDays(d, 0)), [2025, 12, 12])
  assert.deepEqual(ymd(d), [2025, 12, 12])
})
test('isBusinessDay', () => {
  assert.equal(isBusinessDay(new Date(2025, 11, 25)), false)
  assert.equal(isBusinessDay(new Date(2025, 11, 26)), true)
})
