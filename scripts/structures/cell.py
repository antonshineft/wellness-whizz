"""The picture of a mineral page: the element's cell of the periodic table, as a raised block whose mint side fades out.

A mineral is a single atom, so it has no molecule to draw. The cell carries the standard figures: atomic number,
symbol and standard atomic weight (IUPAC, abridged). Text is set in the site's typeface and written into the picture
as outlines, so it looks the same wherever the picture is shown.

    pip install fonttools
    python3 cell.py Mg out.svg        # or "Zn+Mg" for a page about two minerals
"""
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

INK, WHITE, MINT, TEXT, SOFT = '#8d979c', '#ffffff', '#8fdc88', '#1d272d', '#6f7a7f'
S = 1024
FONTS = Path(__file__).resolve().parent.parent.parent / 'public' / 'fonts'
# symbol: (name, atomic number, standard atomic weight)
ELEMENTS = {
    'B': ('boron', 5, '10.81'), 'Mg': ('magnesium', 12, '24.305'), 'K': ('potassium', 19, '39.098'), 'Ca': ('calcium', 20, '40.078'),
    'Cr': ('chromium', 24, '51.996'), 'Mn': ('manganese', 25, '54.938'), 'Fe': ('iron', 26, '55.845'), 'Cu': ('copper', 29, '63.546'),
    'Zn': ('zinc', 30, '65.38'), 'Se': ('selenium', 34, '78.971'), 'I': ('iodine', 53, '126.90'),
}
_fonts: dict[str, TTFont] = {}


def text(s: str, x: float, y: float, size: float, weight: str, fill: str, anchor: str = 'start', spacing: float = 0.0, fit: float = 0.0) -> str:
    """`s` as outlines of the site's typeface: baseline at y, starting at x (or ending / centred there).
    With `fit`, the text is set smaller when it would be wider than that."""
    font = _fonts.setdefault(weight, TTFont(str(FONTS / f'Aeonik-{weight}.otf')))
    glyphs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
    names = [cmap[ord(ch)] for ch in s]
    k = size / font['head'].unitsPerEm
    width = sum(hmtx[n][0] * k for n in names) + spacing * (len(names) - 1)
    if fit and width > fit:
        k, spacing, width = k * fit / width, spacing * fit / width, fit
    cx = x - (width if anchor == 'end' else width / 2 if anchor == 'middle' else 0)
    out = []
    for n in names:
        pen = SVGPathPen(glyphs)
        glyphs[n].draw(TransformPen(pen, (k, 0, 0, -k, cx, y)))
        out.append(pen.getCommands())
        cx += hmtx[n][0] * k + spacing
    return f'<path d="{" ".join(out)}" fill="{fill}"/>'


def rr(x: float, y: float, w: float, r: float) -> str:
    return f'M {x + r:.1f},{y:.1f} H {x + w - r:.1f} A {r} {r} 0 0 1 {x + w:.1f},{y + r:.1f} V {y + w - r:.1f} A {r} {r} 0 0 1 {x + w - r:.1f},{y + w:.1f} H {x + r:.1f} A {r} {r} 0 0 1 {x:.1f},{y + w - r:.1f} V {y + r:.1f} A {r} {r} 0 0 1 {x + r:.1f},{y:.1f} Z'


def block(symbol: str, x: float, y: float, s: float, tag: str) -> tuple[str, str, str]:
    """One cell with its top-left corner at (x, y) and side s: (defs, its fading side, its face)."""
    _, number, weight = ELEMENTS[symbol]
    u = s / 590  # every measure below is given for a cell 590 wide
    r, depth = 76 * u, 150 * u
    # The side of the block: the cell's shape swept down and to the right, strongest at the cell and fading to
    # nothing. Each step is one shade lighter in a mask, so the fade is even and nothing shows through twice.
    steps = int(depth // 2)
    mask = ''.join(f'<path d="{rr(x + 2 * k, y + 2 * k, s, r)}" fill="rgb({v},{v},{v})"/>' for k in range(steps, 0, -1) for v in [round(235 * (1 - k / steps) ** 1.15)])
    defs = (f'<mask id="{tag}m" maskUnits="userSpaceOnUse" x="0" y="0" width="{S}" height="{S}">{mask}</mask>'
            f'<linearGradient id="{tag}f" x1="0" y1="0" x2="1" y2="1"><stop offset=".5" stop-color="{WHITE}"/><stop offset="1" stop-color="#e6ebec"/></linearGradient>')
    face = rr(x, y, s, r)
    side = f'<rect width="{S}" height="{S}" fill="{MINT}" mask="url(#{tag}m)"/>'
    parts = [
        f'<path d="{face}" fill="url(#{tag}f)"/>',
        f'<path d="{face}" fill="none" stroke="{INK}" stroke-width="{12.6 * u:.1f}" stroke-linejoin="round"/><path d="{face}" fill="none" stroke="{WHITE}" stroke-width="{9 * u:.1f}" stroke-linejoin="round"/>',
        text(str(number), x + 60 * u, y + 124 * u, 80 * u, 'Medium', TEXT),
        text(weight, x + s - 60 * u, y + 116 * u, 50 * u, 'Regular', SOFT, 'end'),
        text(symbol, x + s / 2, y + 452 * u, 330 * u, 'Bold', TEXT, 'middle', -6 * u, fit=s - 150 * u),
    ]
    return defs, side, ''.join(parts)


def svg_for(symbols: str) -> str:
    """The picture for "Mg", or for two elements "Zn+Mg", side by side."""
    names = symbols.split('+')
    if len(names) == 1:
        cells = [(names[0], 172, 152, 590)]
    else:
        cells = [(names[0], 70, 130, 410), (names[1], 520, 470, 410)]
    defs, sides, faces = zip(*(block(sym, x, y, s, f'c{i}') for i, (sym, x, y, s) in enumerate(cells)))
    # Every fading side lies under every face, so one cell never dims the figures of another.
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">\n<defs>{"".join(defs)}</defs>\n' + '\n'.join(sides + faces) + '\n</svg>'


def describe(symbols: str) -> str:
    """For the image description: "magnesium (Mg), atomic number 12"."""
    return ' and '.join(f'{ELEMENTS[s][0]} ({s}), atomic number {ELEMENTS[s][1]}' for s in symbols.split('+'))


if __name__ == '__main__':
    open(sys.argv[2], 'w').write(svg_for(sys.argv[1]))
    print('written', sys.argv[2])
