import test from 'node:test'
import assert from 'node:assert/strict'
import { allocate } from './money.mjs'

const sum = a => a.reduce((x, y) => x + y, 0)

test('even split with remainder goes to the earliest', () => assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]))
test('weighted', () => assert.deepEqual(allocate(100, [70, 30]), [70, 30]))
test('largest remainder wins, not the first', () => assert.deepEqual(allocate(10, [1, 1, 8]), [1, 1, 8]))
test('remainder goes to the largest fraction', () => assert.deepEqual(allocate(5, [1, 1, 1, 2]), [1, 1, 1, 2]))
test('ties go to the earlier index', () => assert.deepEqual(allocate(3, [1, 1]), [2, 1]))
test('zero weight gets nothing', () => assert.deepEqual(allocate(10, [0, 1, 1]), [0, 5, 5]))
test('zero weight never gets a remainder cent', () => assert.deepEqual(allocate(1, [0, 1, 1]), [0, 1, 0]))
test('negative total mirrors the positive', () => assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]))
test('zero total', () => assert.deepEqual(allocate(0, [1, 2]), [0, 0]))
test('always sums exactly', () => {
  for (const [t, w] of [[1001, [3, 3, 3, 1]], [7, [1, 2, 3, 4, 5]], [999999, [13, 17, 19]], [-77, [5, 5, 5, 5, 5, 5, 5]]]) {
    const r = allocate(t, w)
    assert.equal(sum(r), t)
    assert.ok(r.every(Number.isInteger))
  }
})
test('fractional weights', () => assert.deepEqual(allocate(100, [0.5, 0.25, 0.25]), [50, 25, 25]))
test('all-zero weights throw', () => assert.throws(() => allocate(100, [0, 0]), /weight/i))
test('empty weights throw', () => assert.throws(() => allocate(100, []), /weight/i))
test('non-integer total throws', () => assert.throws(() => allocate(10.5, [1]), /integer/i))
