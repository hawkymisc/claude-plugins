import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } } as const

/** 描画は初回に遅延初期化 (session.id 等) するので engine 側をそろえる。ble は bridge の応答。 */
function world(on: On, ble: 'connected' | 'scanning' | 'down') {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test' })
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/Users/test/work/myproj' }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', () =>
    ble === 'down'
      ? { deny: 'ECONNREFUSED' }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ble }) } },
  )
  return clock
}

test('AbovePrompt: terminal / desktop の両方で Clawd と説明を描く (D4)', async ($, on) => {
  const clock = world(on, 'connected')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-mods', surface, ...BAND } as never)
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeDefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /未接続/ })).toBeUndefined() // 接続中は出さない
    await ui.unmount()
  }
})

test('A3: bridge 停止中は「未接続 (bridge停止)」を出す', async ($, on) => {
  const clock = world(on, 'down')
  const ui = await $.ui.mount({ plugin: 'clawd-mods', surface: 'desktop', ...BAND } as never)
  await clock.advance(10) // 遅延初期化 → status 取得 → 再描画
  expect(await ui.find({ type: 'Text', text: 'Cardputer: 未接続 (bridge停止)' })).toBeDefined()
  await ui.unmount()
})

test('BLE 未接続 (scanning) は「未接続」だけを出す', async ($, on) => {
  const clock = world(on, 'scanning')
  const ui = await $.ui.mount({ plugin: 'clawd-mods', surface: 'terminal', ...BAND } as never)
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: 'Cardputer: 未接続' })).toBeDefined()
  await ui.unmount()
})

test('survey 中は描かない (engine の描画に委ねる)', async ($, on) => {
  world(on, 'connected')
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine')
  }) // engine 側の描画
  const ui = await $.ui.mount({
    plugin: 'clawd-mods',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { ...BAND.props, hasSurvey: true },
  } as never)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})
