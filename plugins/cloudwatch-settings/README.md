# cloudwatch-settings

Claude Code と OpenAI Codex CLI の利用状況（トークン数、推定コスト、セッション数、ツール呼び出しなど）を、OpenTelemetry のメトリクスとして Amazon CloudWatch へ直接送るように設定する Claude Code スキル。コレクターは置かない。

follow if you like : https://x.com/hawkieslab

## インストール

```
/plugin marketplace add hawkymisc/claude-plugins
/plugin install cloudwatch-settings@hawkymisc-claude-plugins
```

## 使い方

設定したいマシンごとに1回実行する。全マシンで同じ AWS アカウント・同じリージョンにそろえる。

| コマンド | 動作 |
|---|---|
| `/cloudwatch-settings` | セットアップ。足りない情報（AWS アカウントの有無、リージョン、キーの期限など）は質問される |
| `/cloudwatch-settings status` | 現状の確認だけ。何も変更しない |
| `/cloudwatch-settings rotate` | API キーを新しいものに取り替える |
| `/cloudwatch-settings remove` | 設定を取り除く |

## できること

- **API キーの用意**：AWS CLI にログイン済みなら、メトリクス送信専用の IAM ユーザー（`CloudWatchAPIKeyAccess` だけを付与）と API キーを作る。未ログインなら、CloudWatch コンソールで作ったキーをクリップボードかファイルから取り込む。
- **設定の書き込み**：`~/.claude/settings.json` の `env` と、`~/.codex/config.toml` の `[otel.metrics_exporter.otlp-http]` に書く。既存の内容は残し、管理している部分だけを置き換える。
- **マシン別の集計**：リソース属性 `host.name` と `team.id` にマシンの呼び名を入れる。
- **確認**：テスト用のデータポイントを1つ送り、宛先とキーが正しいことを確かめる。
- **ダッシュボード**：AWS が公開している Claude Code 用・Codex 用の CloudWatch ダッシュボードをデプロイする（任意）。

送るのはメトリクスだけ。プロンプト本文などのイベントログとトレースは設定しない。

## API キーの扱い

- キーはこのリポジトリにもプラグインにも含まれない。各マシンの設定ファイルにだけ書かれる（POSIX では権限 0600）。
- キーの取得と書き込みは付属スクリプトが行い、値を標準出力に出さない。会話の記録に残るのは SHA-256 の先頭8桁だけ。
- 設定ファイルの実体が git 管理下にあり、ignore されていない場合は、書き込まずに止まる。
- `~/.config/cloudwatch-settings/state.json` には、リージョン・IAM ユーザー名・キーの ID と期限だけを記録する。

## 前提

- Python 3.8 以降（標準ライブラリのみ使用）。
- AWS アカウント。料金は CloudWatch の OTLP メトリクス取り込み量に応じてかかる（最新の単価は [CloudWatch の料金ページ](https://aws.amazon.com/cloudwatch/pricing/) を参照）。
- AWS CLI v2 は任意。キーの自動作成とダッシュボードのデプロイに使う。

## 制限

- 実際に CloudWatch へ届くところは、スクリプトのテストでは確かめていない（AWS CLI は偽のコマンドで代用している）。初回は `verify` と Query Studio で確認すること。
- Codex の設定キーは Codex CLI の版によって変わりうる。起動時に設定エラーが出たら `/cloudwatch-settings remove` で戻せる。
- Codex 用の `OTEL_RESOURCE_ATTRIBUTES` は、zsh / bash の rc ファイルか Windows のユーザー環境変数に書く。ほかのシェルでは、表示された1行を自分で追加する。
- Windows 本体と WSL はホームが別なので、両方で使うならそれぞれで実行する。

## ファイル

- `skills/cloudwatch-settings/SKILL.md`：手順
- `skills/cloudwatch-settings/scripts/cw_otel.py`：設定スクリプト（`status` / `apply` / `verify` / `dashboards` / `remove`）
- `tests/test_cw_otel.py`：スクリプトのテスト

## 開発

```bash
python3 -m unittest discover -s plugins/cloudwatch-settings/tests -v
```

```bash
claude plugin validate plugins/cloudwatch-settings
```

## 参考

- [Claude Code: Monitoring usage](https://code.claude.com/docs/en/monitoring-usage)
- [AWS Observability Best Practices: Coding Agents Observability](https://aws-observability.github.io/observability-best-practices/ai/coding-agents-observability/)
- [CloudWatch OTLP Metrics Bearer Token Auth](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLP-MetricsBearerTokenAuth.html)
