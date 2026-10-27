// ~/Downloads 直下そのもの（サブディレクトリは対象外）
const DOWNLOADS = /^(\/Users|\/home)\/[^/]+\/Downloads\/?$/

export const isDownloads = (cwd: string): boolean => DOWNLOADS.test(cwd)

export const reason = (cwd: string): string =>
  `downloads-guard: 作業ディレクトリが ${cwd} です。~/Downloads ではセッションを開始できません。別のディレクトリで claude を起動し直してください。`
