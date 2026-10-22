import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions as c, satisfies as s } from './semver.mjs'

test('numeric not lexical', () => assert.equal(c('1.10.0', '1.9.0'), 1))
test('equal', () => assert.equal(c('1.2.3', '1.2.3'), 0))
test('build metadata ignored', () => assert.equal(c('1.2.3+a', '1.2.3+b'), 0))
test('prerelease is lower than release', () => assert.equal(c('1.0.0-rc.1', '1.0.0'), -1))
test('prerelease numeric ids compare numerically', () => assert.equal(c('1.0.0-alpha.10', '1.0.0-alpha.9'), 1))
test('numeric id is lower than alphanumeric', () => assert.equal(c('1.0.0-1', '1.0.0-a'), -1))
test('shorter prerelease is lower when prefix equal', () => assert.equal(c('1.0.0-alpha', '1.0.0-alpha.1'), -1))
test('alphanumeric ids compare lexically', () => assert.equal(c('1.0.0-alpha', '1.0.0-beta'), -1))
test('exact', () => { assert.ok(s('1.2.3', '1.2.3')); assert.ok(!s('1.2.4', '1.2.3')); assert.ok(s('1.2.3', '=1.2.3')) })
test('comparators', () => {
  assert.ok(s('2.0.0', '>1.9.9')); assert.ok(!s('1.9.9', '>1.9.9'))
  assert.ok(s('1.9.9', '>=1.9.9')); assert.ok(s('1.0.0', '<2.0.0')); assert.ok(!s('2.0.0', '<2.0.0')); assert.ok(s('2.0.0', '<=2.0.0'))
})
test('and', () => { assert.ok(s('1.5.0', '>=1.2.0 <2.0.0')); assert.ok(!s('2.0.0', '>=1.2.0 <2.0.0')) })
test('or', () => { assert.ok(s('3.1.0', '^1.0.0 || ^3.0.0')); assert.ok(!s('2.5.0', '^1.0.0 || ^3.0.0')) })
test('tilde', () => { assert.ok(s('1.2.9', '~1.2.3')); assert.ok(!s('1.3.0', '~1.2.3')); assert.ok(!s('1.2.2', '~1.2.3')) })
test('caret', () => { assert.ok(s('1.9.0', '^1.2.3')); assert.ok(!s('2.0.0', '^1.2.3')); assert.ok(!s('1.2.2', '^1.2.3')) })
test('caret on 0.x only allows patch bumps', () => { assert.ok(s('0.2.9', '^0.2.3')); assert.ok(!s('0.3.0', '^0.2.3')) })
test('caret on 0.0.x allows nothing else', () => { assert.ok(s('0.0.3', '^0.0.3')); assert.ok(!s('0.0.4', '^0.0.3')) })
test('prerelease is excluded from a plain range', () => assert.ok(!s('1.5.0-beta.1', '^1.2.3')))
test('prerelease allowed when a comparator names the same tuple', () => {
  assert.ok(s('1.2.3-beta.2', '>=1.2.3-beta.1 <2.0.0'))
  assert.ok(!s('1.3.0-beta.2', '>=1.2.3-beta.1 <2.0.0'))
})
test('prerelease below the lower bound fails', () => assert.ok(!s('1.2.3-alpha', '>=1.2.3-beta.1')))
test('whitespace is tolerated', () => assert.ok(s('1.5.0', '  >=1.2.0   <2.0.0  ')))
test('garbage version throws', () => assert.throws(() => c('1.2', '1.2.3'), /version/i))
