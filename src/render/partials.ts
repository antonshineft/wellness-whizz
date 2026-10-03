/** Reusable fragments that mirror the exported Webflow markup (same classes, so the exported CSS applies). */
import type { FdaStatus, FormType, Product, SafetyStatus, Supplement } from '../db';
import { escapeHtml } from '../html';
import { primaryProduct, shopUrl, type LinkEnv } from '../links';

export const WF_SITE_ID = '65945a814598016172123fbf';
export const WF_PAGE_IDS = {
  home: '65945a814598016172123fc5',
  quiz: '65c62ed2a0336ec29fe56900',
  result: '65c8ededb28fe27c777ca021',
  supplement: '65b279f3722615f329b470f3',
  notFound: '65cded0cf390161c415e500d',
} as const;

/** Images used on result cards and the home slider, per dosage form. */
const CARD_IMAGES: Record<FormType, { src: string; srcset: string }> = {
  capsule: { src: 'Capsule.png', srcset: 'Capsule-p-500.png 500w, Capsule.png 525w' },
  softgel: { src: 'Softgel-1.png', srcset: 'Softgel-1-p-500.png 500w, Softgel-1.png 525w' },
  small_softgel: { src: 'Small-Softgel.png', srcset: 'Small-Softgel-p-500.png 500w, Small-Softgel.png 525w' },
  tablet: { src: 'Tablet.png', srcset: 'Tablet-p-500.png 500w, Tablet.png 525w' },
  powder: { src: 'powder.jpg', srcset: 'powder-p-500.jpg 500w, powder-p-800.jpg 800w, powder.jpg 1024w' },
  bar: { src: 'Bar-1.png', srcset: 'Bar-1-p-500.png 500w, Bar-1.png 525w' },
  gummy: { src: 'Gummy.png', srcset: 'Gummy-p-500.png 500w, Gummy.png 525w' },
  drops: { src: 'Powder.png', srcset: 'Powder-p-500.png 500w, Powder.png 525w' }, // this file is the dropper illustration
};

/** Images used in the big tile on the supplement detail page, per dosage form. */
const DETAIL_IMAGES: Record<FormType, { src: string; srcset: string; cls: string }> = {
  softgel: { src: 'softgels.png', srcset: 'softgels-p-500.png 500w, softgels.png 654w', cls: 'form' },
  small_softgel: { src: 'smallsoft.png', srcset: 'smallsoft-p-500.png 500w, smallsoft.png 654w', cls: 'image-2' },
  powder: { src: 'powder.jpg', srcset: 'powder-p-500.jpg 500w, powder-p-800.jpg 800w, powder.jpg 1024w', cls: 'image-3' },
  capsule: { src: 'Frame-227-1.png', srcset: 'Frame-227-1-p-500.png 500w, Frame-227-1.png 654w', cls: 'image-3' },
  tablet: { src: 'tablets.png', srcset: 'tablets-p-500.png 500w, tablets.png 654w', cls: '' },
  drops: { src: 'DROPS-1.png', srcset: 'DROPS-1-p-500.png 500w, DROPS-1.png 635w', cls: '' },
  bar: { src: 'bar-3.png', srcset: 'bar-3-p-500.png 500w, bar-3.png 654w', cls: '' },
  gummy: { src: 'gummy-2.png', srcset: 'gummy-2-p-500.png 500w, gummy-2.png 654w', cls: '' },
};

const FDA_BADGES: Record<FdaStatus, { src: string; alt: string }> = {
  approved: { src: 'FDA-Yes.png', alt: 'FDA approved' },
  probably_ok: { src: 'FDA-Ok.png', alt: 'FDA probably ok' },
  not_approved: { src: 'FDA-No.png', alt: 'Not approved by FDA' },
};

const SAFETY_BADGES: Record<SafetyStatus, { src: string; alt: string; width: number }> = {
  safe: { src: 'Safe-Yes.png', alt: 'Safe', width: 80 },
  ok: { src: 'Safe-Ok.png', alt: 'Safe Ok', width: 78 },
  not_safe: { src: 'Safe-No.png', alt: 'Not safe', width: 111 },
  prescription: { src: 'Safe-Prescription.png', alt: 'Need Prescription', width: 139 },
};

