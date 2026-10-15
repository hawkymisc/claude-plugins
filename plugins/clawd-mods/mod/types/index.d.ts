export type Category = 'read' | 'write' | 'bash' | 'web' | 'agent' | 'other'
export type State = 'idle' | 'thinking' | 'tool' | 'done' | 'error' | 'waiting'
export type View = { state: State; category?: Category; tool?: string }
export type BleState = 'unknown' | 'connected' | 'scanning' | 'disconnected' | 'no-bridge'

declare module 'claude-code' {
  interface PluginState {
    'clawd-mods': { view: View; ble: BleState; tick: number; demo: number | null }
  }
}
