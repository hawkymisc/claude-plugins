import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Board, Item, RepoBoard, View } from '../types'
import { CWD, ISSUE_FIELDS, PR_FIELDS, clip, detailMarkdown, groupByLabel, hhmm, parseItems, parseRepoArgs } from './logic'

const PANE = 'gh-board'
const TITLE = 'GitHub'
/** PATH に gh が無い起動経路 (デスクトップアプリ等) 向けの候補 */
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
/** 表示する最大件数。LIMIT+1 件取って、超えていれば「50+」と出す */
const LIMIT = 50

const EMPTY: Board = { repos: [], fetchedAt: null, isLoading: false }
const emptyRepo = (target: string, repo: string | null, error: string | null = null): RepoBoard => ({
  target,
  repo,
  prs: [],
  issues: [],
  prsMore: false,
  issuesMore: false,
  error,
})
const board = atom({ plugin: 'gh-board', key: 'boards' } as const, EMPTY)
const view = atom({ plugin: 'gh-board', key: 'view' } as const, { kind: 'list' } as View)
const collapsed = atom({ plugin: 'gh-board', key: 'collapsed' } as const, {} as Record<string, boolean>)
const repoOverride = atom({ plugin: 'gh-board', key: 'repos' } as const, null as string[] | null)

type $ = EngineInterface

// モジュール変数はリロードで消えてよいもの (gh の場所のキャッシュ・取得中フラグ) だけ
let gh: string | null = null
let inflight: Promise<void> | null = null
let again = false
/** リポジトリごとに直近ログした失敗理由 (同じ失敗を毎ターン出さない) */
const lastLogged = new Map<string, string>()

const describe = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err)
  return err.cause === undefined || err.cause === null ? err.message : `${err.message} (cause: ${describe(err.cause)})`
}

/** gh を実行する。起動できなければ次の候補を試す (見つかった候補は覚える)。タイムアウトは候補を変えても無駄なのでそのまま失敗 */
async function runGh($: $, args: string[]) {
  const candidates = gh === null ? GH_CANDIDATES : [gh]
  let lastErr: unknown = null
  for (const bin of candidates) {
    try {
      const r = await $.process.run([bin, ...args], { timeoutMs: 20_000 })
      gh = bin
      return r
    } catch (err) {
      if (/time(d)? ?out/i.test(describe(err))) throw new Error(`${bin} ${args.slice(0, 2).join(' ')} がタイムアウト`, { cause: err })
      lastErr = err // 次の候補を試す。全滅したら cause として下で投げる
    }
  }
  throw new Error(`gh を起動できない (${candidates.join(', ')})`, { cause: lastErr })
}

async function ghOut($: $, args: string[]): Promise<string> {
  const r = await runGh($, args)
  if (r.exitCode !== 0) {
    const msg = (r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`).split('\n')[0] ?? ''
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${msg}`)
  }
  return r.stdout
}

