import type { Register } from 'claude-code'
import { isDownloads, reason } from './guard'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (isDownloads(e.cwd)) {
      $.ui.toast(reason(e.cwd))
      $.ui.status('⛔ ~/Downloads: session blocked')
    }
    return next(e)
  })

  // /cd で Downloads に入った場合もあるので、毎回現在の cwd を読む
  on('prompt.submit', async ($, e, next) => {
    const cwd = await $.session.cwd()
    if (!isDownloads(cwd)) return next(e)
    $.ui.toast(reason(cwd))
    return { drop: reason(cwd) }
  })

  on('tool.call', async ($, e, next) => {
    const cwd = await $.session.cwd()
    return isDownloads(cwd) ? { deny: reason(cwd) } : next(e)
  })
}