export const EFFECTIVITY_LABELS = ['Possible', 'Supportive', 'Reasonable', 'Potent', 'Clinically Proven'] as const;
export const SAFETY_LABELS = ['Cautionary', 'Mild Risk', 'Secure', 'Safe', 'Proven Safe'] as const;

/** Path of the image the result card shows: the supplement's own picture, else the illustration for its form. */
export function cardImageSrc(sup: Supplement): string {
  return sup.image || `/images/${(CARD_IMAGES[sup.form_type] ?? CARD_IMAGES.capsule).src}`;
}

export function cardImage(sup: Supplement, attrs: string): string {
  if (sup.image) return `<img src="${escapeHtml(sup.image)}" loading="lazy" alt="${escapeHtml(sup.name)}" ${attrs}>`;
  const img = CARD_IMAGES[sup.form_type] ?? CARD_IMAGES.capsule;
  return `<img src="/images/${img.src}" srcset="${withPrefix(img.srcset)}" loading="lazy" alt="${escapeHtml(sup.name)}" ${attrs}>`;
}

export function detailImage(sup: Supplement): string {
  if (sup.image) return `<img src="${escapeHtml(sup.image)}" loading="lazy" alt="${escapeHtml(sup.name)}" class="image-3 ww-generated-tile">`;
  const img = DETAIL_IMAGES[sup.form_type] ?? DETAIL_IMAGES.capsule;
  const cls = img.cls ? ` class="${img.cls}"` : '';
  return `<img src="/images/${img.src}" srcset="${withPrefix(img.srcset)}" sizes="(max-width: 479px) 100vw, (max-width: 767px) 73vw, (max-width: 991px) 349.990234375px, 35vw" loading="lazy" alt="${escapeHtml(sup.name)}"${cls}>`;
}

function withPrefix(srcset: string): string {
  return srcset
    .split(',')
    .map((part) => '/images/' + part.trim())
    .join(', ');
}

/** Badges as used in the home slider and supplement header (safety first, then FDA). */
export function headerBadges(sup: Supplement): string {
  const safety = SAFETY_BADGES[sup.safety_status];
  const fda = FDA_BADGES[sup.fda_status];
  return (
    `<img src="/images/${safety.src}" loading="lazy" width="${safety.width}" alt="${safety.alt}">` +
    `<img src="/images/${fda.src}" loading="lazy" width="78" alt="${fda.alt}">`
  );
}

const FDA_TAGS: Record<FdaStatus, { glyph: string; label: string }> = {
  approved: { glyph: '✓', label: 'FDA approved' },
  probably_ok: { glyph: '?', label: 'FDA unverified' },
  not_approved: { glyph: '−', label: 'Not FDA approved' },
};
const SAFETY_TAGS: Record<SafetyStatus, { glyph: string; label: string }> = {
  safe: { glyph: '✓', label: 'Safe' },
  ok: { glyph: '?', label: 'Mostly safe' },
  not_safe: { glyph: '−', label: 'Not safe' },
  prescription: { glyph: '!', label: 'Prescription' },
};

/** Header tags on supplement pages: category, safety and FDA as uniform text tags (same size as result-card tags). */
export function headerTags(sup: Supplement): string {
  const fda = FDA_TAGS[sup.fda_status];
  const safety = SAFETY_TAGS[sup.safety_status];
  const safetyCls = sup.safety_status === 'safe' ? ' ww-tag-good' : sup.safety_status === 'ok' ? '' : ' ww-tag-warn';
  return (
    `<span class="ww-tag">${escapeHtml(sup.category)}</span>` +
    `<span class="ww-tag${safetyCls}"><b>${safety.glyph}</b>${escapeHtml(safety.label)}</span>` +
    `<span class="ww-tag ww-tag-dark"><b>${fda.glyph}</b>${escapeHtml(fda.label)}</span>`
  );
}

