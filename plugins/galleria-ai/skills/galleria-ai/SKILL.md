---
name: galleria-ai
description: Use GALLERIA local AI services over the Tailnet REST APIs for text generation (Liquid / Strata), image generation and editing (FLUX / Qwen via ComfyUI), and Japanese speech synthesis (Qwen3-TTS). Use when the user requests GALLERIA local inference, its Tailnet APIs, or checks of those services.
metadata:
  author: "Hawkies' Lab"
  version: "1.0.0"
---

# GALLERIA ローカルAI — Tailnet REST API 運用ガイド

更新日: 2026-11-01（JST）。別マシンのClaude Code／Codexが、ツールからcurlやPythonでこのPCの推論を利用するための一覧です。作業開始時にこのファイルを読み、実行前に各APIの現在の状態を確認してください。

## プラグイン内のファイル

同梱ワークフローの基準ディレクトリは `${CLAUDE_SKILL_DIR}`（この `SKILL.md` のある場所）です。
本文の `workflows/...` はこのディレクトリからの相対パスとして扱い、クライアントの作業ディレクトリを基準に探さないでください。
Claude Code 以外で参照するときは、このファイルの実際の親ディレクトリに読み替えます。
生成画像・音声の保存先はクライアントの作業ディレクトリ、またはユーザー指定先です。
本文の起動スクリプト・モデル・ログ・検証記録のパスは GALLERIA 側のもので、このプラグインには含みません。

## 接続先と現在の状態

ホスト名は **`galleria.tail3a4167.ts.net`** です。`galleria-1` は別のTailnet端末です。
GALLERIAはWindows、RTX 5090（32GB VRAM）、RAM 64GBです。

| 用途 | Tailnetから使うベースURL | 2026-11-01の確認状態 | 起動方式 |
|---|---|---|---|
| テキスト生成（llama.cpp） | `http://galleria.tail3a4167.ts.net:8081/v1` | Liquidのモデル一覧・health応答を確認 | Windows起動時に自動起動 |
| テキスト生成（Strata） | `http://galleria.tail3a4167.ts.net:8082/v1` | 転送設定済み。サーバー停止中で502 | GALLERIA上で手動起動 |
| 音声生成（speech.cpp） | `http://galleria.tail3a4167.ts.net:8083/v1` | モデル一覧・health・日本語WAV取得を確認 | GALLERIA上で手動起動 |
| 画像生成・Edit（ComfyUI） | `http://galleria.tail3a4167.ts.net:8188` | system_stats・Qwen生成・PNG取得を確認 | Windows起動時に自動起動 |

すべてTailscale ServeによるTailnet内向けの転送です。推論サーバー自体は `127.0.0.1` で待ち受けます。クライアントからの到達可否はTailnetのアクセスルールに従います。アプリのAPIキーは設定していません。curl／Pythonからは不要な `Origin` ヘッダーを付けずに呼び出してください。

別マシンの `127.0.0.1` はそのクライアント自身です。リモート操作では上表のホスト名を使います。
既存の8787番の転送は別用途のため維持しています。

## 推論エンジンとモデル一覧

「導入済み」と「RESTで選択可能」は異なります。チャットモデルは実行中サーバーの `GET /v1/models` に出るIDだけを指定してください。

