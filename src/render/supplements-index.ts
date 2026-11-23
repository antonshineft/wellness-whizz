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

const CHECK = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.4 4.8 9 10 3.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GRADE_WORD: Record<string, string> = { A: 'Strong evidence', B: 'Good evidence', C: 'Mixed evidence', D: 'Weak evidence' };

/** What a supplement passes: its evidence grade, a lab-tested pick (which certifiers), a pick with a studied ingredient (which). */
function checksOf(sup: Supplement): { keys: string[]; grade?: string; tested: string[]; studied: string[] } {
  const picks = sup.products.slice(0, MAX_PICKS);
  const grade = EVIDENCE[sup.slug]?.grade;
  const short = (mark: string) => (mark.startsWith('NSF') ? 'NSF' : mark);
  const tested = [...new Set(picks.map((p) => CERTIFIED[p.url]?.mark).filter(Boolean).map((m) => short(m!)))];
  const studied = [...new Set(picks.flatMap((p) => STUDIED[p.url] ?? []).map((i) => i.name))];
  return { keys: [grade === 'A' || grade === 'B' ? 'evidence' : '', tested.length ? 'tested' : '', studied.length ? 'studied' : ''].filter(Boolean), grade, tested, studied };
}

function tile(sup: Supplement): string {
  const product = sup.products.find((p) => p.image);
  const photo = product
    ? `<img src="${escapeHtml(product.image!)}" loading="lazy" width="150" height="150" alt="${escapeHtml(product.name)}"${blendAttr(product)}>`
    : cardImage(sup, 'width="150" height="150"');
  const c = checksOf(sup);
  const marks =
    (c.grade ? `<span class="ww-tile-mark"><b class="ww-grade">${c.grade}</b>${GRADE_WORD[c.grade]}</span>` : '') +
    (c.tested.length ? `<span class="ww-tile-mark is-good">${CHECK}Lab-tested product: ${escapeHtml(c.tested.join(', '))}</span>` : '') +
    (c.studied.length ? `<span class="ww-tile-mark">${CHECK}Studied: ${escapeHtml(c.studied.slice(0, 2).join(', '))}${c.studied.length > 2 ? ` +${c.studied.length - 2}` : ''}</span>` : '');
  return `
        <a href="/supplement/${escapeHtml(sup.slug)}" class="ww-related-tile" data-checks="${c.keys.join(' ')}">
          <div class="ww-related-media">${photo}</div>
          <div class="ww-related-name">${escapeHtml(sup.name)}</div>
          <span class="ww-tag">${escapeHtml(sup.category)}</span>${marks ? `\n          <span class="ww-tile-marks">${marks}</span>` : ''}
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
  const nav = categories.map((c) => `<a href="#${escapeHtml(c.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" class="ww-tag" data-cat>${escapeHtml(c)} <b>${byCategory.get(c)!.length}</b></a>`).join('');
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
  const count = (k: string) => supplements.filter((x) => checksOf(x).keys.includes(k)).length;
  const chip = (k: string, label: string, n: number) => `<button type="button" class="ww-tag${k ? '' : ' ww-tag-dark'}" data-filter="${k}" data-what="${escapeHtml(label.toLowerCase())}" aria-pressed="${k ? 'false' : 'true'}">${label} <b>${n}</b></button>`;
  const filters = `
      <div class="ww-catalog-nav ww-filter" id="ww-filter" role="group" aria-label="Show only"><span class="ww-row-label">Show only</span>${chip('', 'All', supplements.length)}${chip('tested', 'Lab-tested product', count('tested'))}${chip('studied', 'Clinically studied ingredient', count('studied'))}${chip('evidence', 'Strong evidence (A or B)', count('evidence'))}</div>
      <p class="ww-filter-status" id="ww-filter-status" role="status" aria-live="polite"><a href="/how-it-works#how-we-check">What these checks mean</a></p>`;
  // The filter: hides tiles and empty sections, corrects the category counts, and says what is shown.
  const script = `
      <script>(function(){var box=document.getElementById('ww-filter'),st=document.getElementById('ww-filter-status');if(!box||!st)return;var total=${supplements.length},help=st.innerHTML;function apply(k,user){var shown=0,what='';box.querySelectorAll('button').forEach(function(b){var on=b.dataset.filter===k;b.setAttribute('aria-pressed',on);b.classList.toggle('ww-tag-dark',on);if(on)what=b.dataset.what});document.querySelectorAll('.ww-catalog-section').forEach(function(s){var n=0;s.querySelectorAll('.ww-related-tile').forEach(function(t){var show=!k||(' '+t.dataset.checks+' ').indexOf(' '+k+' ')>=0;t.hidden=!show;if(show)n++});s.hidden=!n;shown+=n;var a=document.querySelector('.ww-catalog-nav a[href="#'+s.id+'"]');if(a){a.querySelector('b').textContent=n;a.classList.toggle('is-empty',!n);if(n)a.removeAttribute('aria-disabled');else a.setAttribute('aria-disabled','true')}});st.innerHTML=k?'Showing <strong>'+shown+' of '+total+'</strong> supplements with a '+what.replace(' (a or b)',' grade, A or B')+'. <a href="/how-it-works#how-we-check">What this means</a> · <button type="button" data-filter="">Show all</button>':help;try{history.replaceState(null,'',k?'?filter='+k:location.pathname)}catch(e){}if(user&&k&&window.innerWidth<768)box.scrollIntoView({behavior:'smooth',block:'start'})}document.addEventListener('click',function(e){var b=e.target.closest('button[data-filter]');if(b)apply(b.dataset.filter,true);var d=e.target.closest('a[aria-disabled]');if(d)e.preventDefault()});var q=new URLSearchParams(location.search).get('filter')||'';if(['tested','studied','evidence'].indexOf(q)>=0)apply(q,false)})();</script>`;
  const body = `${filters}
      <nav class="ww-catalog-nav ww-cats" aria-label="Jump to a category"><span class="ww-row-label">Jump to</span>${nav}</nav>${sections}${script}${quizCta('Not sure where to start?', 'Answer five questions and the advisor narrows these down to the three to five that fit you.')}`;
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
