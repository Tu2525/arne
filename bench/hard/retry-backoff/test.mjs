import test from 'node:test'
import assert from 'node:assert/strict'
import { retry } from './retry.mjs'

const failTimes = n => { let calls = 0; return async () => { if (++calls <= n) throw new Error('boom ' + calls); return 'ok' } }

test('returns the value on first success with no waits', async () => {
  const waits = []
  assert.equal(await retry(async () => 'ok', { tries: 3, delay: 100, sleep: ms => waits.push(ms) }), 'ok')
  assert.deepEqual(waits, [])
})
test('waits double each time', async () => {
  const waits = []
  assert.equal(await retry(failTimes(3), { tries: 4, delay: 100, sleep: async ms => waits.push(ms) }), 'ok')
  assert.deepEqual(waits, [100, 200, 400])
})
test('throws the last error after the last try, with no wait after it', async () => {
  const waits = []
  await assert.rejects(retry(failTimes(9), { tries: 3, delay: 50, sleep: async ms => waits.push(ms) }), /boom 3/)
  assert.deepEqual(waits, [50, 100])
})
test('a single try never waits', async () => {
  const waits = []
  await assert.rejects(retry(failTimes(1), { tries: 1, delay: 50, sleep: async ms => waits.push(ms) }), /boom 1/)
  assert.deepEqual(waits, [])
})
