import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from './render.mjs'
import { DEFAULTS } from './defaults.mjs'

test('defaults', () => assert.equal(render(), 'blue-m'))
test('an option applies', () => assert.equal(render({ color: 'red' }), 'red-m'))
test('an option does not leak into the next call', () => {
  render({ color: 'red', size: 'l' })
  assert.equal(render(), 'blue-m')
})
test('retina flag', () => assert.equal(render({ retina: true }), 'blue-m@2x'))
test('the exported defaults are not changed by a call', () => {
  render({ size: 'xl' })
  assert.deepEqual(DEFAULTS, { color: 'blue', size: 'm', retina: false })
})
