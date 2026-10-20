import { expect, mock, test } from 'claude-code/testing'

// The session beneath arne: a model /model moves, prompts that enter, requests that go out.
function engine(on: any, start = 'claude-opus-5-5') {
  const s = {
    model: start,
    ran: [] as string[],
    entered: [] as string[],
    sent: [] as string[],
    efforts: [] as unknown[],
    usage: null as unknown,
    statuses: [] as string[],
    toasts: [] as string[],
    deny: undefined as string | undefined, // set it and every config write is refused
    compactGate: undefined as Promise<void> | undefined, // set it and /compact waits for it
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', (_$: unknown, e: unknown) => {
    s.statuses.push(JSON.stringify(e ?? null))
    return { value: undefined }
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    s.toasts.push(e.text)
    return { value: undefined }
  })
  on('config.set', (_$: unknown, e: { value: unknown }) => (s.deny ? { deny: s.deny } : { value: e.value }))
  on('classic.PostModelSwitch', () => ({}))
  on('session.model', () => ({ value: s.model }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    s.entered.push(e.text)
    return { text: e.text }
  })
  on('command.run', async (_$: unknown, e: { command: string; args: string }) => {
    s.ran.push(`/${e.command} ${e.args}`)
    if (e.command === 'compact' && s.compactGate) await s.compactGate
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

test('an effort change is silent: no /effort typed, the prompt is not dropped (17c)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  await clock.settle()
  s.ran.length = 0
  const r = await $.prompt.submit(typed('refactor the parser'))
  expect('drop' in r).toBe(false)
  await clock.settle()
  expect(s.ran).toEqual([])
})

test('a cold, big chat holds the prompt; Send as is sends it once, however often it is pressed (17a)', async ($: any, on: any) => {
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

test('a pin of xhigh passes the default ceiling and is kept (17h)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  await $.command.run({ command: 'arne', args: 'pin opus xhigh' })
  for (let i = 0; i < 3; i++) await clock.settle()
  s.ran.length = 0
  await $.prompt.submit(typed('refactor the parser'))
  await clock.settle()
  expect(s.ran).toEqual([])
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('pinned opus · xhigh')
})

test('the Judge row set to Laya sets backend laya, and says Laya runs here (17h)', async ($: any, on: any) => {
  engine(on)
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

test('a big chat with a warm cache shows no alert; once cold, the alert gives both costs in plain words (17p)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 263_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'h1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const warm = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 24 } })
  expect(await warm.find({ type: 'Text', text: /cache went cold|Chat is/i }).catch(() => undefined)).toBeUndefined()
  expect(await warm.find({ type: 'Button', text: /Summarize/ }).catch(() => undefined)).toBeUndefined()
  await warm.unmount()
  await clock.advance(2 * 60 * 60_000)
  const cold = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 24 } })
  expect(await cold.find({ type: 'Text', text: /^The cache went cold, so your next message re-reads all 263k tokens: \$[\d.]+\. A Haiku summary first costs \$[\d.]+\.$/ })).toBeDefined()
  expect(await cold.find({ type: 'Button', text: 'Summarize' })).toBeDefined()
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

test('Handoff sits beside Summarize and runs the compact that saves and copies the summary (17o)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 160_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'ho1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  await clock.advance(2 * 60 * 60_000)
  await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 24 } })
  await $.ui.press({ plugin: 'arne', key: 'handoff' })
  expect(s.ran).toContain('/compact ')
})

