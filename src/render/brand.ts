/**
 * Brand pages (/brand/<slug>), their index (/brands) and the strip of running logos near the foot of a page.
 * The facts come from src/brands-data.ts; this file only lays them out.
 */
import type { BrandPick, BrandPoint, BrandProfile, DoseRecord } from '../brands';
import type { DoseState } from '../dose';
import { escapeHtml } from '../html';
import { shopUrl, type LinkEnv } from '../links';
import { page } from './layout';
import { pageShell } from './pages';
import { AFFILIATE_NOTE, WF_PAGE_IDS } from './partials';

const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The brand's logo, or its name set in type where no logo file is kept. */
function logo(b: BrandProfile, cls = ''): string {
  return b.logo
    ? `<img src="/images/brands/${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)} logo" loading="lazy" class="ww-brand-logo${cls}">`
    : `<span class="ww-brand-wordmark${cls}">${escapeHtml(b.name)}</span>`;
}

/**
 * Running logos, greyed out, each a link to its brand page. The list is written twice so the loop has no seam; the
 * second copy is hidden from screen readers and from the keyboard.
 */
export function brandStrip(brands: BrandProfile[]): string {
  if (brands.length < 4) return '';
  const item = (b: BrandProfile, hidden: boolean) =>
    `<a href="/brand/${escapeHtml(b.slug)}" class="ww-brandstrip-item" title="${escapeHtml(b.name)}"${hidden ? ' aria-hidden="true" tabindex="-1"' : ` aria-label="${escapeHtml(b.name)}: brand profile"`}>${logo(b)}</a>`;
  return `
  <section class="ww-brandstrip" aria-label="Brands we cover">
    <div class="ww-brandstrip-label"><a href="/brands">Brands behind our picks</a></div>
    <div class="ww-brandstrip-window">
      <div class="ww-brandstrip-track" style="--ww-strip-n:${brands.length}">${brands.map((b) => item(b, false)).join('')}${brands.map((b) => item(b, true)).join('')}</div>
    </div>
  </section>`;
}

const VERDICT: Partial<Record<DoseState, { text: string; cls: string }>> = {
  within: { text: 'Within the daily need', cls: 'ok' },
  above: { text: 'Under the safe ceiling', cls: 'ok' },
  in: { text: 'In the studied range', cls: 'ok' },
  more: { text: 'More than the body absorbs', cls: 'warn' },
  over: { text: 'Above the safe ceiling', cls: 'high' },
  beyond: { text: 'Above studied doses', cls: 'warn' },
  under: { text: 'Below studied doses', cls: 'info' },
};

function points(items: BrandPoint[], empty: string): string {
  if (!items.length) return `<p class="ww-brand-empty">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((p) => `<li>${escapeHtml(p.text)} <a href="${escapeHtml(p.source)}" target="_blank" rel="noopener nofollow" class="ww-brand-src">${escapeHtml(p.sourceName)}</a></li>`).join('')}</ul>`;
}

function recordBlock(b: BrandProfile, r: DoseRecord): string {
  if (r.rated < 3) return '';
  const row = (n: number, text: string, cls: string) => (n ? `<li class="ww-brand-rec-${cls}"><b>${n}</b> ${escapeHtml(text)}</li>` : '');
  return `
      <section class="ww-brand-block">
        <h2>How ${escapeHtml(b.name)} doses its products</h2>
        <p>We read the label of every pick and set its daily amount against the official range, or against the doses used in studies where a supplement has no official one. Of the ${r.rated} ${escapeHtml(b.name)} picks we could rate:</p>
        <ul class="ww-brand-rec">
          ${row(r.fine, r.fine === 1 ? 'sits inside the range' : 'sit inside the range', 'ok')}
          ${row(r.high, r.high === 1 ? 'goes above the safe ceiling or the doses studied' : 'go above the safe ceiling or the doses studied', 'high')}
          ${row(r.more, r.more === 1 ? 'carries more in one dose than the body absorbs' : 'carry more in one dose than the body absorbs', 'warn')}
          ${row(r.low, r.low === 1 ? 'falls below the doses used in studies' : 'fall below the doses used in studies', 'info')}
        </ul>
        <p class="ww-brand-small">A high dose is a choice many brands make on purpose, and one a doctor may recommend. The count says how the label compares with the reference, not whether the product is good.</p>
      </section>`;
}

