# Clawd Mods — SPEC

設計判断 D1–D14 を実装仕様に落としたもの（決定の経緯はローカルの PLAN.md、リポジトリ外）。

## 1. コンポーネント

| 名前 | 場所 | 役割 |
|---|---|---|
| `clawd-mods` | `clawd-mods/mod/`（正本。`CLAUDE_CODE_PLUGIN_DIRS` で読み込む） | Claude Code Mod。状態判定・AbovePrompt 描画・デーモンへ送信 |
| `clawd-bridge` | `clawd-mods/bridge/`（Python 3.12 + bleak, uv。`macos/` で ClawdBridge.app + LaunchAgent `dev.clawd.bridge`） | 常駐デーモン。Unix ソケット HTTP で受信 → BLE で Cardputer へ |
| `clawd-cardputer` | `clawd-mods/firmware/clawd_cardputer/`（Arduino, m5stack:esp32 3.3.7, 同梱 BLE (Bluedroid)） | BLE GATT サーバー + 液晶アニメ |
| 共通スプライト | `clawd-mods/sprites/gen.py` → 生成 `mod/hooks/sprites.ts`, `firmware/.../sprites.h`。`export_gif.py` で `docs/anims/*.gif` | 同一ドット定義を共有 |

## 2. 状態モデル（Mod）

`state` ∈ `idle | thinking | tool | done | error | waiting`、`tool` のとき `category` ∈ `read | write | bash | web | agent | other`。

| トリガー | 遷移 |
|---|---|
| `prompt.submit` | → thinking |
| `tool.call`（`agentId` なし = メインループ） | 実行前 → tool(category)。結果 `isError` → error（1.5s）→ thinking、正常・ユーザー拒否（deny）→ thinking |
| `tool.call`（`agentId` あり = サブエージェント） | 無視（D10。親の Agent 呼び出しが agent 状態を保持） |
| `classic.PermissionRequest`（`agent_id` なし） | 同名で実行中の最新の呼び出しを waiting（その tool.call の完了で解除）。`tool.check` の ask は auto mode では分類器が自動判定しユーザーに聞かないため使わない（2026-10-15 変更） |
| `turn.complete`（`agentId` なし） | → done。**次の `prompt.submit` まで維持**（2026-10-15 変更。以前は 3s 後に idle） |
| `session.start` | → idle。セッション情報取得・送信ループ開始（再発火時は張り直し。途中ロードで来ない場合は最初のフック/描画後に遅延開始） |
| `session.end` | 送信ループと送信待ちを止めてから、デーモンへ `end` 送信 |

並列ツール呼び出し: 実行中の呼び出しをスタックで持ち、最後に開始した未完了のもの を表示。全完了で thinking。

カテゴリ写像: Read/Grep/Glob/NotebookRead/LS → read、Edit/Write/NotebookEdit/MultiEdit → write、Bash/BashOutput/KillShell → bash、WebFetch/WebSearch → web、Agent/Task → agent、それ以外（mcp__* 含む）→ other。

既知の制限: waiting は許可ダイアログ表示から tool 完了まで。承認後の実行中も waiting 表示のまま（v1 許容）。auto mode で分類器が自動許可した呼び出しに PermissionRequest が来ないことは実機未確認。

### `/clawd-mods demo`

帯だけで全 11 アニメを 1 つ 3 秒ずつ再生し、終わったら通常表示に戻る（bridge には送らない）。再実行で最初から。引数なし・不明な引数は使い方を返す。

## 3. Mod → bridge IPC

`$.http.fetch("http://clawd/event", { socketPath: "~/.clawd-bridge/bridge.sock" 展開後, method: "POST" })`

```json
{ "v": 1, "session": "<session id>", "label": "<cwd basename, ≤12>", "state": "tool", "category": "write", "tool": "Edit" }
```
`state: "end"` でセッション削除。`GET /status` → `{ "ble": "connected" | "scanning" | "disconnected", "sessions": n }`。

- 送信は 150ms 毎に最新値だけを送る（タイムアウト指定は API に無い）。現在値を 60s 毎に再送（ハートビート: bridge 再起動・10 分掃除で消えないため）。
- 失敗は `$.ui.log` に同文面 1 回だけ記録し Claude の動作は妨げない（D12）。全フックは自前処理を try で囲み `next(e)` を 1 回だけ呼ぶ。
- `tool` はツール名のみ（mcp は `mcp__server__tool` の末尾 `tool` 部分、`[A-Za-z0-9_.-]` 以外は `_`、≤12 文字）。パス・コマンドは送らない（D7）。
- bridge 側検証: `v` は int の 1、`session` ≤64 文字、state/category は文字列かつ既知値。違反は 400。

## 4. bridge → Cardputer BLE

- デバイス名 `Clawd-Cardputer`、Service UUID `c1a0d000-7c1e-4b6e-9a55-0c1a0d000001`
- Characteristic `…0002` (write with response): スナップショット（全セッション状態）
- Characteristic `…0003` (read/notify): デバイス状態 `{"bat":87}` — **v1 未実装**（バッテリーは Cardputer 画面に直接表示）
- bridge はイベント受信毎に**スナップショット全体**を送る（差分なし。取りこぼしても次で回復）。

