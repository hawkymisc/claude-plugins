import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BleState, View } from '../types'
import { RASTER_COLUMNS, RASTER_ROWS, animSvg, rasterCells, tickFor } from './draw'
import { Tracker, animOf, captionOf, eventBody, sameView } from './logic'
import { ANIMS } from './sprites'
import type { AnimName } from './sprites'

const PLUGIN = 'clawd-mods'
const viewAtom = atom({ plugin: 'clawd-mods', key: 'view' } as const, { state: 'idle' } as View)
const bleAtom = atom({ plugin: 'clawd-mods', key: 'ble' } as const, 'unknown' as BleState)
const tickAtom = atom({ plugin: 'clawd-mods', key: 'tick' } as const, 0)
// `/clawd-mods demo` 再生中のアニメ番号。null なら通常表示
const demoAtom = atom({ plugin: 'clawd-mods', key: 'demo' } as const, null as number | null)

const ERROR_MS = 1500
const FLUSH_MS = 150
const STATUS_MS = 5000
const TERMINAL_TICK_MS = 100
// bridge 再起動・10 分の stale 掃除 (SPEC §4) で消えないよう、現在の状態を定期再送する
const HEARTBEAT_MS = 60_000
const DEMO_STEP_MS = 3000
const DEMO_NAMES = Object.keys(ANIMS) as AnimName[]
const USAGE = '使い方: /clawd-mods demo — プロンプト上の帯で全アニメを 1 つ 3 秒ずつ再生します'

type Ctx = {
  tracker: Tracker
  session: string
  label: string
  socketPath: string
  shown: View
  pending: View | null
  isSending: boolean
  lastError: string
  isStarted: boolean
  startScheduled: boolean
  transient: Timer | undefined
  terminalTimer: Timer | undefined
  loops: Timer[]
  demoTimer: Timer | undefined
  isCommandRegistered: boolean
}

function newCtx(): Ctx {
  return {
    tracker: new Tracker(),
    session: '',
    label: '',
    socketPath: '',
    shown: { state: 'idle' },
    pending: null,
    isSending: false,
    lastError: '',
    isStarted: false,
    startScheduled: false,
    transient: undefined,
    terminalTimer: undefined,
    loops: [],
    demoTimer: undefined,
    isCommandRegistered: false,
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null) return JSON.stringify(e) // HookFailure 等
  return String(e)
}

function logOnce($: EngineInterface, ctx: Ctx, text: string): void {
  // 同じ失敗を毎回ログに積まない (bridge 停止中は FLUSH_MS 毎に失敗しうる)
  if (text === ctx.lastError) return
  ctx.lastError = text
  $.ui.log(`${PLUGIN}: ${text}`)
}

async function publish($: EngineInterface, ctx: Ctx): Promise<void> {
  const view = ctx.tracker.view()
  if (sameView(view, ctx.shown)) return
  ctx.shown = view
  ctx.pending = view
  await update($, viewAtom, () => view)
}

function later($: EngineInterface, ctx: Ctx, ms: number, fn: () => void): void {
  ctx.transient?.cancel()
  ctx.transient = $.clock.after(ms, () => {
    fn()
    void publish($, ctx)
  })
}

async function post($: EngineInterface, ctx: Ctx, body: string): Promise<void> {
  if (!ctx.socketPath) return
  const res = await $.http.fetch('http://clawd/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    socketPath: ctx.socketPath,
  })
  if (!res.ok) throw new Error(`bridge answered ${res.status}`)
}

async function flush($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.isSending || ctx.pending === null) return
  const view = ctx.pending
  ctx.pending = null
  ctx.isSending = true
  try {
    await post($, ctx, eventBody(ctx.session, ctx.label, view))
    ctx.lastError = ''
    // 停止表示のままにしない: 送れたなら bridge は生きている
    if ((await read($, bleAtom)) === 'no-bridge') await pollStatus($, ctx)
  } catch (e) {
    // bridge 未起動は想定内 (D12): 帯の「未接続」で見せ、ログは同じ文面につき 1 回
    logOnce($, ctx, `send failed: ${errText(e)}`)
    await update($, bleAtom, () => 'no-bridge')
  } finally {
    ctx.isSending = false
  }
}

