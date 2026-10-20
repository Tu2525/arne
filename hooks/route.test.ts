import { expect, test } from 'claude-code/testing'

import { parseVerdict, systemOneVerdict } from './backends'

import { route, MODEL } from './route'
import type { Backend, Decision } from './route'

const prev: Decision = { tier: 'M', effort: 'medium', reason: 'x', source: 'haiku' }
const says = (tier: 'S' | 'M' | 'L', name = 'b'): Backend => ({
  name,
  ask: async () => ({ tier, effort: 'medium', reason: 'backend' }),
})
const dead: Backend = { name: 'dead', ask: async () => { throw new Error('timeout') } }
const silent: Backend = { name: 'silent', ask: async () => undefined }

test('fast path table', async () => {
  const table: [string, string][] = [
    ['fix the typo in README', 'S'],
    ['rename foo to bar', 'S'],
    ['what is a mutex', 'S'],
    ['architect the auth layer', 'L'],
    ['fix the design typo in plan.md', 'S'],
    ['why does this deadlock', 'L'],
    ['what is the security risk here', 'L'],
    ['x'.repeat(2500), 'L'], // no judge to ask: long means L
  ]
  for (const [text, tier] of table) expect((await route(text))?.tier).toBe(tier)
})

test('a long prompt is read by the judge, not sent to Opus by length alone', async () => {
  const spec = 'Update the loader and run the tests. '.repeat(100)
  expect((await route(spec, { backends: [says('M')] }))?.tier).toBe('M')
  expect((await route(spec, { backends: [dead] }))?.tier).toBe('L')
})

test('continuations keep prev, else default', async () => {
  for (const t of ['', 'yes', 'ok do it', 'Continue.']) {
    expect((await route(t, { prev }))?.source).toBe('prev')
  }
  expect((await route('yes'))?.source).toBe('default')
})

test('a short follow-up keeps the last tier and asks no judge; a new task is judged (17p)', async () => {
  const opus: Decision = { tier: 'L', effort: 'high', reason: 'x', source: 'haiku' }
  let asked = 0
  const counting: Backend = { name: 'haiku', ask: async () => (asked++, { tier: 'S', effort: 'low', reason: 'b' }) }
  for (const t of ['continue', 'looks good, next one', 'that one, B']) {
    const d = await route(t, { prev: opus, backends: [counting] })
    expect(d?.tier).toBe('L')
    expect(d?.effort).toBe('high')
  }
  expect(asked).toBe(0)
  // After Haiku turns, a new hard task goes up; a new plain task is judged.
  const haiku: Decision = { tier: 'S', effort: 'low', reason: 'x', source: 'haiku' }
  expect((await route('design the plugin architecture for routing', { prev: haiku }))?.tier).toBe('L')
  expect((await route('fix the parser bug in lexer.ts', { prev: haiku, backends: [says('M', 'haiku')] }))?.tier).toBe('M')
})

test('fallback chain', async () => {
  expect((await route('refactor the cache', { backends: [dead, silent, says('L', 'haiku')] }))?.source).toBe('haiku')
  expect((await route('refactor the cache', { backends: [dead, silent], prev }))?.source).toBe('prev')
  expect((await route('refactor the cache', { backends: [dead] }))?.source).toBe('default')
})

test('pin beats paused beats fast path', async () => {
  const pin = { tier: 'L' as const, effort: 'high' as const }
  expect((await route('fix typo', { pin, paused: true }))?.source).toBe('pin')
  expect(await route('fix typo', { paused: true })).toBe(undefined)
})

test('subagent priors', async () => {
  expect((await route('find usages', { agentType: 'Explore', backends: [says('M')] }))?.tier).toBe('S')
  expect((await route('find usages', { agentType: 'Explore', backends: [says('L')] }))?.tier).toBe('L')
  expect((await route('anything', { agentType: 'Plan' }))?.tier).toBe('L')
  expect(await route('x', { agentType: 'Explore', paused: true })).not.toBe(undefined)
  expect(MODEL.S).toBe('claude-haiku-5-5')
})

test('verdict parsing rejects junk', async () => {
  expect(parseVerdict('{"tier":"M","effort":"low","reason":"ok"}')?.tier).toBe('M')
  expect(parseVerdict('sure: {"tier":"X","effort":"low"}')).toBe(undefined)
  expect(parseVerdict('no json')).toBe(undefined)
})

test('laya answers map to a verdict, abstention falls through', async () => {
  expect(systemOneVerdict({ tier: { choice: 'L' }, effort: { score: 2 } })?.effort).toBe('high')
  expect(systemOneVerdict({ tier: { choice: 'S', abstention: true }, effort: { score: 0 } })).toBe(undefined)
  expect(systemOneVerdict(undefined)).toBe(undefined)
})

// The docs' sample (17s): a score is an expectation, 0.67 between two levels, so the level is the argmax.
const SAMPLE = {
  tier: { type: 'choice', choice: 'M', confidence: 0.8, probabilities: { S: 0.1, M: 0.7, L: 0.2 } },
  effort: { type: 'score', score: 0.67, confidence: 0.67, probabilities: { '0': 0.33, '1': 0.67, '2': 0 } },
}

test('the sample System One response gives tier and effort through argmax (17s)', async () => {
  expect(systemOneVerdict(SAMPLE, 'jev')).toEqual({ tier: 'M', effort: 'medium', reason: 'jev' })
})

test('a System One answer under 0.5 confidence falls through (17s)', async () => {
  expect(systemOneVerdict({ ...SAMPLE, tier: { ...SAMPLE.tier, confidence: 0.4 } })).toBe(undefined)
  expect(systemOneVerdict({ ...SAMPLE, effort: { ...SAMPLE.effort, confidence: 0.49 } })).toBe(undefined)
})
