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
    // Set it ('arne@x') and rows are keyed as with two arne plugins enabled: `arne.<field>` names no row.
    rowPrefix: undefined as string | undefined,
    rows: [] as { key: string; provider: { plugin: string } }[],
    writes: [] as string[],
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
  on('config.set', (_$: unknown, e: { key: string; value: unknown }) => {
    if (s.deny) return { deny: s.deny }
    if (s.rowPrefix && !e.key.startsWith(`${s.rowPrefix}.`)) return { deny: `arne: $.config.set: no /config row with key ${e.key} ($.config.list names them)` }
    s.writes.push(e.key)
    return { value: e.value }
  })
  on('config.list', () => ({ value: s.rows }))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.PostCompact', () => ({}))
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
  on('model.complete', () => ({ value: { text: '{"tier":"S","effort":"low","reason":"a lookup"}', isAnswered: true } }))
  // The judge picks Haiku; the chat is on Opus with no warm cache: a boundary.
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
  on('model.complete', () => ({ value: { text: '{"tier":"S","effort":"low","reason":"a lookup"}', isAnswered: true } }))
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

test('the Judge row set to Laya sets backend laya, and Settings says what Laya is (17h)', async ($: any, on: any) => {
  engine(on)
  // The Laya segment's press calls this same set; the harness does not reach the pane's buttons.
  await $.config.set({ key: 'arne.backend', value: 'laya' })
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('backend laya')
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 80, rows: 30 } })
  await $.command.run({ command: 'arne', args: 'settings' })
  expect(await pane.find({ type: 'Text', text: 'Laya runs on this machine and learns from your ratings.' })).toBeDefined()
  // The Jev note takes the Laya note's place while Jev is the judge.
  expect(await pane.find({ type: 'Text', text: /^Jev is hosted/ }).catch(() => undefined)).toBeUndefined()
  await $.config.set({ key: 'arne.backend', value: 'jev' })
  expect(await pane.find({ type: 'Text', text: 'Jev is hosted: your prompts leave this machine.' })).toBeDefined()
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

  await $.command.run({ command: 'arne', args: 'on' })
  await $.command.run({ command: 'arne', args: 'settings' })
  const pane = band
  for (const group of ['Routing', 'Limits']) expect(await pane.find({ type: 'Text', text: group })).toBeDefined()
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
  expect(await band.find({ type: 'Text', text: /^cache \d+m$/ })).toBeDefined()
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

  // The panel stays open (its state is arne's), so the narrow mount shows it in the short forms.
  const narrow = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 50 }, viewport: { columns: 50, rows: 24 } })
  expect(await narrow.find({ type: 'Button', text: 'XHigh' })).toBeDefined()
  expect(await narrow.find({ type: 'Button', text: 'Extra high' })).toBeUndefined()
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
  expect(await cold.find({ type: 'Text', text: 'The cache went cold' })).toBeDefined()
  expect(await cold.find({ type: 'Text', text: /^Your next message re-reads all 263k tokens, about \$[\d.]+\.$/ })).toBeDefined()
  expect(await cold.find({ type: 'Button', text: /^Summarize first · \$[\d.]+$/ })).toBeDefined()
})

test('on the desktop the resting line is styled Text and the chevron alone is the button (17l)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  s.usage = { input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'd1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount({ plugin: 'arne', surface: 'desktop', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  expect(await band.find({ type: 'Text', text: 'arne' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^cache \d+m$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /arne/ })).toBeUndefined()
  await band.press({ key: 'band' })
  for (let i = 0; i < 2; i++) await clock.settle()
  expect(await band.find({ type: 'Button', text: 'Extra high' })).toBeDefined()
})

test('a narrow settings pane takes its width from bodyColumns and shows the short effort names (17m)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'desktop', component: 'AbovePrompt', props: { bodyColumns: 40 }, viewport: { columns: 160, rows: 30 } })
  await $.command.run({ command: 'arne', args: 'settings' })
  expect(await pane.find({ type: 'Button', text: 'XHigh' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Extra high' })).toBeUndefined()
})

// A warm 150k Opus chat where the judge wants Sonnet: switching would re-read the chat cold, so it is sticky (17w).
async function stickyOpus($: any, on: any) {
  const e = engine(on)
  const disk = new Map<string, string>()
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', (_$: unknown, x: { path: string }) => ({ value: disk.get(x.path) ?? '' }))
  on('fs.write', (_$: unknown, x: { path: string; text: string }) => (disk.set(x.path, x.text), { value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'build the parser', toolUses: [] }, { role: 'assistant', text: 'done', toolUses: [] }] }))
  on('model.complete', (_$: unknown, x: { system: string }) =>
    x.system.startsWith('Summarize')
      ? { value: { text: 'GOAL: the parser', isAnswered: true } }
      : { value: { text: '{"tier":"M","effort":"medium","reason":"x"}', isAnswered: true } },
  )
  on('turn.start', (_$: unknown, x: { turnId: string }) => ({ turnId: x.turnId }))
  e.s.usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'w0', index: 0, model: e.s.model, effort: 'high', messageCount: 1 })) {
    // drain
  }
  await $.prompt.submit(typed('refactor the parser'))
  for (let i = 0; i < 3; i++) await e.clock.settle()
  await $.turn.start({ text: 'refactor the parser', turnId: 'w1' })
  return { ...e, disk }
}

