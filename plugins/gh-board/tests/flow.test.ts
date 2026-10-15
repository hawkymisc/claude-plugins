import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PRS = JSON.stringify([
  {
    number: 12,
    title: 'feat: pane',
    url: 'https://github.com/o/r/pull/12',
    author: { login: 'alice' },
    body: '## Summary\n\n- adds a pane',
    labels: [],
    updatedAt: '2026-10-15T00:00:00Z',
    isDraft: false,
    headRefName: 'feature/pane',
    mergeable: 'MERGEABLE',
    comments: [
      { author: { login: 'carol' }, createdAt: '2026-10-14T00:00:00Z', body: 'first' },
      { author: { login: 'dave' }, createdAt: '2026-10-15T00:00:00Z', body: 'LGTM latest' },
    ],
  },
  {
    number: 13,
    title: 'conflicted',
    url: 'https://github.com/o/r/pull/13',
    author: { login: 'alice' },
    body: '',
    labels: [],
    updatedAt: '',
    headRefName: 'feature/c',
    mergeable: 'CONFLICTING',
    comments: [],
  },
])
const ISSUES = JSON.stringify([
  { number: 3, title: 'crash on start', url: 'https://github.com/o/r/issues/3', author: { login: 'bob' }, body: 'boom', labels: [{ name: 'bug' }], updatedAt: '' },
  { number: 4, title: 'handover', url: 'https://github.com/o/r/issues/4', author: { login: 'bob' }, body: '', labels: [], updatedAt: '' },
])

type Run = { argv: readonly string[] }

/** engine の下側。gh の応答を差し替え、呼ばれた argv を記録する。 */
function world(on: On, gh: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string }) {
  const runs: Run[] = []
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/Users/test/work/r' }))
  on('session.start', () => ({ cwd: '/Users/test/work/r' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv })
    return { value: { ...gh(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, clock }
}

const ok = (argv: readonly string[]) => {
  if (argv.includes('repo')) return { exitCode: 0, stdout: 'o/r\n', stderr: '' }
  if (argv.includes('pr')) return { exitCode: 0, stdout: PRS, stderr: '' }
  return { exitCode: 0, stdout: ISSUES, stderr: '' }
}

const START = { cwd: '/Users/test/work/r', surface: null, isInteractive: true }
const PANE = { component: 'Pane', requestId: 'gh-board', props: { bodyColumns: 60 } } as const

test('セッション開始で取得し、PR とラベル別 Issue を描く (terminal / desktop)', async ($, on) => {
  const { runs, clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  expect(runs.some(r => r.argv.includes('pr') && r.argv.includes('list'))).toBe(true)
  expect(runs.some(r => r.argv.includes('issue') && r.argv.includes('list'))).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gh-board', surface, ...PANE } as never)
    expect(await ui.find({ key: 'pr-12' })).toBeDefined()
    expect(await ui.find({ key: 'issue-3' })).toBeDefined()
    expect(await ui.find({ key: 'toggle:label:bug' })).toBeDefined()
    expect(await ui.find({ text: /o\/r/ })).toBeDefined()
    await ui.unmount()
  }
})

test('ターン終了ごとに取り直す', async ($, on) => {
  const { runs, clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const before = runs.length
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(10)
  expect(runs.filter(r => r.argv.includes('pr')).length).toBeGreaterThan(
    runs.slice(0, before).filter(r => r.argv.includes('pr')).length,
  )
})

test('ラベルの見出しを押すと折りたたみ、もう一度で開く', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'toggle:label:bug' } as never)
  expect(await ui.find({ key: 'issue-3' })).toBeUndefined()
  expect(await ui.find({ key: 'issue-4' })).toBeDefined()
  await ui.press({ key: 'toggle:label:bug' } as never)
  expect(await ui.find({ key: 'issue-3' })).toBeDefined()
  await ui.unmount()
})

test('PR を押すと Description を Markdown で描き、Back で一覧へ戻る', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gh-board', surface, ...PANE } as never)
    await ui.press({ key: 'pr-12' } as never)
    const md = await ui.find({ type: 'Markdown' })
    expect(md).toBeDefined()
    expect(JSON.stringify(md)).toContain('adds a pane')
    expect(await ui.find({ key: 'pr-12' })).toBeUndefined()
    await ui.press({ key: 'back' } as never)
    expect(await ui.find({ key: 'pr-12' })).toBeDefined()
    await ui.unmount()
  }
})