| エンジン | モデル | 量子化・精度 | 用途と運用状態 |
|---|---|---|---|
| llama.cpp b11429 / CUDA 13.4 | Liquid AI LFM2.5-24B-A2B | Q6_K | 8081で常駐。API ID **`liquid`**。テキスト入出力、32,768 context、同時処理1件 |
| llama.cpp 同上 | Qwen3.8-27B | Unsloth UD-Q6_K | 導入・CLI短文生成確認済み。画像用mmprojも取得済み。RESTサーバー未構成、画像入力は未検証 |
| llama.cpp 同上 | DeepSeek-R1-0528-Qwen3-8B | Unsloth Q8_0 | 導入・CLI短文生成確認済み。RESTサーバー未構成 |
| llama.cpp 同上 | MiniMax-M2.7 | Unsloth UD-IQ2_XXS | GPU・RAM分散の実験用。CLI短文生成確認済み、RESTサーバー未構成 |
| Strata Qwen engine 0.1.45.3 / CUDA 13 | Qwen3.8-Flash-Next | ISTA-DASLab GSQ-RCO IQ2_XS | 8082で手動切替。既知のAPI ID `qwen3.8-flash-next-iq2_xs`。32,768 context、1件ずつ。画像対応設定だが画像入力は未検証 |
| Strata DeepSeek engine 0.1.51 / CUDA 13 | DeepSeek-V4.1-Flash-1017 | ISTA-DASLab GSQ-RCO IQ2_XS / 2.25 bpw | 8082で手動切替。既知のAPI ID `deepseek-v4.1-flash`。8,192 context、テキストのみ。GPU・RAM・SSD分散 |
| ComfyUI 0.41.0 / PyTorch 2.13.0+cu130 | FLUX 3 Image Klein | distilled BF16 | 8188のワークフローで画像生成・参照画像Edit |
| ComfyUI 同上 | Qwen-Image-2.1-Turbo | INT8 convrot | 8188のワークフローで画像生成。公式8ステップsigma、CFG 1 |
| ComfyUI 同上 | Qwen-Image-2.1 | INT8 convrot | 8188のワークフローで参照画像Edit。40 steps、Euler/simple、CFG 1 |
| nyosegawa/speech.cpp 0.10.0 / Vulkan | Qwen3-TTS-12Hz-1.7B-CustomVoice | Q8_0 | 8083で音声生成。API ID **`Qwen3-TTS-12Hz-1.7B-CustomVoice`**。日本語を含む10言語 |

StrataのTerminalは0.2.6、Controlは0.1.51です。QwenとDeepSeekは同じ8082番を使うため、切替時には先に稼働中のStrataを停止します。
Qwen画像2モデルはQwen3-VL 8BのINT8 convrotエンコーダーとBF16 VAEを共有します。
音声のASRモデルは取得していません。CustomVoiceはプリセット声による合成用で、音声クローン・VoiceDesignは使えません。

## 最初の疎通確認

以下はクライアント側のBash例です。PowerShellでは `curl.exe` を使用します。

```bash
curl --fail-with-body --max-time 15 http://galleria.tail3a4167.ts.net:8081/health
curl --fail-with-body --max-time 15 http://galleria.tail3a4167.ts.net:8081/v1/models
curl --fail-with-body --max-time 15 http://galleria.tail3a4167.ts.net:8083/health
curl --fail-with-body --max-time 15 http://galleria.tail3a4167.ts.net:8083/v1/models
curl --fail-with-body --max-time 15 http://galleria.tail3a4167.ts.net:8188/system_stats
curl --fail-with-body --max-time 15 http://galleria.tail3a4167.ts.net:8188/queue
```

8082はStrata起動後に `/health` と `/v1/models` を確認します。Serve経路が残っていてもバックエンドが停止していると502になります。

## テキスト生成: OpenAI互換 Chat Completions

```bash
curl --fail-with-body --max-time 300 \
  http://galleria.tail3a4167.ts.net:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"liquid","messages":[{"role":"user","content":"日本の首都を一語で答えてください。"}],"temperature":0.1,"max_tokens":1024,"stream":false}'
```

回答は `choices[0].message.content` を読みます。思考内容が別フィールドにある場合も、最終回答にはcontentを使います。
Liquidは60秒未使用でモデルメモリを解放します。次の要求では自動ロードされ、過去の確認では約29秒かかりました。十分なHTTPタイムアウトを設定してください。思考に出力予算を使うため、上限が短すぎると本文が出る前に終わります。

Strataは起動後のモデルIDを取得し、同じ `/v1/chat/completions` に送ります。DeepSeekの短文確認では `reasoning_effort: "none"` を指定しています。
ツール呼び出し、長文品質、Responses APIの互換性は未検証です。ここでの利用はエージェントのHTTPツールから追加の推論処理を呼ぶ用途です。

## 音声生成: OpenAI互換 Speech API

```bash
curl --fail-with-body --max-time 300 \
  http://galleria.tail3a4167.ts.net:8083/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3-TTS-12Hz-1.7B-CustomVoice","input":"こんにちは。ローカルの音声生成が使えます。","voice":"ono_anna","language":"ja","response_format":"wav","seed":42}' \
  -o hello.wav
```

- 出力は24kHz・モノラルのWAVです。保存先 `hello.wav` はクライアント側です。
- 日本語向けの声は `ono_anna`。声の一覧は `/v1/models` の `data[].speech.voices` を参照します。
- `instructions` に話し方の指示を渡せます。例: `"落ち着いた優しい口調で"`。
- 対応出力はWAV／PCM。MP3は未対応です。Qwen TTSは `speed` を受け付けません。
- 長さの上限には `max_seconds` を使用できます。レスポンスの `X-Speech-Stop` が `complete` かを確認します。
- `POST /v1/audio/transcriptions` は、ASRモデルを導入・ロードしていない現在の構成では使えません。
- speech.cppの管理ページはローカルHostに制限されています。Tailnet側はREST APIを利用します。