/** Uniform text tags for result cards: FDA (dark), safety, category, form, effectivity. */
export function cardTags(sup: Supplement, formLabel: string): string {
  const fda = FDA_TAGS[sup.fda_status];
  const safety = SAFETY_TAGS[sup.safety_status];
  const n = Math.min(5, Math.max(1, Math.round(sup.effectivity)));
  const bars = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}" style="height:${4 + i * 2}px"></i>`).join('');
  return (
    `<span class="ww-tag ww-tag-dark"><b>${fda.glyph}</b>${escapeHtml(fda.label)}</span>` +
    `<span class="ww-tag"><b>${safety.glyph}</b>${escapeHtml(safety.label)}</span>` +
    `<span class="ww-tag">${escapeHtml(sup.category)}</span>` +
    (formLabel ? `<span class="ww-tag">${escapeHtml(formLabel)}</span>` : '') +
    `<span class="ww-tag ww-tag-dark" title="Effectivity ${n} of 5">Effectivity<span class="ww-bars">${bars}</span>${n}/5</span>`
  );
}

/** Badges as used on result cards (FDA first, then safety, fixed 32px height). */
export function cardBadges(sup: Supplement): string {
  const safety = SAFETY_BADGES[sup.safety_status];
  const fda = FDA_BADGES[sup.fda_status];
  return (
    `<img src="/images/${fda.src}" loading="lazy" width="75" height="32" alt="${fda.alt}" class="vectors-wrapper-80">` +
    `<img src="/images/${safety.src}" loading="lazy" width="74" height="32" alt="${safety.alt}" class="vectors-wrapper-81">`
  );
}

export function ratingImage(value: number, cls: string, extra = ''): string {
  const n = Math.min(5, Math.max(1, Math.round(value)));
  return `<img src="/images/Rate${n}.png" loading="lazy" alt="${n} out of 5" class="${cls}" ${extra}>`;
}

export function navbar(variant: 'default' | 'logo-left' = 'default', currentQuiz = false): string {
  const cls = variant === 'logo-left' ? 'navbar-logo-left w-nav' : 'navbar w-nav';
  const easing = variant === 'logo-left' ? 'ease-in-back' : 'ease';
  const current = currentQuiz ? ' aria-current="page"' : '';
  const currentCls = currentQuiz ? ' w--current' : '';
  return `
  <div data-animation="default" data-collapse="medium" data-duration="400" data-easing="${easing}" data-easing2="ease" role="banner" class="${cls}">
    <div class="navbarcontainer container w-container">
      <div class="navbar-brand">
        <a href="/" class="link-block-3 w-inline-block">
          <div class="logo"><img src="/images/Vectors-Wrapper_4.svg" loading="lazy" width="66.23321533203125" height="66.23321533203125" alt="" class="vectors-wrapper"><img src="/images/Vectors-Wrapper.svg" loading="lazy" width="233.07275390625" height="23.488250732421875" alt="Wellness Whizz" class="vectors-wrapper-6"></div>
        </a>
      </div>
      <div class="navbar-content">
        <nav role="navigation" class="navbar-menu w-nav-menu">
          <div class="div-block-8">
            <a href="https://chat.openai.com/g/g-pqcxd1t8o-wellness-whizz" target="_blank" rel="noopener" aria-label="Wellness Whizz GPT on ChatGPT" class="navbar-link w-nav-link"><img src="/images/Vectors-Wrapper_1.svg" loading="lazy" width="26.173086166381836" height="26.520586013793945" alt="ChatGPT" class="vectors-wrapper-7"></a>
            <a href="https://www.tiktok.com/@theaiwellnesswhiz?_t=8jPysLbiyxN&amp;_r=1" target="_blank" rel="noopener" aria-label="Wellness Whizz on TikTok" class="navbar-link w-nav-link"><img src="/images/Vectors-Wrapper_2.svg" loading="lazy" width="23.03125" height="26.520832061767578" alt="TikTok" class="vectors-wrapper-8"></a>
            <a href="https://x.com/aiwwio" target="_blank" rel="noopener" aria-label="Wellness Whizz on X" class="navbar-link w-nav-link"><img src="/images/x-logo.svg" loading="lazy" width="26" height="26" alt="X (Twitter)" class="vectors-wrapper-9 ww-x-icon"></a>
          </div>
          <a href="/wellness-quiz"${current} class="bignavbutton w-button${currentCls}">Get Started</a>
        </nav>
      </div>
      <div class="menu-button w-nav-button">
        <div class="icon w-icon-nav-menu"></div>
      </div>
    </div>
  </div>`;
}

