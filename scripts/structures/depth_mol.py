"""Draw a molecule as a ball-and-stick figure with depth, in the site's palette, from exact structure data (SMILES).

Usage: python3 depth_mol.py "<SMILES>" out.svg

The shape is the molecule's real three-dimensional shape: RDKit builds conformers from the structure and relaxes them
with a force field, and the most stretched-out one is drawn, seen at an angle. Hydrogens are left out. Every carbon is
a white bead and every other atom a mint bead; a bond fades from white into mint toward an atom that is not carbon.
Parts nearer the viewer are drawn larger and pass in front of parts further away. Nothing is placed by hand.

Raises ValueError for a structure this cannot build in 3D (several separate ions, a metal centre); the caller then
keeps the flat drawing of outline_mol.py.
"""
import math
import sys

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem

INK, WHITE, MINT = '#8d979c', '#ffffff', '#8fdc88'
S = 1024
ORGANIC = {'C', 'N', 'O', 'S', 'P', 'H', 'F', 'Cl', 'Br', 'I', 'Se', 'B'}


def conformer(smiles: str, yaw_deg: float = -32, pitch_deg: float = 24):
    """Heavy atoms of the most extended relaxed conformer, widest side toward the viewer, then tilted.

    The tilt (yaw and pitch, in degrees) is what gives the flat drawing its depth; the glossy 3D picture, which has
    light and shadow for that, asks for less of it (export3d.py)."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError('not a valid structure')
    # A chloride counter-ion is how the database stores some pigments; it is not part of the compound shown.
    frags = [f for f in Chem.GetMolFrags(mol, asMols=True) if not (f.GetNumAtoms() == 1 and f.GetAtomWithIdx(0).GetSymbol() in ('Cl', 'Br'))]
    if len(frags) != 1:
        raise ValueError('several separate parts')
    mol = frags[0]
    if any(a.GetSymbol() not in ORGANIC for a in mol.GetAtoms()):
        raise ValueError('a metal centre')
    heavy = mol.GetNumAtoms()
    mol = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 7
    ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=24 if heavy <= 30 else 10, params=params))
    if not ids:
        params.useRandomCoords = True
        ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=6, params=params))
    if not ids:
        raise ValueError('no 3D shape found')
    try:
        if AllChem.MMFFHasAllMoleculeParams(mol):
            AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=1500)
        else:
            AllChem.UFFOptimizeMoleculeConfs(mol, maxIters=1500)
    except Exception:  # noqa: BLE001 - an unrelaxed conformer is still the right shape
        pass
    keep = [a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() != 'H']

    def spread(cid):
        p = mol.GetConformer(cid).GetPositions()[keep]
        return float(((p - p.mean(axis=0)) ** 2).sum())

    best = max(ids, key=spread)
    pos = np.array(mol.GetConformer(best).GetPositions())[keep]
    flat = Chem.RemoveHs(mol)
    pos -= pos.mean(axis=0)
    if len(pos) > 2:
        _, _, vt = np.linalg.svd(pos, full_matrices=False)
        if np.linalg.det(vt) < 0:  # keep the molecule's handedness: a rotation, never a mirror image
            vt[2] *= -1
        pos = pos @ vt.T  # x: longest extent, y: second, z: thinnest (toward the viewer)
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    ry = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
    rx = np.array([[1, 0, 0], [0, math.cos(pitch), -math.sin(pitch)], [0, math.sin(pitch), math.cos(pitch)]])
    pos = pos @ ry.T @ rx.T
    # A long molecule gets the diagonal of the square: it is turned, in the plane of the picture only, until its
    # long axis as seen runs from lower left to upper right.
    if len(pos) > 2:
        xy = pos[:, :2] - pos[:, :2].mean(axis=0)
        vals, vecs = np.linalg.eigh(xy.T @ xy)
        if vals[1] > 4.8 * max(vals[0], 1e-9):  # about 2.2 times longer than wide
            a = math.radians(40) - math.atan2(vecs[1, 1], vecs[0, 1])
            rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
            pos = pos @ rz.T
    kek = Chem.Mol(flat)
    Chem.Kekulize(kek, clearAromaticFlags=True)
    return kek, pos


def svg_for(smiles: str) -> str:
    mol, pos = conformer(smiles)
    n_atoms = len(pos)
    pad = 150 if n_atoms < 20 else 90
    radius = float(np.linalg.norm(pos, axis=1).max())
    dist = 2.6 * radius + 3.0  # camera distance: near enough for a visible perspective
    f = dist / (dist - pos[:, 2])
    px, py = pos[:, 0] * f, -pos[:, 1] * f
    scale = min((S - 2 * pad) / max(np.ptp(px), 1e-6), (S - 2 * pad) / max(np.ptp(py), 1e-6), 135)
    cx, cy = (px.max() + px.min()) / 2, (py.max() + py.min()) / 2

    def at(p):
        k = dist / (dist - p[2])
        return (p[0] * k - cx) * scale + S / 2, (-p[1] * k - cy) * scale + S / 2, k * scale

    scr = [at(p) for p in pos]
    hetero = [a.GetSymbol() != 'C' for a in mol.GetAtoms()]
    bonds = list(mol.GetBonds())
    # Tubes and beads are sized in angstrom, so they follow the perspective. On a large molecule an angstrom is few
    # pixels: there they keep a readable size, but never so large that neighbouring beads touch.
    mean_k = sum(k for _, _, k in scr) / n_atoms
    bond_px = (sum(math.hypot(scr[b.GetBeginAtomIdx()][0] - scr[b.GetEndAtomIdx()][0], scr[b.GetBeginAtomIdx()][1] - scr[b.GetEndAtomIdx()][1]) for b in bonds) / len(bonds)) if bonds else 1.4 * mean_k
    width = 0.17 * max(1.0, min(5.2, 0.16 * bond_px) / (0.17 * mean_k))
    bead = max(1.0, min(11.5, 0.3 * bond_px) / (0.31 * mean_k))
    out_w = 1.7 if bond_px > 40 else 1.3
    rings = mol.GetRingInfo().AtomRings()
    defs, items = [], []  # items: (z, svg); drawn from the furthest to the nearest

    def paint(a, b, n):
        if hetero[a] and hetero[b]:
            return MINT
        if not hetero[a] and not hetero[b]:
            return WHITE
        c, h = (a, b) if hetero[b] else (b, a)
        defs.append(f'<linearGradient id="g{n}" gradientUnits="userSpaceOnUse" x1="{scr[c][0]:.1f}" y1="{scr[c][1]:.1f}" x2="{scr[h][0]:.1f}" y2="{scr[h][1]:.1f}"><stop offset=".15" stop-color="{WHITE}"/><stop offset=".9" stop-color="{MINT}"/></linearGradient>')
        return f'url(#g{n})'

    def line(x1, y1, x2, y2, w, stroke, cap='butt', past=0.0):
        geo = f'x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"'
        under = f'<line {geo} stroke="{INK}" stroke-width="{w + 2 * out_w:.1f}" stroke-linecap="{cap}"/>'
        if past:  # the fill runs a little past the far end, so the two halves of one bond meet without a seam
            d = math.hypot(x2 - x1, y2 - y1) or 1
            geo = f'x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2 + (x2 - x1) / d * past:.1f}" y2="{y2 + (y2 - y1) / d * past:.1f}"'
        return under + f'<line {geo} stroke="{stroke}" stroke-width="{w:.1f}" stroke-linecap="{cap}"/>'

    for n, bond in enumerate(bonds):
        a, b = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        mid = (pos[a] + pos[b]) / 2
        mx, my, _ = at(mid)
        p = paint(a, b, n)
        # Each bond is drawn as two halves, so each half sits at the depth of its own atom.
        for end in (a, b):
            q = (pos[end] + mid) / 2
            items.append((q[2], line(scr[end][0], scr[end][1], mx, my, width * at(q)[2], p, past=1.6)))
        if bond.GetBondTypeAsDouble() >= 2:
            (x1, y1, k1), (x2, y2, k2) = scr[a], scr[b]
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy) or 1
            nx, ny = -dy / length, dx / length
            centre = next(((sum(scr[i][0] for i in r) / len(r), sum(scr[i][1] for i in r) / len(r)) for r in rings if a in r and b in r), None)
            if centre and ((centre[0] - (x1 + x2) / 2) * nx + (centre[1] - (y1 + y2) / 2) * ny) < 0:
                nx, ny = -nx, -ny
            k = (k1 + k2) / 2
            off = width * k * 2.1
            trim = .18 if centre else .1
            for sign in ((1,) if bond.GetBondTypeAsDouble() == 2 else (1, -1)):
                items.append((mid[2] - .02, line(x1 + dx * trim + sign * nx * off, y1 + dy * trim + sign * ny * off, x2 - dx * trim + sign * nx * off, y2 - dy * trim + sign * ny * off, width * k * .8, p, 'round')))
    for i, (x, y, k) in enumerate(scr):
        r = (0.40 if hetero[i] else 0.31) * k * bead
        items.append((pos[i][2], f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r + out_w:.1f}" fill="{INK}"/><circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{MINT if hetero[i] else WHITE}"/>'))
    items.sort(key=lambda t: t[0])
    return '\n'.join([f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">', '<defs>' + ''.join(defs) + '</defs>', *[s for _, s in items], '</svg>'])


if __name__ == '__main__':
    open(sys.argv[2], 'w').write(svg_for(sys.argv[1]))
    print('written', sys.argv[2])