test('a sticky cheaper pick shows stay, switch and handoff with their costs; one handoff on a double press (17w)', async ($: any, on: any) => {
  const { s, clock, disk } = await stickyOpus($, on)
  expect(s.model).toBe('claude-opus-5-5')
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120 }, viewport: { columns: 120, rows: 40 } })
  await band.press({ key: 'band' })
  expect(await band.find({ type: 'Text', text: 'Stay on Opus' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'Switch to Sonnet' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'New chat on Sonnet' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /pays off in \d+ turn/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'Sonnet fits this task, but the cache is warm.' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^Switching in this chat re-reads all 150k tokens\. A new chat starts from a Haiku summary\. To switch here, pick a Model below\.$/ })).toBeDefined()
  await Promise.all([band.press({ key: 'handoff-row' }).catch(() => undefined), band.press({ key: 'handoff-row' }).catch(() => undefined)])
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(s.ran.filter(r => r.startsWith('/clear')).length).toBe(0)
  expect(s.model).toBe('claude-opus-5-5')
  expect([...disk.values()].join('')).toContain('GOAL: the parser')
  expect(s.toasts.at(-1)).toContain('Open a new chat on Sonnet')
})

test('Handoff set to Clear runs /clear, moves the model and sends the summary (17w)', async ($: any, on: any) => {
  const { s, clock } = await stickyOpus($, on)
  await $.config.set({ key: 'arne.handoff', value: 'clear' })
  for (let i = 0; i < 3; i++) await clock.settle()
  await $.command.run({ command: 'arne', args: 'handoff haiku' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(s.ran.filter(r => r.startsWith('/clear')).length).toBe(1)
  expect(s.model).toBe('claude-haiku-5-5')
  expect(s.entered.at(-1)).toContain('GOAL: the parser')
})

test('/arne handoff haiku writes the summary to the clipboard and file, and leaves this chat uncleared (17w)', async ($: any, on: any) => {
  const { s, clock, disk } = await stickyOpus($, on)
  await $.command.run({ command: 'arne', args: 'handoff haiku' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(s.ran.filter(r => r.startsWith('/clear')).length).toBe(0)
  expect(s.model).toBe('claude-opus-5-5')
  expect([...disk.values()].join('')).toContain('GOAL: the parser')
  expect(s.toasts.at(-1)).toContain('Open a new chat on Haiku')
  expect((await $.command.run({ command: 'arne', args: 'handoff gpt' })).text).toContain('Usage')
})

test('the resting line is the model and effort, then the reason: no "auto ·", no "(routed)"; a pin says pinned', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  on('model.complete', () => ({ value: { text: '{"tier":"S","effort":"low","reason":"a lookup"}', isAnswered: true } }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  await $.prompt.submit(typed('what is a mutex'))
  for (let i = 0; i < 3; i++) await clock.settle()
  await $.turn.start({ text: 'what is a mutex', turnId: 'r1' })
  for await (const _ of $.turn.step({ turnId: 'r1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  expect(await band.find({ type: 'Text', text: /Haiku/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /auto ·|\(routed\)/ }).catch(() => undefined)).toBeUndefined()
  await band.unmount()
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  for (let i = 0; i < 3; i++) await clock.settle()
  const pinned = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 24 } })
  expect(await pinned.find({ type: 'Text', text: /\(routed\)/ }).catch(() => undefined)).toBeUndefined()
  expect(await pinned.find({ type: 'Text', text: /^ *pinned$/ })).toBeDefined()
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
  expect(prompts[0]).toContain('Last messages:\n- user: build the routing plugin\n- assistant: ok\n- user: now add the band')
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
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80 }, viewport: { columns: 80, rows: 40 } })
  const text = (await $.command.run({ command: 'arne', args: 'stats' })).text
  expect(await pane.find({ type: 'Text', text: 'Saved $0.10' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '83% less than $0.13' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Haiku' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^An estimate/ })).toBeDefined()
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
  const before = (await band.find({ type: 'Text', text: /^cache \d+m$/ })).text
  await clock.advance(2 * 60_000) // inside the 5m TTL: still warm, two minutes fewer
  for (let i = 0; i < 3; i++) await clock.settle()
  const after = (await band.find({ type: 'Text', text: /^cache \d+m$/ })).text
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
  await $.config.set({ key: 'arne.coldTokens', value: 200_000 }) // no cold offer, so the heavy alert shows
  await coldHeavy($, s, clock)
  const band = await $.ui.mount(band80)
  expect(await band.find({ type: 'Text', text: 'This chat is 160k tokens' })).toBeDefined()
  await band.press({ key: 'dismiss' })
  expect(await band.find({ type: 'Text', text: /^This chat is/ }).catch(() => undefined)).toBeUndefined()
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

test('/arne backend jev sets the backend and says prompts leave the machine (17s)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  expect((await $.command.run({ command: 'arne', args: 'backend jev' })).text).toContain('leave this machine')
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('backend jev')
})

test('Jev with no TYPESAFE_API_KEY makes no request: Haiku judges, and the why line says so (17s)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  let fetched = 0
  on('http.fetch', () => (fetched++, { value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  let judged = 0
  on('model.complete', () => (judged++, { value: { text: '{"tier":"M","effort":"medium","reason":"x"}', isAnswered: true } }))
  await $.command.run({ command: 'arne', args: 'backend jev' })
  await $.prompt.submit(typed('tidy up the helpers in this module'))
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(fetched).toBe(0)
  expect(judged).toBe(1)
  const pane = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 100, rows: 30 } })
  await $.ui.press({ plugin: 'arne', key: 'band' })
  expect(await pane.find({ type: 'Text', text: /^Jev needs a key; Haiku judged$/ })).toBeDefined()
})

// Jev with a key: the request it makes, and every log write, for the key-handling tests (17s).
function jevHarness(on: any, env: Record<string, string>) {
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name] }))
  const fetched: any[] = []
  const sample = { model: 'jev-latest', answers: { tier: { type: 'choice', choice: 'M', confidence: 0.8, probabilities: { S: 0.1, M: 0.7, L: 0.2 } }, effort: { type: 'score', score: 0.67, confidence: 0.67, probabilities: { '0': 0.33, '1': 0.67, '2': 0 } } }, usage: { input_tokens: 120, output_tokens: 12 } }
  on('http.fetch', (_$: unknown, e: any) => (fetched.push(e), { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(sample) } }))
  const disk = new Map<string, string>()
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: disk.get(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => (disk.set(e.path, e.text), { value: undefined }))
  return { fetched, disk }
}