export function footer(): string {
  return `
  <section class="footer">
    <footer id="Footer" class="frame-217">
      <div class="text-55">Your Personalized Supplement AI Advisor</div>
      <div class="frame-218">
        <div data-w-id="2b9b101a-68ad-ad8d-3793-d3601abc8c34" class="wellness">WELLNESS WHIZZ </div><img src="/images/Vectors-Wrapper_13.svg" loading="lazy" width="150.27268981933594" height="145.3221435546875" alt="" data-w-id="2b9b101a-68ad-ad8d-3793-d3601abc8c36" class="vectors-wrapper-63"><img src="/images/Vectors-Wrapper_12.svg" loading="lazy" width="152.4515380859375" height="117.09674835205078" alt="" data-w-id="2b9b101a-68ad-ad8d-3793-d3601abc8c37" class="vectors-wrapper-62"><img src="/images/Vectors-Wrapper_15.svg" loading="lazy" width="109" height="187.63829040527344" alt="" data-w-id="2b9b101a-68ad-ad8d-3793-d3601abc8c38" class="vectors-wrapper-65"><img src="/images/Vectors-Wrapper_16.svg" loading="lazy" width="152" height="203.06663513183594" alt="" data-w-id="2b9b101a-68ad-ad8d-3793-d3601abc8c39" class="vectors-wrapper-66"><img src="/images/Vectors-Wrapper_14.svg" loading="lazy" width="153.16067504882812" height="139.3534393310547" alt="" data-w-id="2b9b101a-68ad-ad8d-3793-d3601abc8c3a" class="vectors-wrapper-64">
      </div>
      <a data-w-id="af3b4a1d-4e56-d54b-44c8-76282d422767" href="/wellness-quiz" class="footerbutton w-inline-block">
        <div class="text-57">Start Quiz Now</div>
      </a>
      <div class="frame-220">
        <div class="frame-221">
          <a href="/supplements" class="text-58 ww-footer-link">Supplements</a>
          <a href="/blog" class="text-58 ww-footer-link">Blog</a>
          <a href="/research" class="text-58 ww-footer-link">Research</a>
          <a href="/how-it-works" class="text-58 ww-footer-link">How it works</a>
          <a href="/terms" class="text-58 ww-footer-link">Terms and Conditions</a>
        </div>
        <nav class="frame-222">
          <a href="https://chat.openai.com/g/g-pqcxd1t8o-wellness-whizz" target="_blank" rel="noopener" aria-label="Wellness Whizz GPT on ChatGPT" class="w-inline-block"><img src="/images/Vectors-Wrapper_9.svg" loading="lazy" width="37.501739501953125" height="38" alt="ChatGPT" class="vectors-wrapper-59"></a>
          <a href="https://www.tiktok.com/@theaiwellnesswhiz?_t=8jPysLbiyxN&amp;_r=1" target="_blank" rel="noopener" aria-label="Wellness Whizz on TikTok" class="w-inline-block"><img src="/images/Vectors-Wrapper_10.svg" loading="lazy" width="33" height="38" alt="TikTok" class="vectors-wrapper-60"></a><a href="https://x.com/aiwwio" target="_blank" rel="noopener" aria-label="Wellness Whizz on X" class="w-inline-block"><img src="/images/x-logo-light.svg" loading="lazy" width="34" height="38" alt="X (Twitter)" class="vectors-wrapper-61 ww-x-icon"></a>
        </nav>
      </div>
    </footer>
  </section>`;
}

