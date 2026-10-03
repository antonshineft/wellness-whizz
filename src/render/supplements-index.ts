/** /supplements: the whole catalogue, grouped by category, as photo tiles. */
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { page } from './layout';
import { pageShell, quizCta } from './pages';
import { WF_PAGE_IDS, blendAttr, cardImage } from './partials';

function tile(sup: Supplement): string {
  const product = sup.products.find((p) => p.image);
  const photo = product
    ? `<img src="${escapeHtml(product.image!)}" loading="lazy" width="150" height="150" alt="${escapeHtml(product.name)}"${blendAttr(product)}>`
    : cardImage(sup, 'width="150" height="150"');
  return `
        <a href="/supplement/${escapeHtml(sup.slug)}" class="ww-related-tile">
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
  const body = `
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
