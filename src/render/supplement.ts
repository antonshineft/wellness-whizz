/** /supplement/:slug — the "Supplements" CMS template page. */
import { OG_IMAGES } from '../og';
import type { Supplement } from '../db';
import { MAX_PICKS, STATE_RANK, doseBlank, doseFor, doseLimits, doseLine, doseScale, type DoseCheck } from '../dose';
import { escapeHtml } from '../html';
import { EVIDENCE } from '../evidence';
import { SHOP } from '../checks';
import { shopUrl, type LinkEnv } from '../links';
import { page } from './layout';
import { INSIGHT_IMAGES } from '../insights';
import { noteLabel, notePath, type ResearchNote } from '../research';
import { reviewedLine } from './pages';
import {
  EFFECTIVITY_LABELS, SAFETY_LABELS, WF_PAGE_IDS, blendAttr, cardImage, detailImage, exploreSection, footer, headerTags, navbar,
  AFFILIATE_NOTE, productPicks, ratingImage, relatedSection, stickyBuyBar,
  batchTag, certifiedTag, studiedTag, topPickBadge, topPickUrl,
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

/** On a graded supplement the evidence grade stands where the old effectivity bars were (src/evidence.ts). */
function evidenceBlock(slug: string): string {
  const e = EVIDENCE[slug];
  const word = { A: 'Strong', B: 'Good', C: 'Mixed', D: 'Weak' }[e.grade] ?? '';
  return `
              <div class="frame-170">
                <div class="title">
                  <div class="frame-185">
                    <div class="frame-186"><img src="/images/Vectors-Wrapper_7.svg" loading="lazy" width="8" height="8" alt="" class="vectors-wrapper-56"><img src="/images/Vectors-Wrapper_8.svg" loading="lazy" width="2.305000066757202" height="3.560000419616699" alt="" class="vectors-wrapper-57"></div>
                    <div class="text-38">EVIDENCE</div>
                  </div>
                </div>
                <div class="_2">
                  <div class="frame-187">
                    <div class="frame-188">
                      <div class="frame-189">
                        <div class="text-39"><strong>${word}</strong><span style="display:block;font-size:12px;line-height:16px;font-weight:500;opacity:.85;margin-top:2px">for ${escapeHtml(e.outcome.charAt(0).toLowerCase() + e.outcome.slice(1))}</span></div>
                      </div>
                    </div>
                    <a href="/how-it-works#how-we-check" class="frame-190" style="text-decoration:none" title="${escapeHtml(`Evidence grade ${e.grade} (${word.toLowerCase()}) for: ${e.outcome}`)}"><span style="display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;border:3px solid #1d272d;color:#1d272d;font-family:Aeonik,sans-serif;font-size:30px;line-height:1;font-weight:700">${e.grade}</span></a>
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
        ? `<img src="${escapeHtml(p.image)}" loading="lazy" width="306" height="305" alt="${escapeHtml(p.name)}" class="convertedimage14-4"${blendAttr(p)}>`
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
          <h3 class="heading-3">${escapeHtml(picksHeading(sup))}</h3>
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

/** A pick's brand: a link to the brand's profile where it has one. */
function brandLabel(brand: string | undefined, brandPath?: (brand: string) => string | null): string {
  if (!brand) return '';
  const path = brandPath?.(brand);
  return path ? `<a href="${escapeHtml(path)}" class="ww-brand-link">${escapeHtml(brand)}</a>` : escapeHtml(brand);
}

/**
 * The picks section with dose scales: a numbered list of brands on the left and a two-column grid of cards on the
 * right (three rows for six picks). Picks are ordered by their verdict, best-dosed first.
 */
function picksGrid(env: LinkEnv, sup: Supplement, dose: DoseCheck | null, brandPath?: (brand: string) => string | null): string {
  const products = sup.products.slice(0, MAX_PICKS);
  if (!products.length) return '';
  // The top pick leads; the rest follow by how well the dose fits, then in the editors' order.
  const top = topPickUrl(sup, dose);
  const ranked = products
    .map((p, i) => ({ p, i, d: doseFor(dose, p.url) }))
    .sort((a, b) => Number(b.p.url === top) - Number(a.p.url === top) || (a.d ? STATE_RANK[a.d.state] : STATE_RANK.unknown) - (b.d ? STATE_RANK[b.d.state] : STATE_RANK.unknown) || a.i - b.i);
  const list = ranked
    .map((r, n) => `<li><a href="#pick-${n + 1}"><span class="ww-top-n">${n + 1}</span><span class="ww-top-brand">${escapeHtml(r.p.brand || r.p.name)}</span></a></li>`)
    .join('\n            ');
  const cards = ranked
    .map((r, n) => {
      const p = r.p;
      const image = p.image
        ? `<img src="${escapeHtml(p.image)}" loading="lazy" width="200" height="200" alt="${escapeHtml(p.name)}"${blendAttr(p)}>`
        : cardImage(sup, 'width="200" height="200"');
      return `
            <article class="ww-top-card" id="pick-${n + 1}">
              <span class="ww-top-n" aria-hidden="true">${n + 1}</span>
              <div class="ww-top-photo">${image}${p.url === top ? topPickBadge() : ''}</div>
              <div class="ww-top-name">${escapeHtml(p.name)}</div>
              <div class="ww-top-meta">${brandLabel(p.brand, brandPath)}${r.d && dose ? `${p.brand ? ' · ' : ''}${doseLine(dose, r.d)}` : ''}</div>
              ${certifiedTag(p.url)}${batchTag(SHOP[p.url]?.report)}${studiedTag(p.url)}
              ${r.d && dose ? doseScale(dose, r.d) : doseLimits(dose, p.url) ?? doseBlank(dose, false, sup.name)}
              <a href="${escapeHtml(shopUrl(env, sup, p))}" target="_blank" rel="noopener nofollow sponsored" class="outbutton w-button" data-track="outbound_click" data-slug="${escapeHtml(sup.slug)}" data-product="${escapeHtml(p.name)}">Buy on iHerb</a>
            </article>`;
    })
    .join('');
  return `
    <section class="ww-top" aria-label="Top picks">
      <div class="ww-top-side">
        <h2 class="heading-3">${escapeHtml(picksHeading(sup).replace('Top 5 Picks', `Top ${products.length} Picks`))}</h2>
        <p class="ww-top-how">${dose ? 'Our top pick first: it is independently tested and its dose fits. The rest follow by how well one serving fits the reference range.' : 'In our editors\' order.'} <a href="/how-it-works#how-we-check">How we check</a></p>
        <ol class="ww-top-list">
            ${list}
        </ol>
      </div>
      <div class="ww-top-main">
        <div class="ww-top-grid">${cards}
        </div>
      </div>
    </section>`;
}

function synergySection(sup: Supplement): string {
  if (!sup.enhancing_html && !sup.interactions_html) return '';
  // The band's picture: this supplement's own (src/insights.ts) where one has been made, else the shared one.
  const own = INSIGHT_IMAGES.has(sup.slug)
    ? ` ww-insight" style="--ww-insight:url('/images/insights/${escapeHtml(sup.slug)}.webp');--ww-insight-m:url('/images/insights/${escapeHtml(sup.slug)}-m.webp')`
    : '';
  return `
    <div class="frame-203${own}">
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

const INSIGHT_SHARE = {
  x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.5 7.4L3 21l2.2-5.3A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.2-1.2"/></svg>',
};

/** Share row under "Why consider …": the same round green buttons as the quiz result's share block. */
function insightShare(sup: Supplement, origin: string): string {
  const url = `${origin}/supplement/${sup.slug}`;
  const text = `${sup.name}: what it does, who it suits and what the studies say`;
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const waHref = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
  return `
          <div class="ww-ishare" data-ishare data-url="${escapeHtml(url)}" data-title="${escapeHtml(text)}">
            <span class="ww-ishare-label">Share</span>
            <a class="ww-ishare-btn" href="${escapeHtml(xHref)}" target="_blank" rel="noopener"><span>${INSIGHT_SHARE.x}</span><b>Post</b></a>
            <a class="ww-ishare-btn" href="${escapeHtml(waHref)}" target="_blank" rel="noopener"><span>${INSIGHT_SHARE.whatsapp}</span><b>WhatsApp</b></a>
            <button class="ww-ishare-btn" type="button" data-ishare-copy><span>${INSIGHT_SHARE.link}</span><b>Copy link</b></button>
          </div>`;
}

const GUIDE_TAGS: [RegExp, string][] = [
  [/^\s*what\b/i, 'What'],
  [/^\s*who\b/i, 'Who'],
  [/^\s*how\b|dos(e|age)|safely/i, 'How'],
  [/sleep|diet|training|habit|lifestyle|routine/i, 'Lifestyle'],
];

/**
 * The stored guide as cards. Newer guides are a title, an opening paragraph, h4 chapters and a "Key takeaways" list;
 * older ones are a title and three or four chapters under h2 headings. Either way the first heading is the title,
 * what follows it is the opening, and every later heading starts a chapter card. Chapters get a one-word label when
 * every one of them answers a plain question (what, who, how, lifestyle); otherwise they are numbered.
 * A guide with fewer than two headings is shown as it was written.
 */
function guideCards(html: string): string {
  const heads = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  if (heads.length < 2) return `<div class="rich-text-block-4 w-richtext ww-fg-plain">${html}</div>`;
  const end = (i: number) => (i + 1 < heads.length ? heads[i + 1].index! : html.length);
  const body = (i: number) => html.slice(heads[i].index! + heads[i][0].length, end(i)).trim();
  const before = html.slice(0, heads[0].index!).trim();
  const chapters = heads.slice(1).map((h, k) => {
    const plain = h[2].replace(/<[^>]+>/g, '').trim();
    return { heading: h[2].trim(), plain, content: body(k + 1), take: /takeaway|bottom line|in short|summary|conclusion/i.test(plain) };
  });
  const tags = chapters.map((c) => (c.take ? '' : GUIDE_TAGS.find(([re]) => re.test(c.plain))?.[1] ?? ''));
  const named = chapters.filter((c) => !c.take);
  const worded = named.length > 0 && chapters.every((c, i) => c.take || tags[i]) && new Set(tags.filter(Boolean)).size === named.length;
  let n = 0;
  const cards = chapters
    .map((c, i) => {
      if (c.take) return `
            <div class="ww-fg-card is-take"><h4>${c.heading}</h4>${c.content}</div>`;
      n += 1;
      const tag = worded ? `<span class="ww-fg-tag">${tags[i]}</span>` : `<span class="ww-fg-tag is-num">${n}</span>`;
      return `
            <div class="ww-fg-card">${tag}<h4>${c.heading}</h4>${c.content}</div>`;
    })
    .join('');
  return `<div class="ww-fg">
          <div class="ww-fg-intro rich-text-block-4 w-richtext">${before}<h3>${heads[0][2].trim()}</h3>${body(0)}</div>
          <div class="ww-fg-grid">${cards}
          </div>
        </div>`;
}

/** "Health Insights": the why, the guide and the research as three cards that stack while the heading stays in view. */
function insightsSection(sup: Supplement, research: string, origin: string): string {
  const why = sup.why_consider
    ? `
      <i class="ww-stack-mark" aria-hidden="true"></i>
      <div class="frame-209 ww-stack-card">
        <h3 class="heading-green">Why consider ${escapeHtml(sup.name)}?</h3>
        <div class="ww-stack-clip"><div class="ww-stack-scroll ww-why-body">
          <div class="regular-on-green">${escapeHtml(sup.why_consider)}</div>${insightShare(sup, origin)}
        </div></div>
      </div>
      <i class="ww-stack-space" aria-hidden="true"></i>`
    : '';
  const holistic = sup.holistic_html
    ? `
      <i class="ww-stack-mark" aria-hidden="true"></i>
      <div class="frame-209 ww-stack-card is-guide">
        <h3 class="heading-green">The full guide</h3>
        <div class="ww-stack-clip"><div class="ww-stack-scroll ww-fg-wrap">
          ${guideCards(sup.holistic_html)}
        </div></div>
      </div>
      <i class="ww-stack-space" aria-hidden="true"></i>`
    : '';
  if (!why && !holistic && !research) return '';
  return `
    <div class="frame-202 ww-stack" data-ww-stack>
      <h2 class="heading-2 ww-stack-head">Health Insights</h2>${why}${holistic}${research}
    </div>`;
}

/** One classic study from the stored list, as the same kind of row a research note gets: its title, then the journal and year. */
function studyItems(html: string | undefined): string {
  if (!html) return '';
  return [...html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => {
      const text = m[2].replace(/<[^>]+>/g, '').trim();
      const cut = text.search(/\s[\u2014\u2013-]\s(?!.*\s[\u2014\u2013-]\s)/);
      const title = cut > 0 ? text.slice(0, cut) : text;
      const meta = cut > 0 ? text.slice(cut).replace(/^\s[\u2014\u2013-]\s/, '') : '';
      return `
          <li class="ww-rl-item">
            <a href="${m[1]}" class="ww-rl-title" target="_blank" rel="noopener">${title}</a>${meta ? `
            <span class="ww-rl-meta">${meta}</span>` : ''}
          </li>`;
    })
    .join('');
}

/**
 * "Research": one block for both kinds of source. The newest notes about this supplement come first, each linking its
 * own page under /research/, then the classic studies the page was written from.
 */
function researchSection(sup: Supplement, notes: readonly ResearchNote[]): string {
  const latest = notes
    .map(
      (n) => `
          <li class="ww-rl-item">
            <a href="${escapeHtml(notePath(n))}" class="ww-rl-title">${escapeHtml(n.title)}</a>
            <span class="ww-rl-meta">${noteLabel(n)}${n.pub_type ? ` \u00b7 ${escapeHtml(n.pub_type)}` : ''}</span>${n.takeaway ? `
            <p class="ww-rl-take">${escapeHtml(n.takeaway)}</p>` : ''}
          </li>`,
    )
    .join('');
  const classic = studyItems(sup.studies_html);
  // A stored list this cannot read as links is shown as it was written.
  const classicBlock = classic
    ? `<ul class="ww-rl-list">${classic}
        </ul>`
    : sup.studies_html ? `<div class="w-richtext">${sup.studies_html}</div>` : '';
  if (!latest && !classicBlock) return '';
  return `
    <i class="ww-stack-mark" aria-hidden="true"></i>
    <div class="frame-209 recent ww-rl ww-stack-card" id="research">
      <h3 class="heading-green recent">Research</h3>
      <div class="ww-stack-clip"><div class="ww-stack-scroll rich-text-block-4 links ww-rl-body">${latest && classicBlock ? `
        <div class="ww-rl-tabs">
          <input type="radio" name="ww-rl" id="ww-rl-new" class="ww-rl-radio" checked>
          <input type="radio" name="ww-rl" id="ww-rl-key" class="ww-rl-radio">
          <div class="ww-rl-seg"><label for="ww-rl-new">New studies</label><label for="ww-rl-key">Key studies</label></div>
          <div class="ww-rl-panel is-new">
            <ul class="ww-rl-list">${latest}
            </ul>
            <p class="ww-rl-more"><a href="/research">All research notes</a></p>
          </div>
          <div class="ww-rl-panel is-key">
            ${classicBlock}
          </div>
        </div>` : `${latest ? `
        <h4 class="ww-rl-group">New studies</h4>
        <ul class="ww-rl-list">${latest}
        </ul>
        <p class="ww-rl-more"><a href="/research">All research notes</a></p>` : ''}${classicBlock ? `
        <h4 class="ww-rl-group">Key studies</h4>
        ${classicBlock}` : ''}`}
      </div></div>
    </div>
    <i class="ww-stack-space" aria-hidden="true"></i>`;
}

/** "Common Questions": the answers to what people search for about this supplement, as an accordion. */
function faqSection(sup: Supplement): string {
  if (!sup.faqs.length) return '';
  const items = sup.faqs
    .map(
      (f, i) => `
        <details class="ww-qa-item"${i === 0 ? ' open' : ''}>
          <summary class="ww-qa-q"><h3>${escapeHtml(f.q)}</h3><span class="ww-qa-chevron" aria-hidden="true"></span></summary>
          <div class="ww-qa-a"><p>${escapeHtml(f.a)}</p></div>
        </details>`,
    )
    .join('');
  return `
    <div class="frame-202 ww-qa" id="faq">
      <h2 class="heading-2">Common Questions</h2>
      <div class="ww-qa-list">${items}
      </div>
    </div>`;
}

export interface SupplementPageExtras {
  related?: Supplement[];
  /** Site origin for canonical URL and structured data. */
  origin?: string;
  /** The newest research notes about this supplement (src/research.ts), shown as "Latest Research". */
  notes?: readonly ResearchNote[];
  /**
   * The dose check for this supplement's picks (src/dose.ts). Undefined keeps the old picks section; a check, or
   * null when the page has none yet, shows the new one: brands on the left, a grid of cards with scales on the right.
   */
  dose?: DoseCheck | null;
  /** The strip of running brand logos, shown above the footer (src/render/brand.ts); empty or absent leaves it out. */
  brandStrip?: string;
  /** The path of a brand's profile page for a pick's brand name, or null when it has none: brand names then become links. */
  brandPath?: (brand: string) => string | null;
}

function seoHead(sup: Supplement, origin: string): string {
  const url = `${origin}/supplement/${sup.slug}`;
  const reviewed = (sup.updated_at || sup.created_at || '').slice(0, 10);
  const product = sup.products.find((p) => p.image);
  const image = product?.image ? new URL(product.image, origin).toString() : null;
  // What a shared link shows: the page's own card (name, a short line, its molecule) where one has been drawn
  // (scripts/og/build.cjs), else the first product photo as before.
  const card = OG_IMAGES.has(sup.slug) ? `${origin}/images/og/${sup.slug}.jpg` : null;
  const safe = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
  // The page is described as a MedicalWebPage about a Substance rather than as a DietarySupplement: that type is a
  // Product subtype, and Google (and so Semrush) treats a Product without offers, a review or a rating as an error.
  const webPage = {
    '@context': 'https://schema.org',
    '@type': 'MedicalWebPage',
    '@id': url,
    url,
    name: seoTitle(sup),
    description: sup.summary,
    inLanguage: 'en',
    ...(image ? { primaryImageOfPage: { '@type': 'ImageObject', url: image } } : {}),
    isPartOf: { '@type': 'WebSite', name: 'Wellness Whizz', url: `${origin}/` },
    publisher: { '@type': 'Organization', name: 'Wellness Whizz', url: `${origin}/` },
    about: { '@type': 'Substance', name: sup.name, description: sup.summary },
    ...(reviewed ? { datePublished: sup.created_at.slice(0, 10), dateModified: reviewed, lastReviewed: reviewed } : {}),
    reviewedBy: { '@type': 'Organization', name: 'Wellness Whizz editorial team', url: `${origin}/about` },
  };
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: 'Supplements', item: `${origin}/supplements` },
      { '@type': 'ListItem', position: 3, name: sup.name, item: url },
    ],
  };
  const faqPage = sup.faqs.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: sup.faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }
    : null;
  return `
  <link rel="canonical" href="${escapeHtml(url)}">${card ? `\n  <meta property="og:image" content="${escapeHtml(card)}">\n  <meta property="og:image:type" content="image/jpeg">\n  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">\n  <meta property="og:image:alt" content="${escapeHtml(sup.name)}: ${escapeHtml(sup.summary)}">\n  <meta name="twitter:image" content="${escapeHtml(card)}">` : image ? `\n  <meta property="og:image" content="${escapeHtml(image)}">\n  <meta name="twitter:image" content="${escapeHtml(image)}">` : ''}
  <script type="application/ld+json">${safe(webPage)}</script>
  <script type="application/ld+json">${safe(breadcrumbs)}</script>${faqPage ? `\n  <script type="application/ld+json">${safe(faqPage)}</script>` : ''}`;
}

/**
 * Titles that match how people actually search for a page (from the Semrush keyword export), keyed by the slug
 * without its hash. Everything else gets the generic "Name: Benefits, Dosage, Safety & Where to Buy" pattern.
 */
const SEO_TITLES: Record<string, string> = {
  'green-superfood-powders': 'Super Greens Powder: Benefits, Best Picks & Safety',
  'whey-protein-isolate': 'Whey Isolate vs Whey Protein: Benefits & Best Picks',
  'womens-health-supplements': 'Best Vitamins for Women: Daily Picks, Dosage & Safety',
  'mens-health-supplements': 'Best Supplements for Men: Picks, Dosage & Safety',
  'protein-bars': 'Best Protein Bars for Weight Loss: Picks & Safety',
  'prenatal-vitamins': 'Best Prenatal Vitamins: What to Look For & Safety',
  'fiber-supplements': 'Best Fiber Supplements & Gummies: Picks & Safety',
  'electrolyte-drinks': 'Electrolytes: What They Are, When to Take & Safety',
  'sleep-aids': 'Best Natural Sleep Aids: What Works & Safety',
  'meal-replacement-shakes': 'Best Meal Replacement Shakes for Weight Loss & Safety',
  'weight-management-supplements': 'Weight Loss Supplements: What Works, Safety & Picks',
  'pre-workout-supplements': 'Best Pre Workout Supplements: Picks, Dosage & Safety',
  'resveratrol': 'Best Resveratrol Supplement: Dosage, Safety & Picks',
  'l-theanine': 'Best L-Theanine Supplement: Dosage, Safety & Picks',
  'quercetin': 'Best Quercetin Supplement: Dosage, Safety & Picks',
  'choline': 'Best Choline Supplements: Dosage, Safety & Picks',
  'thyroid-support-supplements': 'Thyroid Support Supplements: What Helps & Safety',
  'urinary-tract-support-supplements': 'Urinary Tract Health Supplements: Picks & Safety',
  'heart-health-supplements': 'Heart Health Supplements: What Helps & Safety',
  'joint-health-supplements': 'Joint Health Supplements: What Helps & Safety',
  'energy-bars': 'Energy Bars: Benefits, Best Picks & Safety',
};

/** "Top 5" heading phrased the way buyers search ("best magnesium supplements"). */
function picksHeading(sup: Supplement): string {
  const name = sup.name.trim();
  if (/\b(health|management|support)$/i.test(name)) return `Best ${name} Supplements: Top 5 Picks`;
  if (/(supplements?|vitamins|bars|shakes|powders|proteins?|boosters|aids|extracts?|oil|drinks|pollen|isolate)$/i.test(name) || name.includes('(')) {
    return `Best ${name}: Top 5 Picks`;
  }
  return `Best ${name} Supplements: Top 5 Picks`;
}

/** Keep titles under about 60 characters including the site name the layout appends. */
function seoTitle(sup: Supplement): string {
  const custom = SEO_TITLES[sup.slug.replace(/-[0-9a-f]{5}$/, '')];
  if (custom) return custom;
  const suffix = ' | Wellness Whizz'.length;
  for (const candidate of [
    `${sup.name}: Benefits, Dosage, Safety & Where to Buy`,
    `${sup.name}: Benefits, Dosage & Safety`,
    `${sup.name}: Benefits & Safety`,
    `${sup.name} Guide`,
  ]) {
    if (candidate.length + suffix <= 60) return candidate;
  }
  return sup.name;
}

function seoDescription(sup: Supplement): string {
  const effectivity = Math.min(5, Math.max(1, Math.round(sup.effectivity)));
  const safety = Math.min(5, Math.max(1, Math.round(sup.safety)));
  const base = (sup.summary || `${sup.name}: benefits, contraindications, interactions and research.`).trim();
  const tail = ` ${EVIDENCE[sup.slug] ? `Evidence grade ${EVIDENCE[sup.slug].grade}` : `Effectivity ${effectivity}/5`}, safety ${safety}/5, with contraindications, interactions, studies and ${sup.products.length ? `${sup.products.length} products to buy on iHerb` : 'where to buy on iHerb'}.`;
  const text = base.length + tail.length <= 300 ? base + tail : base.slice(0, 300 - tail.length).replace(/\s+\S*$/, '') + tail;
  return text.slice(0, 300);
}

/** A word the giant hero heading cannot wrap ("Acetylcysteine") gets a smaller size (.heading--long in wellness-extras.css). */
const longWord = (name: string) => name.split(/\s+/).some((w) => w.replace(/[()]/g, '').length > 11);
/** The hero title's size class: a name with a very long word, or one too long for a line, is set smaller. */
const titleSize = (name: string) => (longWord(name) ? ' heading--long' : name.length > 30 ? ' heading--s' : name.length > 15 ? ' heading--m' : '');

/** Generated rich text sometimes contains <h1>; a page keeps one h1 (the supplement name), so inner ones become h2. */
const demoteH1 = <T extends string | null | undefined>(html: T): T => (html ? (html.replace(/<(\/?)h1\b/gi, '<$1h2') as T) : html);

export function renderSupplementPage(input: Supplement, explore: Supplement[], env: LinkEnv, extras: SupplementPageExtras = {}): string {
  const sup: Supplement = {
    ...input,
    benefits_html: demoteH1(input.benefits_html),
    contraindications_html: demoteH1(input.contraindications_html),
    enhancing_html: demoteH1(input.enhancing_html),
    interactions_html: demoteH1(input.interactions_html),
    holistic_html: demoteH1(input.holistic_html),
    studies_html: demoteH1(input.studies_html),
  };
  const body = `${navbar('logo-left')}
  <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35752" class="heading-3-columns">
    <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35753" style="-webkit-transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-moz-transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-ms-transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);transform:translate3d(0, 34px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);opacity:0.4" class="frame-48">
      <div class="frame-49">
        <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35755" style="opacity:0" class="mask-container">
          <h1 class="heading${titleSize(sup.name)}">${escapeHtml(sup.name)}</h1>
        </div>
        <div class="frame-50">
          <div class="frame-51">
            <div class="text-10">${escapeHtml(sup.summary || `${sup.name}: benefits, dosage, safety and where to buy.`)}</div>
          </div>
        </div>
        <div class="ww-hero-foot">
          ${reviewedLine(sup.updated_at || sup.created_at, '', false)}
          <div class="frame-52">${headerTags(sup)}</div>
        </div>
      </div>
    </div>${productPicks(env, sup)}
    <div data-w-id="2841e5e2-b1d4-d414-f4f8-0c4efba35769" style="opacity:0.27;-webkit-transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-moz-transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);-ms-transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0);transform:translate3d(0, 50px, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)" class="_3-columns">
      <div class="column-5">
        <div class="frame-226">${detailImage(sup)}</div>
        <div class="frame-227">
          <div class="frame-228">
            <div class="text-61">DISCLAIMER</div>
            <div class="text-62">This content is for informational purposes and not medical advice. Results may vary.  Consult a healthcare professional before use. ${AFFILIATE_NOTE} <a href="/about#disclaimer" class="ww-disclaimer-link">Read the full medical disclaimer</a></div>
          </div>
        </div>
      </div>${infoColumn({
        title: 'Benefits',
        icon: '<img src="/images/Vectors-Wrapper_5.svg" loading="lazy" width="36" height="36" alt="Benefit Smiley Face" class="vectors-wrapper-36">',
        tagline: 'What trials found, strongest evidence first',
        safe: false,
        rating: EVIDENCE[sup.slug] ? evidenceBlock(sup.slug) : ratingBlock('EFFECTIVITY', EFFECTIVITY_LABELS, sup.effectivity, false),
        html: sup.benefits_html,
      })}${infoColumn({
        title: 'Contraindications',
        icon: '<img src="/images/Frame-96.svg" loading="lazy" width="40" height="36" alt="Caution Warning" class="vectors-wrapper-36">',
        tagline: 'Who should skip it or ask a doctor first',
        safe: true,
        rating: ratingBlock('SAFETY', SAFETY_LABELS, sup.safety, true),
        html: sup.contraindications_html,
      })}
    </div>${extras.dose === undefined ? productCards(env, sup) : picksGrid(env, sup, extras.dose, extras.brandPath)}
  </div>
  <section class="info">${synergySection(sup)}${insightsSection(sup, researchSection(sup, extras.notes ?? []), extras.origin ?? 'https://aiww.io')}${faqSection(sup)}
  </section>${relatedSection(extras.related ?? [], `Browse all ${explore.length || ''} supplements`)}${extras.brandStrip ?? ''}${footer()}${stickyBuyBar(env, sup)}`;

  return page({
    title: seoTitle(sup),
    description: seoDescription(sup),
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2 ww-has-sticky',
    head: HEAD_STYLES + (extras.origin ? seoHead(sup, extras.origin) : ''),
    body,
    scripts: '  <script src="/js/insights.js" defer></script>',
  });
}