// ---------- shop elements (iHerb referral links) ----------

const OUTBOUND_ATTRS = 'target="_blank" rel="noopener nofollow sponsored"';

function trackAttrs(sup: Supplement, product?: Product): string {
  return `data-track="outbound_click" data-slug="${escapeHtml(sup.slug)}"${product ? ` data-product="${escapeHtml(product.name)}"` : ''}`;
}

/** Inline style for photos that still carry a white background (fetched from iHerb at runtime). */
export function blendAttr(product?: { opaque?: boolean } | null): string {
  return product?.opaque ? ' style="mix-blend-mode:multiply"' : '';
}

function productImage(sup: Supplement, product: Product, attrs: string): string {
  return product.image
    ? `<img src="${escapeHtml(product.image)}" loading="lazy" alt="${escapeHtml(product.name)}" ${attrs}${blendAttr(product)}>`
    : cardImage(sup, attrs);
}

/** Primary call to action: "Buy on iHerb" for the supplement's main product. */
export function buyButton(env: LinkEnv, sup: Supplement, extraClass = ''): string {
  const product = primaryProduct(sup);
  return `<a href="${escapeHtml(shopUrl(env, sup, product))}" ${OUTBOUND_ATTRS} class="fakebutton ww-buy w-button${extraClass ? ' ' + extraClass : ''}" ${trackAttrs(sup, product)}>Buy on iHerb</a>`;
}

/** Small clickable product photos (result cards). Products without a real photo are left out. */
export function productThumbs(env: LinkEnv, sup: Supplement, max = 3): string {
  const products = sup.products.filter((p) => p.image).slice(0, max);
  if (!products.length) return '';
  return `<div class="ww-products">${products
    .map(
      (p) =>
        `<a href="${escapeHtml(shopUrl(env, sup, p))}" ${OUTBOUND_ATTRS} class="ww-product" ${trackAttrs(sup, p)}>` +
        productImage(sup, p, 'width="76" height="76"') +
        `<span>${escapeHtml(p.name)}</span></a>`,
    )
    .join('')}</div>`;
}

/** "Top picks on iHerb" strip under the supplement page header. */
export function productPicks(env: LinkEnv, sup: Supplement): string {
  const products = sup.products.slice(0, 5);
  const picks = products.length
    ? products
        .map(
          (p) => `
      <div class="ww-pick${p.image ? '' : ' ww-pick-text'}">${p.image ? productImage(sup, p, 'width="120" height="120"') : ''}
        <div class="ww-pick-name">${escapeHtml(p.name)}${p.brand ? `<small>${escapeHtml(p.brand)}</small>` : ''}</div>
        <a href="${escapeHtml(shopUrl(env, sup, p))}" ${OUTBOUND_ATTRS} class="outbutton w-button" ${trackAttrs(sup, p)}>${p.image ? 'Buy on iHerb' : 'Find on iHerb'}</a>
      </div>`,
        )
        .join('')
    : `
      <div class="ww-pick ww-pick-text">
        <div class="ww-pick-name">${escapeHtml(sup.name)}</div>
        <a href="${escapeHtml(shopUrl(env, sup))}" ${OUTBOUND_ATTRS} class="outbutton w-button" ${trackAttrs(sup)}>Find on iHerb</a>
      </div>`;
  return `
    <section class="ww-strip-wrap" aria-label="Where to buy">
      <div class="ww-strip-title">Top picks on iHerb</div>
      <div class="ww-strip">${picks}
      </div>
      ${disclosure()}
    </section>`;
}

/** Sticky "buy" bar shown on small screens. */
export function stickyBuyBar(env: LinkEnv, sup: Supplement): string {
  const product = primaryProduct(sup);
  return `
  <div class="ww-sticky"><span>Buy <strong>${escapeHtml(sup.name)}</strong> on iHerb</span><a href="${escapeHtml(shopUrl(env, sup, product))}" ${OUTBOUND_ATTRS} class="outbutton w-button" ${trackAttrs(sup, product)}>Buy now</a></div>`;
}