test('a TypeSafe key in /config, with no env, makes the request with Bearer, and no log row carries it (17s)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  const { fetched, disk } = jevHarness(on, {})
  await $.command.run({ command: 'arne', args: 'backend jev' })
  await $.config.set({ key: 'arne.typesafe_key', value: 'ts-option-key' })
  await $.prompt.submit(typed('tidy up the helpers in this module'))
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(fetched.length).toBe(1)
  expect(fetched[0].init.headers.authorization).toBe('Bearer ts-option-key')
  const log = [...disk.values()].join(String.fromCharCode(10))
  expect(log).toContain('"kind":"jev"')
  expect(log).not.toContain('ts-option-key')
})

test('TYPESAFE_API_KEY wins over the /config key (17s)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  const { fetched } = jevHarness(on, { TYPESAFE_API_KEY: 'ts-env-key' })
  await $.command.run({ command: 'arne', args: 'backend jev' })
  await $.config.set({ key: 'arne.typesafe_key', value: 'ts-option-key' })
  await $.prompt.submit(typed('tidy up the helpers in this module'))
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(fetched[0].init.headers.authorization).toBe('Bearer ts-env-key')
})

test('Jev with no key anywhere: Settings says so under Routing with Add key…, which points to /config (17s)', async ($: any, on: any) => {
  const { s } = engine(on, 'claude-sonnet-5-5')
  jevHarness(on, {})
  await $.command.run({ command: 'arne', args: 'backend jev' })
  const band = await $.ui.mount(band100)
  await $.command.run({ command: 'arne', args: 'settings' })
  expect(await band.find({ type: 'Text', text: 'Jev needs a TypeSafe key.' })).toBeDefined()
  await band.press({ key: 'add-key' })
  expect(s.toasts.at(-1)).toBe('Set it in /config → arne → TypeSafe API key, or the TYPESAFE_API_KEY environment variable.')
  // A key in /config takes the line away.
  await $.config.set({ key: 'arne.typesafe_key', value: 'ts-option-key' })
  expect(await band.find({ key: 'add-key' }).catch(() => undefined)).toBeUndefined()
})

test('the first prompt after a compact is sent, not held, even past the TTL (17v)', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await coldHeavy($, s, clock)
  // The kit cannot reload the module, so nothing but state carries the compact: the cache atom, as after a reload.
  await $.classic.PostCompact({ trigger: 'auto', compact_summary: 'summary' })
  await clock.advance(2 * 60 * 60_000)
  const r = await $.prompt.submit(typed('what is a mutex'))
  expect(String((r as any).drop ?? '')).not.toContain('holding')
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(s.entered).toEqual(['what is a mutex'])
})

test('one cold Dismiss covers the cold spell: no heavy alert after it; the next cold spell shows them again', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await coldHeavy($, s, clock)
  const band = await $.ui.mount(band80)
  expect(await band.find({ type: 'Text', text: /^The cache went cold/ })).toBeDefined()
  await band.press({ key: 'continue' }) // the cold alert's Dismiss
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(await band.find({ type: 'Text', text: /^The cache went cold/ }).catch(() => undefined)).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^This chat is/ }).catch(() => undefined)).toBeUndefined()
  await band.unmount()
  await coldHeavy($, s, clock) // a new response, then cold again: a new warmUntil
  const again = await $.ui.mount(band80)
  expect(await again.find({ type: 'Text', text: /^The cache went cold/ })).toBeDefined()
})

