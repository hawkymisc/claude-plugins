export type Comment = { author: string; body: string; createdAt: string }

export type Item = {
  number: number
  title: string
  url: string
  author: string
  body: string
  labels: string[]
  updatedAt: string
  /** PR のみ */
  isDraft?: boolean
  /** PR のみ: head ブランチ名 */
  branch?: string
  /** PR のみ: GitHub の mergeable。CONFLICTING ならマージできない。UNKNOWN は GitHub が計算中 */
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** 会話コメントの件数 (PR のレビューコメントは含まない) */
  comments: number
  /** 最新 (最後) の会話コメント */
  lastComment?: Comment
}

/** 1 リポジトリ分の一覧。取得はリポジトリごとに独立 */
export type RepoBoard = {
  /** 指定値 (owner/repo か '.' = cwd)。前回データとの照合に使う */
  target: string
  /** owner/repo。cwd のリポジトリを解決できなかったときは null */
  repo: string | null
  prs: Item[]
  issues: Item[]
  /** 上限 (50 件) を超えて存在する */
  prsMore: boolean
  issuesMore: boolean
  /** 直近の取得失敗の理由。成功で null に戻る */
  error: string | null
}

export type Board = {
  /** 表示順どおりのリポジトリ */
  repos: RepoBoard[]
  /** 最後に取得を終えた時刻 (epoch ms) */
  fetchedAt: number | null
  isLoading: boolean
}

export type View = { kind: 'list' } | { kind: 'pr' | 'issue'; repo: string | null; number: number }

declare module 'claude-code' {
  interface PluginState {
    'gh-board': {
      boards: Board
      view: View
      /** 折りたたみ中のセクション (key: 見出しボタンの key) */
      collapsed: Record<string, boolean>
      /** /gh-board で指定した表示対象 (owner/repo、'.' は cwd)。null ならセッションの cwd のリポジトリだけ */
      repos: string[] | null
    }
  }
}
