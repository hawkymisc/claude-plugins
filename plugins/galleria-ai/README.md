# galleria-ai

GALLERIA のローカルAIを、別マシンの Claude Code から Tailnet 経由で利用するスキル。
ローカル環境の `SKILLS.md`（2026-11-01 JST 版）をプラグイン形式にし、画像用の API ワークフロー4点を同梱しています。

follow if you like : https://x.com/hawkieslab

## インストール

```text
/plugin marketplace add hawkymisc/claude-plugins
/plugin install galleria-ai@hawkymisc-claude-plugins
```

## 使い方

```text
/galleria-ai:galleria-ai GALLERIA の API の疎通を確認して
/galleria-ai:galleria-ai Liquid でこの文章を要約して
/galleria-ai:galleria-ai FLUX で雪の中のキツネの画像を作って
/galleria-ai:galleria-ai Qwen Edit でこの画像に青いマフラーを追加して
/galleria-ai:galleria-ai この文章を日本語の WAV 音声にして
```

GALLERIA のローカルAIや Tailnet API の利用を依頼した場合にもスキルを参照します。
各 API の稼働状態とモデル一覧を確認してから、curl または Python で呼び出します。

## 前提

- クライアントが対象の Tailnet に参加し、`galleria.tail3a4167.ts.net` にアクセスできること。
- クライアントで curl または Python が使えること（PowerShell では `curl.exe`）。
- GALLERIA 側で利用する推論サーバーが起動していること。音声と Strata は手動起動です。

このプラグインはクライアント用の運用手順とワークフローを配布します。サーバーのセットアップやモデル重みは含みません。
接続先はこの GALLERIA 専用です。API キーは不要ですが、Tailnet のアクセスルールに従います。
モデルの選択、ライセンス、起動・停止方法、確認範囲は [SKILL.md](skills/galleria-ai/SKILL.md) を参照してください。

## ファイル

- `skills/galleria-ai/SKILL.md`：接続先・モデル一覧・REST 呼び出し例・運用上の制約。
- `skills/galleria-ai/workflows/flux3-api.json`：FLUX 生成。
- `skills/galleria-ai/workflows/flux3-edit-api.json`：FLUX Edit。
- `skills/galleria-ai/workflows/qwen-image21-turbo-api.json`：Qwen Turbo 生成。
- `skills/galleria-ai/workflows/qwen-image21-edit-api.json`：Qwen Edit。

ワークフローはスキルのディレクトリから読み込み、生成物はクライアントの作業ディレクトリへ保存します。
Edit の入力画像は ComfyUI の `/upload/image` にアップロードしてから使用します。