test('gh が失敗したら理由をペインに出す (リモートなし等)', async ($, on) => {
  const { clock } = world(on, () => ({ exitCode: 1, stdout: '', stderr: 'no git remotes found\n' }))
  await $.session.start(START as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ text: /no git remotes found/ })).toBeDefined()
  await ui.unmount()
})

test('/gh-board owner/repo で対象を切り替え --repo 付きで取得する', async ($, on) => {
  const { runs, clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const r = await $.command.run({ command: 'gh-board', args: 'x/y' } as never)
  await clock.advance(10)
  expect(JSON.stringify(r)).toContain('x/y')
  const last = runs[runs.length - 1]
  expect(last?.argv.join(' ')).toContain('--repo x/y')
})

test('Issue を押すと本文を描き、空本文は (説明なし)、Back で戻る', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'desktop', ...PANE } as never)
  await ui.press({ key: 'issue-4' } as never)
  expect(JSON.stringify(await ui.find({ type: 'Markdown' }))).toContain('説明なし')
  await ui.press({ key: 'back' } as never)
  await ui.press({ key: 'issue-3' } as never)
  expect(JSON.stringify(await ui.find({ type: 'Markdown' }))).toContain('boom')
  await ui.press({ key: 'back' } as never)
  expect(await ui.find({ key: 'issue-3' })).toBeDefined()
  await ui.unmount()
})

test('PR / Issues セクション自体も折りたためる', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'toggle:prs' } as never)
  expect(await ui.find({ key: 'pr-12' })).toBeUndefined()
  await ui.press({ key: 'toggle:issues' } as never)
  expect(await ui.find({ key: 'issue-4' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle:label:bug' })).toBeUndefined()
  await ui.unmount()
})

test('/gh-board reset で cwd のリポジトリ (gh repo view) に戻る', async ($, on) => {
  const { runs, clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  await $.command.run({ command: 'gh-board', args: 'x/y' } as never)
  const mark = runs.length
  await $.command.run({ command: 'gh-board', args: 'reset' } as never)
  await clock.advance(10)
  const after = runs.slice(mark).map(r => r.argv.join(' '))
  expect(after.some(a => a.includes('repo view'))).toBe(true)
  expect(after.some(a => a.includes('--repo x/y'))).toBe(false)
})

test('不正な引数は gh を呼ばずに理由を返す', async ($, on) => {
  const { runs, clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const mark = runs.length
  const r = await $.command.run({ command: 'gh-board', args: 'foo' } as never)
  expect(JSON.stringify(r)).toContain('owner/repo')
  expect(runs.length).toBe(mark)
})

test('PATH に gh が無ければ /opt/homebrew/bin/gh を試し、以後それを使う', async ($, on) => {
  const tried: string[] = []
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    tried.push(e.argv[0] ?? '')
    if (e.argv[0] === 'gh') return { deny: 'ENOENT' }
    return { value: { ...ok(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start(START as never)
  await clock.advance(10)
  expect(tried[0]).toBe('gh')
  expect(tried[1]).toBe('/opt/homebrew/bin/gh')
  const n = tried.filter(b => b === 'gh').length
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(10)
  expect(tried.filter(b => b === 'gh').length).toBe(n)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ key: 'pr-12' })).toBeDefined()
  await ui.unmount()
})

test('失敗のあと成功すればエラー表示が消え、失敗は前回のデータを残す', async ($, on) => {
  let fail = false
  const { clock } = world(on, argv => (fail ? { exitCode: 1, stdout: '', stderr: 'HTTP 502\n' } : ok(argv)))
  await $.session.start(START as never)
  await clock.advance(10)
  fail = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ text: /HTTP 502/ })).toBeDefined()
  expect(await ui.find({ key: 'pr-12' })).toBeDefined()
  fail = false
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await clock.advance(10)
  expect(await ui.find({ text: /HTTP 502/ })).toBeUndefined()
  await ui.unmount()
})

test('サブエージェントのターン終了 (agentId あり) では取得しない', async ($, on) => {
  const { runs, clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const mark = runs.length
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'sub1' } as never)
  await clock.advance(10)
  expect(runs.length).toBe(mark)
})

test('別リポジトリへの切替が失敗したら旧リポジトリのデータを出さない', async ($, on) => {
  const { clock } = world(on, argv => (argv.join(' ').includes('--repo x/y') ? { exitCode: 1, stdout: '', stderr: 'Could not resolve to a Repository\n' } : ok(argv)))
  await $.session.start(START as never)
  await clock.advance(10)
  await $.command.run({ command: 'gh-board', args: 'x/y' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ key: 'pr-12' })).toBeUndefined()
  expect(await ui.find({ text: /x\/y/ })).toBeDefined()
  expect(await ui.find({ text: /Could not resolve/ })).toBeDefined()
  await ui.unmount()
})

