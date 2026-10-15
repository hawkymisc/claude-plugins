import { describe, expect, test } from 'claude-code/testing'

import { CWD, ISSUE_FIELDS, MAX_REPOS, NO_LABEL, PR_FIELDS, clip, detailMarkdown, groupByLabel, parseItems, parseRepoArgs } from '../hooks/logic'

describe('parseItems', () => {
  test('gh の JSON を Item に正規化する (PR)', () => {
    const json = JSON.stringify([
      {
        number: 7,
        title: 'feat: x',
        url: 'https://github.com/o/r/pull/7',
        author: { login: 'alice' },
        body: 'desc',
        labels: [{ name: 'bug' }],
        updatedAt: '2026-10-15T00:00:00Z',
        isDraft: true,
        headRefName: 'feature/x',
      },
    ])
    expect(parseItems(json)).toEqual([
      {
        number: 7,
        title: 'feat: x',
        url: 'https://github.com/o/r/pull/7',
        author: 'alice',
        body: 'desc',
        labels: ['bug'],
        updatedAt: '2026-10-15T00:00:00Z',
        isDraft: true,
        branch: 'feature/x',
        comments: 0,
      },
    ])
  })
  test('欠けたフィールドは空で埋める (author が null の bot 等)', () => {
    const [it] = parseItems(JSON.stringify([{ number: 1, title: 't', url: 'u', author: null, body: null }]))
    expect(it?.author).toBe('')
    expect(it?.body).toBe('')
    expect(it?.labels).toEqual([])
  })
  test('配列でない JSON は例外', () => {
    expect(() => parseItems('{}')).toThrow()
  })
})

describe('groupByLabel', () => {
  const mk = (number: number, labels: string[]) => ({
    number,
    title: '',
    url: '',
    author: '',
    body: '',
    labels,
    updatedAt: '',
    comments: 0,
  })
  test('ラベル名順、ラベルなしは最後。複数ラベルは各グループに出る', () => {
    const groups = groupByLabel([mk(1, ['enhancement']), mk(2, []), mk(3, ['bug', 'enhancement'])])
    expect(groups.map(g => [g.label, g.items.map(i => i.number)])).toEqual([
      ['bug', [3]],
      ['enhancement', [1, 3]],
      [NO_LABEL, [2]],
    ])
  })
  test('空なら空', () => {
    expect(groupByLabel([])).toEqual([])
  })
})

describe('parseRepoArgs', () => {
  test('owner/repo と GitHub URL を受け付ける', () => {
    expect(parseRepoArgs('hawkymisc/mods')).toEqual({ kind: 'set', repos: ['hawkymisc/mods'] })
    expect(parseRepoArgs(' https://github.com/a/b.git ')).toEqual({ kind: 'set', repos: ['a/b'] })
  })
  test('空白・カンマ区切りで複数、重複は除き順序は保つ。. は cwd のリポジトリ', () => {
    expect(parseRepoArgs('a/b c/d,e/f  a/b')).toEqual({ kind: 'set', repos: ['a/b', 'c/d', 'e/f'] })
    expect(parseRepoArgs('. a/b')).toEqual({ kind: 'set', repos: [CWD, 'a/b'] })
  })
  test('空はペインを開くだけ、reset は cwd に戻す', () => {
    expect(parseRepoArgs('')).toEqual({ kind: 'open' })
    expect(parseRepoArgs('reset')).toEqual({ kind: 'reset' })
  })
  test('1 つでも不正なら全体を不正にし、どれが不正か言う', () => {
    const r = parseRepoArgs('a/b foo')
    expect(r.kind).toBe('invalid')
    expect(JSON.stringify(r)).toContain('foo')
    expect(parseRepoArgs('a/b/c').kind).toBe('invalid')
  })
  test(`${MAX_REPOS} 件を超えたら不正`, () => {
    const many = Array.from({ length: MAX_REPOS + 1 }, (_, i) => `o/r${i}`).join(' ')
    expect(parseRepoArgs(many).kind).toBe('invalid')
  })
})

describe('clip', () => {
  test('表示幅 (全角=2) で切って … を付ける', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('あいうえ', 5)).toBe('あい…')
    expect(clip('abc', 10)).toBe('abc')
  })
})