## 画像生成・Edit: ComfyUIの非同期API

ComfyUIではモデルID付きのチャット要求ではなく、API形式のワークフローJSONを送信します。
下表の `workflows/*-api.json` はこのスキルに同梱されています。`${CLAUDE_SKILL_DIR}/workflows` から読み込んでください。通常のUI形式 `.json` を `/prompt` へ送らないでください。

| 用途 | API形式JSON | プロンプトの変更箇所 | Editの画像入力 |
|---|---|---|---|
| FLUX生成 | `workflows/flux3-api.json` | `graph["4"]["inputs"]["text"]` | — |
| FLUX Edit | `workflows/flux3-edit-api.json` | 同上 | `graph["11"]["inputs"]["image"]` |
| Qwen Turbo生成 | `workflows/qwen-image21-turbo-api.json` | `graph["4"]["inputs"]["prompt"]` | — |
| Qwen Edit | `workflows/qwen-image21-edit-api.json` | 同上 | `graph["15"]["inputs"]["image"]` |

基本の流れ:

1. Editの場合は `POST /upload/image` にmultipartの `image` フィールドで画像を送信します。
2. `POST /prompt` に `{"prompt": graph}` を送信し、返された `prompt_id` を保存します。
3. `GET /history/{prompt_id}` をポーリングします。履歴がまだなければ待機します。
4. 履歴の `status.status_str` が `success` かを確認します。エラー時は `status.messages` を読みます。
5. `outputs` 内の `images` から `filename`、`subfolder`、`type` を取り出し、`GET /view` で画像を取得します。

Qwen Turboでの一通りの例（Python標準ライブラリのみ。クライアントで実行）:

```python
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://galleria.tail3a4167.ts.net:8188"

def api(path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode("utf-8")) from e

workflow_dir = Path(r"${CLAUDE_SKILL_DIR}") / "workflows"
graph = json.loads((workflow_dir / "qwen-image21-turbo-api.json").read_text(encoding="utf-8"))
graph["4"]["inputs"]["prompt"] = "A red fox in fresh snow, warm sunrise, realistic photograph."
graph["8"]["inputs"]["noise_seed"] = 42
job = api("/prompt", {"prompt": graph})["prompt_id"]
deadline = time.monotonic() + 1800
while time.monotonic() < deadline:
    result = api("/history/" + job).get(job)
    if result:
        if result["status"]["status_str"] != "success":
            raise RuntimeError(json.dumps(result["status"], ensure_ascii=False))
        index = 0
        for output in result["outputs"].values():
            for image in output.get("images", []):
                query = urllib.parse.urlencode({k: image[k] for k in ("filename", "subfolder", "type")})
                with urllib.request.urlopen(BASE + "/view?" + query, timeout=60) as r:
                    index += 1
                    Path(f"generated-{index}.png").write_bytes(r.read())
        break
    time.sleep(1)
else:
    raise TimeoutError(f"Job {job} is still pending; inspect /queue and /history/{job}")
```

Edit画像のアップロード例:

```bash
curl --fail-with-body --max-time 120 \
  http://galleria.tail3a4167.ts.net:8188/upload/image \
  -F 'image=@input.png' -F 'type=input'
```

戻り値の `name` と `subfolder` を結合してワークフローの画像入力へ設定します。クライアントの絶対パスをそのまま指定してもサーバーからは読めません。
Qwen Editではプロンプト中の `<image1>` が編集対象です。生成例と同様に `qwen-image21-edit-api.json` を読み、プロンプトと画像入力を差し替えて送信します。
seedは `graph["12"]["inputs"]["seed"]`、stepsは同じノードの `steps` です。参照画像のサイズ予算は `graph["4"]["inputs"]["resolution"]`（既定1024）。
生成画像はサーバーの `outputs` にも保存されます。クライアントには `/view` のレスポンスを保存してください。

`GET /object_info` は対応ノードとモデル候補、`GET /queue` は待機・実行中ジョブの確認に使えます。
共有キューへの送信後、通信が切れても処理が続く場合があります。POSTを再送する前に保存したprompt_idの履歴を確認し、重複投入を避けます。
他ユーザーのジョブを巻き込む `/interrupt` や全体キュー削除は通常の操作では行いません。

