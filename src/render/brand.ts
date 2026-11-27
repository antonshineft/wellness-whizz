/**
 * Brand pages (/brand/<slug>), their index (/brands) and the strip of running logos near the foot of a page.
 * The facts come from src/brands-data.ts; this file only lays them out.
 */
import type { BrandPick, BrandPoint, BrandProfile, DoseRecord } from '../brands';
import { verdictIcon, type DoseState } from '../dose';
import { escapeHtml } from '../html';
import { classWords, statusWords, type BrandRecall } from '../recalls';
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

/** The short verdict beside a pick; `cls` is the scale's own class, so signs and colours match the supplement pages. */
const VERDICT: Partial<Record<DoseState, { text: string; cls: string }>> = {
  within: { text: 'Within the daily need', cls: 'ok' },
  above: { text: 'Under the safe ceiling', cls: 'ok' },
  in: { text: 'In the studied range', cls: 'ok' },
  more: { text: 'More than the body absorbs', cls: 'more' },
  over: { text: 'Above the safe ceiling', cls: 'over' },
  beyond: { text: 'Above studied doses', cls: 'more' },
  under: { text: 'Below studied doses', cls: 'info' },
};

function points(items: BrandPoint[], empty: string): string {
  if (!items.length) return `<p class="ww-brand-empty">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((p) => `<li>${escapeHtml(p.text)} <a href="${escapeHtml(p.source)}" target="_blank" rel="noopener nofollow" class="ww-brand-src">${escapeHtml(p.sourceName)}</a></li>`).join('')}</ul>`;
}

