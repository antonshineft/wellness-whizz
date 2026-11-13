// Renders every board of a page to its own PNG. Usage: node render.cjs <page.html> <out dir>
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const page = path.resolve(process.argv[2] || 'boards.html');
  const out = path.resolve(process.argv[3] || 'out');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
  await p.goto('file://' + page);
  await p.waitForSelector('body[data-ready]');
  await p.waitForTimeout(400);
  for (const s of await p.$$('section.board')) {
    const id = await s.getAttribute('id');
    await s.screenshot({ path: path.join(out, id + '.png') });
  }
  await b.close();
})();
