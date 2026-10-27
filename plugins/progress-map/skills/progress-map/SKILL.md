---
name: progress-map
description: Create or update a progress-map Artifact (作業マップ / 進捗マップ) for the current repository — gates waiting on the user, a dependency diagram, and per-lane tables of what is in progress, ready, blocked or done. Takes one argument, `plan` (build the overall picture from PLAN.md) or `issue` (build it from the open and recently closed GitHub Issues). Use when the user asks to make, refresh, or "update the artifact to current progress" for a progress / work map, 進捗をアーティファクトで, 作業マップを更新, 全体像を見える化.
argument-hint: "plan | issue"
metadata:
  author: "Hawkies' Lab"
  version: "1.1.0"
---

# progress-map：進捗マップのアーティファクトを作る・更新する

リポジトリの進捗を1枚のArtifactにまとめる。上から順に、ユーザー判断待ちのゲート、全体の依存図（Mermaid）、レーン別の表、最近片付いたもの、実機などで未確認のもの、を並べる。要約から詳細へ下っていく構成にする。

## 引数

| 引数 | 作業の一覧の出典 | 向いている場面 |
|---|---|---|
| `plan` | `PLAN.md`（なければ `docs/PLAN.md`、`*PLAN*.md` を探す。複数あればユーザーに聞く）のフェーズとタスク表（`✅` / `⚠️` / `🔲`） | フェーズ単位の全体像を見たい |
| `issue` | GitHub の open Issue と、直近（前回の版の日付以降、なければ7日）に close された Issue・merge された PR | いま取り組む課題を見たい |

引数がなければ、既存のマップの出典（ページ内の meta 行）に合わせる。新しく作る場合は一行で聞く（`1: plan` / `2: issue`）。

## 手順

### 1. プロジェクトに関連づけられたマップを探す（あれば必ずそれを更新する）

**原則：プロジェクトに関連づけられたマップがあれば、新しく作らずにそれを更新する。** 新しいアーティファクトを作るのは、関連づけがなく、ユーザーも既存のURLを持っていないと確かめた場合だけ。

**プロジェクトの識別子**：`git remote get-url origin` を `owner/repo` の形に直したもの（例：`octocat/hello-world`）。remote がなければ `git rev-parse --show-toplevel` の絶対パス。ワークツリーでも同じ識別子になるよう、ワークツリーのパスは使わない。

**関連づけの記録（2か所）**：
1. **台帳**：`~/.claude/progress-maps.json`。キーがプロジェクトの識別子、値が `{"url": "...", "title": "...", "source": "plan|issue", "updated": "YYYY-MM-DD"}`。リポジトリにはコミットしないので、ブランチやワークツリーに左右されない。
2. **ページ自身**：`<head>` 相当の位置に `<meta name="progress-map:project" content="<識別子>">` を置き、publish の `description` にも識別子を入れる。台帳が失われても、ページから関連を復元できる。

**探す順番**：
1. 台帳にこのプロジェクトの `url` があれば、`Artifact` の `action: "read"` で読む。読めて、ページの `progress-map:project` が識別子と一致すれば、それを更新対象にする。読めない（削除済み・権限なし）か、一致しなければ、2へ進み、そのことを報告に書く。
2. 台帳にない場合は、`action: "list"` を `limit: 200`、`scope: "all"` で取り、次のどれかに当たるものを候補にする：ページの `progress-map:project` が一致（候補を `read` して確かめる）／`description` に識別子を含む／タイトルに「作業マップ」「進捗マップ」「進捗」「マップ」「ロードマップ」「への道」とプロジェクト名を含む。一覧が200件を超えると出る場合は、`after` などで続きも見る。
3. 候補が1つなら、それを更新対象にして台帳に記録する。複数あれば、どれを更新するかユーザーに聞く（`1:` `2:` のラベルで、タイトル・URL・最終更新日を添える）。
4. 候補がなければ、新しく作る前に一行で聞く：「このプロジェクトの既存の進捗マップのURLはありますか？（なければ新規に作ります）」。URLが返ってきたら、それを `read` して更新対象にし、台帳に記録する。

**更新の仕方**：更新対象が決まったら、`action: "read"` で読み、その版を土台にする。publish には必ずその `url` を渡す（渡さないと別のURLになる）。新しく作った場合も、更新した場合も、publish の後に台帳の `url`・`updated`・`source` を書き換える。

- 読んだHTMLの末尾にある `<!--claude-mermaid-runtime-begin…end-->` ブロックと、先頭の `<!doctype…><body>` の外枠は配信側が付けたもの。土台にするときは取り除き、`<pre class="mermaid">` の原文だけを残す（publish すると配信側がまた付ける）。

### 2. 実際の状態を確かめる（古い記述を信じない）

マップ・Issue本文・PLAN.md は古いことがある。次の権威ある情報源で確かめてから書く。

