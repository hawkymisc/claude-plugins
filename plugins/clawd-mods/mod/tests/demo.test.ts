import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// `/clawd-mods demo`: プロンプト上の帯で全アニメを 1 つ 3 秒ずつ再生する
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } } as const

function world(on: On) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test' })
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/Users/test/work/myproj' }))
  on('session.start', () => ({ cwd: '/Users/test/work/myproj' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"ble":"connected"}' } }))
  return clock
}

const RUN = (args: string) => ({ command: 'clawd-mods', args, origin: 'user' }) as never

test('demo 引数で帯に全アニメを 3 秒ずつ流し、終わったら通常表示に戻る', async ($, on) => {
  const clock = world(on)
  await $.session.start({ cwd: '/Users/test/work/myproj', surface: null, isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'clawd-mods', surface: 'desktop', ...BAND } as never)
  const r = await $.command.run(RUN('demo'))
  expect((r as { text?: string }).text).toMatch(/demo/)
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /demo 1\/11 · idle/ })).toBeDefined()
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /demo 2\/11 · thinking/ })).toBeDefined()
  await clock.advance(3000 * 9)
  expect(await ui.find({ type: 'Text', text: /demo 11\/11 · waiting/ })).toBeDefined()
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /demo/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeDefined()
  await ui.unmount()
})

test('引数なし・不明な引数は使い方を返し、demo は始めない', async ($, on) => {
  const clock = world(on)
  await $.session.start({ cwd: '/Users/test/work/myproj', surface: null, isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'clawd-mods', surface: 'terminal', ...BAND } as never)
  for (const args of ['', 'dance']) {
    const r = await $.command.run(RUN(args))
    expect((r as { text?: string }).text).toMatch(/usage|使い方/i)
  }
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /demo/ })).toBeUndefined()
  await ui.unmount()
})

test('demo 中にもう一度 demo で最初から', async ($, on) => {
  const clock = world(on)
  await $.session.start({ cwd: '/Users/test/work/myproj', surface: null, isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'clawd-mods', surface: 'desktop', ...BAND } as never)
  await $.command.run(RUN('demo'))
  await clock.advance(6010)
  await $.command.run(RUN('demo'))
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /demo 1\/11/ })).toBeDefined()
  await ui.unmount()
})
