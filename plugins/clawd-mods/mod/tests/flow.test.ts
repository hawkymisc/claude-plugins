import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Sent = { url: string; body: unknown; socketPath?: string }

/** 実行環境の下側 (engine) を最小限そろえ、bridge への送信を記録する。 */
function world(on: On, bridgeUp: boolean) {
  const sent: Sent[] = []
  mock.env(on, { HOME: '/Users/test' })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/Users/test/work/myproj' }))
  on('session.start', () => ({ cwd: '/Users/test/work/myproj' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('http.fetch', ($, e) => {
    if (!bridgeUp) return { deny: 'ECONNREFUSED' }
    if (e.url.endsWith('/status')) {
      return { value: { status: 200, ok: true, headers: {}, text: '{"ble":"connected","sessions":1}' } }
    }
    sent.push({ url: e.url, body: JSON.parse(e.init?.body ?? 'null'), socketPath: e.init?.socketPath })
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  return { sent, clock }
}

const START = { cwd: '/Users/test/work/myproj', surface: null, isInteractive: true }

test('ツール呼び出しが bridge へ tool → thinking として届く', async ($, on) => {
  const { sent, clock } = world(on, true)
  await $.session.start(START as never)
  await clock.advance(200)
  await $.prompt.submit({ text: 'hi' } as never)
  await clock.advance(200)
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await clock.advance(200)
  const states = sent.map(s => (s.body as { state: string; category?: string }).state)
  expect(sent[0]?.socketPath).toBe('/Users/test/.clawd-bridge/bridge.sock')
  expect(sent[0]?.url).toBe('http://clawd/event')
  expect(states[0]).toBe('idle')
  expect(states).toContain('thinking')
  // 送信は FLUSH_MS 毎の最新値なので、tool 状態は合間に潰れることがある。最後は thinking。
  expect(states[states.length - 1]).toBe('thinking')
  for (const s of sent) {
    expect((s.body as { label: string }).label).toBe('myproj')
    expect(JSON.stringify(s.body).includes('/x')).toBe(false) // D7: パスは送らない
  }
})

test('turn 完了の done は次のプロンプトまで維持し、プロンプトで thinking に戻る', async ($, on) => {
  const { sent, clock } = world(on, true)
  await $.session.start(START as never)
  await $.prompt.submit({ text: 'hi' } as never)
  await clock.advance(200)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
  await clock.advance(200)
  const last = () => (sent[sent.length - 1]?.body as { state: string }).state
  expect(last()).toBe('done')
  await clock.advance(10 * 60_000) // 10 分経っても done のまま (ハートビートも done)
  expect(last()).toBe('done')
  await $.prompt.submit({ text: 'next' } as never)
  await clock.advance(200)
  expect(last()).toBe('thinking')
})

test('bridge 停止中でもツールは普通に動く (D12)', async ($, on) => {
  const { clock } = world(on, false)
  await $.session.start(START as never)
  await $.prompt.submit({ text: 'hi' } as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await clock.advance(400)
  expect((r as { text?: string }).text).toBe('ok')
})