test('a session start clears a busy flag a reload left behind: the cold alert has its buttons and Summarize compacts', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$: unknown, e: unknown) => e)
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ value: '' }))
  await coldHeavy($, s, clock)
  // A compact that never finishes stands in for one a reload cut short: its `finally` never runs.
  s.compactGate = new Promise<void>(() => {})
  const band = await $.ui.mount(band80)
  void band.press({ key: 'compact' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(await band.find({ type: 'Text', text: 'summarizing…' })).toBeDefined()
  await $.session.start({ source: 'startup', cwd: '/p' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(await band.find({ type: 'Text', text: 'summarizing…' }).catch(() => undefined)).toBeUndefined()
  s.compactGate = undefined
  await band.press({ key: 'compact' })
  expect(s.ran.filter(r => r.startsWith('/compact')).length).toBe(2)
})

test('a subagent gets its model at spawn: never dearer than the chat, effort at least medium; a named model or a fork is left alone (17x)', async ($: any, on: any) => {
  const { s } = engine(on)
  let judged = 0
  on('model.complete', () => (judged++, { value: { text: '{"tier":"M","effort":"low","reason":"a search"}', isAnswered: true } }))
  const spawned: (string | undefined)[] = []
  on('agent.spawn', (_$: unknown, e: { model?: string; parentModel: string; tool_use_id: string }) => {
    spawned.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: `a-${e.tool_use_id}` }
  })
  await $.config.set({ key: 'arne.subagents', value: 'auto' }) // off by default
  const spawn = (id: string, extra: object = {}) =>
    $.agent.spawn({ tool_use_id: id, prompt: 'look through the hooks and list every atom', description: 'list atoms', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra })

  expect((await spawn('t1')).model).toBe('claude-sonnet-5-5')
  // Its steps keep that model and get the spawn's effort, raised to medium.
  for await (const _ of $.turn.step({ turnId: 'p1', agentId: 'a-t1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1 })) {
    // drain
  }
  expect(s.sent).toEqual(['claude-sonnet-5-5'])
  expect(s.efforts).toEqual(['medium'])

  // A Haiku chat never sends a Sonnet subagent.
  expect((await spawn('t2', { parentModel: 'claude-haiku-5-5' })).model).toBe('claude-haiku-5-5')

  const before = judged
  // A named model at or under the Subagents ceiling (Sonnet by default) runs as asked.
  expect((await spawn('t3', { model: 'haiku' })).model).toBe('haiku')
  expect((await spawn('t4', { fork: true })).model).toBe('claude-opus-5-5')
  expect(judged).toBe(before)
  expect(spawned.slice(2)).toEqual(['haiku', undefined])
})

test('a long brief is no Opus subagent; a moved one is said on its call; Subagents off and an asked model pass through; the panel footnote counts them (17x, band fix 6)', async ($: any, on: any) => {
  const { clock } = engine(on, 'claude-sonnet-5-5')
  on('model.complete', () => ({ value: { text: '{"tier":"S","effort":"low","reason":"a lookup"}', isAnswered: true } }))
  const notices: { tool_use_id: string; text?: string }[] = []
  on('ui.notice', (_$: unknown, e: { tool_use_id: string; text?: string }) => (notices.push(e), { value: undefined }))
  const got: any[] = []
  on('agent.spawn', (_$: unknown, e: any) => (got.push(e), { model: e.model ?? e.parentModel, agentId: `a-${e.tool_use_id}` }))
  await $.config.set({ key: 'arne.subagents', value: 'auto' }) // off by default
  const spawn = (id: string, extra: object = {}) =>
    $.agent.spawn({ tool_use_id: id, prompt: 'Design the plan: '.padEnd(5000, 'x'), description: 'a task', subagentType: 'general-purpose', parentModel: 'claude-sonnet-5-5', background: false, fork: false, ...extra })

  // 5000 chars with "design" and "plan" in it: once fast: hard, Opus. Now the judge's pick, said on the call.
  expect((await spawn('t1')).model).toBe('claude-haiku-5-5')
  expect(notices).toEqual([{ tool_use_id: 't1', text: expect.stringContaining('arne: Haiku') }])
  // The Plan prior is Opus, but a Sonnet chat never sends one dearer than itself.
  expect((await spawn('t2', { subagentType: 'Plan' })).model).toBe('claude-sonnet-5-5')
  expect((await spawn('t3', { model: 'haiku' })).model).toBe('haiku')
  expect(notices.length).toBe(1)

  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 100, rows: 24 } })
  await $.ui.press({ plugin: 'arne', key: 'band' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(await band.find({ type: 'Text', text: '3 subagents routed: 1 Haiku, 1 kept, 1 as asked' })).toBeDefined()
  // The switch lives in Settings now; the panel keeps only the count.
  expect(await band.find({ type: 'Text', text: 'Subagents' }).catch(() => undefined)).toBeUndefined()
  await $.ui.press({ plugin: 'arne', key: 'gear' })
  await $.ui.press({ plugin: 'arne', key: 'subagents-off' })
  for (let i = 0; i < 3; i++) await clock.settle()
  const n = got.length
  await spawn('t4')
  expect(got[n]).toEqual({ tool_use_id: 't4', prompt: 'Design the plan: '.padEnd(5000, 'x'), description: 'a task', subagentType: 'general-purpose', parentModel: 'claude-sonnet-5-5', background: false, fork: false })
  expect((await $.command.run({ command: 'arne', args: 'subagents on' })).text).toBe("arne picks each subagent's model, no ceiling.")
})

test('the Subagents ceiling caps a named model and the judge, under any parent or pin; Opus lets Opus through; Off, a fork and a cheaper named model are untouched (17y)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  on('model.complete', () => ({ value: { text: '{"tier":"L","effort":"high","reason":"a design"}', isAnswered: true } }))
  const notices: { tool_use_id: string; text?: string }[] = []
  on('ui.notice', (_$: unknown, e: { tool_use_id: string; text?: string }) => (notices.push(e), { value: undefined }))
  const got: any[] = []
  on('agent.spawn', (_$: unknown, e: any) => (got.push(e), { model: e.model ?? e.parentModel, agentId: `a-${e.tool_use_id}` }))
  await $.config.set({ key: 'arne.subagents', value: 'sonnet' })
  const spawn = (id: string, extra: object = {}) =>
    $.agent.spawn({ tool_use_id: id, prompt: 'look through the hooks and list every atom', description: 'list atoms', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra })

  // Named Opus: Sonnet at medium, said on the call, and the effort holds in its steps.
  expect((await spawn('t1', { model: 'opus' })).model).toBe('claude-sonnet-5-5')
  expect(notices.at(-1)).toEqual({ tool_use_id: 't1', text: 'arne: Sonnet (capped from Opus)' })
  for await (const _ of $.turn.step({ turnId: 'p1', agentId: 'a-t1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1 })) {
    // drain
  }
  expect(s.efforts.at(-1)).toBe('medium')
  // The judge's Opus under an Opus chat: Sonnet too. A named Haiku stays Haiku.
  expect((await spawn('t2')).model).toBe('claude-sonnet-5-5')
  expect((await spawn('t3', { model: 'haiku' })).model).toBe('haiku')
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 100, rows: 24 } })
  await $.ui.press({ plugin: 'arne', key: 'band' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect(await band.find({ type: 'Text', text: '3 subagents routed: 1 Sonnet, 1 as asked, 1 capped' })).toBeDefined()
  // A fork shares the parent's cache: untouched, even when it names Opus.
  expect((await spawn('t4', { fork: true, model: 'opus' })).model).toBe('opus')
  // A pin is the main chat's: the ceiling still holds.
  await $.command.run({ command: 'arne', args: 'pin opus high' })
  for (let i = 0; i < 3; i++) await clock.settle()
  expect((await spawn('t5', { model: 'opus' })).model).toBe('claude-sonnet-5-5')
  await $.command.run({ command: 'arne', args: 'unpin' })

  expect((await $.command.run({ command: 'arne', args: 'subagents opus' })).text).toBe('arne routes subagents, Opus at most.')
  expect((await spawn('t6', { model: 'opus' })).model).toBe('opus')
  expect((await spawn('t7')).model).toBe('claude-opus-5-5')

  expect((await $.command.run({ command: 'arne', args: 'subagents off' })).text).toBe('arne leaves subagents on the model they ask for.')
  await spawn('t8', { model: 'opus' })
  await spawn('t9')
  expect(got.at(-2).model).toBe('opus')
  expect(got.at(-1).model).toBe(undefined)
  expect((await $.command.run({ command: 'arne', args: 'subagents max' })).text).toBe('Usage: /arne subagents auto|haiku|sonnet|opus|off')
})

test('the old Subagents On/Off reads as a ceiling: true is Sonnet, false is off; anything else is Auto (17y)', async ($: any, on: any) => {
  engine(on)
  const band = await $.ui.mount(band100)
  await $.command.run({ command: 'arne', args: 'settings' })
  await $.config.set({ key: 'arne.subagents', value: false })
  expect((await band.find({ key: 'subagents-off' })).props.variant).toBe('secondary')
  await $.config.set({ key: 'arne.subagents', value: true })
  expect((await band.find({ key: 'subagents-sonnet' })).props.variant).toBe('secondary')
})

test('two arne plugins enabled: a write finds the row arne owns; two rows of its own refuse with a hint; toasts carry no doubled prefix (17x)', async ($: any, on: any) => {
  const { s } = engine(on)
  s.rowPrefix = 'arne@x'
  s.rows = [{ key: 'arne@x.subagents', provider: { plugin: 'arne' } }, { key: 'other.subagents', provider: { plugin: 'other' } }]
  expect((await $.command.run({ command: 'arne', args: 'subagents off' })).text).toBe('arne leaves subagents on the model they ask for.')
  expect(s.writes).toEqual(['arne@x.subagents'])

  s.rows.push({ key: 'arne@y.subagents', provider: { plugin: 'arne' } })
  expect((await $.command.run({ command: 'arne', args: 'subagents on' })).text).toBe('arne leaves subagents on the model they ask for.')
  expect(s.toasts.at(-1)).toBe('Could not change subagents: two copies of arne are enabled; turn one off in /plugin')

  s.rows = [{ key: 'arne@x.subagents', provider: { plugin: 'arne@x' } }]
  s.rowPrefix = 'arne@x'
  await $.command.run({ command: 'arne', args: 'subagents on' })
  expect(s.writes.at(-1)).toBe('arne@x.subagents')
  s.rows = [{ key: 'plugin.subagents', provider: { name: 'arne@x' } }]
  s.rowPrefix = 'plugin'
  await $.command.run({ command: 'arne', args: 'subagents on' })
  expect(s.writes.at(-1)).toBe('plugin.subagents') // the provider's shape is not documented: any arne in it counts
  s.rowPrefix = 'arne@x'
  s.rows = []
  await $.command.run({ command: 'arne', args: 'subagents on' })
  const n = s.toasts.length
  await $.command.run({ command: 'arne', args: 'subagents on' })
  expect(s.toasts.length).toBe(n) // no row anywhere: applies for the session, no rollback toast
  s.rowPrefix = undefined
  await $.command.run({ command: 'arne', args: 'subagents on' })
})

test('a new chat: the band names the running model, the panel has no notes beside the pickers (band fixes 1, 2)', async ($: any, on: any) => {
  engine(on, 'claude-haiku-5-5')
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 100, rows: 24 } })
  expect(await band.find({ type: 'Text', text: /^ *Haiku$/ })).toBeDefined()
  await band.press({ key: 'band' })
  expect(await band.find({ type: 'Text', text: /picked|takes no effort/ }).catch(() => undefined)).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'No decision yet.' })).toBeDefined()
})