test('上限を超える件数は 50+ と表示する', async ($, on) => {
  const many = JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ number: i + 1, title: `t${i}`, url: '', author: { login: 'a' }, body: '', labels: [], updatedAt: '' })))
  const { runs, clock } = world(on, argv => (argv.includes('repo') ? ok(argv) : { exitCode: 0, stdout: argv.includes('pr') ? many : '[]', stderr: '' }))
  await $.session.start(START as never)
  await clock.advance(10)
  expect(runs.find(r => r.argv.includes('pr'))?.argv.join(' ')).toContain('--limit 51')
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ text: /50\+/ })).toBeDefined()
  expect(await ui.find({ key: 'pr-51' })).toBeUndefined()
  expect(await ui.find({ key: 'pr-50' })).toBeDefined()
  await ui.unmount()
})

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
/** 描画ツリーで key の Button を探し、祖先 Box の paddingLeft の合計と label を返す */
function indentOf(tree: unknown, key: string, pad = 0): { pad: number; label: string } | undefined {
  const n = tree as Node
  if (n === null || typeof n !== 'object') return undefined
  if (n.type === 'Button' && n.props?.key === key) return { pad, label: String(n.props?.label ?? '') }
  const here = pad + (n.type === 'Box' ? Number(n.props?.paddingLeft ?? 0) : 0)
  for (const c of n.children ?? []) {
    const hit = indentOf(c, key, here)
    if (hit) return hit
  }
  return undefined
}

test('カテゴリの下の行は Box の余白でインデントする (空白文字に頼らない)', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gh-board', surface, ...PANE } as never)
    const tree = await ui.drawn()
    const at = (key: string) => indentOf(tree, key)
    expect(at('toggle:prs')?.pad).toBe(0)
    expect(at('toggle:issues')?.pad).toBe(0)
    expect(at('pr-12')?.pad).toBe(2)
    expect(at('toggle:label:bug')?.pad).toBe(2)
    expect(at('issue-3')?.pad).toBe(4)
    for (const key of ['pr-12', 'toggle:label:bug', 'issue-3']) expect(at(key)?.label.startsWith(' ')).toBe(false)
    await ui.unmount()
  }
})


/** 描画ツリーで key の Button を探す */
function findButton(tree: unknown, key: string): Node | undefined {
  const n = tree as Node
  if (n === null || typeof n !== 'object') return undefined
  if (n.type === 'Button' && n.props?.key === key) return n
  for (const c of n.children ?? []) {
    const hit = findButton(c, key)
    if (hit) return hit
  }
  return undefined
}
const colorsIn = (n: Node | undefined): unknown[] =>
  (n?.children ?? []).flatMap(c => (typeof c === 'object' && c !== null ? [(c as Node).props?.color, ...colorsIn(c as Node)] : []))

test('一覧の行にコメント数を出し、0 件なら出さない', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gh-board', surface, ...PANE } as never)
    const tree = await ui.drawn()
    expect(String(findButton(tree, 'pr-12')?.props?.label)).toContain('💬2')
    expect(String(findButton(tree, 'pr-13')?.props?.label)).not.toContain('💬')
    await ui.unmount()
  }
})

test('Conflict している PR (mergeable=CONFLICTING) は赤で描き、他は赤にしない', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gh-board', surface, ...PANE } as never)
    const tree = await ui.drawn()
    expect(colorsIn(findButton(tree, 'pr-13'))).toContain('red')
    expect(colorsIn(findButton(tree, 'pr-12'))).not.toContain('red')
    await ui.unmount()
  }
})

test('詳細に最新のコメント (作者・本文) と Conflict の有無を出す', async ($, on) => {
  const { clock } = world(on, ok)
  await $.session.start(START as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'desktop', ...PANE } as never)
  await ui.press({ key: 'pr-12' } as never)
  const md = JSON.stringify(await ui.find({ type: 'Markdown' }))
  expect(md).toContain('LGTM latest')
  expect(md).toContain('@dave')
  expect(md).not.toContain('first')
  await ui.press({ key: 'back' } as never)
  await ui.press({ key: 'pr-13' } as never)
  expect(JSON.stringify(await ui.find({ type: 'Markdown' }))).toContain('Conflict')
  await ui.unmount()
})


