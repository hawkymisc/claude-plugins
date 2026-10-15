"""Clawd スプライト生成器。

1 つのドット定義から Mod 用 TypeScript (`sprites.ts`) と
Cardputer 用 C ヘッダ (`sprites.h`) を生成する。

usage: python3 sprites/gen.py <out_ts> <out_h>
"""

import json
import sys
from pathlib import Path

W, H = 16, 12

# パレット: 0 は透明
PALETTE = {
    ".": 0,
    "O": 1,  # オレンジ (Clawd 本体)
    "K": 2,  # 黒 (目)
    "W": 3,  # 白
    "G": 4,  # 灰 (道具)
    "B": 5,  # 青 (汗・画面)
    "Y": 6,  # 黄 (きらめき・ERROR 時の本体)
    "R": 7,  # 赤 (ERROR の汗)
}
COLORS = ["#000000", "#D97757", "#1F1F1F", "#FFFFFF", "#9A9A9A", "#5BA4E6", "#F2C94C", "#E5484D"]

BASE = [
    "................",
    "................",
    "...OOOOOOOOOO...",
    "...OOOOOOOOOO...",
    "...OOKOOOOKOO...",
    ".OOOOKOOOOKOOOO.",
    ".OOOOOOOOOOOOOO.",
    "...OOOOOOOOOO...",
    "...OOOOOOOOOO...",
    "...O.O....O.O...",
    "...O.O....O.O...",
    "................",
]


def grid(rows):
    assert len(rows) == H and all(len(r) == W for r in rows), rows
    return [list(r) for r in rows]


def to_rows(g):
    return ["".join(r) for r in g]


def shift(rows, dx=0, dy=0):
    g = [["."] * W for _ in range(H)]
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            nx, ny = x + dx, y + dy
            if c != "." and 0 <= nx < W and 0 <= ny < H:
                g[ny][nx] = c
    return to_rows(g)


def paint(rows, points):
    """points: [(x, y, char)] を上書き。"""
    g = grid(rows)
    for x, y, c in points:
        if 0 <= x < W and 0 <= y < H:
            g[y][x] = c
    return to_rows(g)


def eyes_closed(rows):
    # 目の上段を本体色に戻し、下段だけ残す (まばたき)
    return paint(rows, [(5, 4, "O"), (10, 4, "O")])


def look(rows, dx):
    pts = [(5, 4, "O"), (5, 5, "O"), (10, 4, "O"), (10, 5, "O")]
    pts += [(5 + dx, 4, "K"), (5 + dx, 5, "K"), (10 + dx, 4, "K"), (10 + dx, 5, "K")]
    return paint(rows, pts)


def arm(rows, side, pose):
    """side: 'L'|'R'。pose: 'up' | 'down'（既定位置は行5-6）。"""
    x = 1 if side == "L" else 14
    pts = [(x, 5, "."), (x, 6, ".")]
    pts += [(x, 3, "O"), (x, 4, "O")] if pose == "up" else [(x, 7, "O"), (x, 8, "O")]
    return paint(rows, pts)


def eyes_down(rows):
    """目線を下へ (上段を消して下段だけ残す)。"""
    return paint(rows, [(5, 4, "O"), (10, 4, "O")])


def read_book(b):
    """READ: 両手で開いた本を持ち、目で行を追ってページをめくる。"""
    body = eyes_down(b)

    def with_book(rows, book_rows, extra=()):
        g = grid(rows)
        for dy, r in enumerate(book_rows):
            for x, c in enumerate(r):
                if c != ".":
                    g[7 + dy][x] = c
        for x, y, c in extra:
            g[y][x] = c
        return to_rows(g)

    # 白いページ・黒い行・灰の背表紙。両端の O は本を持つ手
    book = ["..OWWWWGGWWWWO..", "...WKKWGGWKKW...", "...WWWWGGWWWW..."]
    later = ["..OWWWWGGWWWWO..", "...WKWKGGWKWK...", "...WWWWGGWWWW..."]
    look_right = paint(body, [(5, 5, "O"), (10, 5, "O"), (6, 5, "K"), (11, 5, "K")])
    f1 = with_book(body, book)
    f2 = with_book(look_right, book)
    # 右ページが立ち上がり (f3)、左へ倒れて (f4) 次のページの行になる
    f3 = with_book(body, ["..OWWWWGGWWWWO..", "...WKKWGGWWWW...", "...WWWWGGWWWW..."], [(9, 6, "W"), (10, 6, "W"), (10, 5, "W")])
    f4 = with_book(body, ["..OWWWWGGWWWWO..", "...WWWWGGWKWK...", "...WWWWGGWWWW..."], [(5, 6, "W"), (6, 6, "W"), (5, 5, "W")])
    return [f1, f2, f1, f2, f3, f4, with_book(body, later), with_book(look_right, later)]