test('the costs table holds the one Hand off, on the recommended row; no Laya line in the panel; narrow has no notes (band fixes 3, 4, 7)', async ($: any, on: any) => {
  await stickyOpus($, on)
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120 }, viewport: { columns: 120, rows: 40 } })
  await band.press({ key: 'band' })
  expect(await band.findAll({ type: 'Button', text: 'Hand off' })).toHaveLength(1)
  expect(await band.find({ type: 'Button', text: 'Handoff…' }).catch(() => undefined)).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /pays off in \d+ turns? · Recommended/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Ratings train Laya/ }).catch(() => undefined)).toBeUndefined()
  expect(await band.find({ type: 'Button', text: 'Good call' })).toBeDefined()

  const slim = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 50 }, viewport: { columns: 50, rows: 40 } })
  expect(await slim.find({ type: 'Text', text: /picked/ }).catch(() => undefined)).toBeUndefined()
  expect(await slim.find({ type: 'Text', text: 'Opus' })).toBeDefined()
})

test('a cold alert on the chat’s own tier offers a new chat, not a handoff (band fix 5)', async ($: any, on: any) => {
  const { s, clock } = engine(on)
  s.usage = { input_tokens: 50_000 }
  for await (const _ of $.turn.step({ turnId: 't0', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  await clock.advance(2 * 60 * 60_000)
  const band = await $.ui.mount({ plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 100, rows: 24 } })
  expect(await band.find({ type: 'Button', text: 'New chat on Opus' })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /^Handoff to/ }).catch(() => undefined)).toBeUndefined()
})

