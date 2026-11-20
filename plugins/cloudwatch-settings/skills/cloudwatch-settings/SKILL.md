---
name: cloudwatch-settings
description: Set up this machine so that Claude Code and OpenAI Codex CLI both export their OpenTelemetry usage metrics (tokens, cost, sessions, tool calls) straight to Amazon CloudWatch with a CloudWatch metrics API key (bearer token) — no collector. Obtains or creates the key, writes it into ~/.claude/settings.json and ~/.codex/config.toml without ever showing it, verifies delivery, and can deploy the AWS dashboards. Arguments - none (set up), `status`, `rotate`, `remove`. Use when the user asks to send Claude Code / Codex telemetry or usage data to CloudWatch, CloudWatch に OTel を送る設定, 利用状況を CloudWatch で見たい, API キーの更新・ローテーション, or to undo that setup.
argument-hint: "[status | rotate | remove]"
metadata:
  author: "Hawkies' Lab"
  version: "0.1.0"
---

# cloudwatch-settings：Claude Code と Codex の利用状況を CloudWatch へ送る

このマシンの Claude Code と Codex CLI を、OpenTelemetry のメトリクスを Amazon CloudWatch の OTLP エンドポイントへ直接送るように設定する。コレクターは置かない。認証は CloudWatch メトリクス API キー（ベアラートークン）で行う。

マシンごとに1回実行する。複数台あるときは、全台で同じ AWS アカウント・同じリージョンにそろえる。

引数：`$ARGUMENTS`

| 引数 | すること |
|---|---|
| なし | セットアップ（下の手順1〜6） |
| `status` | 手順1だけ行い、結果を報告する。何も変更しない |
| `rotate` | API キーを新しいものに取り替える（「キーの取り替え」） |
| `remove` | 設定を取り除く（「取り除く」） |

## 何が変わるか

| 場所 | 変更 |
|---|---|
| `~/.claude/settings.json` の `env` | `CLAUDE_CODE_ENABLE_TELEMETRY`、`OTEL_METRICS_EXPORTER`、`OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` / `_ENDPOINT` / `_HEADERS`、`OTEL_RESOURCE_ATTRIBUTES` |
| `~/.codex/config.toml` | 末尾に `[otel.metrics_exporter.otlp-http]` の管理ブロック |
| シェル（任意） | Codex 用の `OTEL_RESOURCE_ATTRIBUTES`。zsh / bash は rc ファイルの管理ブロック、Windows はユーザー環境変数 |
| AWS（AWS CLI で作る場合） | IAM ユーザー `coding-agents-otel-<マシン名>`（`CloudWatchAPIKeyAccess` だけを付与）と API キー1つ。任意でダッシュボード2枚 |
| `~/.config/cloudwatch-settings/state.json` | リージョン、IAM ユーザー名、キーの ID と期限。秘密の値は入れない |

送るのはメトリクスだけ。イベントログ（プロンプト本文など）とトレースは設定しない。

## API キーの扱い（必ず守る）

API キーは長期間有効な認証情報。会話の記録にも、リポジトリにも残さない。

- キーの値を、チャット・ツールの引数・コマンドの出力に出さない。**取得も書き込みも、付属スクリプト `cw_otel.py` に任せる。** スクリプトは値を表示せず、SHA-256 の先頭8桁（fingerprint）だけを返す。
- `aws iam create-service-specific-credential` を自分で直接実行しない（応答にキーが含まれ、会話に残る）。
- キーの入った `settings.json` や `config.toml` を、Read・`cat`・`grep` で表示しない。Edit / Write で書き換えない。状態は `status` で確かめる。
- 利用者にキーをチャットへ貼らせない。貼られてしまったら、そのキーは漏れたものとして使わず、削除して作り直すよう勧める。
- リポジトリ・プラグイン・dotfiles のどこにもキーを書かない。設定ファイルの実体が git 管理下にあると、スクリプトは `git_tracked` で止まる。

## 分からないことは AskUserQuestion で聞く

**推測で進めない。** `status` で分かることは聞かない。それ以外で、利用者にしか分からないこと・利用者が決めることは、`AskUserQuestion` ツールで聞く（1回に4問まで、各問2〜4択。`AskUserQuestion` が使えない環境では、同じ内容を本文で聞く）。次のどれかに当たったら、必ず聞いてから進む。

