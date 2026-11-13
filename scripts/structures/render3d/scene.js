// The glossy molecule: pearl-white carbons and bonds, green for every atom that is not carbon, on a clear ground.
// Positions come from export3d.py in angstrom (x right, y up, z toward the viewer). Nothing here moves an atom.
import * as THREE from 'three';

const SIZE = 1024; // the picture written to disk
const OVERSAMPLE = 2; // drawn at twice the size, then reduced: smooth edges
const FOV = 26;
const MAX_PX_PER_ANGSTROM = 118; // a five-atom molecule does not fill the whole square

const ATOM = 0.42; // radius of a carbon, in angstrom
const HETERO = 0.46; // radius of any other atom
const BOND = 0.235; // radius of a bond
const SECOND = 0.12; // radius of the second bar of a double bond in a ring
const PAIR = 0.135; // radius of each bar of a double bond in a chain, drawn as two side by side
const CAP = 0.42; // how far the rounded end of a chain reaches past its last atom
const MIN_ATOM_PX = 13; // on a large molecule an atom is few pixels: it is thickened to stay readable,
const MAX_THICKEN = 1.6; // but never so much that neighbouring atoms merge

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE * OVERSAMPLE, SIZE * OVERSAMPLE, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// What the glossy surfaces mirror: a pale room, a warm cream-gold floor, and three soft lamps. The room keeps the lit
// side white, the floor colours the shade underneath (the shade is warm, never grey), the lamps give the streaks of light.
function studio() {
  const room = new THREE.Scene();
  const wall = (color, w, h, pos, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look); room.add(m);
  };
  room.background = new THREE.Color(0xe4e1d8);
  wall(new THREE.Color(0xc79a4e), 60, 60, [0, -12, 0], [0, 0, 0]); // floor: the colour of the shade
  wall(new THREE.Color(0xffffff).multiplyScalar(22), 10, 6, [-9, 11, 9], [0, 0, 0]); // key lamp, upper left
  wall(new THREE.Color(0xffffff).multiplyScalar(7), 5, 9, [12, 4, 7], [0, 0, 0]); // side lamp, right
  wall(new THREE.Color(0xfff3d6).multiplyScalar(3), 14, 3, [0, 13, -6], [0, 0, 0]); // warm strip above and behind
  return new THREE.PMREMGenerator(renderer).fromScene(room, 0.02).texture;
}
scene.environment = studio();
scene.environmentIntensity = 0.8;

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 500);
// Warm light from the upper left, as on the cream tile it sits on; a soft cool fill from the lower right.
const key = new THREE.DirectionalLight(0xfffaf2, 1.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 12;
key.shadow.intensity = 0.55; // soft, never black
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0xffe2ad, 0.3);
scene.add(fill, fill.target);
scene.add(new THREE.HemisphereLight(0xffffff, 0xe0b566, 0.34));

// Pearl: a soft white that mirrors the cream room, shades to a warm grey underneath and carries clear streaks of light.
const PEARL = new THREE.MeshPhysicalMaterial({ color: 0xf8f8f6, roughness: 0.24, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
// Leaf: the site's green as a jelly. A clear glossy skin over a paler core, so light seems to pass through it.
const LEAF_SKIN = new THREE.MeshPhysicalMaterial({ color: 0x2fa628, roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, transparent: true, opacity: 0.74 });
const LEAF_CORE = new THREE.MeshStandardMaterial({ color: 0xb4f3a0, roughness: 0.6, metalness: 0, emissive: 0x8fe57a, emissiveIntensity: 0.45 });

const UP = new THREE.Vector3(0, 1, 0);
const TOWARD_VIEWER = new THREE.Vector3(0, 0, 1);
const group = new THREE.Group();
scene.add(group);

function capsule(from, to, radius, material) {
  const axis = new THREE.Vector3().subVectors(to, from);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, axis.length(), 10, 28), material);
  mesh.position.copy(from).addScaledVector(axis, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, axis.clone().normalize());
  return mesh;
}
function ball(at, radius, material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 28), material);
  mesh.position.copy(at);
  return mesh;
}

/** The side on which the second bar of a double bond lies: inside its ring, else in the plane of the neighbouring bonds. */
function sideOf(mol, bond, P) {
  const a = P[bond.a], b = P[bond.b];
  const along = new THREE.Vector3().subVectors(b, a).normalize();
  const flatten = (v) => v.addScaledVector(along, -v.dot(along));
  if (bond.ring) {
    const centre = bond.ring.reduce((s, i) => s.add(P[i]), new THREE.Vector3()).multiplyScalar(1 / bond.ring.length);
    const v = flatten(centre.sub(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)));
    if (v.lengthSq() > 1e-6) return v.normalize();
  }
  for (const other of mol.bonds) {
    if (other === bond) continue;
    const shared = [bond.a, bond.b].find((i) => i === other.a || i === other.b);
    if (shared === undefined) continue;
    const far = other.a === shared ? other.b : other.a;
    const v = flatten(new THREE.Vector3().subVectors(P[far], P[shared]));
    if (v.lengthSq() > 1e-3) return v.normalize().negate();
  }
  const v = new THREE.Vector3().crossVectors(along, TOWARD_VIEWER);
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, 1, 0);
}

