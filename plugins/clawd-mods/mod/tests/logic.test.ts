import { describe, expect, test } from 'claude-code/testing'

import { toBase64, animSvg, rasterCells } from '../hooks/draw'
import { Tracker, animOf, captionOf, categoryOf, eventBody, shortToolName } from '../hooks/logic'
import { ANIMS } from '../hooks/sprites'

describe('categoryOf (SPEC §2 カテゴリ写像)', () => {
  test('組み込みツールを 6 カテゴリへ', () => {
    expect(categoryOf('Read')).toBe('read')
    expect(categoryOf('Grep')).toBe('read')
    expect(categoryOf('Glob')).toBe('read')
    expect(categoryOf('Edit')).toBe('write')
    expect(categoryOf('Write')).toBe('write')
    expect(categoryOf('Bash')).toBe('bash')
    expect(categoryOf('WebFetch')).toBe('web')
    expect(categoryOf('WebSearch')).toBe('web')
    expect(categoryOf('Agent')).toBe('agent')
  })
  test('MCP と未知のツールは other', () => {
    expect(categoryOf('mcp__github__create_issue')).toBe('other')
    expect(categoryOf('SomethingNew')).toBe('other')
  })
})

describe('shortToolName (SPEC §3)', () => {
  test('MCP は末尾のツール名、12 文字で切る', () => {
    expect(shortToolName('mcp__github__create_issue')).toBe('create_issue')
    expect(shortToolName('mcp__x__a_very_long_tool_name')).toBe('a_very_long_')
    expect(shortToolName('Edit')).toBe('Edit')
  })
})

describe('Tracker (SPEC §2 状態遷移)', () => {
  test('submit → thinking、ツール中はそのカテゴリ、終了で thinking', () => {
    const t = new Tracker()
    expect(t.view()).toEqual({ state: 'idle' })
    t.submit()
    expect(t.view()).toEqual({ state: 'thinking' })
    t.toolStart('a', 'Read')
    expect(t.view()).toEqual({ state: 'tool', category: 'read', tool: 'Read' })
    t.toolEnd('a', false)
    expect(t.view()).toEqual({ state: 'thinking' })
  })

  test('並列呼び出しは最後に始まった未完了のものを表示', () => {
    const t = new Tracker()
    t.submit()
    t.toolStart('a', 'Read')
    t.toolStart('b', 'Bash')
    expect(animOf(t.view())).toBe('bash')
    t.toolEnd('b', false)
    expect(animOf(t.view())).toBe('read')
    t.toolEnd('a', false)
    expect(animOf(t.view())).toBe('thinking')
  })

  test('同名の呼び出しが並列なら、まだ待っていない最新のものを waiting にする', () => {
    const t = new Tracker()
    t.submit()
    t.toolStart('a', 'Bash')
    t.toolStart('b', 'Bash')
    t.toolAskByName('Bash')
    t.toolEnd('a', false)
    expect(t.view()).toEqual({ state: 'waiting', tool: 'Bash' }) // b が待っている
    t.toolEnd('b', false)
    expect(t.view()).toEqual({ state: 'thinking' })
    t.toolAskByName('Nope') // 該当なしは無視
    expect(t.view()).toEqual({ state: 'thinking' })
  })

  test('エラーは recover まで error を保ち、その後 thinking', () => {
    const t = new Tracker()
    t.submit()
    t.toolStart('a', 'Bash')
    t.toolEnd('a', true)
    expect(t.view()).toEqual({ state: 'error' })
    t.toolStart('b', 'Read')
    expect(t.view()).toEqual({ state: 'error' })
    t.recover()
    expect(animOf(t.view())).toBe('read')
  })

  test('許可待ちの呼び出しは完了まで waiting、他より優先 (ツール名で特定)', () => {
    const t = new Tracker()
    t.submit()
    t.toolStart('a', 'Read')
    t.toolStart('b', 'Bash')
    t.toolAskByName('Read')
    expect(t.view()).toEqual({ state: 'waiting', tool: 'Read' })
    t.toolEnd('a', false)
    expect(animOf(t.view())).toBe('bash')
  })

  test('turn 完了で done。次の submit まで done のまま', () => {
    const t = new Tracker()
    t.submit()
    t.toolStart('a', 'Read')
    t.complete()
    expect(t.view()).toEqual({ state: 'done' })
    t.recover() // error 用のタイマーが残っていても done は崩れない
    expect(t.view()).toEqual({ state: 'done' })
    t.submit()
    expect(t.view()).toEqual({ state: 'thinking' })
  })

})

describe('captionOf', () => {
  test('ツール名付きの説明', () => {
    expect(captionOf({ state: 'tool', category: 'write', tool: 'Edit' })).toBe('Writing · Edit')
    expect(captionOf({ state: 'idle' })).toBe('Idle')
  })
})

describe('eventBody (SPEC §3 / D7)', () => {
  test('ツール名と状態のみ。label は 12 文字まで', () => {
    const body = JSON.parse(eventBody('S', 'a-very-long-project-name', { state: 'tool', category: 'bash', tool: 'Bash' }))
    expect(body).toEqual({ v: 1, session: 'S', label: 'a-very-long-', state: 'tool', category: 'bash', tool: 'Bash' })
  })
  test('end', () => {
    expect(JSON.parse(eventBody('S', 'p', 'end'))).toEqual({ v: 1, session: 'S', label: 'p', state: 'end' })
  })
})

describe('draw', () => {
  test('toBase64 は標準パディング付き', () => {
    expect(toBase64(new Uint8Array([]))).toBe('')
    expect(toBase64(new Uint8Array([102]))).toBe('Zg==')
    expect(toBase64(new Uint8Array([102, 111]))).toBe('Zm8=')
    expect(toBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v')
  })
  test('全アニメの SVG が上限 131072 文字未満で、フレーム数ぶんの <g> を持つ', () => {
    for (const name of Object.keys(ANIMS) as (keyof typeof ANIMS)[]) {
      const svg = animSvg(name, 3)
      expect(svg.length < 131072).toBe(true)
      expect(svg.split('<g ').length - 1).toBe(ANIMS[name].frames.length)
    }
  })
  test('Raster のセル数は 16×6×3 u32 = 1152 byte', () => {
    const b64 = rasterCells('idle', 0)
    expect(b64.length).toBe(Math.ceil(1152 / 3) * 4)
  })
})