describe('detailMarkdown', () => {
  test('ブランチ・作者・Draft・ラベル・リンク・本文を含む', () => {
    const md = detailMarkdown('pr', {
      number: 9, title: 'T', url: 'https://github.com/o/r/pull/9', author: 'a', body: 'B', labels: ['bug'], updatedAt: '', isDraft: true, branch: 'f/x', comments: 0,
    })
    for (const s of ['PR #9 T', '`f/x`', '@a', 'Draft', '`bug`', '[GitHub で開く](https://github.com/o/r/pull/9)', 'B']) expect(md).toContain(s)
  })
  test('空本文は (説明なし)', () => {
    expect(detailMarkdown('issue', { number: 1, title: '', url: '', author: '', body: '  ', labels: [], updatedAt: '', comments: 0 })).toContain('説明なし')
  })
})

describe('信頼できない GitHub 由来の文字列', () => {
  test('制御文字 (ESC 等) と bidi 制御を落とし、本文の改行・タブは残す', () => {
    const [it] = parseItems(JSON.stringify([{ number: 1, title: 'a\u001b]8;;x\u0007b‮', url: '', author: { login: 'x\u001by' }, body: 'l1\n\tl2\u001b[31m', labels: [{ name: 'b⁦g' }] }]))
    expect(it?.title).toBe('a]8;;xb')
    expect(it?.author).toBe('xy')
    expect(it?.body).toBe('l1\n\tl2[31m')
    expect(it?.labels).toEqual(['bg'])
  })
  test('number が無い要素は不正な出力として例外', () => {
    expect(() => parseItems(JSON.stringify([{ title: 'x' }]))).toThrow()
  })
  test('エラー文に出力の断片を含めない', () => {
    try {
      parseItems('{"token":"secret"}')
    } catch (e) {
      expect(String(e).includes('secret')).toBe(false)
    }
  })
  test('detailMarkdown: バッククォートで code span を抜けられず、github.com 以外の URL はリンクにしない', () => {
    const md = detailMarkdown('pr', { number: 1, title: '[x](javascript:1) *t*', url: 'https://evil.example/1', author: 'a', body: '', labels: ['a`b'], updatedAt: '', branch: 'f`[x](y)', comments: 0 })
    expect(md).not.toContain('a`b')
    expect(md).not.toContain('f`[')
    expect(md).not.toContain('](https://evil.example/1)')
    expect(md).toContain('\\[x\\]')
  })
  test('parseRepoArgs: 先頭 - と . / .. のセグメントは不正', () => {
    expect(parseRepoArgs('-x/y').kind).toBe('invalid')
    expect(parseRepoArgs('../y').kind).toBe('invalid')
    expect(parseRepoArgs('x/.').kind).toBe('invalid')
    expect(parseRepoArgs('a.b/c-d.e').kind).toBe('set')
  })
})

describe('コメントと mergeable', () => {
  test('件数と最新コメントを取り出し、制御文字を落とす', () => {
    const [it] = parseItems(JSON.stringify([{ number: 1, mergeable: 'CONFLICTING', comments: [
      { author: { login: 'a' }, createdAt: '2026-10-01T00:00:00Z', body: 'old' },
      { author: { login: 'b\u001b' }, createdAt: '2026-10-02T00:00:00Z', body: 'new\u001b[2J' },
    ] }]))
    expect(it?.comments).toBe(2)
    expect(it?.lastComment).toEqual({ author: 'b', createdAt: '2026-10-02T00:00:00Z', body: 'new[2J' })
    expect(it?.mergeable).toBe('CONFLICTING')
  })
  test('comments が無ければ 0 件・lastComment なし', () => {
    const [it] = parseItems(JSON.stringify([{ number: 1 }]))
    expect(it?.comments).toBe(0)
    expect(it?.lastComment).toBeUndefined()
  })
  test('gh に comments と mergeable を要求する', () => {
    expect(PR_FIELDS.split(',')).toContain('comments')
    expect(PR_FIELDS.split(',')).toContain('mergeable')
    expect(ISSUE_FIELDS.split(',')).toContain('comments')
  })
})