def write_paper(b):
    """WRITE: 右手でペンを持ち、右側に置いた紙に左から右へ字を書いていく。"""
    body = shift(b, dx=-3)  # 体を左へ寄せて右側を紙のために空ける
    # 目は紙 (右下) を見る: 上段を消し、下段を 1 つ右へ
    body = paint(body, [(2, 4, "O"), (2, 5, "O"), (7, 4, "O"), (7, 5, "O"), (3, 5, "K"), (8, 5, "K")])
    body = paint(body, [(10, 5, "."), (11, 5, "."), (11, 6, ".")])  # 右腕は描き直す
    paper_x0, paper_x1 = 10, 15
    frames = []
    for hx in (11, 12, 13, 14, 15):
        g = grid(body)
        for y in (9, 10, 11):  # 紙 (右側だけ)
            for x in range(paper_x0, paper_x1 + 1):
                g[y][x] = "W"
        for x in range(paper_x0, hx):  # 書けた字 (ペン先の左側)
            g[10][x] = "K" if (x - paper_x0) % 2 == 0 else "W"
        for x in range(10, hx):  # 腕: 体の右端から横へ
            g[6][x] = "O"
        g[7][hx] = "O"   # 手
        g[8][hx] = "Y"   # ペン軸
        g[9][hx] = "Y"
        g[10][hx] = "B"  # ペン先
        frames.append(to_rows(g))
    return frames


def surf(b):
    """WEB: サーフボードに乗って波に乗る (波が流れ、体が上下にゆれる)。"""
    body_hi = shift(arm(b, "L", "up"), dy=-2)
    body_lo = shift(arm(b, "R", "up"), dy=-1)
    wave = "B..BB..BB..BB..B"
    frames = []
    for k, (body, board_y) in enumerate([(body_hi, 9), (body_lo, 10), (body_hi, 9), (body_lo, 10)]):
        g = grid(body)
        for x in range(1, 15):
            g[board_y][x] = "Y"
        g[board_y][0] = "."
        crest = wave[k:] + wave[:k]
        for x, c in enumerate(crest):
            if c == "B":
                g[11][x] = "B"
            if board_y == 9:
                g[10][x] = "B" if x % 4 == k % 4 else g[10][x]
        g[board_y - 1][15 if k % 2 else 0] = "W"  # しぶき
        frames.append(to_rows(g))
    return frames