// --- Settings and Stats in the band's panel: a Pane lost the first press of every button in the app ---

const band100 = { plugin: 'arne', surface: 'terminal', component: 'AbovePrompt', props: {}, viewport: { columns: 100, rows: 40 } } as const

test('one press on each settings choice in the panel writes that setting', async ($: any, on: any) => {
  const { s } = engine(on, 'claude-sonnet-5-5')
  const band = await $.ui.mount(band100)
  await band.press({ key: 'band' })
  await band.press({ key: 'gear' })
  // Auto last: off, the band draws only its off line.
  for (const [key, value] of [['backend', 'heuristic'], ['subagents', 'off'], ['modelFloor', 'sonnet'], ['modelCeiling', 'sonnet'], ['effortFloor', 'medium'], ['effortCeiling', 'high'], ['auto', 'false']]) {
    await band.press({ key: `${key}-${value}` })
    expect(s.writes.at(-1)).toBe(`arne.${key}`)
  }
  expect((await $.command.run({ command: 'arne', args: '' })).text).toContain('arne off')
  await $.command.run({ command: 'arne', args: 'on' })
  await $.command.run({ command: 'arne', args: 'subagents on' })
})

test('Settings and Stats each open from the panel footer, and ‹ Back returns to the main panel; closing resets the view; /arne settings opens it', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ value: '' })) // an empty decisions.jsonl: Stats has nothing yet
  const band = await $.ui.mount(band100)
  const at = async (text: string) => Boolean(await band.find({ type: 'Text', text }).catch(() => undefined))
  await band.press({ key: 'band' })
  await band.press({ key: 'gear' })
  expect([await at('Routing'), await at('Model')]).toEqual([true, false])
  // Settings no longer links to Stats.
  expect(await band.find({ key: 'open-stats' }).catch(() => undefined)).toBeUndefined()
  await band.press({ key: 'back' })
  expect([await at('Model'), await at('Routing')]).toEqual([true, false])
  await band.press({ key: 'open-stats' })
  expect([await at('Stats'), await at('No turns in the last 7 days yet.'), await at('Model')]).toEqual([true, true, false])
  await band.press({ key: 'back' })
  expect([await at('Model'), await at('Stats')]).toEqual([true, false])

  await band.press({ key: 'gear' })
  await band.press({ key: 'band' }) // closes
  await band.press({ key: 'band' }) // opens on its main rows
  expect([await at('Model'), await at('Routing')]).toEqual([true, false])

  await band.press({ key: 'band' })
  expect(await at('Model')).toBe(false)
  await $.command.run({ command: 'arne', args: 'settings' })
  expect(await at('Routing')).toBe(true)
})