- AWS アカウントを持っているか、どのアカウントを使うかが分からない。
- このマシンで AWS CLI にログインできていない（`aws_identity.ready` が `false`）。
- リージョンが決まっていない。
- AWS 側に何かを作る・消す・取り替える前（IAM ユーザー、API キー、ダッシュボード）。
- 既存の設定とぶつかった（`conflict_claude`、`conflict_codex`、`existing_key`、`git_tracked`）。
- シェルの rc ファイルやユーザー環境変数を書き換える前。

各手順に、質問と選択肢の例を書いてある。選択肢の先頭は推奨にし、ラベルの末尾に「（推奨）」と付ける。

## スクリプト

`${CLAUDE_SKILL_DIR}/scripts/cw_otel.py`（Python 3.8 以降、標準ライブラリのみ）。結果は JSON で返る。失敗時は `ok: false` と `error.code`。

Python は `python3`、`python`、`py -3` の順に探す。どれもなければ、インストールしてよいかを聞く（Windows なら `winget install Python.Python.3.13`、macOS なら `xcode-select --install`）。断られたら、ここで止めて報告する。スクリプトなしでキーを扱う手作業に切り替えない。

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" status
```

## 手順

### 1. 現状を調べる

`status` を実行し、次を読む。

| 項目 | 見ること |
|---|---|
| `tools` | `claude`、`codex`、`aws` があるか。`codex` がなければ Codex 側は設定しない（その旨を報告する） |
| `aws_identity` | `ready` と、ログイン中の `account`・`arn` |
| `claude.configured` / `codex.configured` | すでに設定済みか。両方 `true` で `verify` も通るなら、やることは残っていないと報告して終える |
| `claude.conflicts` / `codex.conflicts` | 別の送信先向けの OTel 設定があるか |
| `git_tracked` | 設定ファイルの実体が git 管理下にあるか |
| `key_expiry` | `expired` か `expiring_soon` なら、キーの取り替えを勧める |
| `created_key_in_use_by` | このマシンで作った IAM のキーを、いまどの対象が使っているか。空のリストなら、そのキーは使われないまま IAM に残っている。消すかどうかを聞く |
| `state.region` | 以前このマシンで使ったリージョン |
| `platform.wsl` | WSL 内かどうか。Windows 本体と WSL は別のホームなので、両方で使うなら両方で実行が要る |

引数が `status` なら、ここで要点を報告して終える。

### 2. 利用者に聞く

`status` の結果に合わせて、足りないものだけを聞く。

**(a) API キーをどう用意するか**

`aws_identity.ready` が `true` のとき（質問文にアカウント ID を入れる）：

- 質問例：「AWS アカウント 123456789012 に、メトリクス送信専用の IAM ユーザーと API キーを作ってよいですか？」
- `このアカウントに作る（推奨）`：スクリプトが作成から書き込みまで行う。
- `コンソールで作ったキーを使う`：自分で作ったキー、または他のマシンと共用のキーを取り込む。
- `別のアカウントを使う`：プロファイル名を聞き、以降のコマンドに `--aws-profile` を付けて `status` からやり直す。

`aws_identity.ready` が `false` のとき：

- 質問例：「AWS アカウントはお持ちですか？このマシンでは AWS CLI にログインできていません。」
- `ある。コンソールでキーを作る（推奨）`：下の「コンソールで作ったキーを取り込む」へ。
- `ある。このマシンで AWS CLI を設定する`：利用者自身のターミナルで `aws login` や `aws configure sso` を実行してもらい（対話式なので代行しない）、終わったら `status` からやり直す。AWS CLI v2 がなければ、入れ方を案内する。
- `持っていない`：AWS アカウントの作成は、支払い情報と本人確認が要る利用者自身の手続き。https://aws.amazon.com/ から作成できることと、作成後にこのスキルをもう一度実行すればよいことを伝えて、ここで終える。代わりに作ろうとしない。
- `分からない`：職場のアカウントしかないのか、個人のものがあるのかを一緒に整理する。職場のアカウントに個人利用のデータを送ることは勧めない。

**(b) リージョン**（`state.region` があればそれを使い、聞かない）

- 質問例：「メトリクスをどのリージョンに送りますか？全マシンで同じにします。」
- `ap-northeast-1（東京）`、`us-east-1（バージニア北部）`、ほかは自由入力。
- 他のマシンですでに設定済みなら、そのリージョンに合わせるよう添える。料金はリージョンで異なるので、気にする利用者には料金ページを見るよう伝える。

**(c) キーの有効期限**（AWS CLI で作るときだけ）

- `90日（推奨）`：`--age-days 90`。期限が来たら `/cloudwatch-settings rotate`。
- `365日`：`--age-days 365`。
- `無期限`：`--no-expiry`。手間はないが、漏れたときに自分で消すまで使われ続ける。

**(d) マシンの呼び名と Codex 用の環境変数**

- 呼び名の既定は `status` の `default_label`（ホスト名）。「このマシンを `<default_label>` という名前で記録します」と示し、変えたければ自由入力してもらう。英数字と `-` `_` `.` だけにする。
- Codex はリソース属性を環境変数 `OTEL_RESOURCE_ATTRIBUTES` からしか読まない。`追加する（推奨）`：rc ファイルかユーザー環境変数に書く（マシン別に集計できる。同じシェルから起動する他の OTel 対応アプリにも同じ属性が付く）。`追加しない`：`--shell-env skip`（Codex のデータはマシン別に分けられない）。

**(e) ダッシュボード**（`aws_identity.ready` が `true` のときだけ）

- `デプロイする`、`他のマシンで済んでいる・不要`。アカウントとリージョンごとに1回でよい。カスタムダッシュボードは枚数によって料金がかかりうるので、気にする利用者には料金ページを見るよう伝える。

### 3. 書き込む

まず `--dry-run` で計画を確かめる（何も変更しない）。そのあと同じ引数で実行する。

AWS CLI で作る場合：

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" apply --region ap-northeast-1 --token-source aws-cli --age-days 90 --label macbook
```

