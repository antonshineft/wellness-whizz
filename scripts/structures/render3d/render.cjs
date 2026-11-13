// Draws the glossy 3D picture of every molecule into public/images/structures-3d/<slug>.webp.
//
//   python3 scripts/structures/export3d.py                      # atoms and bonds, from PubChem through RDKit
//   node scripts/structures/render3d/render.cjs [--out <dir>] [<slug> ...]
//
// The scene (scene.js) runs in a headless browser with the three.js library from node_modules; no image model and no
// outside service takes part. The same molecule always gives the same picture.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..', '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : path.join(ROOT, 'public', 'images', 'structures-3d');
const only = new Set(args.filter((a, i) => !a.startsWith('--') && (outFlag < 0 || i !== outFlag + 1)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(HERE, 'molecules.json'), 'utf8'));
  const slugs = Object.keys(data.molecules).filter((s) => !only.size || only.has(s));
  fs.mkdirSync(OUT, { recursive: true });
  // Software drawing, so the result does not depend on the machine's graphics card.
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  page.on('pageerror', (e) => { console.error('scene error:', e.message); process.exitCode = 1; });
  // The page and the library are read from disk under a made-up address; nothing is fetched from the network.
  await page.route('http://render.local/**', (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.startsWith('/three/') ? path.join(ROOT, 'node_modules', 'three', url.pathname.slice(7)) : path.join(HERE, url.pathname === '/' ? 'scene.html' : url.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('http://render.local/');
  await page.waitForFunction('window.sceneReady === true', null, { timeout: 60000 });
  let done = 0;
  for (const slug of slugs) {
    const picture = await page.evaluate((mol) => window.renderMolecule(mol), data.molecules[slug]);
    fs.writeFileSync(path.join(OUT, `${slug}.webp`), Buffer.from(picture.split(',')[1], 'base64'));
    done++;
  }
  await browser.close();
  console.log(`${done} pictures in ${OUT}`);
})().catch((err) => { console.error(err); process.exit(1); });
