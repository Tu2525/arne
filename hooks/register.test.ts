import { expect, mock, test } from 'claude-code/testing'

// The session beneath arne: a model /model moves, prompts that enter, requests that go out.
function engine(on: any, start = 'claude-opus-5-5') {
  const s = { model: start, ran: [] as string[], entered: [] as string[], sent: [] as string[], usage: null as unknown }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('classic.PostModelSwitch', () => ({}))
  on('session.model', () => ({ value: s.model }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    s.entered.push(e.text)
    return { text: e.text }
  })
  on('command.run', (_$: unknown, e: { command: string; args: string }) => {
    s.ran.push(`/${e.command} ${e.args}`)
    if (e.command === 'model') s.model = e.args
    return { text: 'ok' }
  })
  on('turn.step', async function* (_$: unknown, e: { model: string; turnId: string; index: number }) {
    s.sent.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: s.usage }
  })
  return { s, clock }
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('a model move runs the real /model first, then sends the prompt exactly once (17c)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  // "what is a mutex" is the fast path's Haiku; the chat is on Opus with no warm cache: a boundary.
  const r = await $.prompt.submit(typed('what is a mutex'))
  expect('drop' in r && r.drop !== undefined).toBe(true)
  await clock.settle()
  expect(s.ran).toEqual(['/model claude-haiku-5-5'])
  expect(s.entered).toEqual(['what is a mutex'])

  // arne's own switch, as the app reports it, does not pause arne.
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5-5', requested_model: 'claude-haiku-5-5', source: 'command' })
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('arne on')

  // The main-loop request keeps the session's model: no silent rewrite.
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  expect(s.sent).toEqual(['claude-haiku-5-5'])
})

test('a cold, big chat holds the prompt; Send anyway sends it once, however often it is pressed (17a)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  // One 50k-token answer on Opus, then two hours: the cache is cold and the chat is past coldTokens.
  s.usage = { input_tokens: 50_000 }
  for await (const _ of $.turn.step({ turnId: 't0', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  await clock.advance(2 * 60 * 60_000)

  const r = await $.prompt.submit(typed('what is a mutex'))
  expect('drop' in r && String(r.drop)).toContain('holding')
  expect(s.entered).toEqual([])

  await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  const settle = async () => {
    for (let i = 0; i < 5; i++) await clock.settle()
  }
  await $.ui.press({ plugin: 'arne', key: 'send-anyway' })
  await settle()
  await $.ui.press({ plugin: 'arne', key: 'send-anyway' }).catch(() => undefined) // gone, or a no-op
  await settle()
  expect(s.entered).toEqual(['what is a mutex'])
  // Released on a cold chat, it is a cache boundary: the real /model moved before it went.
  expect(s.ran).toEqual(['/model claude-haiku-5-5'])
})

test('a model the person picks pauses arne, and every surface says so (17d)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'picker' })
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('arne paused')
  await $.command.run({ command: 'arne', args: 'on' })
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('arne on')
})