async function pollStatus($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.socketPath) return
  try {
    const res = await $.http.fetch('http://clawd/status', { socketPath: ctx.socketPath })
    if (!res.ok) throw new Error(`bridge answered ${res.status}`)
    const ble = (JSON.parse(res.text) as { ble?: string }).ble
    const next: BleState = ble === 'connected' ? 'connected' : ble === 'scanning' ? 'scanning' : 'disconnected'
    await update($, bleAtom, () => next)
  } catch (e) {
    logOnce($, ctx, `status failed: ${errText(e)}`)
    await update($, bleAtom, () => 'no-bridge')
  }
}

function bleNoteOf(ble: BleState): string | undefined {
  if (ble === 'connected' || ble === 'unknown') return undefined
  return ble === 'no-bridge' ? 'Cardputer: 未接続 (bridge停止)' : 'Cardputer: 未接続'
}

function stopLoops(ctx: Ctx): void {
  for (const t of ctx.loops) t.cancel()
  ctx.loops = []
}

/**
 * セッション情報を読み、送信ループを張る。session.start が来ない途中ロード
 * (ホットリロード等) でも最初のフックで呼ばれる。再呼び出し時は張り直す。
 */
async function start($: EngineInterface, ctx: Ctx): Promise<void> {
  ctx.isStarted = true
  ctx.session = await $.session.id()
  const cwd = await $.session.cwd()
  ctx.label = cwd.split('/').filter(Boolean).pop() ?? 'claude'
  const home = await $.env.get('HOME')
  ctx.socketPath = home ? `${home}/.clawd-bridge/bridge.sock` : ''
  stopLoops(ctx)
  ctx.loops.push(
    $.clock.every(FLUSH_MS, () => void flush($, ctx)),
    $.clock.every(STATUS_MS, () => void pollStatus($, ctx)),
    $.clock.every(HEARTBEAT_MS, () => {
      ctx.pending ??= ctx.shown
    }),
  )
  ctx.pending = ctx.shown
  await pollStatus($, ctx)
  if (!ctx.isCommandRegistered) {
    try {
      await $.command.register({ name: 'clawd-mods', description: 'Clawd: `demo` で全アニメを帯で再生' })
      ctx.isCommandRegistered = true
    } catch (err) {
      // コマンドが無くても表示・送信は続ける
      logHookFailure($, 'command.register', err)
    }
  }
}

/** 帯だけのローカル demo (bridge には送らない)。再実行で最初から。 */
async function startDemo($: EngineInterface, ctx: Ctx): Promise<void> {
  ctx.demoTimer?.cancel()
  await update($, demoAtom, () => 0)
  ctx.demoTimer = $.clock.every(DEMO_STEP_MS, () => {
    void update($, demoAtom, i => (i === null || i + 1 >= DEMO_NAMES.length ? null : i + 1)).then(async () => {
      if ((await read($, demoAtom)) === null) {
        ctx.demoTimer?.cancel()
        ctx.demoTimer = undefined
      }
    })
  })
}

async function ensureStarted($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.isStarted) await start($, ctx)
}

function logHookFailure($: EngineInterface, hook: string, e: unknown): void {
  $.ui.log(`${PLUGIN}: ${hook} hook failed: ${errText(e)}`)
}

function startTerminalTicks($: EngineInterface, ctx: Ctx): void {
  // ターミナルだけフレームを自前で送る。Desktop は SVG の SMIL が回す。
  ctx.terminalTimer ??= $.clock.every(TERMINAL_TICK_MS, () => void update($, tickAtom, t => t + 1))
}