export function disclosure(onDark = false): string {
  return `<p class="ww-disclosure${onDark ? ' on-dark' : ''}">As an iHerb affiliate, Wellness Whizz earns from qualifying purchases at no extra cost to you. Prices and availability are shown on iHerb.</p>`;
}

/** One entry of the "Explore manually" list. */
export function exploreItem(sup: Supplement): string {
  return `<div role="listitem" class="collection-item w-dyn-item w-col w-col-3"><a data-w-id="8f15da15-fcc1-d435-9e4d-ff3fddaced87" href="/supplement/${escapeHtml(sup.slug)}" class="link">${escapeHtml(sup.name)}</a></div>`;
}

export function exploreSection(supplements: Supplement[]): string {
  const items = supplements.length
    ? `<div role="list" class="linksnav w-dyn-items w-row">${supplements.map(exploreItem).join('')}</div>`
    : `<div role="list" class="linksnav w-dyn-items w-row"></div><div class="w-dyn-empty"><div>No items found.</div></div>`;
  return `
  <div id="Links" class="manuallinks">
    <h3 class="heading-2 explore">Explore manually</h3>
    <figure class="collection-list-wrapper w-dyn-list">${items}</figure>
  </div>`;
}

/** One card of the home-page slider: the real product photo on the cream square, illustration as fallback. */
export function homeCard(sup: Supplement): string {
  const product = sup.products.find((p) => p.image);
  const image = product
    ? `<img src="${escapeHtml(product.image)}" loading="lazy" width="213" height="213" alt="${escapeHtml(product.name)}" class="convertedimage2 ww-slider-photo"${blendAttr(product)}>`
    : cardImage(sup, `width="213" height="213" class="convertedimage2${sup.image ? ' ww-slider-photo' : ''}"`);
  return `<div role="listitem" class="collection-item-2 ww-carousel-item">
  <a href="/supplement/${escapeHtml(sup.slug)}" class="link-block-2 w-inline-block" aria-label="${escapeHtml(sup.name)}"></a>
  <div class="imagecard">${image}
    <div class="frame-256">
      <div class="text-75">${escapeHtml(sup.name)}</div>
      <div class="frame-257">${headerBadges(sup)}</div>
    </div>
  </div>
</div>`;
}

/** Email capture box. source "results" sends the recommendation list (when email is configured), "newsletter" subscribes. */
export function captureBox(opts: { source: 'results' | 'newsletter'; sessionId?: string; dark?: boolean; compact?: boolean; title?: string; text?: string }): string {
  const title = opts.title ?? (opts.source === 'results' ? 'Email me these results' : 'Get new guides by email');
  const text =
    opts.text ??
    (opts.source === 'results'
      ? 'Your list with buy links, so you can come back to it on any device. No spam, unsubscribe any time.'
      : 'One or two evidence-based articles a month. No spam, unsubscribe any time.');
  const cls = `ww-capture${opts.dark ? ' on-dark' : ''}${opts.compact ? ' is-compact' : ''}`;
  return `
      <div class="${cls}">
        <div class="ww-capture-text"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>
        <form data-ww-subscribe data-source="${opts.source}"${opts.sessionId ? ` data-session="${escapeHtml(opts.sessionId)}"` : ''} novalidate>
          <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required aria-label="Email address">
          <button type="submit">${opts.source === 'results' ? 'Send my results' : 'Subscribe'}</button>
          <p class="ww-capture-note" aria-live="polite">By subscribing you agree to our <a href="/terms">terms</a>.</p>
        </form>
      </div>`;
}

/** "Related supplements": same-category tiles shown above the explore list on supplement pages. */
export function relatedSection(related: Supplement[]): string {
  if (!related.length) return '';
  const tiles = related
    .map((sup) => {
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
    })
    .join('');
  return `
  <section class="ww-related-wrap">
    <div class="ww-related-inner">
      <h3 class="ww-related-title">Related supplements</h3>
      <div class="ww-related-grid">${tiles}
      </div>
    </div>
  </section>`;
}
