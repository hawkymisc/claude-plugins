# progress-map

リポジトリの進捗を、claude.ai の Artifact 1枚（作業マップ）にまとめて作成・更新する Claude Code スキル。

follow if you like : https://x.com/hawkieslab

## インストール

```
/plugin marketplace add hawkymisc/claude-plugins
/plugin install progress-map@hawkymisc-claude-plugins
```

## 使い方

| コマンド | 出典 |
|---|---|
| `/progress-map plan` | `PLAN.md` のフェーズとタスク表（`✅` / `⚠️` / `🔲`）。コミット・PR・Issue と突き合わせる |
| `/progress-map issue` | open の Issue と、直近に close された Issue・merge された PR |
| `/progress-map` | 既存のマップと同じ出典。新規のときは聞く |

## できること

- **ページの構成**：ユーザーの判断待ち（ゲート）→ Mermaid の依存図 → レーン別の表（着手可・進行中・待ち・判断待ち）→ 最近片付いたもの → 未確認のもの。
- **実態の確認**：Issue 本文・PLAN.md・前回のマップを鵜呑みにせず、`git log`・`gh`・コード・`git worktree list` で確かめてから書く。
- **依存の判定**：Issue に書かれた依存だけでなく、同じ対象・同じファイル（生成物を含む）を触る作業の衝突からも順序を付ける。
- **プロジェクトとの関連づけ**：作ったマップを `~/.claude/progress-maps.json`（キーは `owner/repo`）と、ページ内の `<meta name="progress-map:project">` に記録する。関連づいたマップがあれば、新しく作らずに同じ URL を更新する。

## 前提

- claude.ai の Artifact を publish できる環境（Claude Code の `Artifact` ツール）。
- `gh` CLI がログイン済み（`issue` モード）。

## ファイル

- `skills/progress-map/SKILL.md`：手順
- `skills/progress-map/template.html`：初回用のひな形
