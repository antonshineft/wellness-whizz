"""Draw a molecule as an outlined stick figure in the site's palette, from exact structure data (a SMILES string).

Usage: python3 outline_mol.py "<SMILES>" out.svg
Every bond is a white tube with a thin dark outline. Where a bond ends at an atom other than carbon (oxygen,
nitrogen, sulfur ...) the tube fades from white into mint toward that atom. Nothing is drawn that the data does not hold.
"""
import math
import sys

from rdkit import Chem
from rdkit.Chem import AllChem

# The outline is a softened grey of the site's ink, so the figure reads as drawn rather than printed.
INK, WHITE, MINT, CREAM = '#8d979c', '#ffffff', '#8fdc88', '#fdf1cf'
S, PAD = 1024, 120


def svg_for(smiles: str, background: str | None = None) -> str:
    """`background` None leaves the image transparent, so it takes the colour of whatever card it sits on."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError('not a valid structure')
    # A chloride counter-ion is how the database stores some pigments; it is not part of the compound shown.
    frags = [f for f in Chem.GetMolFrags(mol, asMols=True) if not (f.GetNumAtoms() == 1 and f.GetAtomWithIdx(0).GetSymbol() in ('Cl', 'Br'))]
    if frags and len(frags) < len(Chem.GetMolFrags(mol)):
        merged = frags[0]
        for f in frags[1:]:
            merged = Chem.CombineMols(merged, f)
        mol = merged
    AllChem.Compute2DCoords(mol)
    conf = mol.GetConformer()
    raw = [(conf.GetAtomPosition(i).x, -conf.GetAtomPosition(i).y) for i in range(mol.GetNumAtoms())]
    # A long chain laid out flat would be a hairline across the square: turn it onto the diagonal, where it has
    # the most room. The molecule is only rotated, never reshaped.
    n = len(raw)
    if n > 2:
        mx, my = sum(p[0] for p in raw) / n, sum(p[1] for p in raw) / n
        sxx = sum((p[0] - mx) ** 2 for p in raw); syy = sum((p[1] - my) ** 2 for p in raw); sxy = sum((p[0] - mx) * (p[1] - my) for p in raw)
        theta = 0.5 * math.atan2(2 * sxy, sxx - syy)
        c, sn = math.cos(-theta), math.sin(-theta)
        flat = [((p[0] - mx) * c - (p[1] - my) * sn, (p[0] - mx) * sn + (p[1] - my) * c) for p in raw]
        span_x = max(p[0] for p in flat) - min(p[0] for p in flat); span_y = max(p[1] for p in flat) - min(p[1] for p in flat)
        if span_x > 2.6 * max(span_y, 1e-6):
            a = math.radians(-38)
            raw = [(p[0] * math.cos(a) - p[1] * math.sin(a), p[0] * math.sin(a) + p[1] * math.cos(a)) for p in flat]
    xs, ys = [p[0] for p in raw], [p[1] for p in raw]
    scale = min((S - 2 * PAD) / max(1e-6, max(xs) - min(xs)), (S - 2 * PAD) / max(1e-6, max(ys) - min(ys)), 150)
    # Tubes get thinner as the molecule gets larger, so big structures stay legible.
    W = max(4.0, min(13.6, scale * 0.105))
    O = max(0.9, min(1.9, W * 0.14))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    pts = [((x - cx) * scale + S / 2, (y - cy) * scale + S / 2) for x, y in raw]
    kek = Chem.Mol(mol)
    Chem.Kekulize(kek, clearAromaticFlags=True)
    rings = kek.GetRingInfo().AtomRings()

    def ring_centre(a, b):
        for ring in rings:
            if a in ring and b in ring:
                return sum(pts[i][0] for i in ring) / len(ring), sum(pts[i][1] for i in ring) / len(ring)
        return None

    tubes = []  # (x1, y1, x2, y2, hetero at start, hetero at end)
    for bond in kek.GetBonds():
        a, b = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        ha, hb = kek.GetAtomWithIdx(a).GetSymbol() != 'C', kek.GetAtomWithIdx(b).GetSymbol() != 'C'
        tubes.append((x1, y1, x2, y2, ha, hb))
        if bond.GetBondTypeAsDouble() >= 2:
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy)
            nx, ny = -dy / length, dx / length
            centre = ring_centre(a, b)
            if centre and ((centre[0] - (x1 + x2) / 2) * nx + (centre[1] - (y1 + y2) / 2) * ny) < 0:
                nx, ny = -nx, -ny
            trim, off = (0.16 if centre else 0.04), W * 1.75
            tubes.append((x1 + dx * trim + nx * off, y1 + dy * trim + ny * off, x2 - dx * trim + nx * off, y2 - dy * trim + ny * off, ha, hb))
            if bond.GetBondTypeAsDouble() == 3:
                tubes.append((x1 + dx * trim - nx * off, y1 + dy * trim - ny * off, x2 - dx * trim - nx * off, y2 - dy * trim - ny * off, ha, hb))

    # No glow or background in the image itself: the card it sits on supplies both, so the edges never show.
    defs = []
    under, over = [], []
    for i, (x1, y1, x2, y2, ha, hb) in enumerate(tubes):
        geo = f'x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"'
        under.append(f'<line {geo} stroke="{INK}" stroke-width="{W + 2 * O:.1f}" stroke-linecap="round"/>')
        if ha or hb:
            # White on the carbon side, fading into mint toward the other atom; both ends mint when both are not carbon.
            if ha and hb:
                stops = f'<stop offset="0" stop-color="{MINT}"/><stop offset="1" stop-color="{MINT}"/>'
            elif hb:
                stops = f'<stop offset="0" stop-color="{WHITE}"/><stop offset=".15" stop-color="{WHITE}"/><stop offset=".9" stop-color="{MINT}"/><stop offset="1" stop-color="{MINT}"/>'
            else:
                stops = f'<stop offset="0" stop-color="{MINT}"/><stop offset=".1" stop-color="{MINT}"/><stop offset=".85" stop-color="{WHITE}"/><stop offset="1" stop-color="{WHITE}"/>'
            defs.append(f'<linearGradient id="b{i}" gradientUnits="userSpaceOnUse" {geo}>{stops}</linearGradient>')
            over.append(f'<line {geo} stroke="url(#b{i})" stroke-width="{W}" stroke-linecap="round"/>')
        else:
            over.append(f'<line {geo} stroke="{WHITE}" stroke-width="{W}" stroke-linecap="round"/>')
    # An atom with no bonds (the metal of a mineral salt) is a small mint bead.
    for atom in kek.GetAtoms():
        if atom.GetDegree() == 0:
            x, y = pts[atom.GetIdx()]
            r = max(W * 1.05, 7)
            under.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r + O:.1f}" fill="{INK}"/>')
            over.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{MINT}"/>')
    # Plain white tubes first, tinted ones last, so a fade is never covered by a neighbour's round cap.
    over.sort(key=lambda s: 'url(' in s)
    return '\n'.join([
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">',
        '<defs>' + ''.join(defs) + '</defs>',
        *([f'<rect width="{S}" height="{S}" fill="{background}"/>'] if background else []),
        *under, *over, '</svg>',
    ])


if __name__ == '__main__':
    open(sys.argv[2], 'w').write(svg_for(sys.argv[1], sys.argv[3] if len(sys.argv) > 3 else None))
    print('written', sys.argv[2])