function picksBlock(env: LinkEnv, b: BrandProfile, picks: BrandPick[]): string {
  if (!picks.length) return '';
  const rows = picks
    .map((p) => {
      const v = p.state ? VERDICT[p.state] : undefined;
      return `<li>
            <a href="/supplement/${escapeHtml(p.supplement.slug)}" class="ww-brand-pick-sup">${escapeHtml(p.supplement.name)}</a>
            <span class="ww-brand-pick-name">${escapeHtml(p.product.name)}${v ? ` <em class="ww-brand-chip ww-brand-chip-${v.cls}">${escapeHtml(v.text)}</em>` : ''}</span>
            <a href="${escapeHtml(shopUrl(env, p.supplement, p.product))}" target="_blank" rel="noopener nofollow sponsored" class="ww-brand-pick-buy" data-track="outbound_click" data-slug="${escapeHtml(p.supplement.slug)}" data-product="${escapeHtml(p.product.name)}">iHerb</a>
          </li>`;
    })
    .join('\n          ');
  const pages = new Set(picks.map((p) => p.supplement.slug)).size;
  return `
      <section class="ww-brand-block">
        <h2>${escapeHtml(b.name)} on Wellness Whizz</h2>
        <p>${picks.length} ${picks.length === 1 ? 'pick' : 'picks'} on ${pages} ${pages === 1 ? 'supplement page' : 'supplement pages'}. A pick is on a page because it is a widely sold product of that supplement on iHerb, not because the brand asked for it.</p>
        <ul class="ww-brand-picks">
          ${rows}
        </ul>
        <p class="ww-brand-small">${escapeHtml(AFFILIATE_NOTE)}</p>
      </section>`;
}

export interface BrandPageData {
  brand: BrandProfile;
  picks: BrandPick[];
  record: DoseRecord;
  others: BrandProfile[];
  origin: string;
}

export function renderBrandPage(env: LinkEnv, d: BrandPageData): string {
  const b = d.brand;
  const cap = (v: string | number) => String(v).replace(/^[a-z]/, (ch) => ch.toUpperCase());
  const fact = (label: string, value: string | number | null) => (value ? `<div><dt>${label}</dt><dd>${escapeHtml(cap(value))}</dd></div>` : '');
  const body = `
      <dl class="ww-brand-facts">
        ${fact('Founded', b.founded)}${fact('Founder', b.founder)}${fact('Headquarters', b.headquarters)}${fact('Owner', b.owner)}
      </dl>
      <section class="ww-brand-block">
        <h2>A short history</h2>
        <p class="ww-brand-history">${escapeHtml(b.history)}</p>
      </section>
      <div class="ww-brand-sides">
        <section class="ww-brand-side ww-brand-plus">
          <h2>What speaks for it</h2>
          ${points(b.positives, 'We found nothing we could confirm from an independent source.')}
        </section>
        <section class="ww-brand-side ww-brand-minus">
          <h2>What to know</h2>
          ${points(b.negatives, 'Our search found no FDA warning letter, recall or settled lawsuit against the brand. That is not proof there has never been one.')}
        </section>
      </div>${recordBlock(b, d.record)}${picksBlock(env, b, d.picks)}`;
  const lead = [b.founded ? `Founded in ${b.founded}` : '', b.headquarters ?? '', b.owner ? `owned by ${b.owner}` : ''].filter(Boolean).join(' · ');
  const shell = pageShell({
    eyebrow: 'Brand profile',
    title: b.name,
    lead: lead || 'Who makes it, what speaks for the company and what to know before you buy.',
    body: body + brandStrip(d.others),
    heroAside: `<div class="ww-page-hero-media ww-brand-hero-logo">${logo(b, ' is-large')}</div>`,
  });
  const safe = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: `${d.origin}/brand/${b.slug}`,
    name: `${b.name}: brand profile`,
    dateModified: b.reviewed,
    about: { '@type': 'Brand', name: b.name },
    publisher: { '@id': `${d.origin}/#organization` },
  };
  return page({
    title: `${b.name}: history, strengths and what to know`,
    description: `${b.name} at a glance: who owns it, a short history, what speaks for the company, what to know before you buy, and how its ${d.picks.length} picks on Wellness Whizz are dosed.`.slice(0, 300),
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(d.origin)}/brand/${escapeHtml(b.slug)}">\n  <script type="application/ld+json">${safe(ld)}</script>`,
    body: shell,
  });
}

export function renderBrandsIndex(brands: (BrandProfile & { picks: number })[], origin: string): string {
  const cards = brands
    .map(
      (b) => `
        <a href="/brand/${escapeHtml(b.slug)}" class="ww-brand-card">
          <span class="ww-brand-card-logo">${logo(b)}</span>
          <strong>${escapeHtml(b.name)}</strong>
          <span>${[b.founded ? `Since ${b.founded}` : '', `${b.picks} ${b.picks === 1 ? 'pick' : 'picks'}`].filter(Boolean).join(' · ')}</span>
        </a>`,
    )
    .join('');
  const shell = pageShell({
    eyebrow: 'Brands',
    title: 'The brands behind our picks',
    lead: 'Who makes the supplements we point to: a short history of each company, what speaks for it and what to know, each point with its source.',
    body: `
      <div class="ww-brand-grid">${cards}
      </div>
      <p class="ww-brand-small ww-brand-index-note">These are the brands that appear most often among our product picks. No brand pays to be listed, and iHerb pays us the same commission whichever one you buy.</p>`,
    variant: 'plain',
  });
  return page({
    title: 'Supplement brands: who makes our picks',
    description: 'Profiles of the supplement brands behind the Wellness Whizz product picks: history, ownership, strengths and what to know, with sources.',
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(origin)}/brands">`,
    body: shell,
  });
}
