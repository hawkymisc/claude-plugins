"""clawd-mods の全アニメーションを GIF に書き出す。

usage: uv run --with pillow python -I sprites/export_gif.py <out_dir>
出力: <name>.gif (11 個) と、全部を並べた all.gif
"""

import sys
from math import lcm
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
import gen  # noqa: E402  (同じフォルダの生成器。sys.path 追加後に読む)

SCALE = 10
PAD = 2  # ドット単位の余白
BG = (24, 24, 27)
LABEL_H = 22
LOOP_MS = 4800


def rgb(hexcolor: str) -> tuple[int, int, int]:
    return tuple(int(hexcolor[i : i + 2], 16) for i in (1, 3, 5))


def render(frame: list[str], scale: int = SCALE) -> Image.Image:
    w, h = (gen.W + PAD * 2) * scale, (gen.H + PAD * 2) * scale
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    for y, row in enumerate(frame):
        for x, ch in enumerate(row):
            c = gen.PALETTE[ch]
            if c:
                x0, y0 = (x + PAD) * scale, (y + PAD) * scale
                d.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], fill=rgb(gen.COLORS[c]))
    return img


def save(frames: list[Image.Image], durations: list[int], path: Path) -> None:
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=2)


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    anims = gen.frames()
    for name, a in anims.items():
        imgs = [render(f) for f in a["frames"]]
        save(imgs, [a["ms"]] * len(imgs), out / f"{name}.gif")

    # 一覧: 4 列グリッド、50ms 刻みで各アニメを自分の ms で進める
    names = list(anims)
    cols, scale = 4, 6
    cell = render(anims[names[0]]["frames"][0], scale)
    cw, ch = cell.width, cell.height + LABEL_H
    rows = -(-len(names) // cols)
    tick = 50
    # 全周期の最小公倍数は 252s と長すぎるので、一覧は 4.8s で切って繰り返す
    period = min(LOOP_MS, lcm(*(a["ms"] * len(a["frames"]) for a in anims.values())))
    sheets = []
    for t in range(0, period, tick):
        sheet = Image.new("RGB", (cw * cols, ch * rows), BG)
        d = ImageDraw.Draw(sheet)
        for i, name in enumerate(names):
            a = anims[name]
            f = a["frames"][(t // a["ms"]) % len(a["frames"])]
            x, y = (i % cols) * cw, (i // cols) * ch
            sheet.paste(render(f, scale), (x, y))
            d.text((x + 8, y + cell.height + 4), name, fill=(220, 220, 220))
        sheets.append(sheet)
    save(sheets, [tick] * len(sheets), out / "all.gif")
    print(f"ok: {len(names)} gifs + all.gif ({len(sheets)} frames, {period} ms loop) -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
