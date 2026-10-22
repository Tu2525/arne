import test from 'node:test'
import assert from 'node:assert/strict'
import { Cache } from './cache.mjs'

const mk = (o = {}) => { const t = { v: 0 }; const c = new Cache({ max: 2, ttl: 100, now: () => t.v, ...o }); return [c, t] }

test('stores and reads', () => { const [c] = mk(); c.set('a', 1); assert.equal(c.get('a'), 1) })
test('expired entry reads as undefined', () => { const [c, t] = mk(); c.set('a', 1); t.v = 101; assert.equal(c.get('a'), undefined) })
test('entry is still alive exactly at the ttl', () => { const [c, t] = mk(); c.set('a', 1); t.v = 100; assert.equal(c.get('a'), 1) })
test('has is false once expired', () => { const [c, t] = mk(); c.set('a', 1); t.v = 101; assert.equal(c.has('a'), false) })
test('size ignores expired entries', () => { const [c, t] = mk(); c.set('a', 1); t.v = 101; assert.equal(c.size, 0) })
test('expired get removes the entry', () => { const [c, t] = mk(); c.set('a', 1); t.v = 101; c.get('a'); assert.equal(c.map.size, 0) })
test('evicts least recently set when full', () => {
  const [c] = mk(); c.set('a', 1); c.set('b', 2); c.set('c', 3)
  assert.equal(c.get('a'), undefined); assert.equal(c.get('b'), 2); assert.equal(c.get('c'), 3)
})
test('get refreshes recency', () => {
  const [c] = mk(); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3)
  assert.equal(c.get('a'), 1); assert.equal(c.get('b'), undefined)
})
test('overwriting a key does not evict another', () => {
  const [c] = mk(); c.set('a', 1); c.set('b', 2); c.set('a', 9)
  assert.equal(c.get('a'), 9); assert.equal(c.get('b'), 2); assert.equal(c.size, 2)
})
test('overwriting refreshes recency and ttl', () => {
  const [c, t] = mk(); c.set('a', 1); c.set('b', 2); t.v = 60; c.set('a', 9); c.set('c', 3)
  assert.equal(c.get('b'), undefined); t.v = 150; assert.equal(c.get('a'), 9)
})
test('get does not extend the ttl', () => {
  const [c, t] = mk(); c.set('a', 1); t.v = 60; c.get('a'); t.v = 101; assert.equal(c.get('a'), undefined)
})
test('expired entries are purged before evicting live ones', () => {
  const [c, t] = mk(); c.set('a', 1); t.v = 50; c.set('b', 2); t.v = 120; c.set('c', 3)
  assert.equal(c.get('b'), 2); assert.equal(c.get('c'), 3)
})
test('delete', () => { const [c] = mk(); c.set('a', 1); assert.equal(c.delete('a'), true); assert.equal(c.delete('a'), false); assert.equal(c.get('a'), undefined) })
test('falsy values are real values', () => { const [c] = mk(); c.set('a', 0); assert.equal(c.get('a'), 0); assert.equal(c.has('a'), true) })
