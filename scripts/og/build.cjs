// Draws the share image (Open Graph, 1200×630) of every supplement page into public/images/og/<slug>.jpg.
//
//   curl -s https://aiww.io/api/supplements > /tmp/supplements.json
//   node scripts/og/build.cjs /tmp/supplements.json [--out <dir>] [<slug> ...]
//
// The layout is the owner's Figma frame (card.html). Each card carries the page's name, a short line from its summary
// and its molecule: the glossy 3D picture where there is one, the flat drawing or the mineral cell otherwise. A page
// with no picture of its own gets no card and keeps the share image it had. The list of pages that have a card is
// written to src/og.ts, which the site reads (src/render/supplement.ts).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : path.join(ROOT, 'public', 'images', 'og');
const rest = args.filter((a, i) => !a.startsWith('--') && (outFlag < 0 || i !== outFlag + 1));
const listFile = rest.find((a) => a.endsWith('.json'));
const only = new Set(rest.filter((a) => !a.endsWith('.json')));
const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const LINE_MAX = 96; // what three lines of the card hold

/** The summary as one short line: its first sentence, cut at a comma or a joining word when it is still too long. */
function shortLine(summary) {
  let s = String(summary || '').replace(/\s+/g, ' ').trim();
  const stop = s.search(/[.!?](\s|$)/);
  if (stop > 40) s = s.slice(0, stop + 1);
  if (s.length <= LINE_MAX) return s;
  const cut = s.lastIndexOf(', ', LINE_MAX);
  if (cut > 50) return s.slice(0, cut).replace(/,?\s+(and|or|with|while|but|which|that)$/i, '') + '.';
  // No comma to cut at: end before the last joining word that still leaves a whole thought ("... and reduce inflammation").
  const joins = [' with ', ' while ', ' which ', ' and ', ' for ', ' by ', ' through '].map((w) => s.lastIndexOf(w, LINE_MAX)).filter((i) => i > 50);
  if (joins.length) return s.slice(0, Math.max(...joins)) + '.';
  return s; // the card clamps it to three lines
}

(async () => {
  if (!listFile) throw new Error('give the list of supplements: a JSON file saved from /api/supplements');
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8')).filter((s) => !only.size || only.has(s.slug));
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('card error:', e.message); process.exitCode = 1; });
  // Everything is read from disk under a made-up address; nothing is fetched from the network.
  await page.route('http://og.local/**', (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = p === '/' ? path.join(HERE, 'card.html')
      : p.startsWith('/fonts/') ? path.join(ROOT, 'node_modules', '@fontsource', 'dm-sans', 'files', p.slice(7))
        : p.startsWith('/public/') ? path.join(ROOT, p.slice(1)) : '';
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('http://og.local/');
  await page.waitForFunction('window.cardReady === true', null, { timeout: 60000 });
  const card = await page.$('#og');
  const made = [], without = [], shrunk = [], clipped = [];
  for (const s of list) {
    const glossy = path.join(ROOT, 'public', 'images', 'structures-3d', `${s.slug}.webp`);
    const flat = path.join(ROOT, 'public', 'images', 'structures', `${s.slug}.svg`);
    const picture = fs.existsSync(glossy) ? `/public/images/structures-3d/${s.slug}.webp` : fs.existsSync(flat) ? `/public/images/structures/${s.slug}.svg` : '';
    if (!picture) { without.push(s.slug); continue; }
    const size = await page.evaluate((c) => window.setCard(c), { name: s.name, line: shortLine(s.summary), picture, flat: !picture.endsWith('.webp') });
    if (size < 64) shrunk.push(`${s.slug} (${size}px)`);
    if (await page.evaluate(() => { const l = document.getElementById('line'); return l.scrollHeight > l.clientHeight + 1; })) clipped.push(s.slug);
    await card.screenshot({ path: path.join(OUT, `${s.slug}.jpg`), type: 'jpeg', quality: 88 });
    made.push(s.slug);
  }
  await browser.close();
  console.log(`${made.length} cards in ${OUT}`);
  if (shrunk.length) console.log('name set smaller to fit:', shrunk.join(', '));
  if (clipped.length) console.log('line cut short with dots:', clipped.join(', '));
  if (without.length) console.log('no picture, no card:', without.join(', '));
  if (outFlag < 0 && !only.size) {
    const have = fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4)).sort();
    fs.writeFileSync(path.join(ROOT, 'src', 'og.ts'), `/**
 * Supplement pages that have a share image of their own (public/images/og/<slug>.jpg, 1200×630).
 * Generated by scripts/og/build.cjs; do not edit. A page not listed keeps the share image it had.
 */
export const OG_IMAGES: ReadonlySet<string> = new Set(${JSON.stringify(have, null, 1)});
`);
    console.log(`${have.length} pages listed in src/og.ts`);
  }
})().catch((err) => { console.error(err); process.exit(1); });
