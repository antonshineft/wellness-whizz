/** /supplement/:slug — the "Supplements" CMS template page. */
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { shopUrl, type LinkEnv } from '../links';
import { page } from './layout';
import {
  EFFECTIVITY_LABELS, SAFETY_LABELS, WF_PAGE_IDS, cardImage, detailImage, exploreSection, footer, headerBadges, navbar,
  productPicks, ratingImage, stickyBuyBar,
} from './partials';

const PRODUCT_CARD_IDS = [
  '2841e5e2-b1d4-d414-f4f8-0c4efba357d3',
  '2841e5e2-b1d4-d414-f4f8-0c4efba357d4',
  '2841e5e2-b1d4-d414-f4f8-0c4efba357d5',
  '2841e5e2-b1d4-d414-f4f8-0c4efba357d6',
  '2841e5e2-b1d4-d414-f4f8-0c4efba357d7',
];

const HEAD_STYLES = `
  <style>
    .rich-text-block-2 ol { list-style: none; counter-reset: section; padding-left: 0; }
    .rich-text-block-2 ol li { counter-increment: section; margin-bottom: 10px; padding-left: 20px; position: relative; opacity: 0.7; color: #FFF; }
    .rich-text-block-2 ol li::before { content: counters(section, ".") " "; position: absolute; left: 0; font-weight: bold; color: #87D581; opacity: 1; }
    .rich-text-block-2 ol li:nth-child(1)::before { content: '➊ '; }
    .rich-text-block-2 ol li:nth-child(2)::before { content: '➋ '; }
    .rich-text-block-2 ol li:nth-child(3)::before { content: '➌ '; }
    .rich-text-block-2 ol li:nth-child(4)::before { content: '➍ '; }
    .rich-text-block-2 ol li:nth-child(5)::before { content: '➎ '; }
    .rich-text-block-2 ol li:nth-child(6)::before { content: '➏ '; }
    .rich-text-block-2 ol li:nth-child(7)::before { content: '➐ '; }
    .rich-text-block-2.two-columns ol { -webkit-column-count: 2; -moz-column-count: 2; column-count: 2; -webkit-column-gap: 16px; -moz-column-gap: 16px; column-gap: 16px; }
    .rich-text-block-4 a { color: #87d581; }
  </style>`;

function ratingBlock(title: string, labels: readonly string[], value: number, safe: boolean): string {
  const n = Math.min(5, Math.max(1, Math.round(value)));
  const label = labels[n - 1];
  const strong = n === 5 && !safe ? label : `<strong>${label}</strong>`;
  return `
              <div class="frame-170">
                <div class="title">
                  <div class="frame-185">
                    <div class="frame-186"><img src="/images/Vectors-Wrapper_7.svg" loading="lazy" width="8" height="8" alt="" class="vectors-wrapper-56"><img src="/images/Vectors-Wrapper_8.svg" loading="lazy" width="2.305000066757202" height="3.560000419616699" alt="" class="vectors-wrapper-57"></div>
                    <div class="text-38">${title}</div>
                  </div>
                </div>
                <div class="_2">
                  <div class="frame-187">
                    <div class="frame-188">
                      <div class="frame-189">
                        <div class="text-39">${strong}</div>
                      </div>
                    </div>
                    <div class="frame-190${safe ? ' safe' : ''}">${ratingImage(n, 'vectors-wrapper-58', 'height="40.672607421875" width="129.5"')}</div>
                  </div>
                </div>
              </div>`;
}

function infoColumn(opts: { title: string; icon: string; tagline: string; safe: boolean; rating: string; html: string }): string {
  return `
      <div class="column-2">
        <div class="frame-56">
          <div class="frame-143${opts.safe ? ' safe' : ''}">
            <div class="frame-144">
              <div class="frame-145">
                <div class="frame-146">
                  <div class="text-30">${opts.title}</div>${opts.icon}
                </div>
                <div class="frame-147">
                  <div class="text-31">${opts.tagline}</div>
                  <wrapper class="vectors-wrapper-37"></wrapper>
                </div>
              </div>
              <div class="frame-148">
                <div class="frame-149"></div>
                <div class="frame-156">
                  <div class="frame-157"><img src="/images/Vectors-Wrapper_6.svg" loading="lazy" width="2.305000066757202" height="3.560000419616699" alt="" class="vectors-wrapper-43"></div>
                </div>
              </div>${opts.rating}
              <div class="frame-184"></div>
            </div>
          </div>
          <div>
            <div class="rich-text-block-2 w-richtext">${opts.html}</div>
          </div>
        </div>
      </div>`;
}

function productCards(env: LinkEnv, sup: Supplement): string {
  const products = sup.products.slice(0, 5);
  if (!products.length) return '';
  const names = products.map((p) => `<div class="text-41">${escapeHtml(p.name)}</div>`).join('\n            ');
  const cards = products
    .map((p, i) => {
      const link = escapeHtml(shopUrl(env, sup, p));
      const image = p.image
        ? `<img src="${escapeHtml(p.image)}" loading="lazy" width="306" height="305" alt="${escapeHtml(p.name)}" class="convertedimage14-4">`
        : cardImage(sup, `width="306" height="305" class="convertedimage14-4"`);
      return `
              <div id="Card" data-w-id="${PRODUCT_CARD_IDS[i]}" style="opacity:0" class="frame-114">
                <div class="frame-113">${image}
                  <div class="frame-112">
                    <div class="text-43">${escapeHtml(p.name)}${p.brand ? `<br><span style="font-size:18px;font-weight:500;line-height:24px">${escapeHtml(p.brand)}</span>` : ''}</div>
                    <a href="${link}" target="_blank" rel="noopener nofollow sponsored" class="outbutton w-button" data-track="outbound_click" data-slug="${escapeHtml(sup.slug)}" data-product="${escapeHtml(p.name)}">Buy on iHerb</a>
                  </div>
                </div>
              </div>`;
    })
    .join('');
  return `
    <section class="gallery-scroll-2">
      <div class="columns-2">
        <div class="column-12">
          <h3 class="heading-3">Top 5 Available Supplements</h3>
          <div class="frame-191">
            ${names}
          </div>
        </div>
        <div class="column-13">
          <div class="content-5">
            <div class="image-wrapper-2">${cards}
            </div>
          </div>
        </div>
      </div>
    </section>`;
}

