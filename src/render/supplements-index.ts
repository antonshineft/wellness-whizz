/** /supplements: the whole catalogue, grouped by category, as photo tiles. */
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { page } from './layout';
import { pageShell, quizCta } from './pages';
import { WF_PAGE_IDS, blendAttr, cardImage } from './partials';
import { CERTIFIED } from '../certified';
import { STUDIED } from '../studied';
import { EVIDENCE } from '../evidence';
import { MAX_PICKS } from '../dose';

/** The checks a supplement passes, as filter keys: a graded page, a tested pick, a pick with a studied ingredient. */
function checksOf(sup: Supplement): string[] {
  const picks = sup.products.slice(0, MAX_PICKS);
  const e = EVIDENCE[sup.slug];
  return [e && (e.grade === 'A' || e.grade === 'B') ? 'evidence' : '', picks.some((p) => CERTIFIED[p.url]) ? 'tested' : '', picks.some((p) => STUDIED[p.url]) ? 'studied' : ''].filter(Boolean);
}

function tile(sup: Supplement): string {
  const product = sup.products.find((p) => p.image);
  const photo = product
    ? `<img src="${escapeHtml(product.image!)}" loading="lazy" width="150" height="150" alt="${escapeHtml(product.name)}"${blendAttr(product)}>`
    : cardImage(sup, 'width="150" height="150"');
  return `
        <a href="/supplement/${escapeHtml(sup.slug)}" class="ww-related-tile" data-checks="${checksOf(sup).join(' ')}">
          <div class="ww-related-media">${photo}</div>
          <div class="ww-related-name">${escapeHtml(sup.name)}</div>
          <span class="ww-tag">${escapeHtml(sup.category)}</span>
        </a>`;
}

export function renderSupplementsIndex(supplements: Supplement[], origin: string): string {
  const byCategory = new Map<string, Supplement[]>();
  for (const s of [...supplements].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));
  const nav = categories.map((c) => `<a href="#${escapeHtml(c.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" class="ww-tag">${escapeHtml(c)} <b>${byCategory.get(c)!.length}</b></a>`).join('');
  const sections = categories
    .map(
      (c) => `
      <section class="ww-catalog-section" id="${escapeHtml(c.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">
        <h2>${escapeHtml(c)}</h2>
        <div class="ww-related-grid">${byCategory.get(c)!.map(tile).join('')}
        </div>
      </section>`,
    )
    .join('');
  const count = (k: string) => supplements.filter((x) => checksOf(x).includes(k)).length;
  const chip = (k: string, label: string, n: number) => `<button type="button" class="ww-tag" data-filter="${k}" aria-pressed="${k ? 'false' : 'true'}" style="cursor:pointer;border:0;font:inherit">${label} <b style="color:inherit;opacity:.65">${n}</b></button>`;
  const filters = `
      <div class="ww-catalog-nav" id="ww-filter" role="group" aria-label="Filter by check" style="margin-bottom:12px">${chip('', 'All', supplements.length)}${chip('tested', 'Independently tested pick', count('tested'))}${chip('studied', 'Studied ingredient', count('studied'))}${chip('evidence', 'Evidence grade A or B', count('evidence'))}</div>
      <p style="font-size:14px;line-height:20px;margin:0 0 20px;text-align:center"><a href="/how-it-works#how-we-check" style="color:inherit">What these checks mean</a></p>
      <script>(function(){var box=document.getElementById('ww-filter');if(!box)return;function apply(k){box.querySelectorAll('button').forEach(function(b){var on=b.dataset.filter===k;b.setAttribute('aria-pressed',on);b.classList.toggle('ww-tag-dark',on)});document.querySelectorAll('.ww-catalog-section').forEach(function(s){var any=false;s.querySelectorAll('.ww-related-tile').forEach(function(t){var show=!k||(' '+t.dataset.checks+' ').indexOf(' '+k+' ')>=0;t.style.display=show?'':'none';if(show)any=true});s.style.display=any?'':'none'});try{history.replaceState(null,'',k?'?filter='+k:location.pathname)}catch(e){}}box.addEventListener('click',function(e){var b=e.target.closest('button');if(b)apply(b.dataset.filter)});var q=new URLSearchParams(location.search).get('filter')||'';if(['tested','studied','evidence'].indexOf(q)>=0)document.addEventListener('DOMContentLoaded',function(){apply(q)});else box.querySelector('button').classList.add('ww-tag-dark')})();</script>`;
  const body = `${filters}
      <nav class="ww-catalog-nav" aria-label="Categories">${nav}</nav>${sections}${quizCta('Not sure where to start?', 'Answer five questions and the advisor narrows these down to the three to five that fit you.')}`;
  const shell = pageShell({
    eyebrow: 'Supplements',
    title: `${supplements.length} supplements, one honest profile each`,
    lead: 'Benefits, contraindications, interactions, the research, and real products on iHerb for every supplement in the catalogue.',
    body,
    variant: 'plain',
  });
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: 'Supplements', item: `${origin}/supplements` },
    ],
  };
  return page({
    title: 'All supplements',
    description: `Profiles of ${supplements.length} supplements: benefits, safety, interactions, studies and where to buy on iHerb, grouped by category.`,
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(origin)}/supplements">\n  <script type="application/ld+json">${JSON.stringify(breadcrumbs).replace(/</g, '\\u003c')}</script>`,
    body: shell,
  });
}
