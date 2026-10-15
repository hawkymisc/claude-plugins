import { ANIMS, PALETTE, SPRITE_H, SPRITE_W } from './sprites'
import type { AnimName } from './sprites'

function px(frame: number[][], x: number, y: number): number {
  return frame[y]?.[x] ?? 0
}

/** 1 フレームを横方向のランにまとめた rect 列 (SVG サイズ節約)。 */
function frameRects(frame: number[][], size: number): string {
  let out = ''
  for (let y = 0; y < SPRITE_H; y++) {
    let x = 0
    while (x < SPRITE_W) {
      const c = px(frame, x, y)
      if (c === 0) {
        x++
        continue
      }
      let end = x + 1
      while (end < SPRITE_W && px(frame, end, y) === c) end++
      out += `<rect x="${x * size}" y="${y * size}" width="${(end - x) * size}" height="${size}" fill="${PALETTE[c] ?? '#000'}"/>`
      x = end
    }
  }
  return out
}

/**
 * アニメーションを SMIL の discrete 切替で 1 枚の SVG にする。
 * Desktop の `Svg isInteractive` が自前で回すので再描画は要らない。
 */
export function animSvg(name: AnimName, size: number): string {
  const { ms, frames } = ANIMS[name]
  const n = frames.length
  const dur = `${(ms * n) / 1000}s`
  const keyTimes = Array.from({ length: n + 1 }, (_, i) => (i / n).toFixed(4)).join(';')
  const groups = frames
    .map((f, i) => {
      const values = Array.from({ length: n + 1 }, (_, k) => (k === i ? 'visible' : 'hidden')).join(';')
      const anim =
        n > 1
          ? `<animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" calcMode="discrete" dur="${dur}" repeatCount="indefinite"/>`
          : ''
      return `<g visibility="${i === 0 ? 'visible' : 'hidden'}">${anim}${frameRects(f, size)}</g>`
    })
    .join('')
  const w = SPRITE_W * size
  const h = SPRITE_H * size
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${groups}</svg>`
}

const DEFAULT = 0x01000000

function rgb(c: number): number {
  const hex = PALETTE[c]
  return c === 0 || hex === undefined ? DEFAULT : parseInt(hex.slice(1), 16)
}

/** ターミナル用: `▀` 1 セルで縦 2 ドット。SPRITE_W 列 × SPRITE_H/2 行。 */
export function rasterCells(name: AnimName, tick: number): string {
  const { frames } = ANIMS[name]
  const frame = frames[tick % frames.length] ?? []
  const words = new Uint32Array(SPRITE_W * (SPRITE_H / 2) * 3)
  let i = 0
  for (let row = 0; row < SPRITE_H / 2; row++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const top = px(frame, x, row * 2)
      const bottom = px(frame, x, row * 2 + 1)
      words[i++] = top === 0 && bottom === 0 ? 0x20 : top === 0 ? 0x2584 : 0x2580
      words[i++] = top === 0 ? rgb(bottom) : rgb(top)
      words[i++] = top === 0 ? DEFAULT : rgb(bottom)
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 標準パディング付き base64 (実行環境の toBase64 有無に依存しない)。 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

/** フレーム送り間隔: アニメの ms をターミナル tick (ms) で割った数。 */
export function tickFor(name: AnimName, elapsedMs: number): number {
  return Math.floor(elapsedMs / ANIMS[name].ms)
}

export const RASTER_COLUMNS = SPRITE_W
export const RASTER_ROWS = SPRITE_H / 2
