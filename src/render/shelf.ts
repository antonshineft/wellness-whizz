/** /shelf (the upload form) and /shelf/:id (what the model made of the photos). */
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { primaryProduct, searchUrl, shopUrl, type LinkEnv } from '../links';
import type { ShelfAnalysis, ShelfScan } from '../shelf';
import { page } from './layout';
import { pageShell, quizCta } from './pages';
import { WF_PAGE_IDS, blendAttr, buyButton, cardImage, footer, navbar } from './partials';

const NOINDEX = '\n  <meta name="robots" content="noindex">';

const GOALS = ['Better sleep', 'More energy', 'Joints', 'Immunity'];

/**
 * The upload page: the whole hero is a looping picture (public/js/shelf.js draws it) whose centre takes the
 * photos, and a sheet over its lower edge that holds the title and, once a photo is in, the
 * next steps.
 */
export function renderShelfPage(origin: string): string {
  const chips = GOALS.map((g) => `<button type="button" class="ww-scan-chip" aria-pressed="false">${escapeHtml(g)}</button>`).join('');
  const shell = `${navbar('logo-left')}
  <main class="ww-page-wrap ww-scan">
    <form class="ww-scan-form" id="ww-shelf" novalidate>
      <div class="ww-scan-art" id="ww-scan-art">
        <canvas aria-hidden="true"></canvas>
        <span class="ww-scan-blur" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span class="ww-scan-grain" aria-hidden="true"></span>
        <input type="file" id="ww-shelf-files" name="photos" accept="image/*" multiple>
        <label class="ww-scan-hole" for="ww-shelf-files">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14"/></svg>
          <b id="ww-scan-hole-title">Drop a photo</b>
          <small id="ww-scan-hole-sub">or tap to choose</small>
        </label>
      </div>
      <div class="ww-scan-sheet">
        <h1 class="ww-scan-title">Scan your supplement shelf</h1>
        <p class="ww-scan-lead">Photograph the bottles you already have. The advisor reads the labels and tells you what overlaps, what to take apart and what is missing for your goal.</p>
        <p class="ww-scan-hint" id="ww-scan-hint">Up to 3 photos. Labels facing the camera, good light. Photos are analysed and not stored.</p>
        <div class="ww-scan-next" id="ww-scan-next" hidden>
          <div class="ww-scan-thumbs" id="ww-shelf-previews" aria-live="polite"></div>
          <p class="ww-scan-label">What are you taking them for? (optional)</p>
          <div class="ww-scan-chips" id="ww-scan-chips">${chips}</div>
          <input type="text" class="ww-scan-goal" name="goal" maxlength="200" placeholder="or type your own" autocomplete="off" aria-label="What are you taking them for?">
          <button type="submit" class="ww-scan-go" id="ww-shelf-submit">Check my shelf</button>
        </div>
        <p class="ww-shelf-status" id="ww-shelf-status" aria-live="polite"></p>
      </div>
      <p class="ww-scan-note">This is information, not medical advice. Keep taking prescribed medicines as directed and ask a pharmacist before combining them with supplements.</p>
    </form>
    <div class="ww-page">
      <section class="ww-scan-back">
        <h2>What you get back</h2>
        <dl>
          <div><dt>Every product recognised</dt><dd>With its dose per serving and a link to its profile.</dd></div>
          <div><dt>Overlaps</dt><dd>The same ingredient coming from two bottles, and whether that matters.</dd></div>
          <div><dt>What to take apart</dt><dd>Pairs that compete for absorption, and the best time of day for each.</dd></div>
          <div><dt>What is missing</dt><dd>For your goal, with the evidence in one sentence and where to buy it.</dd></div>
        </dl>
      </section>${quizCta('Want a list built from scratch?', 'The two-minute quiz weighs your goals, diet and what you already take, then explains its picks.')}
    </div>
  </main>${footer()}`;
  return page({
    title: 'Scan your supplement shelf',
    description: 'Photograph your supplement bottles and get a free AI check: what overlaps, what to take apart, when to take each one, and what is missing for your goal.',
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(origin)}/shelf">`,
    body: shell,
    scripts: '  <script src="/js/shelf.js" defer></script>',
  });
}

function photo(sup: Supplement | undefined, alt: string): string {
  const product = sup?.products.find((p) => p.image);
  if (product?.image) return `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(alt)}" loading="lazy" width="60" height="60"${blendAttr(product)}>`;
  if (sup) return cardImage(sup, `width="60" height="60" alt="${escapeHtml(alt)}"`);
  return '<span class="ww-shelf-noimg" aria-hidden="true"></span>';
}

