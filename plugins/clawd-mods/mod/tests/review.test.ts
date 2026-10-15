import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// レビュー指摘 (2026-10-15) を SPEC §2 の仕様として固定するテスト
type Body = { session: string; state: string; category?: string; tool?: string }

function world(on: On, opts: { verdict?: 'allow' | 'ask'; toolError?: boolean } = {}) {
  const sent: Body[] = []
  mock.env(on, { HOME: '/Users/test' })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/Users/test/work/myproj' }))
  on('session.start', () => ({ cwd: '/Users/test/work/myproj' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: opts.verdict ?? 'allow' }))
  const inflight: { id?: string; tool?: string } = {}
  on('tool.call', async ($, e) => {
    inflight.id = e.tool_use_id
    inflight.tool = e.tool
    await clock.sleep(300) // ツール実行時間。FLUSH_MS (150) より長い
    return opts.toolError ? { result: 'boom', text: 'boom', isError: true } : { result: 'ok', text: 'ok' }
  })
  on('http.fetch', ($, e) => {
    if (e.url.endsWith('/status')) return { value: { status: 200, ok: true, headers: {}, text: '{"ble":"connected"}' } }
    sent.push(JSON.parse(e.init?.body ?? 'null') as Body)
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  // engine は tool.call の実行中に権限判定 (tool.check) を行う。テストではそれを外から起こす
  const check = ($: any) =>
    $.tool.check({ tool: inflight.tool, input: {}, tool_use_id: inflight.id } as never)
  const states = () => sent.map(b => (b.state === 'tool' ? `tool:${b.category}` : b.state))
  return { sent, clock, states, check }
}

const START = { cwd: '/Users/test/work/myproj', surface: null, isInteractive: true } as never

async function runTool($: any, clock: any, tool: object, during?: () => Promise<unknown>) {
  const call = $.tool.call(tool as never)
  await clock.settle()
  if (during) await during()
  await clock.advance(400)
  return call
}

test('A1: 実行中のツールのカテゴリが bridge に届く (FLUSH_MS より長いツール)', async ($, on) => {
  const { clock, states } = world(on)
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await runTool($, clock, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  await clock.advance(200)
  expect(states()).toContain('tool:write')
})

test('tool.check が ask でも、実際の許可ダイアログが無ければ waiting にしない (auto mode)', async ($, on) => {
  const { clock, states, check } = world(on, { verdict: 'ask' })
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await runTool($, clock, { tool: 'Bash', command: 'ls' }, () => check($))
  await clock.advance(200)
  expect(states()).not.toContain('waiting')
})

test('許可ダイアログ (classic.PermissionRequest) が出たら waiting、ツール完了で解除', async ($, on) => {
  const { clock, states } = world(on)
  on('classic.PermissionRequest', () => ({}))
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await runTool($, clock, { tool: 'Bash', command: 'rm x' }, () =>
    $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } } as never),
  )
  await clock.advance(200)
  expect(states()).toContain('waiting')
  expect(states()[states().length - 1]).toBe('thinking')
})

test('サブエージェントの許可ダイアログは waiting にしない (D10)', async ($, on) => {
  const { clock, states } = world(on)
  on('classic.PermissionRequest', () => ({}))
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await runTool($, clock, { tool: 'Bash', command: 'ls' }, () =>
    $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'sub1' } as never),
  )
  await clock.advance(200)
  expect(states()).not.toContain('waiting')
})

test('ツールのエラーは error → 1.5 秒後に thinking', async ($, on) => {
  const { clock, states } = world(on, { toolError: true })
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await runTool($, clock, { tool: 'Bash', command: 'false' })
  await clock.advance(200)
  expect(states()[states().length - 1]).toBe('error')
  await clock.advance(1500)
  expect(states()[states().length - 1]).toBe('thinking')
})

test('D10: サブエージェントのツール呼び出しとターン完了は無視する', async ($, on) => {
  const { clock, states } = world(on)
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await clock.advance(200)
  const before = states().length
  await runTool($, clock, { tool: 'Read', file_path: '/x', agentId: 'sub1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn', agentId: 'sub1' } as never)
  await clock.advance(200)
  expect(states().slice(before)).toEqual([])
})

test('session.end は end を送り、その後は何も送らない', async ($, on) => {
  const { sent, clock } = world(on)
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi' } as never)
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: {} } as never)
  const n = sent.length
  expect(sent[n - 1]).toEqual({ v: 1, session: 'S1', label: 'myproj', state: 'end' } as never)
  await clock.advance(120_000)
  expect(sent.length).toBe(n)
})

test('session.start を繰り返してもループは重複しない (ハートビートは 1 本)', async ($, on) => {
  const { sent, clock } = world(on)
  await $.session.start(START)
  await $.session.start(START)
  await $.session.start(START)
  await clock.advance(200)
  const n = sent.length
  await clock.advance(60_000)
  expect(sent.length - n).toBe(1)
})