- `git fetch -q origin` → `git log origin/main --since=<前回の日付> --format='%h %ad %s' --date=short`、main の先頭のハッシュ。
- `gh pr list --state open`、`gh pr view <n> --json body`（merge済みPRの本文に「未対応」「申し送り」があれば拾う）。
- `issue` モード：`gh issue list --state open --limit 100`、`gh issue view <n> --json state,closedAt,body,comments`。**判断済みかどうかは最後のコメントまで読む**（本文が「未決」でもコメントで決着していることがある）。
- `plan` モード：PLAN.md の各タスクの状態を、対応するコミット・PR・Issueと突き合わせる。食い違いは、マップでは実態の方を示し、PLAN.md の更新が必要なことを報告する（勝手に直さない）。
- 「未決」「未実装」と書かれた項目は、コード（`grep`）とテスト・検証ツールで実装の有無を確かめる。
- 作業中のものは `git worktree list` で探す。各ワークツリーの `git status -s` と `git log origin/main..HEAD` から、未コミットの変更や先行コミットのあるブランチを「進行中」に載せる。ブランチ名だけで中身が空なら「着手したばかり／空」と書く。「作業中のセッションはなし」と書く前に必ず確かめる。
- 長期ブランチ（例：機能の試作ブランチ）は `git rev-list --left-right --count origin/main...origin/<branch>` で先行・遅れを出す。

### 3. 依存関係を決める

Issue に書かれた依存だけで済ませない。次の重なりでも順序を付ける。

- **対象の重なり**：同じキャラ・技・画面・モジュールを扱う Issue。
- **ファイルの重なり**：同じソース・データ・生成物（自動生成ファイル、指紋・マニフェスト、基準記録）を書き換える Issue。並行すると衝突し、後からやり直しが要るものは、どちらを先にするかを決めて矢印にする。
- **ゲート**：ユーザーの判断・プレイ・決定を待つものは、黒い六角形のゲートノードにして矢印を出す。すでに判断が出ているもの（コメントで決着済み）をゲートにしない。

推定で決めた状態（例：「凍結はマージの事実から解除とみなした」）は、ページ内でも推定と分かる書き方にし、終わりの報告でユーザーに確認する。

### 4. ページを書く

書く前に `artifact-design` スキルを読み込む（ページ全体の約束事）。構成と見た目は既存の版に合わせ、初回は `template.html`（このスキルのディレクトリ）を写して使う。

- **meta 行**：「YYYY-MM-DD 時点」、出典（`plan`：`PLAN.md` のパス／`issue`：open の数）、main のハッシュ、長期ブランチの先行・遅れ、open PR の数。
- **ゲート**：ユーザーの判断・プレイ待ちだけ。各カードに「止めているもの」を Issue 番号で書く。解除されたゲートは次の1回だけ打消し線で残し、その次の更新で消す。
- **全体図**：Mermaid `flowchart LR`。`classDef` で `ready`（着手可）・`block`（待ち）・`wait`（判断待ち）・`run`（進行中）・`gate` を色分けし、凡例を下に置く。
- **レーン別の表**：列は「Issue／内容／待っているもの／状態」。状態は `pill`（着手可・進行中・待ち・判断待ち・保留）。Issue のない残件（PRの申し送りなど）は番号を「—」にして載せる。
- **最近片付いたもの**：今回の更新で完了したものを先頭に、日付と PR 番号を付ける。
- **未確認**：テストは通ったが実機・本番などで確かめていないものを最後に1行で。
- 色はすべて `:root` のトークン、ダーク用を `prefers-color-scheme` と `[data-theme]` の両方で定義する。表は横スクロールの枠に入れ、スマホ幅で崩さない。

- **関連づけ**：`<meta name="progress-map:project" content="<識別子>">` を必ず入れる（`template.html` にある）。既存の版にない場合は足す。

ファイルはスクラッチパッドに置き（例：`<scratchpad>/progress-map/work-map.html`）、`Artifact` で手順1で決めた `url` へ publish する。新規のときだけ `url` を渡さず、`icon`（`map`）と、識別子を含む `description`（例：「octocat/hello-world の作業マップ（issue）」）を付ける。publish したら台帳 `~/.claude/progress-maps.json` を更新する（ファイルがなければ作る。他のプロジェクトのキーは残す）。

### 5. 確かめて報告する

- publish 後に `action: "read"` で読み返し、Mermaid のランタイムが付いていることと、前回からの差分が入っていることを確かめる。
- 報告は短く：何が完了に移ったか、何が着手可になったか、新しく見つけた食い違い（古い Issue 本文、PLAN.md のずれ、マップに漏れていた作業中のワークツリーなど）、推定で決めた点。
- Issue のクローズ・コメント・PLAN.md の更新は、マップの更新とは別の外向きの操作なので、提案だけしてユーザーの指示を待つ。

## やらないこと

- 関連づけられたマップがあるのに、新しいURLで作り直す。既存の版を読まずに上書きする。
- 関連づけ（台帳とページの `meta`）を残さずに publish を終える。
- Issue 本文や前回のマップの「未決」「作業中なし」を、確かめずに引き写す。
- ゲートを、すでに判断の出ているものや推定だけの理由で作る。
- 動画・バイナリなどの大きな生成物をページに埋め込む（パスで示す）。
