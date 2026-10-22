import test from 'node:test'
import assert from 'node:assert/strict'
import { topN } from './rank.mjs'
import { reportLines } from './report.mjs'

const items = () => [{ name: 'a', score: 2 }, { name: 'b', score: 9 }, { name: 'c', score: 5 }, { name: 'd', score: 7 }]

test('top n best first', () => assert.deepEqual(topN(items(), 2).map(i => i.name), ['b', 'd']))
test('topN does not reorder the caller array', () => {
  const xs = items()
  topN(xs, 2)
  assert.deepEqual(xs.map(i => i.name), ['a', 'b', 'c', 'd'])
})
test('report keeps submission order in the all section', () => {
  assert.deepEqual(reportLines(items()), ['top b 9', 'top d 7', 'top c 5', 'all a 2', 'all b 9', 'all c 5', 'all d 7'])
})
test('topN with n larger than the list', () => assert.equal(topN(items(), 10).length, 4))
