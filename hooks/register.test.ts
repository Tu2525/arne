import { expect, mock, test } from 'claude-code/testing'

// The session beneath arne: a model /model moves, prompts that enter, requests that go out.
function engine(on: any, start = 'claude-opus-5-5') {
  const s = { model: start, ran: [] as string[], entered: [] as string[], sent: [] as string[], efforts: [] as unknown[], usage: null as unknown, statuses: [] as string[] }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', (_$: unknown, e: unknown) => {
    s.statuses.push(JSON.stringify(e ?? null))
    return { value: undefined }
  })
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
  on('turn.step', async function* (_$: unknown, e: { model: string; turnId: string; index: number; effort?: string }) {
    s.sent.push(e.model)
    s.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: s.usage }
  })
  return { s, clock }
}

// A pick in the band's panel: open it with a press on the line if it is closed, then press the segment.
async function pick($: any, row: string, value: string) {
  const press = () => $.ui.press({ plugin: 'arne', key: `${row}-${value}` })
  await press().catch(async () => {
    await $.ui.press({ plugin: 'arne', key: 'band' })
    await press()
  })
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

test('an effort change runs the native /effort first, once, and not again while it matches (17c)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  await clock.settle()
  s.ran.length = 0
  const r = await $.prompt.submit(typed('refactor the parser'))
  expect('drop' in r && r.drop !== undefined).toBe(true)
  await clock.settle()
  expect(s.ran).toEqual(['/effort high'])
  expect(s.entered).toEqual(['refactor the parser'])
  // Native effort now matches: the next prompt goes straight through.
  const r2 = await $.prompt.submit(typed('and the lexer'))
  expect('drop' in r2).toBe(false)
  expect(s.ran).toEqual(['/effort high'])
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

test('the band pickers pin a model by one pick, move /model at once, and Auto unpins (17e)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  await $.command.run({ command: 'arne', args: '' })
  await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  const settle = async () => {
    for (let i = 0; i < 3; i++) await clock.settle()
  }
  await pick($, 'model', 'haiku')
  await settle()
  expect(s.ran).toEqual(['/model claude-haiku-5-5'])
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('pinned haiku')

  // Effort alone: the model pin stays, and the prompt is routed with the pinned tier.
  await pick($, 'effort', 'high')
  await settle()
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('pinned haiku · high')

  await pick($, 'model', 'auto')
  await pick($, 'effort', 'auto')
  await settle()
  expect((await $.command.run({ command: 'arne', args: '' })).text).not.toContain('pinned')
})

test('a pick in the app picker pins that tier instead of pausing, and band Auto unpins it (17f)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'sdk' })
  const status = (await $.command.run({ command: 'arne', args: '' })).text
  expect(status).toContain('arne on')
  expect(status).toContain('pinned opus')
  // The app already moved: arne runs no /model of its own for that pick.
  expect(s.ran).toEqual([])

  await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  await pick($, 'model', 'auto')
  for (let i = 0; i < 3; i++) await clock.settle()
  expect((await $.command.run({ command: 'arne', args: '' })).text).not.toContain('pinned')
})

test('the band says so when arne runs a model the app picker does not show (17f)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'sdk' })
  const ui = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  expect(await ui.find({ type: 'Text', text: /app picker shows/ })).toBeUndefined()

  await pick($, 'model', 'opus')
  for (let i = 0; i < 3; i++) await clock.settle()
  // arne's own /model, as the app reports it.
  await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', requested_model: 'claude-opus-5-5', source: 'command' })
  expect(await ui.find({ type: 'Text', text: /The app's model menu shows Sonnet; arne runs Opus/ })).toBeDefined()
})

test('a pin of xhigh passes the default ceiling and reaches the native /effort and the request (17h)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  await $.command.run({ command: 'arne', args: 'pin opus xhigh' })
  for (let i = 0; i < 3; i++) await clock.settle()
  s.ran.length = 0
  await $.prompt.submit(typed('refactor the parser'))
  await clock.settle()
  expect(s.ran).toEqual(['/effort xhigh'])
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('pinned opus · xhigh')
})

test('the Judge row set to Laya sets backend laya, and says Laya runs here (17h)', async ($: any, on: any) => {
  engine(on)
  on('config.set', (_$: unknown, e: { value: unknown }) => ({ value: e.value }))
  // The Laya segment's press calls this same set; the harness does not reach the pane's buttons.
  await $.config.set({ key: 'arne.backend', value: 'laya' })
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('backend laya')
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'Pane', props: {}, requestId: 'arne-settings', viewport: { columns: 80, rows: 30 } })
  expect(await pane.find({ type: 'Text', text: /Laya runs on this machine through laya-serve/ })).toBeDefined()
})