def frames():
    b = BASE
    a = {}
    a["idle"] = {"ms": 600, "frames": [b, b, b, eyes_closed(b)]}
    dots = [(12, 0, "W"), (13, 0, "W"), (14, 0, "W")]
    a["thinking"] = {
        "ms": 300,
        "frames": [paint(look(b, -1), dots[:1]), paint(look(b, -1), dots[:2]), paint(look(b, -1), dots)],
    }
    a["read"] = {"ms": 450, "frames": read_book(b)}
    a["write"] = {"ms": 220, "frames": write_paper(b)}
    hammer_up = [(14, 0, "G"), (15, 0, "G"), (13, 0, "G"), (14, 1, "O"), (14, 2, "O")]
    hammer_dn = [(15, 7, "G"), (15, 8, "G"), (15, 9, "G"), (14, 7, "O")]
    a["bash"] = {
        "ms": 250,
        "frames": [paint(arm(b, "R", "up"), hammer_up), paint(b, hammer_dn)],
    }
    a["web"] = {"ms": 260, "frames": surf(b)}
    ghost = [(x, y, "G") for x, y in [(0, 1), (1, 1), (2, 1), (0, 2), (2, 2), (0, 3), (1, 3), (2, 3)]]
    ghost2 = [(x + 13, y, c) for x, y, c in ghost]
    a["agent"] = {"ms": 300, "frames": [paint(b, ghost), paint(b, ghost2)]}
    gear1 = [(13, 0, "G"), (15, 0, "G"), (14, 1, "G"), (13, 2, "G"), (15, 2, "G")]
    gear2 = [(14, 0, "G"), (13, 1, "G"), (15, 1, "G"), (14, 2, "G")]
    a["other"] = {"ms": 300, "frames": [paint(b, gear1), paint(b, gear2)]}
    spark = [(1, 0, "Y"), (14, 0, "Y"), (0, 2, "Y"), (15, 2, "Y")]
    a["done"] = {
        "ms": 250,
        "frames": [b, paint(shift(arm(arm(b, "L", "up"), "R", "up"), dy=-2), spark)],
    }
    sad = paint(shift(b, dy=1), [(5, 5, "O"), (10, 5, "O")])  # 目を細める
    sad = [r.replace("O", "Y") for r in sad]  # ERROR 中だけ本体を黄色 (警告色)
    a["error"] = {"ms": 500, "frames": [paint(sad, [(13, 3, "R")]), paint(sad, [(13, 4, "R")])]}
    a["waiting"] = {"ms": 300, "frames": [arm(b, "R", "up"), b]}
    for name, anim in a.items():
        for f in anim["frames"]:
            grid(f)  # サイズ検査
    return a


def encode(rows):
    return [[PALETTE[c] for c in r] for r in rows]


def write_ts(anims, path):
    data = {k: {"ms": v["ms"], "frames": [encode(f) for f in v["frames"]]} for k, v in anims.items()}
    path.write_text(
        "// 生成ファイル: sprites/gen.py から生成。直接編集しない。\n"
        f"export const SPRITE_W = {W}\nexport const SPRITE_H = {H}\n"
        f"export const PALETTE: readonly string[] = {json.dumps(COLORS)}\n"
        "export type AnimName = " + " | ".join(f"'{k}'" for k in anims) + "\n"
        "export type Anim = { ms: number; frames: number[][][] }\n"
        f"export const ANIMS: Record<AnimName, Anim> = {json.dumps(data)}\n"
    )


def rgb565(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) for i in (1, 3, 5))
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def write_h(anims, path):
    out = ["// 生成ファイル: sprites/gen.py から生成。直接編集しない。", "#pragma once", "#include <stdint.h>",
           f"#define SPRITE_W {W}", f"#define SPRITE_H {H}",
           "static const uint16_t PALETTE565[] = {" + ", ".join(f"0x{rgb565(c):04X}" for c in COLORS) + "};",
           "struct Anim { uint16_t ms; uint8_t count; const uint8_t (*frames)[SPRITE_H][SPRITE_W]; };"]
    names = list(anims)
    for k in names:
        fs = anims[k]["frames"]
        body = ",\n".join("  {" + ",".join("{" + ",".join(map(str, r)) + "}" for r in encode(f)) + "}" for f in fs)
        out.append(f"static const uint8_t ANIM_{k.upper()}[{len(fs)}][SPRITE_H][SPRITE_W] = {{\n{body}\n}};")
    out.append("enum AnimId { " + ", ".join(f"A_{k.upper()}" for k in names) + ", A_COUNT };")
    out.append("static const Anim ANIMS[A_COUNT] = {" + ", ".join(
        f"{{{anims[k]['ms']}, {len(anims[k]['frames'])}, ANIM_{k.upper()}}}" for k in names) + "};")
    out.append("static const char* const ANIM_NAMES[A_COUNT] = {" + ", ".join(f'"{k}"' for k in names) + "};")
    path.write_text("\n".join(out) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: gen.py <out_ts> <out_h>")
    anims = frames()
    write_ts(anims, Path(sys.argv[1]))
    write_h(anims, Path(sys.argv[2]))
    print(f"ok: {len(anims)} anims, {sum(len(a['frames']) for a in anims.values())} frames")