function build(mol, P, k) {
  for (const child of [...group.children]) { child.geometry.dispose(); group.remove(child); }
  const hetero = mol.atoms.map((a) => a.el !== 'C');
  for (const bond of mol.bonds) {
    const a = P[bond.a], b = P[bond.b];
    if (bond.order === 2 && !bond.ring) {
      // A double bond in a chain: two bars side by side.
      const side = sideOf(mol, bond, P);
      for (const sign of [1, -1]) group.add(capsule(a.clone().addScaledVector(side, sign * 0.19 * k), b.clone().addScaledVector(side, sign * 0.19 * k), PAIR * k, PEARL));
      continue;
    }
    group.add(capsule(a, b, BOND * k, PEARL));
    if (bond.order >= 2) {
      // In a ring the second bar floats inside the ring; a triple bond gets a bar on each side.
      const side = sideOf(mol, bond, P);
      for (const sign of bond.order === 2 ? [1] : [1, -1]) {
        const from = a.clone().lerp(b, 0.24).addScaledVector(side, sign * 0.45);
        const to = b.clone().lerp(a, 0.24).addScaledVector(side, sign * 0.45);
        group.add(capsule(from, to, SECOND * k, PEARL));
      }
    }
  }
  const add = (make, isHetero) => {
    if (!isHetero) return group.add(make(1, PEARL));
    const core = make(0.66, LEAF_CORE);
    const skin = make(1, LEAF_SKIN);
    skin.renderOrder = 2; // drawn after the core it covers
    group.add(core, skin);
  };
  mol.atoms.forEach((atom, i) => {
    const radius = (hetero[i] ? HETERO : ATOM) * k;
    const only = atom.bonds === 1 ? mol.bonds.find((bd) => bd.a === i || bd.b === i) : null;
    if (only) {
      // The end of a chain is a rounded pill pointing away from the molecule.
      const outward = new THREE.Vector3().subVectors(P[i], P[only.a === i ? only.b : only.a]).normalize();
      add((k2, material) => capsule(P[i].clone().addScaledVector(outward, -0.08), P[i].clone().addScaledVector(outward, CAP), radius * k2, material), hetero[i]);
    } else {
      add((k2, material) => ball(P[i], radius * k2, material), hetero[i]);
    }
  });
  for (const mesh of group.children) { mesh.castShadow = mesh.material !== LEAF_CORE; mesh.receiveShadow = mesh.material === PEARL; }
}

/** Stand the camera straight in front, as near as keeps every atom inside the square with a margin. */
function frame(P) {
  const box = new THREE.Box3().setFromPoints(P);
  const centre = box.getCenter(new THREE.Vector3());
  const reach = Math.max(...P.map((p) => p.distanceTo(centre))) + 1.2;
  const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const edge = t * 0.86;
  const margin = 0.8;
  const fits = (d) => P.every((p) => {
    const depth = d - (p.z - centre.z);
    return depth > 0.5 && (Math.abs(p.x - centre.x) + margin) / depth <= edge && (Math.abs(p.y - centre.y) + margin) / depth <= edge;
  });
  let near = reach * 0.6, far = reach * 14;
  for (let i = 0; i < 40; i++) { const mid = (near + far) / 2; if (fits(mid)) far = mid; else near = mid; }
  const distance = Math.max(far, SIZE / 2 / (MAX_PX_PER_ANGSTROM * t));
  camera.position.set(centre.x, centre.y, centre.z + distance);
  camera.lookAt(centre);
  camera.near = Math.max(0.1, distance - reach - 2);
  camera.far = distance + reach + 2;
  camera.updateProjectionMatrix();
  key.position.set(centre.x - reach * 0.9, centre.y + reach * 1.3, centre.z + reach * 1.7);
  key.target.position.copy(centre);
  const s = key.shadow.camera;
  s.left = s.bottom = -reach - 1; s.right = s.top = reach + 1; s.near = 0.1; s.far = reach * 6; s.updateProjectionMatrix();
  fill.position.set(centre.x + reach, centre.y - reach * 0.6, centre.z + reach);
  fill.target.position.copy(centre);
  return SIZE / 2 / (distance * t); // pixels per angstrom at the molecule's centre
}

const small = document.createElement('canvas');
small.width = small.height = SIZE;
const pen = small.getContext('2d');
pen.imageSmoothingQuality = 'high';

/** Draw one molecule and return it as a WebP picture (a data address) with a clear ground. */
window.renderMolecule = (mol) => {
  const P = mol.atoms.map((a) => new THREE.Vector3(...a.p));
  const pxPerAngstrom = frame(P);
  build(mol, P, Math.min(MAX_THICKEN, Math.max(1, MIN_ATOM_PX / (ATOM * pxPerAngstrom))));
  renderer.render(scene, camera);
  pen.clearRect(0, 0, SIZE, SIZE);
  pen.drawImage(canvas, 0, 0, SIZE, SIZE);
  return small.toDataURL('image/webp', 0.92);
};
window.sceneReady = true;