コンソールで作ったキーを取り込む場合：

1. 利用者に、CloudWatch コンソールの **Settings** → **API keys** → **Create** でメトリクス用の API キーを作り、値をコピーしてもらう。チャットには貼らないよう伝える。
2. `AskUserQuestion` で確かめる：`コピーした`、`ファイルに保存した`（パスを聞く）、`やめる`。
3. コピーなら `--token-source clipboard`（`status` の `clipboard_available` が `false` ならファイルにしてもらう）。ファイルなら `--token-source file --token-file <パス>`。取り込み後、そのファイルはスクリプトが消す（残すなら `--keep-token-file`）。

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" apply --region ap-northeast-1 --token-source clipboard --label gaming-pc
```

`ok: true` でも `warnings` が空でなければ、その内容を報告に入れる（例：Codex 用の環境変数を書けなかった。このときは `codex_shell_env.manual_line` の1行を、利用者に自分のシェル設定へ追加してもらう）。

主な引数：

| 引数 | 意味 |
|---|---|
| `--targets claude,codex` | 設定する対象。既定の `auto` は、見つかったものすべて |
| `--label` | マシンの呼び名。`host.name` と `team.id` に入る |
| `--attr key=value` | 追加のリソース属性（複数可） |
| `--shell-env skip` | Codex 用の環境変数を書かない |
| `--aws-profile` | AWS CLI のプロファイル |
| `--token-source existing` | すでに片方に入っているキーを、もう片方にも入れる。リージョンや呼び名だけ変えるときにも使う |

リソース属性は `host.name`、`team.id`（どちらも呼び名）、`user.id`（OS のユーザー名）、`environment=personal`。AWS のダッシュボードは `team.id` で集計するので、呼び名を入れておくとマシン別の内訳になる。

### 4. 確かめる

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" verify
```

設定済みのキーで、テスト用のデータポイント `cloudwatch_settings.setup.check` を1つ送る。`ok: true`（HTTP 200）なら、宛先とキーは正しい。401 / 403 なら、キーが無効か、リージョンが違う。

`verify` が確かめるのは宛先とキーまで。Claude Code と Codex が実際に送り始めるのは、**次に起動したセッションから**（いま動いているセッションは対象外）。実データは、新しいセッションを少し使った数分後に、CloudWatch の Query Studio で次のクエリを実行して確かめるよう利用者に伝える。届くところまでは確かめていない、と報告に書く。

```
sum({"claude_code.token.usage"})
```

```
sum({"codex.turn.token_usage", "@resource.service.name"=~"codex.*"})
```