function synergySection(sup: Supplement): string {
  if (!sup.enhancing_html && !sup.interactions_html) return '';
  return `
    <div class="frame-203">
      <div class="frame-204">
        <div data-w-id="a6669be3-1761-c7e4-ff8a-36b268ed4a9a" class="div-block">
          <div class="frame-205"></div>
          <div class="frame-206">
            <div class="text-block-10">✦ ENHANCING EFFECT</div>
            <div class="frame-208">
              <div class="rich-text-block-2 two-columns w-richtext">${sup.enhancing_html}</div>
            </div>
          </div>
          <div class="frame-206">
            <div class="frame-207">
              <div class="rich-text-block-2 two-columns w-richtext">${sup.interactions_html}</div>
            </div>
            <div class="text-block-10">⌘ POSSIBLE INTERACTIONS</div>
          </div>
        </div>
      </div>
    </div>`;
}

function insightsSection(sup: Supplement): string {
  const why = sup.why_consider
    ? `
      <div data-w-id="a6669be3-1761-c7e4-ff8a-36b268ed4aac" style="opacity:0" class="frame-209">
        <h3 class="heading-green">Why You Should Consider to take it? </h3>
        <div class="regular-on-green">${escapeHtml(sup.why_consider)}</div>
      </div>
      <div class="div-block-15"></div>`
    : '';
  const holistic = sup.holistic_html
    ? `
      <div data-w-id="73d1e791-d515-c74d-e8a9-59ee0ec00260" style="opacity:0" class="frame-209">
        <h3 class="heading-green">Holistic Highlights</h3>
        <div>
          <div class="rich-text-block-4 w-richtext">${sup.holistic_html}</div>
        </div>
      </div>
      <div class="div-block-15"></div>`
    : '';
  if (!why && !holistic) return '';
  return `
    <div class="frame-202">
      <h2 class="heading-2">Health Insights</h2>${why}${holistic}
    </div>`;
}

function studiesSection(sup: Supplement): string {
  if (!sup.studies_html) return '';
  return `
    <div data-w-id="d2583c6d-a801-58f2-5a58-efcac18e2fe2" style="opacity:0" class="frame-209 recent">
      <h3 class="heading-green recent">Relevant Studies</h3>
      <div class="rich-text-block-4 links w-richtext">${sup.studies_html}</div>
    </div>`;
}

export function renderSupplementPage(sup: Supplement, explore: Supplement[], env: LinkEnv): string {
  const body = `${navbar('logo-left')}
  <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35752" class="heading-3-columns">
    <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35753" style="-webkit-transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-moz-transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-ms-transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);opacity:0.4" class="frame-48">
      <div class="frame-49">
        <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35755" style="opacity:0" class="mask-container">
          <h1 class="heading">${escapeHtml(sup.name)}</h1>
        </div>
        <div class="frame-50">
          <div class="frame-51">
            <div class="text-10">${escapeHtml(sup.summary || `${sup.name}: benefits, dosage, safety and where to buy.`)}</div>
          </div>
          <div class="frame-52"><span class="ww-tag">${escapeHtml(sup.category)}</span>${headerBadges(sup)}</div>
        </div>
      </div>
    </div>${productPicks(env, sup)}
    <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35769" style="opacity:0.27;-webkit-transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-moz-transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-ms-transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)" class="_3-columns">
      <div class="column-5">
        <div class="frame-226">${detailImage(sup)}</div>
        <div class="frame-227">
          <div class="frame-228">
            <div class="text-61">DISCLAIMER</div>
            <div class="text-62">This content is for informational purposes and not medical advice. Results may vary.  Consult a healthcare professional before use.</div>
          </div>
        </div>
      </div>${infoColumn({
        title: 'Benefits',
        icon: '<img src="/images/Vectors-Wrapper_5.svg" loading="lazy" width="36" height="36" alt="Benefit Smiley Face" class="vectors-wrapper-36">',
        tagline: 'Empowering your journey towards optimal Well-being',
        safe: false,
        rating: ratingBlock('EFFECTIVITY', EFFECTIVITY_LABELS, sup.effectivity, false),
        html: sup.benefits_html,
      })}${infoColumn({
        title: 'Contraindications',
        icon: '<img src="/images/Frame-96.svg" loading="lazy" width="40" height="36" alt="Caution Warning" class="vectors-wrapper-36">',
        tagline: 'Navigate safely: Awareness for healthier decisions',
        safe: true,
        rating: ratingBlock('SAFETY', SAFETY_LABELS, sup.safety, true),
        html: sup.contraindications_html,
      })}
    </div>${productCards(env, sup)}
  </div>
  <section class="info">${synergySection(sup)}${insightsSection(sup)}${studiesSection(sup)}
  </section>${exploreSection(explore)}${footer()}${stickyBuyBar(env, sup)}`;

  return page({
    title: sup.name,
    description: sup.summary || `${sup.name}: benefits, contraindications, interactions and research.`,
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2 ww-has-sticky',
    head: HEAD_STYLES,
    body,
  });
}
