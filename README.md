# claude-plugins

Hawkies' Lab の Claude Code プラグイン（Mods）マーケットプレイス。

follow if you like : https://x.com/hawkieslab

## インストール

```
/plugin marketplace add hawkymisc/claude-plugins
/plugin install clawd-mods@hawkymisc-claude-plugins
/plugin install gh-board@hawkymisc-claude-plugins
/plugin install progress-map@hawkymisc-claude-plugins
/plugin install downloads-guard@hawkymisc-claude-plugins
/plugin install cloudwatch-settings@hawkymisc-claude-plugins
```

## プラグイン

| 名前 | 説明 |
|---|---|
| [clawd-mods](plugins/clawd-mods) | ツール使用に応じた Clawd アニメをプロンプト上部に表示し、BLE で Cardputer ADV にミラーする（プラグイン本体は `mod/`、`bridge/` と `firmware/` は任意の周辺機器向け） |
| [gh-board](plugins/gh-board) | セッション開始時とターン終了時に GitHub の PR / Issue 一覧を右ペインに表示する |
| [progress-map](plugins/progress-map) | リポジトリの進捗を Artifact の作業マップにまとめて作成・更新するスキル（`plan` / `issue` で出典を選ぶ） |
| [downloads-guard](plugins/downloads-guard) | 作業ディレクトリが `~/Downloads` のセッションでは、プロンプトとツール実行をすべて拒否する |
| [cloudwatch-settings](plugins/cloudwatch-settings) | Claude Code と Codex CLI の OpenTelemetry メトリクスを Amazon CloudWatch へ直接送る設定を行うスキル（API キーはリポジトリに含めず、各マシンの設定ファイルにだけ書く） |
