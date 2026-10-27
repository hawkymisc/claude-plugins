# downloads-guard

作業ディレクトリが `~/Downloads` 直下のとき、Claude Code でプロンプト送信とすべてのツール実行を拒否し、作業を始めさせない Mod。ダウンロードした未検証ファイルの置き場で誤ってエージェントを動かす事故を防ぎます。

follow if you like : https://x.com/hawkieslab

## 動作

- `session.start`: 作業ディレクトリが `~/Downloads`（`/Users/<name>/Downloads` または `/home/<name>/Downloads`）そのものなら、トースト＋ステータスラインで警告
- `prompt.submit`: 送信ごとに現在の cwd を読み直し、Downloads ならプロンプトを破棄（`/cd` で入った場合も対象）
- `tool.call`: Downloads ではすべてのツール呼び出しを deny
- サブディレクトリ（`~/Downloads/foo`）は対象外

プロセスの強制終了はしません（Mod API に終了手段がないため）。拒否により、実質的に何も実行できない状態になります。

## インストール

```
/plugin marketplace add hawkymisc/claude-plugins
/plugin install downloads-guard@hawkymisc-claude-plugins
```
