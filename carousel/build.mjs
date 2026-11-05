// Renders one research carousel: asks the site for a job (copy + note + product photo), fills carousel/template.html,
// screenshots the four slides with Playwright, uploads them to the "carousels" release and reports them ready.
// Environment: WW_ORIGIN, WW_STATS_KEY, GH_TOKEN, GH_REPO, optional JOB_PMID (else the oldest queued copy), CAROUSEL_LOCAL=1 to skip upload/report.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ORIGIN = (process.env.WW_ORIGIN || 'https://aiww.io').replace(/\/$/, '');
const KEY = process.env.WW_STATS_KEY || '';
const LOCAL = process.env.CAROUSEL_LOCAL === '1';
const here = path.dirname(new URL(import.meta.url).pathname);
const work = path.join(here, 'work');
mkdirSync(work, { recursive: true });
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

async function site(method, p, body) {
  const r = await fetch(`${ORIGIN}${p}${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(KEY)}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}

function uploadAsset(file, name) {
  const repo = process.env.GH_REPO; const tag = 'carousels';
  const named = path.join(work, name); writeFileSync(named, readFileSync(file));
  try { execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' }); }
  catch { execFileSync('gh', ['release', 'create', tag, '--repo', repo, '--title', 'Instagram carousels', '--notes', 'Rendered research carousels (carousel/build.mjs).', '--latest=false'], { stdio: 'inherit' }); }
  execFileSync('gh', ['release', 'upload', tag, named, '--repo', repo, '--clobber'], { stdio: 'inherit' });
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

const jobFile = process.env.JOB_FILE;
let job;
if (jobFile) job = JSON.parse(readFileSync(jobFile, 'utf8'));
else {
  const r = await site('GET', `/api/admin/carousels/next${process.env.JOB_PMID ? `?pmid=${process.env.JOB_PMID}` : ''}`);
  job = r.json.job;
  if (!job) { log(`no carousel to render (HTTP ${r.status})`); process.exit(0); }
}
log(`job ${job.pmid}: ${job.supplement.name} · ${job.copy.cover.headline}`);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(here, 'template.html'), { waitUntil: 'load' });
  await page.evaluate((j) => window.fill(j), job);
  await page.waitForTimeout(1200); // fonts and the product image
  const files = [];
  for (const id of ['s1', 's2', 's3', 's4']) {
    const file = path.join(work, `carousel-${job.pmid}-${id}.png`);
    await page.locator('#' + id).screenshot({ path: file });
    files.push(file);
  }
  await browser.close();
  log(`rendered ${files.length} slides`);
  if (LOCAL) { log(`local: ${files.join(', ')}`); process.exit(0); }
  const urls = files.map((f, i) => uploadAsset(f, `carousel-${job.pmid}-${stamp}-${i + 1}.png`));
  const rr = await site('POST', `/api/admin/carousels/${job.pmid}/ready`, { images: urls });
  log(`reported ready: HTTP ${rr.status} ${JSON.stringify(rr.json).slice(0, 120)}`);
  process.exit(rr.ok ? 0 : 1);
} catch (e) {
  log(`render failed: ${e.message}`);
  if (!LOCAL) await site('POST', `/api/admin/carousels/${job.pmid}/failed`, { error: String(e.message).slice(0, 900) });
  process.exit(1);
}