test('the costs table has fixed-width columns, a dim header, and the one Hand off at the recommended row\'s end (17w redesign)', async ($: any, on: any) => {
  await stickyOpus($, on)
  const band = await $.ui.mount({ plugin: 'arne', surface: 'desktop', component: 'AbovePrompt', props: { bodyColumns: 100 }, viewport: { columns: 100, rows: 40 } })
  await band.press({ key: 'band' })
  const widths = async (k: string) => (await band.find({ key: `cost-${k}-row` })).children.map((c: any) => c.props.width)
  const first = await widths('head')
  for (const k of ['stay', 'switch', 'handoff']) expect(await widths(k)).toEqual(first)
  expect(first.filter((w: unknown) => typeof w === 'number').length).toBe(4)
  const head = await band.find({ key: 'cost-head-row' })
  expect(head.children[1].children[0]).toMatchObject({ type: 'Text', props: { dimColor: true } })
  expect(await band.find({ type: 'Text', text: 'Stay on Opus' })).toBeDefined()
  const end = (await band.find({ key: 'cost-handoff-row' })).children.at(-1)
  expect(end.children[0].props).toMatchObject({ label: 'Hand off', variant: 'secondary' })
  // The footer gives way to the table's Hand off.
  expect(await band.find({ key: 'handoff-menu' }).catch(() => undefined)).toBeUndefined()
})

test('Subagents reads its ceiling in Settings, not in the panel; no Esc hint, since no key closes the band (fixes 2, 3)', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  const band = await $.ui.mount(band100)
  await band.press({ key: 'band' })
  expect(await band.find({ type: 'Text', text: /Esc/ }).catch(() => undefined)).toBeUndefined()
  expect(await band.find({ key: 'subs-on' }).catch(() => undefined)).toBeUndefined()
  await band.press({ key: 'gear' })
  expect((await band.find({ key: 'subagents-off' })).props.label).toBe('✓ Off') // the picked segment carries a ✓
  expect((await band.find({ key: 'subagents-sonnet' })).props.label).toBe('Sonnet')
})

// --- The redesign: dim secondary text, a quiet resting line, alerts in macOS order ---

test('no Text in the band, panel, alerts, Settings or Stats uses color subtle or inactive', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ value: '' }))
  await coldHeavy($, s, clock) // a cold alert over the band
  const band = await $.ui.mount(band100)
  const check = async () => {
    for (const t of await band.findAll({ type: 'Text' })) expect(['subtle', 'inactive']).not.toContain(t.props.color)
  }
  await check()
  await band.press({ key: 'band' })
  await check()
  await band.press({ key: 'gear' })
  await check()
  await band.press({ key: 'back' })
  await band.press({ key: 'open-stats' })
  await check()
})

test('an alert puts dismiss first and its primary last, with the price it spends', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  await coldHeavy($, s, clock)
  const band = await $.ui.mount(band100)
  const cold = (await band.find({ key: 'alert-cold-actions' })).children
  expect(cold.map((b: any) => b.props.key)).toEqual(['continue', 'handoff', 'compact'])
  expect(cold.at(-1).props.variant).toBe('primary')
  expect(cold.at(-1).props.label).toMatch(/· \$\d+\.\d\d$/)

  await $.prompt.submit(typed('what is a mutex')) // held on the cold chat
  const heldActions = (await band.find({ key: 'alert-held-actions' })).children
  expect(heldActions.map((b: any) => b.props.label)).toEqual([expect.stringMatching(/^Send now · \$/), expect.stringMatching(/^Summarize, then send · \$/)])
  expect(heldActions.at(-1).props.variant).toBe('primary')
  expect(await band.find({ type: 'Text', text: 'Your message is waiting' })).toBeDefined()
})

test('Settings starts with ‹ Back, then its title; the Judge row offers Jev; Limits uses the same effort names as the band', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  const band = await $.ui.mount(band100)
  await $.command.run({ command: 'arne', args: 'settings' })
  const view = await band.find({ key: 'settings-view' })
  expect(view.children[0].props.key).toBe('view-head')
  const head = await band.find({ key: 'view-head' })
  expect(head.children[0].props.label).toBe('‹ Back')
  expect(head.children[1]).toMatchObject({ type: 'Text', props: { weight: 'semibold' } })
  expect(await band.find({ type: 'Text', text: 'Settings' })).toBeDefined()
  expect((await band.find({ key: 'backend-jev' })).props.label).toBe('Jev')
  expect(await band.find({ type: 'Text', text: 'Limits' })).toBeDefined()
  expect(await band.find({ key: 'effortCeiling-medium' })).toMatchObject({ props: { label: 'Medium' } })
  expect(await band.find({ type: 'Text', text: /Also in \/config\./ })).toBeDefined()
})

