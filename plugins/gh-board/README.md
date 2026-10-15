# gh-board

セッション開始時と毎ターン終了時に、GitHub リポジトリの open な PR / Issue を `gh` CLI で取得し、右ペインに表示する Claude Code Mod。

follow if you like : https://x.com/hawkieslab

## インストール

```
/plugin marketplace add hawkymisc/claude-plugins
/plugin install gh-board@hawkymisc-claude-plugins
```

## できること

- **自動更新**: `session.start` と `turn.complete` で取得（取得中に再要求が来たら終了後に 1 回だけ取り直す）。ペイン右上の `↻` で手動更新。
- **PR 一覧**: `#番号 タイトル [draft] @author 💬コメント数`。Conflict でマージできない PR (`mergeable: CONFLICTING`) は赤字。
- **Issue 一覧**: `#番号 タイトル @author 💬コメント数`。ラベルごとにグループ化（複数ラベルは各グループに表示、ラベルなしは最後）。見出しクリックで折りたたみ / 展開。`Pull Requests` / `Issues` セクション自体も折りたためる。
- **詳細表示**: PR / Issue をクリックすると Description を Markdown でレンダリングし、その下に最新のコメント (会話コメントのみ。PR のレビューコメントは含まない) を表示。`← 一覧へ` で戻る。`GitHub で開く` リンク付き。
- **複数リポジトリ**: 複数指定するとリポジトリ名が最上位の折りたたみ見出しになり、その下に PR / Issues を並べる。取得はリポジトリごとに独立で、失敗したリポジトリだけ見出しの下に理由を出す。
- **エラー表示**: リモート無し・未ログイン等の `gh` の失敗理由をペインに表示（内容が変わったときだけ transcript にもログ）。

## コマンド

| コマンド | 動作 |
|---|---|
| `/gh-board` | ペインを開いて更新 |
| `/gh-board owner/repo` | 表示対象を切替（`https://github.com/owner/repo` も可） |
| `/gh-board a/b c/d . ` | 複数リポジトリを同時に表示（空白かカンマ区切り、最大 10 件。`.` はセッションの cwd のリポジトリ） |
| `/gh-board reset` | セッションの cwd のリポジトリに戻す |

## 前提

- `gh` CLI がログイン済み（`gh auth status`）。PATH に無い場合は `/opt/homebrew/bin/gh`, `/usr/local/bin/gh` を順に試す。
- 対象はデフォルトで `gh repo view` が解決するリポジトリ（= セッション cwd の git remote）。
- 各 50 件まで（`--limit 50`）。

## 開発

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

開発中のセッションに読み込むには `claude --plugin-dir <このフォルダ>`、またはデスクトップアプリなら `~/.claude/settings.json` の `env.CLAUDE_CODE_PLUGIN_DIRS` にこのフォルダを追加する。
