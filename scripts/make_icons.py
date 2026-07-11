#!/usr/bin/env python3
"""Generate the BULWORK MODE extension icons (yellow running-bond brick wall, full-bleed) from
extension/icons/bulwork.svg. Prefers cairosvg (exact SVG render); falls back to drawing with Pillow.
Writes icon16/32/48/128.png into extension/icons/.  Run: python3 scripts/make_icons.py"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "..", "extension", "icons")
SVG = os.path.join(ICONS, "bulwork.svg")
SIZES = (16, 32, 48, 128)

# Design constants (in the 128-unit viewBox), kept in sync with bulwork.svg.
MORTAR = (230, 168, 54, 255)   # #E6A836
BRICK = (251, 217, 98, 255)    # #FBD962
OUTLINE = (236, 192, 76, 255)  # #ECC04C
YS = [-9, 13, 35, 57, 79, 101, 123]
EVEN_XS = [-21, 25, 71, 117]
ODD_XS = [-44, 2, 48, 94]


def via_cairosvg():
    import cairosvg
    for sz in SIZES:
        cairosvg.svg2png(url=SVG, write_to=os.path.join(ICONS, f"icon{sz}.png"),
                         output_width=sz, output_height=sz)
    return "cairosvg"


def via_pil():
    from PIL import Image, ImageDraw
    S = 512  # supersample, then downscale for clean edges

    def draw(sz):
        k = sz / 128.0
        img = Image.new("RGBA", (sz, sz), MORTAR)
        d = ImageDraw.Draw(img)
        bw, bh, rx = 42 * k, 18 * k, 2.5 * k
        ow = max(1, round(1.2 * k))
        for i, yc in enumerate(YS):
            xs = EVEN_XS if i % 2 == 0 else ODD_XS
            y = yc * k
            for xc in xs:
                x = xc * k
                d.rounded_rectangle([x, y, x + bw, y + bh], radius=rx,
                                    fill=BRICK, outline=OUTLINE, width=ow)
        return img

    for sz in SIZES:
        draw(S).resize((sz, sz), Image.LANCZOS).save(os.path.join(ICONS, f"icon{sz}.png"))
    return "pillow"


def main():
    os.makedirs(ICONS, exist_ok=True)
    for fn in (via_cairosvg, via_pil):
        try:
            print("generated icons via", fn())
            return 0
        except Exception as e:
            print(f"{fn.__name__} unavailable: {e}", file=sys.stderr)
    print("ERROR: need cairosvg or pillow (pip install pillow)", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