function recordBlock(b: BrandProfile, r: DoseRecord): string {
  if (r.rated < 3) return '';
  const row = (n: number, text: string, cls: string) => (n ? `<li class="ww-brand-sign-${cls}">${verdictIcon(cls)}<b>${n}</b> <span>${escapeHtml(text)}</span></li>` : '');
  return `
      <section class="ww-brand-block">
        <h2>How ${escapeHtml(b.name)} doses its products</h2>
        <p>We read the label of every pick and set its daily amount against the official range, or against the doses used in studies where a supplement has no official one. Of the ${r.rated} ${escapeHtml(b.name)} picks we could rate:</p>
        <ul class="ww-brand-rec">
          ${row(r.fine, r.fine === 1 ? 'sits inside the range' : 'sit inside the range', 'ok')}
          ${row(r.high, r.high === 1 ? 'goes above the safe ceiling or the doses studied' : 'go above the safe ceiling or the doses studied', 'over')}
          ${row(r.more, r.more === 1 ? 'carries more in one dose than the body absorbs' : 'carry more in one dose than the body absorbs', 'more')}
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
            <span class="ww-brand-pick-name">${escapeHtml(p.product.name)}${v ? ` <em class="ww-brand-chip ww-brand-sign-${v.cls}">${verdictIcon(v.cls)}${escapeHtml(v.text)}</em>` : ''}</span>
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


/** One plain sentence on how the brand's picks sit against the reference ranges, or '' when too few are rated. */
function doseSentence(b: BrandProfile, r: DoseRecord): string {
  if (r.rated < 3) return '';
  const off = r.high + r.more + r.low;
  return `Of the ${r.rated} ${b.name} products we rated, ${r.fine} ${r.fine === 1 ? 'sits' : 'sit'} inside the reference dose range${off ? ` and ${off} ${off === 1 ? 'falls' : 'fall'} outside it` : ''}.`;
}

/**
 * The questions people type about a brand, answered only from the sourced profile and the site's own dose data.
 * Nothing here is an opinion: where the profile has no point, the answer says so.
 */
function brandQuestions(b: BrandProfile, r: DoseRecord, recalls?: BrandPageData['recalls']): { q: string; a: string }[] {
  const fda = !recalls || !recalls.tracked || !recalls.checked
    ? ''
    : recalls.events.length
      ? ` The FDA's enforcement reports list ${recalls.events.length} ${recalls.events.length === 1 ? 'recall' : 'recalls'} under the company's name, the latest reported on ${longDate(recalls.events[0].date)} (${statusWords(recalls.events[0].status).toLowerCase()}).`
      : ` The FDA's enforcement reports list no recall under the company's name as of ${longDate(recalls.checked)}.`;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const out: { q: string; a: string }[] = [];
  const plus = b.positives.length ? `we could confirm ${n(b.positives.length, 'point', 'points')} in its favour from independent sources` : 'we found no point in its favour that an independent source confirms';
  const minus = b.negatives.length ? `${n(b.negatives.length, 'thing', 'things')} worth knowing before you buy` : 'no FDA warning letter, recall or settled lawsuit in our search';
  out.push({
    q: `Is ${b.name} a good brand?`,
    a: `We do not score brands, so here is the record: ${plus}, and ${minus}. ${doseSentence(b, r)} Each point on this page links to the source it rests on.`.replace(/\s+/g, ' ').trim(),
  });
  if (b.owner || b.founder || b.founded) {
    const parts = [b.owner ? `${b.name} is owned by ${b.owner}.` : '', b.founded ? `It was founded in ${b.founded}${b.founder ? ` by ${b.founder}` : ''}.` : b.founder ? `It was founded by ${b.founder}.` : '', b.headquarters ? `Its headquarters are in ${b.headquarters}.` : ''];
    out.push({ q: `Who owns ${b.name} and where is it based?`, a: parts.filter(Boolean).join(' ') });
  }
  const tested = b.positives.filter((p) => /third[- ]party|independent(ly)? (lab|test)|\bNSF\b|\bUSP\b|\bGMP\b|certif|ConsumerLab|Informed/i.test(p.text));
  if (tested.length) out.push({ q: `Is ${b.name} tested or certified by anyone independent?`, a: tested.map((p) => `${p.text} (source: ${p.sourceName})`).join(' ') });
  out.push({
    q: `Has ${b.name} had recalls, FDA warnings or lawsuits?`,
    a: (b.negatives.length
      ? b.negatives.map((p) => `${p.text} (source: ${p.sourceName})`).join(' ')
      : 'Our search found no FDA warning letter, recall or settled lawsuit against the brand. That is not proof there has never been one.') + fda,
  });
  return out;
}

/** FDA recall records, newest first: what was recalled, why, how serious the FDA rated it, and where to check. */
function recallsBlock(b: BrandProfile, r: BrandPageData['recalls']): string {
  if (!r || !r.tracked || !r.checked) return '';
  const checked = `Read from the FDA's public enforcement reports on ${longDate(r.checked)}; we check again every week.`;
  if (!r.events.length) {
    return `
      <section class="ww-brand-block ww-brand-recalls" id="recalls">
        <h2>FDA recall records</h2>
        <p>The FDA's enforcement reports list no food or supplement recall under ${escapeHtml(b.name)}'s company name.</p>
        <p class="ww-brand-small">${checked} A recall filed under a different company name, or handled outside the United States, would not appear here.</p>
      </section>`;
  }
  const item = (e: BrandRecall) => `<li class="ww-recall">
            <div class="ww-recall-head"><b>${escapeHtml(longDate(e.date))}</b><span class="ww-recall-chip${/ongoing/i.test(e.status) ? ' is-open' : ''}">${escapeHtml(statusWords(e.status))}</span></div>
            <p class="ww-recall-what">${escapeHtml(e.products[0])}${e.products.length > 1 ? ` <em>and ${e.products.length - 1} more ${e.products.length === 2 ? 'product' : 'products'} in the same recall</em>` : ''}</p>
            <p><span class="ww-recall-label">Reason given</span> ${escapeHtml(e.reason)}</p>
            <p><span class="ww-recall-label">FDA rating</span> ${escapeHtml(classWords(e.classification))}</p>${e.lots ? `
            <p><span class="ww-recall-label">Lots</span> ${escapeHtml(e.lots)}</p>` : ''}
            <p class="ww-brand-small">Recalled by ${escapeHtml(e.firm)} · FDA record <a href="https://api.fda.gov/food/enforcement.json?search=recall_number:%22${encodeURIComponent(e.numbers[0])}%22" target="_blank" rel="noopener nofollow" class="ww-brand-src">${escapeHtml(e.numbers[0])}</a></p>
          </li>`;
  const open = r.events.filter((e) => /ongoing/i.test(e.status)).length;
  return `
      <section class="ww-brand-block ww-brand-recalls" id="recalls">
        <h2>FDA recall records</h2>
        <p>${r.events.length} ${r.events.length === 1 ? 'recall' : 'recalls'} on record under the company's name${open ? `, ${open} still open` : ', all closed'}. Most recalls are started by the company itself, and a closed one means the FDA considers it dealt with.</p>
        <ul class="ww-recalls">
          ${r.events.slice(0, 5).map(item).join('\n          ')}
        </ul>${r.events.length > 5 ? `
        <details class="ww-recalls-older"><summary>Show ${r.events.length - 5} older ${r.events.length - 5 === 1 ? 'record' : 'records'}</summary>
        <ul class="ww-recalls">
          ${r.events.slice(5).map(item).join('\n          ')}
        </ul></details>` : ''}
        <p class="ww-brand-small">${checked} If you own a recalled lot, stop using it and follow the company's or the FDA's instructions.</p>
      </section>`;
}