function productRow(env: LinkEnv, p: ShelfAnalysis['products'][number], sup: Supplement | undefined): string {
  const conf = p.confidence === 'high' ? '' : ` <span class="ww-tag ww-shelf-conf">${p.confidence === 'medium' ? 'probably' : 'not sure'}</span>`;
  const meta = [p.supplement, p.dose].filter(Boolean).join(' · ');
  const actions = sup
    ? `<div class="ww-shop-actions"><a href="/supplement/${escapeHtml(sup.slug)}" class="ww-shop-link">Full profile</a>${buyButton(env, sup, 'ww-shop-buy')}</div>`
    : `<div class="ww-shop-actions"><a href="${escapeHtml(searchUrl(env, p.supplement))}" target="_blank" rel="noopener nofollow sponsored" class="fakebutton ww-buy ww-shop-buy w-button" data-track="outbound_click" data-slug="shelf" data-product="${escapeHtml(p.supplement)}">Find on iHerb</a></div>`;
  return `
          <div class="ww-shop-item">
            <div class="ww-shop-top">
              <span class="ww-shop-thumb">${photo(sup, p.label)}</span>
              <div class="ww-shop-info">
                <div class="ww-shop-name">${escapeHtml(p.label)}${conf}</div>
                <div class="ww-shop-brand">${escapeHtml(meta)}</div>
              </div>
            </div>${actions}
          </div>`;
}

function missingRow(env: LinkEnv, m: ShelfAnalysis['missing'][number], sup: Supplement | undefined): string {
  const product = sup ? primaryProduct(sup) : undefined;
  const href = sup ? shopUrl(env, sup, product) : searchUrl(env, m.supplement);
  return `
          <div class="ww-shop-item">
            <div class="ww-shop-top">
              <span class="ww-shop-thumb">${photo(sup, m.supplement)}</span>
              <div class="ww-shop-info">
                <div class="ww-shop-name">${escapeHtml(sup?.name ?? m.supplement)}</div>
                <div class="ww-shop-brand">${escapeHtml(m.why)}</div>
              </div>
            </div>
            <div class="ww-shop-actions">${sup ? `<a href="/supplement/${escapeHtml(sup.slug)}" class="ww-shop-link">Full profile</a>` : ''}<a href="${escapeHtml(href)}" target="_blank" rel="noopener nofollow sponsored" class="fakebutton ww-buy ww-shop-buy w-button" data-track="outbound_click" data-slug="${escapeHtml(sup?.slug ?? 'shelf')}" data-product="${escapeHtml(product?.name ?? m.supplement)}">Buy on iHerb</a></div>
          </div>`;
}

function notes(title: string, items: { heads: string[]; note: string; caution?: boolean }[]): string {
  if (!items.length) return '';
  return `
      <section class="ww-shelf-section">
        <h2>${escapeHtml(title)}</h2>
        <ul class="ww-shelf-notes">${items
          .map((i) => `<li${i.caution ? ' class="is-caution"' : ''}>${i.heads.length ? `<strong>${escapeHtml(i.heads.join(' + '))}</strong>: ` : ''}${escapeHtml(i.note)}</li>`)
          .join('')}</ul>
      </section>`;
}

export function renderShelfResult(scan: ShelfScan, supplements: Map<string, Supplement>, env: LinkEnv, origin: string): string {
  const a = scan.analysis;
  const sup = (slug: string | null | undefined) => (slug ? supplements.get(slug) : undefined);
  const products = a.products.length
    ? `
      <section class="ww-shelf-section">
        <h2>Recognised on your shelf</h2>
        <div class="ww-shop ww-shelf-products">${a.products.map((p) => productRow(env, p, sup(p.slug))).join('')}
        </div>
      </section>`
    : `
      <section class="ww-shelf-section">
        <h2>Nothing recognisable yet</h2>
        <p>The labels could not be read. Try again with the bottles closer, labels facing the camera, in daylight.</p>
      </section>`;
  const missing = a.missing.length
    ? `
      <section class="ww-shelf-section">
        <h2>Missing for your goal</h2>
        <div class="ww-shop ww-shelf-products">${a.missing.map((m) => missingRow(env, m, sup(m.slug))).join('')}
          <p class="ww-note" style="margin:12px 0 0">Prices and availability are set by iHerb.</p>
        </div>
      </section>`
    : '';
  const body = `
      <div class="ww-shelf-result ww-prose">${products}${notes('Overlaps', a.overlaps.map((o) => ({ heads: o.supplements, note: o.note })))}${notes(
        'Take these apart, or with care',
        a.interactions.map((i) => ({ heads: i.supplements, note: i.note, caution: i.severity === 'caution' })),
      )}${notes('When to take each one', a.timing.map((t) => ({ heads: [t.supplement], note: t.note })))}${missing}
        ${a.caution ? `<p class="ww-note">${escapeHtml(a.caution)}</p>` : ''}
        <p class="ww-note">Wellness Whizz earns a commission on purchases made through iHerb links on this page, at no extra cost to you. This is information, not medical advice.</p>
        <p><a href="/shelf" class="fakebutton ww-secondary w-button">Scan another shelf</a></p>
      </div>${quizCta('Want a list built from scratch?', 'The two-minute quiz weighs your goals, diet and what you already take, then explains its picks.')}`;
  const shell = pageShell({
    eyebrow: 'Shelf scan',
    title: a.products.length ? `${a.products.length} product${a.products.length === 1 ? '' : 's'} on your shelf` : 'Your shelf scan',
    lead: a.summary || 'Here is what the advisor made of your photos.',
    body,
  });
  return page({
    title: 'Your shelf scan',
    description: 'What the Wellness Whizz advisor made of your supplement shelf: overlaps, what to take apart, timing and what is missing.',
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `${NOINDEX}\n  <link rel="canonical" href="${escapeHtml(origin)}/shelf/${escapeHtml(scan.id)}">`,
    body: shell,
  });
}