test('a pin from the band or /arne pin moves /model at once, before any prompt (17f)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(s.ran).toEqual(['/model claude-opus-5-5'])

  await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  await pick($, 'model', 'haiku')
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(s.ran.at(-1)).toBe('/model claude-haiku-5-5')
  expect(s.entered).toEqual([])
})

test('the band never prefixes "arne:", says off in words, and the settings pane is grouped like /config (17b)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  on('config.set', (_$: unknown, e: { value: unknown }) => ({ value: e.value }))
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  expect(await band.find({ type: 'Text', text: /arne:/ })).toBeUndefined()
  await $.command.run({ command: 'arne', args: 'off' })
  expect(await band.find({ type: 'Text', text: 'off' })).toBeDefined()

  const pane = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'Pane', props: {}, requestId: 'arne-settings', viewport: { columns: 80, rows: 30 } })
  for (const group of ['Routing', 'Range']) expect(await pane.find({ type: 'Text', text: group })).toBeDefined()
})

test('a step with no usage keeps the cache size, and the footer gets no status while on (17g)', async ($: any, on: any) => {
  const { s } = engine(on)
  s.usage = { input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 't0', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  s.usage = null // an interrupted step
  for await (const _ of $.turn.step({ turnId: 't0', index: 1, model: s.model, effort: 'medium', messageCount: 2 })) {
    // drain
  }
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 24 } })
  expect(await band.find({ type: 'Text', text: /cache warm \d+m · 50k/ })).toBeDefined()
  // The footer already shows the model and effort; arne adds nothing there while it runs.
  expect(s.statuses.filter(x => x.includes('·'))).toEqual([])
})

test('the band takes its width from bodyColumns: one resting row, short effort labels when narrow (17i)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'w1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const wide = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  await $.ui.press({ plugin: 'arne', key: 'band' })
  for (let i = 0; i < 2; i++) await clock.settle()
  expect(await wide.find({ type: 'Button', text: 'Extra high' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: 'Esc to close' })).toBeDefined()

  // The panel stays open (its state is arne's), so the narrow mount shows it in the short forms.
  const narrow = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 50 }, viewport: { columns: 50, rows: 24 } })
  expect(await narrow.find({ type: 'Button', text: 'XHi' })).toBeDefined()
  expect(await narrow.find({ type: 'Button', text: 'Extra high' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'Esc to close' })).toBeUndefined()
  // The resting line keeps the model at 50 columns: the reason and cache shorten, the head stays.
  expect(await narrow.find({ type: 'Text', text: /Sonnet/ })).toBeDefined()
})

test('a chat past the heavy size gets its own banner with both costs, not a band row (17i)', async ($: any, on: any) => {
  const { s } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 160_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'h1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 24 } })
  expect(await band.find({ type: 'Text', text: /Chat is 160k tokens\. Compacting with Haiku costs \$[\d.]+; resending the whole chat costs \$[\d.]+\./ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: 'Compact and send' })).toBeDefined()
  expect(await band.find({ type: 'Button', text: 'Send anyway' })).toBeDefined()
})

test('on the desktop the resting line is styled Text and the chevron alone is the button (17l)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'd1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount({ plugin: 'arne', surface: 'desktop', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  expect(await band.find({ type: 'Text', text: 'arne' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /cache warm \d+m · 50k/ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /arne/ })).toBeUndefined()
  await band.press({ key: 'band' })
  for (let i = 0; i < 2; i++) await clock.settle()
  expect(await band.find({ type: 'Button', text: 'Extra high' })).toBeDefined()
})

test('a narrow settings pane takes its width from bodyColumns and shows the short effort names (17m)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'desktop', component: 'Pane', props: { bodyColumns: 40 }, requestId: 'arne-settings', viewport: { columns: 160, rows: 30 } })
  expect(await pane.find({ type: 'Button', text: 'XHi' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Extra high' })).toBeUndefined()
})

test('Handoff sits beside Compact and runs the compact that saves and copies the summary (17o)', async ($: any, on: any) => {
  const { s } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 160_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'ho1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 24 } })
  await $.ui.press({ plugin: 'arne', key: 'handoff' })
  expect(s.ran).toContain('/compact ')
})