test('an Auto pick says so on the band: auto, the model, routed; a pin does not', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  await $.prompt.submit(typed('what is a mutex'))
  for (let i = 0; i < 3; i++) await clock.settle()
  await $.turn.start({ text: 'what is a mutex', turnId: 'r1' })
  for await (const _ of $.turn.step({ turnId: 'r1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  expect(await band.find({ type: 'Text', text: /auto · Haiku.*\(routed\)/ })).toBeDefined()
  await band.unmount()
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  for (let i = 0; i < 3; i++) await clock.settle()
  const pinned = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  expect(await pinned.find({ type: 'Text', text: /\(routed\)/ }).catch(() => undefined)).toBeUndefined()
})

test('a model pin from the app menu pins both parts: no judge, the effort the app sends, subagents left alone (17p)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  let judged = 0
  on('model.complete', () => (judged++, { value: { text: '{"tier":"S","effort":"low","reason":"x"}', isAnswered: true } }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', requested_model: 'claude-opus-5-5', source: 'sdk' })
  for (let i = 0; i < 3; i++) await clock.settle()
  s.ran.length = 0
  const r = await $.prompt.submit(typed('tidy up the helpers in this module'))
  expect('drop' in r).toBe(false)
  await $.turn.start({ text: 'tidy up the helpers in this module', turnId: 'p1' })
  for await (const _ of $.turn.step({ turnId: 'p1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  await $.turn.start({ text: 'find the helpers', turnId: 'p1', agentId: 'a1' })
  for await (const _ of $.turn.step({ turnId: 'p1', agentId: 'a1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1 })) {
    // drain
  }
  expect(judged).toBe(0)
  expect(s.ran).toEqual([])
  expect(s.sent).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  expect(s.efforts).toEqual(['medium', 'low'])
})

test('a pin belongs to its chat: another session starts on Auto, the first keeps its pin (17p)', async ($: any, on: any) => {
  const { clock } = engine(on)
  let sid = 'A'
  on('session.id', () => ({ value: sid }))
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('pinned opus · high')
  sid = 'B'
  expect((await $.command.run({ command: 'arne', args: '' })).text).not.toContain('pinned')
  sid = 'A'
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('pinned opus · high')
})

test('the judge gets the conversation so far ahead of the new prompt (17p)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  const prompts: string[] = []
  on('model.complete', (_$: unknown, e: { prompt: string }) => (prompts.push(e.prompt), { value: { text: '{"tier":"M","effort":"medium","reason":"x"}', isAnswered: true } }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'build the routing plugin', toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 't', tool: 'Edit', input: { file_path: 'hooks/route.ts' } }] },
      { role: 'user', text: 'now add the band', toolUses: [] },
    ],
  }))
  await $.prompt.submit(typed('refactor the helpers in this module please'))
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Conversation so far:')
  expect(prompts[0]).toContain('First prompt: build the routing plugin')
  expect(prompts[0]).toContain('- now add the band')
  expect(prompts[0]).toContain('Files touched: hooks/route.ts')
  expect(prompts[0]).toContain('New prompt to judge:\nrefactor the helpers in this module please')
})

test('a finished turn logs its usage, and Stats and /arne stats show the estimate against Opus and Sonnet (17q)', async ($: any, on: any) => {
  engine(on, 'claude-haiku-5-5')
  // An in-memory disk, so the test never reads or writes the real decisions.jsonl.
  const disk = new Map<string, string>()
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: disk.get(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => (disk.set(e.path, e.text), { value: undefined }))
  on('turn.complete', (_$: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  const usage = { model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }
  await $.turn.complete({ turnId: 's1', reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, usage })
  expect([...disk.values()].join('')).toContain('"type":"usage"')
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'Pane', requestId: 'arne-stats', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 40 } })
  expect(await pane.find({ type: 'Text', text: 'Saved $0.10' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '83% less than $0.13' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Haiku' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^An estimate/ })).toBeDefined()
  const text = (await $.command.run({ command: 'arne', args: 'stats' })).text
  expect(text).toContain('estimate')
  expect(text).toContain('Today: $0.02 spent over 1 turns')
})

// --- 17u: every button answers on the press ---

const band80 = { plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 24 } } as const

test('"Turn on" shows the on band at once, though arne\'s own config write skips its hook (17u)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  await $.command.run({ command: 'arne', args: 'off' })
  const band = await $.ui.mount(band80)
  expect(await band.find({ type: 'Text', text: 'off' })).toBeDefined()
  await band.press({ key: 'auto' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: 'off' }).catch(() => undefined)).toBeUndefined()
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('arne on')
})

test('a refused config write puts the band back and says so (17u)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  const band = await $.ui.mount(band80)
  await band.press({ key: 'band' })
  s.deny = 'a managed setting owns arne.auto'
  await band.press({ key: 'auto' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: 'off' }).catch(() => undefined)).toBeUndefined()
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('arne on')
  expect(s.toasts.join('\n')).toContain('a managed setting owns arne.auto')
})

test('the band countdown ticks without a session start, as after a reload (17u)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'k1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount(band80)
  await $.command.run({ command: 'arne', args: 'backend heuristic' })
  const before = (await band.find({ type: 'Text', text: /cache warm \d+m/ })).text
  await clock.advance(2 * 60_000) // inside the 5m TTL: still warm, two minutes fewer
  for (let i = 0; i < 3; i++) await clock.settle()
  const after = (await band.find({ type: 'Text', text: /cache warm \d+m/ })).text
  expect(after).not.toBe(before)
})

// A cold 160k Sonnet chat: the cold alert, and once that is dismissed, the heavy one.
async function coldHeavy($: any, s: any, clock: any) {
  s.usage = { input_tokens: 160_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'c1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  await clock.advance(2 * 60 * 60_000)
}

test('heavy "Dismiss" hides the banner (17u)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await coldHeavy($, s, clock)
  const band = await $.ui.mount(band80)
  await band.press({ key: 'continue' }) // the cold alert's Dismiss
  expect(await band.find({ type: 'Text', text: /^Chat is 160k tokens/ })).toBeDefined()
  await band.press({ key: 'dismiss' })
  expect(await band.find({ type: 'Text', text: /^Chat is/ }).catch(() => undefined)).toBeUndefined()
})

test('a double press on "Summarize" runs one compact, and the banner says summarizing (17u)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await coldHeavy($, s, clock)
  let release = () => {}
  s.compactGate = new Promise<void>(r => (release = r))
  const band = await $.ui.mount(band80)
  const first = band.press({ key: 'compact' })
  for (let i = 0; i < 3; i++) await clock.settle()
  await band.press({ key: 'compact' }).catch(() => undefined)
  expect(await band.find({ type: 'Text', text: 'summarizing…' })).toBeDefined()
  release()
  await first
  expect(s.ran.filter(r => r.startsWith('/compact'))).toEqual(['/compact '])
})

test('/arne unpin redraws the band (17u)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  for (let i = 0; i < 3; i++) await clock.settle()
  const band = await $.ui.mount(band80)
  await band.press({ key: 'band' })
  expect(await band.find({ type: 'Text', text: 'pinned' })).toBeDefined()
  await $.command.run({ command: 'arne', args: 'unpin' })
  expect(await band.find({ type: 'Text', text: 'pinned' }).catch(() => undefined)).toBeUndefined()
})

test('/arne backend sets the backend that routing reads (17u)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  await $.command.run({ command: 'arne', args: 'backend heuristic' })
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('backend heuristic')
})
