"""The picture of every mineral page: one capsule, in the palette and outline of the molecule pictures.

A mineral is a single atom, so it has no molecule to draw; its pages share this capsule instead.

Usage: python3 capsule.py out.svg
"""
import sys

INK, WHITE, MINT, MINT_DEEP = '#8d979c', '#ffffff', '#8fdc88', '#74c96d'
S = 1024
TILT = -32  # degrees: the capsule lies on the diagonal, like the long molecules


def edge(d: str, w: float = 9.0) -> str:
    """A shell edge, drawn like the tubes of the molecule pictures: white with a thin grey outline."""
    return (f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="{w + 3.6}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{d}" fill="none" stroke="{WHITE}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>')


def shine(x1: float, x2: float, y: float, w: float = 24, o: float = .85) -> str:
    return f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{WHITE}" stroke-opacity="{o}" stroke-width="{w}" stroke-linecap="round"/>'


def svg() -> str:
    r, half = 172, 452  # body radius and half length
    rc, seam = 181, -28  # the cap is a little wider than the body it slides over, and ends just left of the middle
    body = f'M {-half + r},{-r} L {half - r},{-r} A {r} {r} 0 0 1 {half - r},{r} L {-half + r},{r} A {r} {r} 0 0 1 {-half + r},{-r} Z'
    cap = f'M {seam},{-rc} L {-half + rc},{-rc} A {rc} {rc} 0 0 0 {-half + rc},{rc} L {seam},{rc}'
    rim = f'M {seam},{-rc} A 34 {rc} 0 0 1 {seam},{rc}'
    defs = (
        f'<linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{WHITE}"/><stop offset=".5" stop-color="{WHITE}"/><stop offset="1" stop-color="#dde3e4"/></linearGradient>'
        f'<linearGradient id="cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8f5d4"/><stop offset=".4" stop-color="{MINT}"/><stop offset="1" stop-color="{MINT_DEEP}"/></linearGradient>'
    )
    parts = [
        f'<path d="{body}" fill="url(#body)"/>',
        edge(body),
        f'<path d="{cap} A 34 {rc} 0 0 0 {seam},{-rc} Z" fill="url(#cap)"/>',
        shine(-half + 120, seam - 60, -108),
        edge(cap),
        edge(rim),
    ]
    return '\n'.join([f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">', f'<defs>{defs}</defs>', f'<g transform="translate(512 512) rotate({TILT})">', *parts, '</g>', '</svg>'])


if __name__ == '__main__':
    open(sys.argv[1], 'w').write(svg())
    print('written', sys.argv[1])