// The kit draws no paint, so a view's height is counted from its tree, as the terminal lays it out: a Text
// or Button is a row, a border adds two, a column stacks its children with its gap, a row puts them side by side.
// No wrapping is counted here; the widths are checked on their own.
function rowsOf(n: any): number {
  if (!n || typeof n !== 'object') return 0
  if (n.type === 'Text' || n.type === 'Button') return 1
  const p = n.props ?? {}
  const kids = (n.children ?? []).filter((c: any) => c && typeof c === 'object')
  const inner =
    p.flexDirection === 'column'
      ? kids.reduce((sum: number, c: any) => sum + rowsOf(c), 0) + (p.gap ?? 0) * Math.max(0, kids.length - 1)
      : Math.max(0, ...kids.map(rowsOf))
  return inner + (p.borderStyle ? 2 : 0)
}

test('Settings fits the band: side by side from 90 columns in at most 12 rows, stacked at 50, one line per note', async ($: any, on: any) => {
  engine(on, 'claude-sonnet-5-5')
  await $.command.run({ command: 'arne', args: 'backend jev' })
  const wide = await $.ui.mount(band100)
  await $.command.run({ command: 'arne', args: 'settings' })
  expect((await wide.find({ key: 'settings-cards' })).props.flexDirection).toBe('row')
  // 13 rows: the Limits card's five choice rows. Unchecked in the live app: confirm it fits the half-window cap.
  expect(rowsOf(await wide.find({ key: 'settings-view' }))).toBeLessThanOrEqual(13)
  const notes = (await wide.findAll({ type: 'Text' })).filter((x: any) => x.props.size === 'footnote')
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) expect(note.text.length).toBeLessThanOrEqual(96)
  // Every choice row has its label in the same fixed column, so the options line up and a long row wraps under its own options.
  for (const key of ['auto', 'backend', 'subagents', 'modelFloor', 'modelCeiling', 'effortFloor', 'effortCeiling']) {
    const row = await wide.find({ type: 'Box', key })
    expect(row.children[0].props.width).toBe(16)
    expect(row.children[0].children[0].children[0].length).toBeLessThanOrEqual(16)
  }
  await wide.unmount()
  const narrow = await $.ui.mount({ ...band100, props: { bodyColumns: 50 }, viewport: { columns: 50, rows: 40 } })
  await $.command.run({ command: 'arne', args: 'settings' })
  expect((await narrow.find({ key: 'settings-cards' })).props.flexDirection).toBe('column')
})

test('the panel: the why sentence, then one footnote with the last turn\'s cost; Settings, Stats and Handoff… left, Turn off right', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-sonnet-5-5')
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('model.complete', () => ({ value: { text: '{"tier":"M","effort":"medium","reason":"a multi-file edit"}', isAnswered: true } }))
  await $.prompt.submit(typed('refactor the helpers in this module please'))
  for (let i = 0; i < 3; i++) await clock.settle()
  await $.turn.start({ text: 'refactor the helpers in this module please', turnId: 'p1' })
  s.usage = { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }
  for await (const _ of $.turn.step({ turnId: 'p1', index: 0, model: s.model, effort: 'medium', messageCount: 1 })) {
    // drain
  }
  const band = await $.ui.mount(band100)
  expect(await band.find({ type: 'Text', text: /^ *a multi-file edit$/ })).toBeDefined()
  await band.press({ key: 'band' })
  expect(await band.find({ type: 'Text', text: 'Sonnet at medium effort: a multi-file edit.' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^Last turn \$\d+\.\d\d$/ })).toBeDefined()
  const footer = (await band.find({ key: 'footer' })).children
  expect(footer[0].children.map((b: any) => b.props.label)).toEqual(['Settings', 'Stats', 'Handoff…'])
  expect(footer[1].props.label).toBe('Turn arne off')
})

test('subagents are left alone until the user turns routing on (experimental, off by default)', async ($: any, on: any) => {
  engine(on)
  on('model.complete', () => ({ value: { text: '{"tier":"S","effort":"low","reason":"a search"}', isAnswered: true } }))
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? e.parentModel, agentId: `a-${e.tool_use_id}` }))
  const r = await $.agent.spawn({ tool_use_id: 't1', prompt: 'list every atom', description: 'atoms', subagentType: 'Plan', parentModel: 'claude-opus-5-5', background: false, fork: false })
  expect(r.model).toBe('claude-opus-5-5')
})

test('a failed attempt moves one model up at once, and the next prompts stay there for two turns', async ($: any, on: any) => {
  const { s, clock } = engine(on, 'claude-haiku-5-5')
  on('model.complete', () => ({ value: { text: '{"tier":"S","effort":"low","reason":"small script"}', isAnswered: true } }))
  const send = async (text: string) => {
    await $.prompt.submit(typed(text))
    await clock.settle()
  }
  await send('write a script that counts the tests')
  expect(s.ran).toEqual([])
  await send('it says 199, that is wrong, try again')
  expect(s.ran).toEqual(['/model claude-sonnet-5-5'])
  await $.classic.PostModelSwitch({ from_model: 'claude-haiku-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'claude-sonnet-5-5', source: 'command' })
  // The judge says Haiku again, but the hold keeps Sonnet for two prompts.
  await send('write a script for the other test file')
  await send('write a script for the third test file')
  expect(s.ran).toEqual(['/model claude-sonnet-5-5'])
  await send('write a script for the last test file')
  expect(s.ran.at(-1)).toBe('/model claude-haiku-5-5')
})
