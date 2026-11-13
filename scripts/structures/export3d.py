"""Write the atoms and bonds of every molecule picture, in three dimensions, for the glossy renderer.

    python3 scripts/structures/export3d.py [out.json] [<slug> ...]

The shape is that of the drawings on the site (depth_mol.conformer: the structure from PubChem, built in 3D by RDKit,
hydrogens left out, turned to its widest side), seen a little more from the front. Nothing is placed by hand and nothing is drawn by an image
model. A page whose compound cannot be built in 3D (several separate ions, a metal centre) and a mineral page (a
periodic-table cell) are listed under "skipped": they keep the picture they have.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from depth_mol import conformer  # noqa: E402
from structures_map import M  # noqa: E402

# Light and shadow carry the depth here, so the molecule is turned less than in the flat drawing: rings stay open.
TILT = (-16, 12)


def molecule(smiles: str) -> dict:
    mol, pos = conformer(smiles, yaw_deg=TILT[0], pitch_deg=TILT[1])
    rings = [list(r) for r in mol.GetRingInfo().AtomRings()]
    atoms = [{'el': a.GetSymbol(), 'p': [round(float(v), 4) for v in pos[a.GetIdx()]], 'bonds': a.GetDegree()} for a in mol.GetAtoms()]
    bonds = []
    for b in mol.GetBonds():
        a, c = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        ring = next((r for r in rings if a in r and c in r), None)
        bonds.append({'a': a, 'b': c, 'order': int(round(b.GetBondTypeAsDouble())), 'ring': ring})
    return {'atoms': atoms, 'bonds': bonds}


def main() -> int:
    args = sys.argv[1:]
    out = Path(args[0]) if args and args[0].endswith('.json') else HERE / 'render3d' / 'molecules.json'
    only = set(a for a in args if not a.endswith('.json'))
    cache = json.loads((HERE / 'pubchem.json').read_text())
    done, skipped = {}, {}
    for slug, (name, kind, _note) in sorted(M.items()):
        if only and slug not in only:
            continue
        if kind == 'element':
            skipped[slug] = 'a mineral page: periodic-table cell'
            continue
        if name not in cache:
            skipped[slug] = 'not looked up yet: run build.py first'
            continue
        try:
            done[slug] = {'compound': name, **molecule(cache[name]['smiles'])}
        except ValueError as why:
            skipped[slug] = str(why)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'molecules': done, 'skipped': skipped}))
    print(f'{len(done)} molecules written to {out}; {len(skipped)} keep their picture')
    return 0


if __name__ == '__main__':
    sys.exit(main())