### 5. ダッシュボード（希望があれば）

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" dashboards --region ap-northeast-1
```

AWS が公開している定義（aws-observability-accelerator）を取得し、リージョンを書き換えて `ClaudeCodeDashboard` と `CodexDashboard` を作る。同じ名前のものがあれば上書きする。返ってきた URL を利用者に渡す。

### 6. 報告する

- 何を設定したか（対象、リージョン、呼び名、キーの fingerprint と期限）。キーの値は書かない。
- `verify` の結果と、実データの確認は利用者に残っていること。
- 新しいセッションから有効になること。Codex 用の環境変数は、新しく開いたシェルから有効になること。
- ほかのマシンでも同じスキルを実行すること（同じリージョンで。ダッシュボードは不要）。
- キーの期限と、取り替え方（`/cloudwatch-settings rotate`）。

## エラーへの対処

| `error.code` | 対処 |
|---|---|
| `conflict_claude` | `settings.json` に別の送信先向けの OTel 設定がある。`error.conflicts` を示し、上書きしてよいか聞く。よければ `--overwrite` を付ける。断られたら Claude Code 側は設定しない |
| `conflict_codex` | `config.toml` に管理外の `metrics_exporter` がある。Codex のメトリクス送信先は1つだけなので、置き換えてよいか聞く。よければ、その定義だけを取り除いてからやり直す（このファイルにキーはまだ入っていないので、ここは Edit でよい） |
| `git_tracked` | 設定ファイルの実体がリポジトリ内にある。`.gitignore` に入れる・実体をリポジトリの外へ移す・その対象を外す、のどれにするか聞く。承知のうえで続けると言われたときだけ `--allow-git-tracked` |
| `existing_key` | その IAM ユーザーにはすでにキーがある。シークレットは作成時にしか取れない。取り替える（`--rotate`）か、手元のキーを取り込むかを聞く |
| `aws_not_ready` | 手順2 (a) の「`ready` が `false` のとき」へ |
| `aws_failed` | `message` に AWS CLI のエラーが入っている。権限不足（`iam:CreateUser`、`iam:AttachUserPolicy`、`iam:CreateServiceSpecificCredential`、`cloudwatch:PutDashboard`）、または AWS CLI が古い。原因を示し、コンソールでキーを作る方法に切り替えるか聞く |
| `no_token` / `bad_token` / `no_clipboard` | コピーし直すか、ファイルで渡してもらう |
| `invalid_settings_json` / `invalid_codex_toml` | 既存の設定ファイルが壊れている。該当箇所を示し、直してよいか聞く |
| `write_failed` | 書き込みに失敗した。途中まで書いたファイルは元の内容に戻してある（`restored`）。`written` にあって `restored` にないファイルがあれば、それを報告する。`new_key_deleted` が `true` なら、作りかけのキーは消えている。`false` なら、IAM に使われないキーが残っていることを報告する |

Codex が起動時に設定エラーを出すようになったら、`codex --version` を確かめる。この設定は Codex の設定スキーマ（`[otel.metrics_exporter.otlp-http]` の `endpoint`・`protocol`・`headers`）に合わせてあるが、キー名は版によって変わりうる。合わないと分かったら、`remove --targets codex` で戻してから報告する。

## キーの取り替え（`rotate`）

1. `status` で `state.iam_user` と `key_expiry` を確かめる。
2. AWS CLI で作ったキーなら、取り替えてよいかを聞いてから、前回と同じリージョン・呼び名で実行する：

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" apply --region ap-northeast-1 --token-source aws-cli --age-days 90 --rotate
   ```

   新しいキーを書き込んだあとに、古いキーを消す。
3. コンソールで作ったキーなら、コンソールで新しいキーを作ってもらい、手順3の取り込みを行う。古いキーをコンソールで消すよう伝える。
4. `verify` で確かめる。共用のキーを取り替えたときは、ほかのマシンでも取り込みが要ると伝える。

## 取り除く（`remove`）

何を消すかを `AskUserQuestion` で聞く（複数選択）：このマシンの設定、IAM の API キーとユーザー、ダッシュボード。

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/cw_otel.py" remove
```

`--delete-key` で IAM の API キーとユーザーも消す（このマシンで作ったものだけ。共用のキーなら、ほかのマシンも送れなくなる）。`--delete-dashboards` でダッシュボードも消す（ほかのマシンからも見えなくなる）。CloudWatch に送ったメトリクスは残る。

## やらないこと

- キーの値を表示する・会話に書く・リポジトリに置く。
- 利用者に聞かずに、AWS のリソースを作る・消す・取り替える。
- AWS アカウントの有無やリージョンを推測で決める。
- AWS アカウントの作成や `aws login` などの対話的なログインを代行する。
- イベントログ（プロンプト本文など）やトレースの送信を、頼まれていないのに有効にする。
- `verify` が通っただけで「実データが届いている」と報告する。