function questionsBlock(qs: { q: string; a: string }[]): string {
  return `
      <section class="ww-brand-block ww-faq ww-brand-faq">
        <h2>Common questions</h2>
        ${qs.map((x) => `<details><summary>${escapeHtml(x.q)}</summary><p>${escapeHtml(x.a)}</p></details>`).join('\n        ')}
      </section>`;
}

export interface BrandPageData {
  /** FDA recall records under the company's name (src/recalls.ts); absent on a preview without the feed. */
  recalls?: { events: BrandRecall[]; checked: string | null; tracked: boolean };
  brand: BrandProfile;
  picks: BrandPick[];
  record: DoseRecord;
  others: BrandProfile[];
  origin: string;
}

export function renderBrandPage(env: LinkEnv, d: BrandPageData): string {
  const b = d.brand;
  // A name that starts with a small letter on purpose (iHerb, eSupplements) keeps it.
  const cap = (v: string | number) => (/^[a-z][A-Z]/.test(String(v)) ? String(v) : String(v).replace(/^[a-z]/, (ch) => ch.toUpperCase()));
  const fact = (label: string, value: string | number | null) => (value ? `<div><dt>${label}</dt><dd>${escapeHtml(cap(value))}</dd></div>` : '');
  const qs = brandQuestions(b, d.record, d.recalls);
  const body = `
      <section class="ww-brand-block ww-brand-short">
        <h2>Is ${escapeHtml(b.name)} a good brand?</h2>
        <p>${escapeHtml(qs[0].a)}</p>
      </section>
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
      </div>${recallsBlock(b, d.recalls)}${recordBlock(b, d.record)}${picksBlock(env, b, d.picks)}${questionsBlock(qs.slice(1))}`;
  const lead = [b.founded ? `Founded in ${b.founded}` : '', b.headquarters ?? '', b.owner ? `owned by ${b.owner}` : ''].filter(Boolean).join(' · ');
  const shell = pageShell({
    eyebrow: 'Brand profile',
    title: b.name,
    lead: lead || 'Who makes it, what speaks for the company and what to know before you buy.',
    body: `
      <div class="ww-brand-frame">${body}
      </div>` + brandStrip(d.others),
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
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qs.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
  };
  const titles = [`${b.name} Review: Is It a Good Brand? Record & Recalls`, `${b.name} Review: Is It a Good Brand?`, `Is ${b.name} a Good Brand?`];
  return page({
    title: titles.find((t) => t.length <= 43) ?? titles[titles.length - 1],
    description: `Is ${b.name} a good brand? Who owns it, what independent sources confirm, recalls and lawsuits to know about, and how its ${d.picks.length} products compare with reference doses.`.slice(0, 160),
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(d.origin)}/brand/${escapeHtml(b.slug)}">\n  <script type="application/ld+json">${safe(ld)}</script>\n  <script type="application/ld+json">${safe(faqLd)}</script>`,
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