## GALLERIA側での起動・停止と保存先

サーバー側のプロジェクトは **`C:\Users\hirok\Develop\local-llm`** です。以下のCMDはGALLERIA上で実行します。REST APIにはWindowsプロセスやタスクを起動する管理APIはありません。

| サービス | 起動 | 停止 | 自動起動 |
|---|---|---|---|
| Liquid | `Start-Liquid.cmd` | `Stop-LocalAI.cmd`（ComfyUIも停止） | `LocalAI-LiquidAI` タスク |
| ComfyUI / FLUX / Qwen画像 | `Start-FLUX3.cmd` または `Start-Qwen-Image.cmd` | `Stop-LocalAI.cmd`（Liquidも停止） | `LocalAI-ComfyUI` タスク |
| Strata Qwen | `Start-Strata.cmd` | `Stop-Strata.cmd` | なし |
| Strata DeepSeek | `Start-Strata-DeepSeek.cmd` | `Stop-Strata-DeepSeek.cmd` または `Stop-Strata.cmd` | なし |
| speech.cpp | `Start-Speech.cmd` | `Stop-Speech.cmd` | なし |

音声を画面なしで起動するときは `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Speech.ps1 -NoBrowser` を使用します。
再起動後は音声・Strataを起動するまで、それぞれのTailnet APIは利用できません。Serveの転送設定と推論プロセスの稼働状態は別です。

| データ | GALLERIA上の保存先 |
|---|---|
| Liquid重み | `models/liquid` |
| FLUX重み・ComfyUIが参照する画像モデル | `models/flux` |
| Qwen画像重み本体 | `models/qwen-image21`（ComfyUI側はハードリンクで参照） |
| Qwen音声重み本体 | `models/speech-tts`（`models/speech-cache`もハードリンク） |
| Qwen27B / DeepSeek-R1 / MiniMax | `D:\LLM-models` の各モデルフォルダ |
| Strataモデル | `D:\LLM-models\strata` |
| 生成画像・検証結果 | プロジェクトの `outputs` |
| ログ | `logs/liquid.stderr.log`、`logs/flux.stderr.log`、`logs/speech.stderr.log` |

MiniMaxのCLI確認では `--jinja -ngl 20 -c 2048 -b 128 -ub 128` が必要でした。`--jinja` なしではこのllama.cpp版で異常終了しています。
追加のCLIモデルをREST化するには、GALLERIA上で別のllama-server起動設定と接続先の追加が必要です。LiquidのAPIでモデル名だけを変えてもロードされません。

## 共有GPUでの運用と確認範囲

- 重い生成や大規模モデルの切替は直列に扱います。特にStrata DeepSeekは検証時にPC全体で約31.1GiBのGPUメモリを使用しました。
- Liquidは空きメモリに応じてGPU配置を調整し、60秒未使用で重みを解放します。VRAM不足時は実行中ジョブとモデル配置を確認します。
- ComfyUIは画像モデルを切り替えて使います。Qwen Editは変更箇所以外の毛並み・背景の質感も変える場合があります。
- Qwen画像2.1／Turboは **Qwen Research License（非商用の研究・評価用途）** です。商用利用には別途許諾が必要です。本文は `models/qwen-image21/base-model-license/LICENSE` と `turbo-model-license/LICENSE` にあります。
- 音声モデルはApache 2.0、speech.cppはMIT。その他のモデルは各保存先の元モデルライセンスを参照します。
- ローカル検証済み: FLUX生成・Edit、Qwen生成・Edit、Qwen日本語TTS（APIとCMD）。過去に各追加LLMの短文生成も確認済みです。
- Tailnetホスト名経由の検証は、このPCからそのURLへ接続して実施しています。別の物理マシンからの呼び出しは未検証です。クライアント側でも上記の疎通確認を実行してください。

設定の正本は `installation.json`、取得リビジョンとSHA256は `models/*download-plan.json` と各 `verified.json`、実行記録は `outputs` です。
Tailnet経由の画像・音声確認記録は `outputs/tailnet-rest-verification.json`、Serve設定のスナップショットは `runtime/tailscale-serve-config.json` に保存しています。
このガイドの稼働状態は確認時点の記録です。判断には現在のhealth・モデル一覧・キューの応答を優先してください。