スナップショット形式（UTF-8 テキスト、≤180 byte。macOS は MTU 185 前後をネゴ）:
```
1|<total>|<state>,<category>,<tool>|<state>,<category>,<tool>|...
```
最大 3 スロット（D11）。`total` は 99 で頭打ち（FW の上限）。3 超なら Cardputer 側で `+N` 表示。180 byte 超の書き込みは FW が破棄。並びは最初にイベントが来た順。セッションは `end` 受信または 10 分無イベントで削除。

bridge の BLE 接続: 起動時スキャン → 接続 → 切断時 2s→30s 指数バックオフで再接続。想定外例外もログしてリトライ（デーモンは落とさない）。
bridge は既に応答するソケットがあれば起動を中止（二重起動防止）。`~/.clawd-bridge/` は 0700、ログ・ソケットは 0600。

## 5. 表示

### Mac（AbovePrompt）
- Desktop: `Svg`（`isInteractive: true`, SMIL アニメ）。Clawd 48×36px 程度 + 右にラベル（例 `Editing…`）。端に `Cardputer: 未接続` を接続時以外のみ表示。
- Terminal: `Raster`（`▀` 半角ブロックで 1 セル=縦 2 ドット）、`$.clock.every(100ms)` の tick で各アニメの ms に応じてフレーム送り。
- `hasSurvey` のときは描画しない（`next(e)`）。

### Cardputer（240×135）
- 上端 14px: BLE 状態（`* Mac` / `o waiting`）+ バッテリー % + `+N`。
- 本体: スロット数 n（1–3）で横を等分割。各スロット: Clawd（1 匹 ×6、2–3 匹 ×4 拡大）+ 下にツール名テキスト。
- 未接続時: 目を閉じた idle フレーム固定 + 「waiting for Mac...」。
- スペースキー: Claude が作業していない時（未接続 / セッションなし / 表示中全員が idle か done）に押すと、全 11 アニメを 3 秒ずつ 1 匹で再生（ローカル demo）。再生中に再度押すと中断。始まった demo は Claude が作業を始めても最後まで流す。作業中の押下は開始せず、画面に「Claude is working」を 1.5 秒表示。キーボードは M5Cardputer 1.1.1（ADV の TCA8418 を自動判別）。
- 描画ループ 50ms（20fps）で M5Canvas に全面再描画。アニメのコマ送りは各 Anim の ms。

## 6. スプライト

16×12 ドット、パレット: 0=透明, 1=オレンジ(#D97757), 2=黒(目), 3=白, 4=灰(道具), 5=青(波・ペン先), 6=黄(きらめき・ボード・ERROR 本体), 7=赤(ERROR の汗)。
各アニメ 2–8 フレーム: idle（まばたき）、thinking（左右に揺れ+「…」）、read（開いた本を読み、ページをめくる）、write（右手にペンを持ち、右側の紙に左から右へ字を書く）、bash（ハンマー）、web（サーフボードで波乗り）、agent（分身）、other（歯車）、done（ジャンプ）、error（しょんぼり。本体は黄色、汗は赤）、waiting（手を振る）。一覧は `docs/anims/*.gif`。

## 7. 受入基準

| # | 基準 | 確認方法 |
|---|---|---|
| A1 | Read/Edit/Bash/WebFetch/Agent 実行中に Mac 帯の Clawd が対応アニメになる | Desktop で実際にツールを使わせて目視 |
| A2 | ターン完了で done → idle | 目視 |
| A3 | bridge 停止中でも Claude は普通に動き、帯に「未接続」 | bridge 停止して 1 ターン |
| A4 | Cardputer がツール状態を 1s 以内に反映 | 目視 + bridge ログのタイムスタンプ |
| A5 | 2 セッション同時で Cardputer に 2 匹並ぶ | 2 セッションで同時にツール実行 |
| A6 | Cardputer 再起動後、bridge が自動再接続 | Cardputer リセット |
| A7 | Mod の単体テスト（状態遷移・カテゴリ写像）が GREEN | `claude plugin test` |
| A8 | bridge の単体テスト（スナップショット生成・タイムアウト削除）が GREEN | `uv run pytest` |

## 8. 既知の未知数（2026-10-15 実機で判明した結果）

- ✅ TCC: Claude の子プロセスは Bluetooth で SIGABRT。ClawdBridge.app（Info.plist + C ランチャーが python を子として spawn）を LaunchAgent で起動して解決。
- ✅ 以前のファームのボンディング情報が Mac に残ると `CBErrorDomain Code=14`。システム設定で登録解除して解決。
- ✅ BLE は arduino-esp32 同梱（Bluedroid）でフラッシュ 61% に収まった（NimBLE 不要）。

### 当初の未知数

- macOS の Bluetooth 権限（TCC）が launchd 起動の Python に付与できるか → 付与先は実行ファイル。ダメなら Terminal から起動 / .app 化。
- arduino-esp32 3.3.x 同梱 BLE（Bluedroid）のフラッシュサイズ。超過なら NimBLE-Arduino を導入。
- Desktop の Svg（SMIL）が AbovePrompt の帯で期待通り動くか。
- Cardputer ADV のピン/電源 API が M5Unified 0.2.17 で対応済みか。
