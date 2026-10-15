import type { Category, View } from '../types'
import type { AnimName } from './sprites'

export type Phase = 'idle' | 'thinking' | 'done' | 'error'

const CATEGORY: Record<string, Category> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  NotebookRead: 'read',
  Edit: 'write',
  MultiEdit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
}

export function categoryOf(tool: string): Category {
  return CATEGORY[tool] ?? 'other'
}

/** BLE に載せるツール名: MCP は末尾のツール名だけ、12 文字まで (SPEC §3)。 */
export function shortToolName(tool: string): string {
  const tail = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? '') : tool
  // bridge はスナップショット区切り (| ,) を含む名前を 400 で拒否するので、許可文字以外は _ に
  const name = tail.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 12)
  return name || 'mcp'
}

type Call = { id: string; tool: string; isWaiting: boolean }

/**
 * メインループのツール呼び出しと turn の進行から、今見せる状態を決める。
 * 優先度: waiting > error > 実行中ツール (最後に始まったもの) > phase。
 */
export class Tracker {
  phase: Phase = 'idle'
  private calls: Call[] = []

  submit(): void {
    this.phase = 'thinking'
    this.calls = []
  }

  toolStart(id: string, tool: string): void {
    this.calls.push({ id, tool, isWaiting: false })
    if (this.phase !== 'error') this.phase = 'thinking'
  }

  /**
   * 許可ダイアログ (classic.PermissionRequest) は tool_use_id を持たないので、
   * 同名で実行中かつまだ待っていない最新の呼び出しを待ち状態にする。
   */
  toolAskByName(tool: string): void {
    const call = [...this.calls].reverse().find(c => c.tool === tool && !c.isWaiting)
    if (call) call.isWaiting = true
  }

  toolEnd(id: string, isError: boolean): void {
    this.calls = this.calls.filter(c => c.id !== id)
    if (isError) this.phase = 'error'
    else if (this.phase !== 'error') this.phase = 'thinking'
  }

  /** error 表示の時間切れ。 */
  recover(): void {
    if (this.phase === 'error') this.phase = 'thinking'
  }

  complete(): void {
    this.calls = []
    this.phase = 'done'
  }

  reset(): void {
    this.calls = []
    this.phase = 'idle'
  }

  view(): View {
    const waiting = this.calls.find(c => c.isWaiting)
    if (waiting) return { state: 'waiting', tool: waiting.tool }
    if (this.phase === 'error') return { state: 'error' }
    const top = this.calls[this.calls.length - 1]
    if (top) return { state: 'tool', category: categoryOf(top.tool), tool: top.tool }
    return { state: this.phase }
  }
}

export function animOf(view: View): AnimName {
  return view.state === 'tool' ? (view.category ?? 'other') : view.state
}

const VERB: Record<AnimName, string> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  read: 'Reading',
  write: 'Writing',
  bash: 'Running',
  web: 'Browsing',
  agent: 'Delegating',
  other: 'Working',
  done: 'Done!',
  error: 'Oops',
  waiting: 'Waiting for you',
}

export function captionOf(view: View): string {
  const verb = VERB[animOf(view)]
  return view.tool ? `${verb} · ${view.tool}` : verb
}

export function sameView(a: View, b: View): boolean {
  return a.state === b.state && a.category === b.category && a.tool === b.tool
}

/** bridge へ送る JSON (SPEC §3)。パス・コマンドは含めない (D7)。 */
export function eventBody(session: string, label: string, view: View | 'end'): string {
  if (view === 'end') return JSON.stringify({ v: 1, session, label, state: 'end' })
  return JSON.stringify({
    v: 1,
    session,
    label: label.slice(0, 12),
    state: view.state,
    ...(view.category ? { category: view.category } : {}),
    ...(view.tool ? { tool: shortToolName(view.tool) } : {}),
  })
}
