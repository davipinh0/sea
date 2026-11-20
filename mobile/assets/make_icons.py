"""Desenha o logo do SEA nas imagens do app (icon.png, adaptive-icon.png e splash.png). Só
biblioteca padrão. Rodar nesta pasta: python make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

ORANGE = (0xF2, 0x65, 0x22)
WHITE = (255, 255, 255)
SS = 3

BACKGROUND = (1, 1, 30, 30, 5)
STROKE = 1.8


def _line(x1, y1, x2, y2):
    half = STROKE / 2
    return (min(x1, x2) - half, min(y1, y2) - half,
            abs(x2 - x1) + STROKE, abs(y2 - y1) + STROKE, half)


SHELF = [
    _line(7, 5.5, 7, 26.5), _line(25, 5.5, 25, 26.5),
    _line(7, 10.5, 25, 10.5), _line(7, 16, 25, 16), _line(7, 21.5, 25, 21.5), _line(7, 26.5, 25, 26.5),
    (9.5, 17.6, 5, 3, 0.6), (16, 12.1, 6.5, 3, 0.6),
]
FAINT_BOX = [(9.5, 23.1, 4, 2.6, 0.6)]


class Canvas:
    def __init__(self, width, height, color=None):
        self.width, self.height = width, height
        pixel = bytes((*color, 255)) if color else bytes(4)
        self.rows = [bytearray(pixel * width) for _ in range(height)]

    def draw(self, shapes, color, opacity, scale, dx, dy):
        top = max(0, int(min(s[1] for s in shapes) * scale + dy) - 1)
        bottom = min(self.height, int(max(s[1] + s[3] for s in shapes) * scale + dy) + 2)
        for py in range(top, bottom):
            cover = {}
            for sub in range(SS):
                y = (py + (sub + 0.5) / SS - dy) / scale
                taken = set()
                for (x0, y0, w, h, r) in shapes:
                    if not y0 <= y <= y0 + h:
                        continue
                    inset = 0.0
                    if y < y0 + r:
                        inset = r - math.sqrt(max(0.0, r * r - (y0 + r - y) ** 2))
                    elif y > y0 + h - r:
                        inset = r - math.sqrt(max(0.0, r * r - (y - (y0 + h - r)) ** 2))
                    a = round(((x0 + inset) * scale + dx) * SS)
                    b = round(((x0 + w - inset) * scale + dx) * SS)
                    taken.update(range(max(0, a), min(self.width * SS, b)))
                for sx in taken:
                    cover[sx // SS] = cover.get(sx // SS, 0) + 1
            row = self.rows[py]
            for px, count in cover.items():
                alpha = opacity * count / (SS * SS)
                i = px * 4
                back = row[i + 3] / 255
                out = alpha + back * (1 - alpha)
                for c in range(3):
                    row[i + c] = round((color[c] * alpha + row[i + c] * back * (1 - alpha)) / out)
                row[i + 3] = round(out * 255)

    def mark(self, size, left, top, background=True):
        scale = size / 32
        if background:
            self.draw([BACKGROUND], ORANGE, 1.0, scale, left, top)
        self.draw(SHELF, WHITE, 1.0, scale, left, top)
        self.draw(FAINT_BOX, WHITE, 0.75, scale, left, top)

    def save(self, path):
        def chunk(kind, data):
            body = kind + data
            return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

        raw = b"".join(b"\x00" + bytes(row) for row in self.rows)
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 6, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
        Path(path).write_bytes(png)


def main():
    here = Path(__file__).parent

    icon = Canvas(1024, 1024, ORANGE)
    icon.mark(1024 * 32 / 30, -1024 / 30, -1024 / 30, background=False)
    icon.save(here / "icon.png")

    # Ícone adaptável: a prateleira dentro da área segura; o laranja vem do backgroundColor do
    # app.json.
    adaptive = Canvas(1024, 1024)
    adaptive.mark(620, (1024 - 620) / 2, (1024 - 620) / 2, background=False)
    adaptive.save(here / "adaptive-icon.png")

    splash = Canvas(924, 2000, WHITE)
    splash.mark(420, (924 - 420) / 2, (2000 - 420) / 2)
    splash.save(here / "splash.png")
    print("icon.png, adaptive-icon.png, splash.png")


if __name__ == "__main__":
    main()