export const register: Register = on => {
  const ctx = newCtx()

  // 方針 (D12): 表示用 Mod の失敗で Claude を止めない。自前の処理は try で囲んでログに残し、
  // next(e) はちょうど 1 回だけ呼ぶ。.catch は想定外の throw の最後の受け皿 (ログ付き)。

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      ctx.tracker.reset()
      ctx.shown = { state: 'idle' }
      await update($, viewAtom, () => ctx.shown)
      await start($, ctx)
    } catch (err) {
      logHookFailure($, 'session.start', err)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    // 送信待ち・ループを先に止め、end の後に古い状態が届いてセッションが蘇るのを防ぐ
    stopLoops(ctx)
    ctx.pending = null
    try {
      await post($, ctx, eventBody(ctx.session || e.sessionId, ctx.label, 'end'))
    } catch (err) {
      logOnce($, ctx, `end failed: ${errText(err)}`)
    }
    ctx.isStarted = false
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await ensureStarted($, ctx)
      ctx.transient?.cancel()
      ctx.tracker.submit()
      await publish($, ctx)
    } catch (err) {
      logHookFailure($, 'prompt.submit', err)
    }
    return next(e)
  }).catch(($, e, next) => {
    logHookFailure($, 'prompt.submit (catch)', next.error)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // サブエージェント内の呼び出しは親の Agent 表示で代表する (D10)
    if (e.agentId !== undefined || e.tool_use_id === undefined) return next(e)
    const id = e.tool_use_id
    try {
      await ensureStarted($, ctx)
      ctx.tracker.toolStart(id, e.tool)
      await publish($, ctx)
    } catch (err) {
      logHookFailure($, 'tool.call (before)', err)
    }
    const result = await next(e)
    try {
      // ユーザーの拒否 (deny) は失敗ではないので error にしない。ツール自身のエラーだけ
      const isError = result.isError === true
      ctx.tracker.toolEnd(id, isError)
      await publish($, ctx)
      if (isError) later($, ctx, ERROR_MS, () => ctx.tracker.recover())
    } catch (err) {
      logHookFailure($, 'tool.call (after)', err)
    }
    return result
  }).catch(($, e, next) => {
    logHookFailure($, 'tool.call (catch)', next.error)
    return next(e)
  })

  // waiting は実際に許可ダイアログが出る時だけ。tool.check の ask は auto mode では
  // 分類器が自動判定してユーザーに聞かないので使わない
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      if (e.agent_id === undefined) {
        ctx.tracker.toolAskByName(e.tool_name)
        await publish($, ctx)
      }
    } catch (err) {
      logHookFailure($, 'classic.PermissionRequest', err)
    }
    return next(e)
  }).catch(($, e, next) => {
    logHookFailure($, 'classic.PermissionRequest (catch)', next.error)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // サブエージェントのターン完了は対象外 (D10)
    try {
      // done は次のプロンプトまで維持する (残っている error 復帰タイマーも止める)
      ctx.transient?.cancel()
      ctx.tracker.complete()
      await publish($, ctx)
    } catch (err) {
      logHookFailure($, 'turn.complete', err)
    }
    return next(e)
  })

  on('command.run', { command: 'clawd-mods' }, async ($, e) => {
    if (e.args.trim() !== 'demo') return { text: USAGE }
    await startDemo($, ctx)
    return { text: `Clawd demo: ${DEMO_NAMES.length} 種を ${DEMO_STEP_MS / 1000} 秒ずつ再生します` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // 描画は純粋でなければならない (state 書き込み禁止) ので、途中ロード時の初期化はタイマーで外に出す
    if (!ctx.isStarted && !ctx.startScheduled) {
      ctx.startScheduled = true
      $.clock.after(0, () => void ensureStarted($, ctx).catch(err => logHookFailure($, 'lazy start', err)))
    }
    const view = await read($, viewAtom)
    const bleNote = bleNoteOf(await read($, bleAtom))
    const demo = await read($, demoAtom)
    const demoName = demo === null ? undefined : DEMO_NAMES[demo]
    const anim = demoName ?? animOf(view)
    const caption = demoName ? `demo ${(demo ?? 0) + 1}/${DEMO_NAMES.length} · ${demoName}` : captionOf(view)

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      startTerminalTicks($, ctx)
      const tick = await read($, tickAtom)
      const cells = rasterCells(anim, tickFor(anim, tick * TERMINAL_TICK_MS))
      return (
        <Box flexDirection="row" alignItems="center">
          <Raster key="clawd" columns={RASTER_COLUMNS} rows={RASTER_ROWS} cells={cells} />
          <Box flexDirection="column" marginLeft={1}>
            <Text>{caption}</Text>
            {bleNote ? <Text dimColor>{bleNote}</Text> : null}
          </Box>
        </Box>
      )
    }

    if (e.surface === 'desktop') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center">
          <Svg source={animSvg(anim, 3)} alt={`Clawd: ${caption}`} width={48} height={36} isInteractive />
          <Box flexDirection="column" marginLeft={1}>
            <Text>{caption}</Text>
            {bleNote ? <Text dimColor>{bleNote}</Text> : null}
          </Box>
        </Box>
      )
    }

    return next(e)
  }).catch(($, e, next) => {
    // 描画に失敗したら engine 既定の帯に戻す (プロンプトを壊さない)
    logHookFailure($, 'ui.render (catch)', next.error)
    return next(e)
  })
}
