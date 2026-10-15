import type { Item } from '../types'

/** ラベルが 1 つも無い Issue のグループ名 */
export const NO_LABEL = '(ラベルなし)'

export const PR_FIELDS = 'number,title,url,author,body,labels,updatedAt,isDraft,headRefName,mergeable,comments'
export const ISSUE_FIELDS = 'number,title,url,author,body,labels,updatedAt,comments'

type Raw = {
  number?: number
  title?: string
  url?: string
  author?: { login?: string } | null
  body?: string | null
  labels?: { name?: string }[] | null
  updatedAt?: string
  isDraft?: boolean
  headRefName?: string
  mergeable?: string
  comments?: { author?: { login?: string } | null; body?: string | null; createdAt?: string }[] | null
}

const MERGEABLE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const

// 端末エスケープ (ESC/OSC/CSI 等の C0・C1 制御) と bidi 制御。GitHub 由来の文字列は信頼しない
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const BODY_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const clean = (s: string | null | undefined) => (s ?? '').replace(CONTROLS, '')

/** `gh pr list --json` / `gh issue list --json` の出力を Item[] にする。形が違えば例外 (出力の中身はエラー文に含めない)。 */
export function parseItems(json: string): Item[] {
  const raw: unknown = JSON.parse(json)
  if (!Array.isArray(raw)) throw new Error('gh の出力が配列ではない')
  return (raw as Raw[]).map((r, i) => {
    if (typeof r?.number !== 'number') throw new Error(`gh の出力の ${i} 番目に number が無い`)
    const item: Item = {
      number: r.number,
      title: clean(r.title),
      url: clean(r.url),
      author: clean(r.author?.login),
      body: (r.body ?? '').replace(BODY_CONTROLS, ''),
      labels: (r.labels ?? []).map(l => clean(l.name)).filter(n => n !== ''),
      updatedAt: clean(r.updatedAt),
      comments: r.comments?.length ?? 0,
    }
    if (r.isDraft !== undefined) item.isDraft = r.isDraft
    if (r.headRefName !== undefined) item.branch = clean(r.headRefName)
    const m = MERGEABLE.find(v => v === r.mergeable)
    if (m !== undefined) item.mergeable = m
    const last = item.comments > 0 ? r.comments?.[item.comments - 1] : undefined
    if (last !== undefined) {
      item.lastComment = {
        author: clean(last.author?.login),
        body: (last.body ?? '').replace(BODY_CONTROLS, ''),
        createdAt: clean(last.createdAt),
      }
    }
    return item
  })
}

export type LabelGroup = { label: string; items: Item[] }

/** ラベル名順にグループ化。複数ラベルの Issue は各グループに出し、ラベルなしは最後。 */
export function groupByLabel(items: readonly Item[]): LabelGroup[] {
  const map = new Map<string, Item[]>()
  for (const it of items) {
    for (const label of it.labels.length === 0 ? [NO_LABEL] : it.labels) {
      const list = map.get(label) ?? []
      list.push(it)
      map.set(label, list)
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === NO_LABEL ? 1 : b === NO_LABEL ? -1 : a.localeCompare(b)))
    .map(([label, list]) => ({ label, items: list }))
}

/** `/gh-board` の引数で「セッションの cwd のリポジトリ」を表す */
export const CWD = '.'
/** 同時に表示できるリポジトリ数 (1 リポジトリにつき gh を 2 回呼ぶ) */
export const MAX_REPOS = 10

export type RepoArgs =
  | { kind: 'open' }
  | { kind: 'reset' }
  | { kind: 'set'; repos: string[] }
  | { kind: 'invalid'; reason: string }

// 各セグメントは先頭 '-' と '.' / '..' を除く (gh の引数として紛らわしいもの)
const REPO = /^(?:https?:\/\/github\.com\/)?((?!-)(?!\.\.?\/)[\w.-]+)\/((?!-)(?!\.\.?(?:\.git)?\/?$)[\w.-]+?)(?:\.git)?\/?$/

/**
 * `/gh-board` の引数: 空=開くだけ、reset=cwd のリポジトリに戻す、
 * 空白/カンマ区切りの owner/repo・GitHub URL・`.` (cwd) = 表示対象をその並びにする
 */
export function parseRepoArgs(args: string): RepoArgs {
  const tokens = args.split(/[\s,]+/).filter(t => t !== '')
  if (tokens.length === 0) return { kind: 'open' }
  if (tokens.length === 1 && tokens[0] === 'reset') return { kind: 'reset' }
  const repos: string[] = []
  for (const t of tokens) {
    const m = t === CWD ? null : REPO.exec(t)
    if (t !== CWD && m === null) return { kind: 'invalid', reason: `owner/repo の形式ではない: ${t}` }
    const repo = m === null ? CWD : `${m[1]}/${m[2]}`
    if (!repos.includes(repo)) repos.push(repo)
  }
  if (repos.length > MAX_REPOS) return { kind: 'invalid', reason: `リポジトリは ${MAX_REPOS} 件まで (${repos.length} 件指定)` }
  return { kind: 'set', repos }
}

function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300)
    ? 2
    : 1
}

/** 表示幅 (全角=2) が width を超えるなら切って … を付ける */
export function clip(text: string, width: number): string {
  let w = 0
  let out = ''
  const chars = [...text]
  const total = chars.reduce((n, ch) => n + charWidth(ch), 0)
  if (total <= width) return text
  for (const ch of chars) {
    const cw = charWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>#|]/g, c => `\\${c}`)

/** 詳細ビューの Markdown。メタ情報は書式を抜けられないようにし、リンクは github.com のみ */
export function detailMarkdown(kind: 'pr' | 'issue', it: Item, repo?: string): string {
  const meta = [
    repo === undefined ? null : `**${escapeMd(repo)}**`,
    kind === 'pr' && it.branch ? code(it.branch) : null,
    it.author ? `@${escapeMd(it.author)}` : null,
    it.isDraft ? 'Draft' : null,
    it.mergeable === 'CONFLICTING' ? '**⚠ Conflict あり (マージ不可)**' : null,
    `💬 ${it.comments}`,
    it.labels.length > 0 ? it.labels.map(code).join(' ') : null,
  ].filter((x): x is string => x !== null)
  return [
    `### ${kind === 'pr' ? 'PR' : 'Issue'} #${it.number} ${escapeMd(it.title)}`,
    meta.join(' · '),
    /^https:\/\/github\.com\//.test(it.url) ? `[GitHub で開く](${it.url})` : '',
    '---',
    it.body.trim() === '' ? '_(説明なし)_' : it.body,
    ...(it.lastComment === undefined
      ? []
      : [
          '---',
          `#### 最新のコメント (${it.comments} 件中)`,
          `@${escapeMd(it.lastComment.author)} · ${it.lastComment.createdAt.slice(0, 16).replace('T', ' ')}`,
          it.lastComment.body.trim() === '' ? '_(本文なし)_' : it.lastComment.body,
        ]),
  ]
    .filter(s => s !== '')
    .join('\n\n')
}

/** epoch ms → HH:MM (ローカル時刻) */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