/** 1 リポジトリ分を取る。失敗は投げずに error として返す (同じリポジトリの前回データは残す) */
async function fetchRepo($: $, target: string, prev: readonly RepoBoard[]): Promise<RepoBoard> {
  let repo: string | null = target === CWD ? null : target
  try {
    if (repo === null) repo = (await ghOut($, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim()
    const name = repo
    const list = (kind: 'pr' | 'issue', fields: string) =>
      ghOut($, [kind, 'list', '--repo', name, '--state', 'open', '--limit', String(LIMIT + 1), '--json', fields])
    const [prsJson, issuesJson] = await Promise.all([list('pr', PR_FIELDS), list('issue', ISSUE_FIELDS)])
    const prs = parseItems(prsJson)
    const issues = parseItems(issuesJson)
    lastLogged.delete(target)
    return {
      target,
      repo: name,
      prs: prs.slice(0, LIMIT),
      issues: issues.slice(0, LIMIT),
      prsMore: prs.length > LIMIT,
      issuesMore: issues.length > LIMIT,
      error: null,
    }
  } catch (err) {
    const reason = describe(err)
    if (lastLogged.get(target) !== reason) {
      lastLogged.set(target, reason)
      $.ui.log(`gh-board: ${repo ?? 'cwd のリポジトリ'} の取得失敗: ${reason}`)
    }
    // 同じ指定の前回データは残す (cwd の解決自体に失敗しても前回の一覧は見せる)
    const old = prev.find(p => p.target === target)
    return old === undefined ? emptyRepo(target, repo, reason) : { ...old, error: reason }
  }
}

async function fetchOnce($: $) {
  try {
    const prev = await read($, board)
    await update($, board, b => ({ ...b, isLoading: true }))
    const targets = (await read($, repoOverride)) ?? [CWD]
    const repos = await Promise.all(targets.map(t => fetchRepo($, t, Array.isArray(prev.repos) ? prev.repos : [])))
    const now = await $.clock.now()
    await update($, board, () => ({ repos, fetchedAt: now, isLoading: false }))
  } catch (err) {
    // 状態の読み書き自体の失敗。ペインは前回の表示のまま
    $.ui.log(`gh-board: 更新に失敗: ${describe(err)}`)
    await update($, board, b => ({ ...b, isLoading: false })).catch(e => $.ui.log(`gh-board: isLoading を戻せない: ${describe(e)}`))
  }
}

/** 取得中に呼ばれたら、終わった後にもう 1 回だけ取り直す */
function refresh($: $): Promise<void> {
  if (inflight !== null) {
    again = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        again = false
        await fetchOnce($)
      } while (again)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 待たずに更新する (session.start / turn.complete / ↻ から) */
function kick($: $, from: string) {
  refresh($).catch(err => $.ui.log(`gh-board: ${from} からの更新に失敗: ${describe(err)}`))
}

function openPane($: $) {
  $.ui.open({ id: PANE, title: TITLE }).catch(err => $.ui.log(`gh-board: ペインを開けない: ${describe(err)}`))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({
        name: 'gh-board',
        description: 'GitHub の PR / Issue ペインを開いて更新 (owner/repo を空白区切りで複数指定可、. は cwd、reset で cwd に戻す)',
        argumentHint: '[owner/repo ... | reset]',
      })
    } catch (err) {
      $.ui.log(`gh-board: /gh-board を登録できない: ${describe(err)}`)
    }
    // リロード時に取得中のまま残った isLoading を戻す (取得中フラグはモジュール変数なので消えている)
    await update($, board, b => ({ ...b, isLoading: false }))
    openPane($)
    kick($, 'session.start')
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) kick($, 'turn.complete') // サブエージェントのターンでは取らない
    return r
  })

  // 返す text の先頭にはエンジンが「gh-board:」を付けるので、自前では付けない
  on('command.run', { command: 'gh-board' }, async ($, e) => {
    const arg = parseRepoArgs(e.args)
    if (arg.kind === 'invalid') return { text: arg.reason }
    if (arg.kind === 'set') await update($, repoOverride, () => arg.repos)
    if (arg.kind === 'reset') await update($, repoOverride, () => null)
    if (arg.kind !== 'open') await update($, view, () => ({ kind: 'list' }) as View)
    openPane($)
    // 進行中の更新 (別のフックが始めたもの) は終わるのを待ち、このコマンドの $ で取り直す
    if (inflight !== null) await inflight.catch(err => $.ui.log(`gh-board: 進行中の更新が失敗: ${describe(err)}`))
    await refresh($)
    const b = await read($, board)
    const n = (len: number, more: boolean) => `${len}${more ? '+' : ''}`
    const lines = b.repos.map(r =>
      r.error !== null
        ? `${r.repo ?? 'cwd のリポジトリ'} — 取得失敗: ${r.error}`
        : `${r.repo} — PR ${n(r.prs.length, r.prsMore)} 件 / Issue ${n(r.issues.length, r.issuesMore)} 件`,
    )
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const b = await read($, board)
    const v = await read($, view)
    const folded = await read($, collapsed)
    const width = Math.max(20, (e.props.bodyColumns ?? 40) - 2)

    // リロード前の古い形の状態が残っていても落ちないように
    const repos = Array.isArray(b.repos) ? b.repos : []
    const multi = repos.length > 1
    const nameOf = (r: RepoBoard) => r.repo ?? CWD
    /** 複数リポジトリのときは key をリポジトリ名で名前空間分けする (同じ番号が衝突しないように) */
    const k = (r: RepoBoard, rest: string) => (multi ? `${nameOf(r)}:${rest}` : rest)

    const toggle = (key: string) => () => update($, collapsed, c => ({ ...c, [key]: !c[key] }))
    const open = (kind: 'pr' | 'issue', repo: string | null, number: number) => () =>
      update($, view, () => ({ kind, repo, number }) as View)
    const back = () => update($, view, () => ({ kind: 'list' }) as View)

    const status = b.isLoading ? '更新中…' : b.fetchedAt !== null ? `更新 ${hhmm(b.fetchedAt)}` : ''
    const title = multi ? `${repos.length} リポジトリ` : (repos[0]?.repo ?? '(リポジトリ未取得)')
    const single = !multi ? repos[0] : undefined
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{clip(title, width - 14)}</Text>
          <Button key="refresh" plain dimColor onPress={() => kick($, '↻')}>
            {`↻ ${status}`}
          </Button>
        </Box>
        {single !== undefined && single.error !== null && <Text color="red">{`⚠ ${single.error}`}</Text>}
      </Box>
    )

    if (v.kind !== 'list') {
      const r = repos.find(x => x.repo === v.repo) ?? (multi ? undefined : repos[0])
      const it = r === undefined ? undefined : (v.kind === 'pr' ? r.prs : r.issues).find(x => x.number === v.number)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back" onPress={back}>
              ← 一覧へ
            </Button>
          </Box>
          {it === undefined ? (
            <Text dimColor>{`#${v.number} は open な一覧に見つからない (close 済み?)`}</Text>
          ) : (
            <Markdown text={detailMarkdown(v.kind, it, multi && r?.repo ? r.repo : undefined)} />
          )}
        </Box>
      )
    }

    /** 階層の深さぶん Box の余白で字下げする (ボタン先頭の空白は描画側で詰められるため使わない) */
    const INDENT = 2
    const nest = (level: number, el: RenderChildren): RenderChildren =>
      level === 0 ? el : <Box paddingLeft={level * INDENT}>{el}</Box>

    const row = (r: RepoBoard, kind: 'pr' | 'issue', it: Item, level: number) => {
      const num = `#${it.number} `
      const talk = it.comments > 0 ? ` 💬${it.comments}` : ''
      const tail = `${it.isDraft ? ' draft' : ''} @${it.author}${talk}`
      const room = width - level * INDENT - num.length - tail.length - 1
      // Conflict でマージできない PR は番号とタイトルを赤に
      const conflict = kind === 'pr' && it.mergeable === 'CONFLICTING'
      return nest(
        level,
        <Button key={k(r, `${kind}-${it.number}`)} plain onPress={open(kind, r.repo, it.number)}>
          <Text color={conflict ? 'red' : 'cyan'}>{num}</Text>
          {conflict ? <Text color="red">{clip(it.title, Math.max(8, room))}</Text> : clip(it.title, Math.max(8, room))}
          <Text dimColor>{tail}</Text>
        </Button>,
      )
    }
    /** 折りたたみ見出し。key がそのまま折りたたみ状態の key */
    const section = (key: string, label: string, note: string, level: number) =>
      nest(
        level,
        <Button key={key} plain onPress={toggle(key)}>
          {`${folded[key] ? '▶' : '▼'} `}
          <Text bold>{label}</Text>
          <Text dimColor>{note}</Text>
        </Button>,
      )
    const none = (level: number) => nest(level, <Text dimColor>なし</Text>)
    const count = (n: number, more: boolean) => ` (${n}${more ? '+' : ''})`

    /** 1 リポジトリ分。base は字下げの起点 (複数リポジトリならリポジトリ見出しの 1 段下) */
    const repoBody = (r: RepoBoard, base: number): RenderChildren[] => {
      const prsKey = k(r, 'toggle:prs')
      const issuesKey = k(r, 'toggle:issues')
      return [
        section(prsKey, 'Pull Requests', count(r.prs.length, r.prsMore), base),
        ...(folded[prsKey] ? [] : r.prs.length === 0 ? [none(base + 1)] : r.prs.map(it => row(r, 'pr', it, base + 1))),
        section(issuesKey, 'Issues', count(r.issues.length, r.issuesMore), base),
        ...(folded[issuesKey]
          ? []
          : r.issues.length === 0
            ? [none(base + 1)]
            : groupByLabel(r.issues).flatMap(g => {
                const labelKey = k(r, `toggle:label:${g.label}`)
                return [
                  section(labelKey, g.label, count(g.items.length, false), base + 1),
                  ...(folded[labelKey] ? [] : g.items.map(it => row(r, 'issue', it, base + 2))),
                ]
              })),
      ]
    }

    return (
      <Box flexDirection="column">
        {header}
        {multi
          ? repos.flatMap(r => {
              const key = `toggle:repo:${nameOf(r)}`
              const note = r.error !== null ? ' 取得失敗' : ` (PR ${r.prs.length}${r.prsMore ? '+' : ''} / Issue ${r.issues.length}${r.issuesMore ? '+' : ''})`
              return [
                section(key, nameOf(r), note, 0),
                ...(folded[key]
                  ? []
                  : [...(r.error !== null ? [nest(1, <Text color="red">{`⚠ ${r.error}`}</Text>)] : []), ...repoBody(r, 1)]),
              ]
            })
          : single !== undefined && repoBody(single, 0)}
      </Box>
    )
  })
}