const XY_PRS = JSON.stringify([
  { number: 12, title: 'xy pr', url: 'https://github.com/x/y/pull/12', author: { login: 'eve' }, body: 'XY BODY', labels: [], updatedAt: '', comments: [] },
])
/** o/r は ok と同じ、x/y は別データ、z/z は存在しない */
const multi = (argv: readonly string[]) => {
  const a = argv.join(' ')
  if (a.includes('--repo z/z')) return { exitCode: 1, stdout: '', stderr: 'Could not resolve to a Repository\n' }
  if (a.includes('--repo x/y')) return { exitCode: 0, stdout: argv.includes('pr') ? XY_PRS : '[]', stderr: '' }
  return ok(argv)
}

test('複数リポジトリを指定すると、それぞれを見出しの下に同時に描く', async ($, on) => {
  const { runs, clock } = world(on, multi)
  await $.session.start(START as never)
  await clock.advance(10)
  const r = await $.command.run({ command: 'gh-board', args: 'o/r x/y' } as never)
  await clock.advance(10)
  const argvs = runs.map(x => x.argv.join(' '))
  expect(argvs.some(a => a.includes('pr list') && a.includes('--repo o/r'))).toBe(true)
  expect(argvs.some(a => a.includes('pr list') && a.includes('--repo x/y'))).toBe(true)
  expect(JSON.stringify(r)).toContain('o/r')
  expect(JSON.stringify(r)).toContain('x/y')
  expect(JSON.stringify(r).includes('gh-board:')).toBe(false) // エンジンが付けるので自前で付けない
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gh-board', surface, ...PANE } as never)
    const tree = await ui.drawn()
    expect(indentOf(tree, 'toggle:repo:o/r')?.pad).toBe(0)
    expect(indentOf(tree, 'toggle:repo:x/y')?.pad).toBe(0)
    expect(indentOf(tree, 'o/r:toggle:prs')?.pad).toBe(2)
    expect(indentOf(tree, 'o/r:pr-12')?.pad).toBe(4)
    expect(indentOf(tree, 'o/r:issue-3')?.pad).toBe(6)
    expect(indentOf(tree, 'x/y:pr-12')).toBeDefined()
    await ui.unmount()
  }
})

test('同じ番号でもリポジトリごとの詳細を開き、Back で戻る', async ($, on) => {
  const { clock } = world(on, multi)
  await $.session.start(START as never)
  await $.command.run({ command: 'gh-board', args: 'o/r x/y' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'desktop', ...PANE } as never)
  await ui.press({ key: 'x/y:pr-12' } as never)
  const md = JSON.stringify(await ui.find({ type: 'Markdown' }))
  expect(md).toContain('XY BODY')
  expect(md).toContain('x/y')
  await ui.press({ key: 'back' } as never)
  await ui.press({ key: 'o/r:pr-12' } as never)
  expect(JSON.stringify(await ui.find({ type: 'Markdown' }))).toContain('adds a pane')
  await ui.unmount()
})

test('1 つのリポジトリが失敗しても他は描き、失敗したリポジトリの下に理由を出す', async ($, on) => {
  const { clock } = world(on, multi)
  await $.session.start(START as never)
  const r = await $.command.run({ command: 'gh-board', args: 'o/r z/z' } as never)
  await clock.advance(10)
  expect(JSON.stringify(r)).toContain('Could not resolve')
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ key: 'o/r:pr-12' })).toBeDefined()
  expect(await ui.find({ key: 'toggle:repo:z/z' })).toBeDefined()
  expect(await ui.find({ text: /Could not resolve/ })).toBeDefined()
  await ui.unmount()
})

test('リポジトリ見出しで、そのリポジトリだけ折りたたむ', async ($, on) => {
  const { clock } = world(on, multi)
  await $.session.start(START as never)
  await $.command.run({ command: 'gh-board', args: 'o/r x/y' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-board', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'toggle:repo:o/r' } as never)
  expect(await ui.find({ key: 'o/r:pr-12' })).toBeUndefined()
  expect(await ui.find({ key: 'x/y:pr-12' })).toBeDefined()
  await ui.unmount()
})

test('. は cwd のリポジトリ (gh repo view) として他と並べる', async ($, on) => {
  const { runs, clock } = world(on, multi)
  await $.session.start(START as never)
  const mark = runs.length
  await $.command.run({ command: 'gh-board', args: '. x/y' } as never)
  await clock.advance(10)
  const after = runs.slice(mark).map(x => x.argv.join(' '))
  expect(after.some(a => a.includes('repo view'))).toBe(true)
  expect(after.some(a => a.includes('--repo o/r'))).toBe(true)
  expect(after.some(a => a.includes('--repo x/y'))).toBe(true)
})
