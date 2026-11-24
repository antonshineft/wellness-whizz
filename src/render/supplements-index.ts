/** /supplements: the whole catalogue, grouped by category, as photo tiles. */
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { page } from './layout';
import { pageShell, quizCta } from './pages';
import { WF_PAGE_IDS, blendAttr, cardImage } from './partials';
import { CERTIFIED, PAID_MARK } from '../certified';
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
  const tested = [...new Set(picks.map((p) => CERTIFIED[p.url]?.mark).filter((m) => m && m !== PAID_MARK).map((m) => short(m!)))];
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
    (c.tested.length ? `<span class="ww-tile-mark is-good">${CHECK}Lab-tested product</span>` : '') +
    (c.studied.length ? `<span class="ww-tile-mark">${CHECK}Studied: ${escapeHtml(c.studied.slice(0, 2).join(', '))}${c.studied.length > 2 ? ` +${c.studied.length - 2}` : ''}</span>` : '');
  return `
        <a href="/supplement/${escapeHtml(sup.slug)}" class="ww-related-tile" data-checks="${c.keys.join(' ')}" data-name="${escapeHtml(`${sup.name} ${sup.category}`.toLowerCase())}">
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
  const idOf = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const sections = categories
    .map(
      (c) => `
        <section class="ww-catalog-section" id="${escapeHtml(idOf(c))}">
          <h2>${escapeHtml(c)}</h2>
          <div class="ww-related-grid">${byCategory.get(c)!.map(tile).join('')}
          </div>
        </section>`,
    )
    .join('');
  const count = (k: string) => supplements.filter((x) => checksOf(x).keys.includes(k)).length;
  const check = (k: string, label: string) => `<label class="ww-opt"><input type="checkbox" name="check" value="${k}"><span>${label}</span><b>${count(k)}</b></label>`;
  const cat = (id: string, label: string, n: number, on = false) => `<label class="ww-opt"><input type="radio" name="cat" value="${escapeHtml(id)}"${on ? ' checked' : ''}><span>${escapeHtml(label)}</span><b data-n="${escapeHtml(id)}">${n}</b></label>`;
  // The side column of a shop: search, the checks a supplement passes, the categories. On a phone it folds into one "Filter" bar.
  const side = `
      <aside class="ww-browse-side" aria-label="Filter the catalogue">
        <details class="ww-browse-filter" id="ww-filter" open>
          <summary>Filter<span id="ww-filter-n"></span></summary>
          <form class="ww-browse-form" onsubmit="return false">
            <label class="ww-browse-search"><span>Search</span><input type="search" name="q" placeholder="Magnesium, sleep, creatine" autocomplete="off"></label>
            <fieldset><legend>Show only</legend>${check('tested', 'Lab-tested product')}${check('studied', 'Clinically studied ingredient')}${check('evidence', 'Strong evidence (A or B)')}
              <a class="ww-browse-help" href="/how-it-works#how-we-check">What these checks mean</a>
            </fieldset>
            <fieldset><legend>Category</legend>${cat('', 'All categories', supplements.length, true)}${categories.map((c) => cat(idOf(c), c, byCategory.get(c)!.length)).join('')}
            </fieldset>
          </form>
        </details>
      </aside>`;
  const script = `
      <script>(function(){var f=document.querySelector('.ww-browse-form'),st=document.getElementById('ww-filter-status'),box=document.getElementById('ww-filter');if(!f||!st)return;var total=${supplements.length};if(window.innerWidth<992)box.open=false;
function state(){return{q:f.q.value.trim().toLowerCase(),cat:f.cat.value,checks:[].slice.call(f.querySelectorAll('input[name=check]:checked')).map(function(i){return i.value})}}
function apply(user){var s=state(),shown=0,per={};document.querySelectorAll('.ww-catalog-section').forEach(function(sec){var n=0,m=0;sec.querySelectorAll('.ww-related-tile').forEach(function(t){var ok=s.checks.every(function(k){return(' '+t.dataset.checks+' ').indexOf(' '+k+' ')>=0})&&(!s.q||t.dataset.name.indexOf(s.q)>=0);if(ok)m++;var show=ok&&(!s.cat||s.cat===sec.id);t.hidden=!show;if(show)n++});per[sec.id]=m;sec.hidden=!n;shown+=n});
var all=0;Object.keys(per).forEach(function(id){all+=per[id];var b=f.querySelector('b[data-n="'+id+'"]');if(b){b.textContent=per[id];b.parentNode.classList.toggle('is-empty',!per[id]&&s.cat!==id)}});var ball=f.querySelector('b[data-n=""]');if(ball)ball.textContent=all;
var active=s.checks.length+(s.cat?1:0)+(s.q?1:0);document.getElementById('ww-filter-n').textContent=active?' ('+active+')':'';
document.getElementById('ww-count').innerHTML=shown?'Showing <strong>'+shown+' of '+total+'</strong> supplements':'<strong>Nothing matches these filters.</strong>';document.getElementById('ww-clear').hidden=!active;
try{history.replaceState(null,'',s.checks.length===1&&!s.cat&&!s.q?'?filter='+s.checks[0]:location.pathname)}catch(e){}
if(user&&window.innerWidth<992){box.open=false;st.scrollIntoView({behavior:'smooth',block:'start'})}}
f.addEventListener('change',function(e){if(e.target.name!=='q')apply(true)});f.q.addEventListener('input',function(){apply(false)});
document.addEventListener('click',function(e){if(e.target.id==='ww-clear'){f.q.value='';f.querySelectorAll('input[name=check]').forEach(function(i){i.checked=false});f.querySelector('input[name=cat]').checked=true;apply(false)}});
var q=new URLSearchParams(location.search).get('filter')||'';var pre=f.querySelector('input[name=check][value="'+q+'"]');if(pre)pre.checked=true;apply(false)})();</script>`;
  const body = `
      <div class="ww-browse">${side}
        <div class="ww-browse-main">
          <p class="ww-filter-status" id="ww-filter-status" role="status" aria-live="polite"><span id="ww-count">Showing <strong>${supplements.length} of ${supplements.length}</strong> supplements</span><button type="button" id="ww-clear" hidden>Clear filters</button></p>${sections}
        </div>
      </div>${script}${quizCta('Not sure where to start?', 'Answer five questions and the advisor narrows these down to the three to five that fit you.')}`;
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
