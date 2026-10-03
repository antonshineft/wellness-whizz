/** /result/:id — the "Results" CMS template page, rendered from the session's stored recommendations. */
import type { QuizProfile, ResultItem, Session } from '../db';
import { escapeHtml } from '../html';
import type { LinkEnv } from '../links';
import { page } from './layout';
import { primaryProduct, shopUrl } from '../links';
import { WF_PAGE_IDS, blendAttr, buyButton, captureBox, cardImage, cardImageSrc, cardTags, disclosure, navbar, productThumbs } from './partials';

const AGE_TEXT: Record<string, string> = { '<18': 'under 18', '18-25': 'aged 18 to 25', '26-40': 'aged 26 to 40', '41-65': 'aged 41 to 65', '65+': 'over 65' };
const ACTIVITY_TEXT: Record<string, string> = {
  Sedentary: 'mostly sedentary', 'Lightly Active': 'lightly active', 'Moderately Active': 'moderately active',
  'Very Active': 'very active', 'Extra Active': 'extremely active',
};
const PLAIN_DIET = /^(none|no|n\/a|nothing|no restrictions?|regular|normal|standard|balanced|omnivore|everything|mixed|-)$/i;
const GENERIC_LEAD = 'Most suitable supplements according to your responses:';
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One sentence that mirrors the quiz answers, so the result page reads as personal rather than generic. */
export function answersSummary(profile: QuizProfile): string {
  const clean = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
  const sex = clean(profile.sex).toLowerCase();
  const person = sex === 'female' ? 'woman' : sex === 'male' ? 'man' : 'person';
  const activity = ACTIVITY_TEXT[clean(profile.activity)] ?? '';
  const age = AGE_TEXT[clean(profile.age)] ?? '';
  const diet = clean(profile.diet);
  const goal = clean(profile.goal);
  if (!activity && !age && !diet && !goal) return GENERIC_LEAD;
  const who = [activity, person].filter(Boolean).join(' ');
  const parts: string[] = [];
  if (diet && !PLAIN_DIET.test(diet)) {
    parts.push(/diet/i.test(diet) ? `on a ${lowerFirst(diet)}` : diet.length <= 28 ? `on a ${lowerFirst(diet)} diet` : `whose diet is "${diet}"`);
  }
  if (goal) parts.push(`focused on ${goal.length > 90 ? `${goal.slice(0, 87).replace(/\s+\S*$/, '')}…` : lowerFirst(goal)}`);
  const article = /^[aeiou]/i.test(who) ? 'an' : 'a';
  return `For ${article} ${who}${age ? ` ${age}` : ''}${parts.length ? `, ${parts.join(' and ')}` : ''}, these are the best fits:`;
}

const SAFETY_LABEL: Record<string, string> = { safe: 'Safe', ok: 'Mostly safe', not_safe: 'Not safe', prescription: 'Prescription' };
const SHARE_ICONS = {
  x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  story: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.5-1.5"/></svg>',
};

/** Short profile chips for the share card, e.g. ["lightly active", "vegan", "better sleep"]. */
export function answerChips(profile: QuizProfile): string[] {
  const clean = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 2).replace(/\s+\S*$/, '')}…` : s);
  const chips: string[] = [];
  const activity = ACTIVITY_TEXT[clean(profile.activity)];
  if (activity) chips.push(activity);
  const diet = clean(profile.diet);
  if (diet && !PLAIN_DIET.test(diet)) chips.push(lowerFirst(clip(diet, 26)));
  const goal = clean(profile.goal);
  if (goal) chips.push(lowerFirst(clip(goal, 40)));
  return chips;
}

/** "Share your plan": preview of the card the browser draws (see public/js/share-card.js) plus the share buttons. */
function shareBlock(session: Session, items: ResultItem[], origin: string): string {
  const url = `${origin}/result/${session.id}`;
  const chips = answerChips(session);
  const line = chips.length ? chips.join(' · ').replace(/^./, (ch) => ch.toUpperCase()) : 'Personal supplement plan';
  const names = items.slice(0, 3).map((i) => i.supplement.name).join(', ');
  const text = `My supplement plan from Wellness Whizz: ${names}${items.length > 3 ? ' and more' : ''}. Take the free 2-minute quiz:`;
  const data = {
    id: session.id,
    title: 'My supplement plan',
    line,
    site: 'aiww.io',
    url,
    text,
    logo: '/images/webclip.png',
    items: items.slice(0, 5).map(({ supplement: s }) => ({
      name: s.name,
      // same-origin images only: a cross-origin photo would taint the canvas and block the export
      image: (() => { const photo = primaryProduct(s)?.image; return photo && photo.startsWith('/') ? photo : cardImageSrc(s); })(),
      score: Math.min(5, Math.max(1, Math.round(s.effectivity))),
      safety: SAFETY_LABEL[s.safety_status] ?? '',
      safe: s.safety_status === 'safe' || s.safety_status === 'ok',
    })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const waHref = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
  return `
            <div class="ww-share-wrap">
              <div class="ww-share" id="ww-share">
                <div class="ww-share-text"><h3>Share your plan</h3><p>A card with your top picks. No name, no answers beyond one line, and a link back to the quiz.</p></div>
                <div class="ww-share-preview"><img id="ww-share-img" src="/result/${escapeHtml(session.id)}/card.jpg" width="1200" height="630" alt="Your plan as a shareable card" loading="lazy"></div>
                <div class="ww-share-buttons">
                  <a class="ww-share-btn" data-share="x" href="${escapeHtml(xHref)}" target="_blank" rel="noopener"><span>${SHARE_ICONS.x}</span><b>Post</b></a>
                  <a class="ww-share-btn" data-share="whatsapp" href="${escapeHtml(waHref)}" target="_blank" rel="noopener"><span>${SHARE_ICONS.whatsapp}</span><b>WhatsApp</b></a>
                  <button class="ww-share-btn" data-share="story" type="button"><span>${SHARE_ICONS.story}</span><b>Story image</b></button>
                  <button class="ww-share-btn" data-share="copy" type="button"><span>${SHARE_ICONS.link}</span><b>Copy link</b></button>
                </div>
                <button class="ww-share-native" data-share="native" type="button" hidden>Share…</button>
                <p class="ww-share-note">The link opens this page. Anyone with it can see your picks; it never shows your email.</p>
              </div>
            </div>
            <script type="application/json" id="ww-share-data">${json}</script>`;
}

const FORM_LABELS: Record<string, string> = {
  capsule: 'Capsules', softgel: 'Softgels', small_softgel: 'Softgels', tablet: 'Tablets', powder: 'Powder',
  gummy: 'Gummies', bar: 'Bars', drops: 'Drops',
};

/** Webflow interaction ids of the five cards (fade-in animations in webflow.js are keyed on these). */
const CARD_IDS = [
  '6a0b56ff-9d27-ba1a-c71f-8b784722378e',
  '5fd3f78a-dc21-1048-e10f-03ef8d30d351',
  'edd86115-b74d-bc73-4536-a0f94a331e1f',
  '41c906cb-244d-46f3-69ac-4a28fba2b43f',
  '5c3ddf26-6cc6-2d01-a454-196bc2180c45',
];

function resultCard(env: LinkEnv, item: ResultItem, index: number): string {
  const sup = item.supplement;
  const href = `/supplement/${escapeHtml(sup.slug)}`;
  const wid = CARD_IDS[index] ? ` data-w-id="${CARD_IDS[index]}" style="opacity:0"` : '';
  const product = primaryProduct(sup);
  // Lead with the real product photo when there is one; the generic illustration is the fallback.
  const media = product?.image
    ? `<img src="${escapeHtml(product.image)}" loading="lazy" alt="${escapeHtml(product.name)}"${blendAttr(product)}>`
    : cardImage(sup, 'class="ww-card-illustration"');
  const mediaLink = product
    ? `<a href="${escapeHtml(shopUrl(env, sup, product))}" target="_blank" rel="noopener nofollow sponsored" class="ww-card-media" data-track="outbound_click" data-slug="${escapeHtml(sup.slug)}" data-product="${escapeHtml(product.name)}">${media}</a>`
    : `<a href="${href}" class="ww-card-media">${media}</a>`;
  const form = FORM_LABELS[sup.form_type] ?? '';
  return `
          <div${wid} class="result-card-frame">
            <div class="ww-card">
              <div class="ww-card-main">
                ${mediaLink}
                <div class="ww-card-body">
                  <h2 class="ww-card-title">${escapeHtml(sup.name)}</h2>
                  <div class="ww-card-meta">${cardTags(sup, form)}</div>
                  <p class="ww-card-text">${escapeHtml(item.reason || sup.summary)}</p>
                  ${productThumbs(env, sup)}
                </div>
              </div>
              <div class="ww-card-bottom">
                <div class="ww-actions">${buyButton(env, sup)}<a href="${href}" class="fakebutton ww-secondary w-button">More Details</a></div>
              </div>
            </div>
          </div>`;
}

export function renderResultPage(session: Session, items: ResultItem[], env: LinkEnv, extras: { origin?: string } = {}): string {
  const names = items.map((i) => i.supplement.name).join(', ');
  const origin = extras.origin ?? '';
  const head = `
  <meta name="robots" content="noindex">${
    origin
      ? `
  <link rel="canonical" href="${escapeHtml(origin)}/result/${escapeHtml(session.id)}">
  <meta property="og:url" content="${escapeHtml(origin)}/result/${escapeHtml(session.id)}">
  <meta property="og:image" content="${escapeHtml(origin)}/result/${escapeHtml(session.id)}/card.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:image" content="${escapeHtml(origin)}/result/${escapeHtml(session.id)}/card.jpg">`
      : ''
  }`;
  const body = `${navbar()}
  <div class="div-block-7">
    <div class="sliderblock">
      <div class="frame-250">
        <h3 class="heading-4 results">Your Personal Wellness Advice</h3>
        <div class="text-48"><strong class="bold-text">${escapeHtml(answersSummary(session))}</strong></div>
      </div>
      <div class="w-dyn-list">
        <div role="list" class="w-dyn-items">
          <div data-session-id="${escapeHtml(session.id)}" role="listitem" class="resultsclass w-dyn-item">${items.map((item, i) => resultCard(env, item, i)).join('')}${origin ? shareBlock(session, items, origin) : ''}
            <div class="ww-capture-wrap">${captureBox({ source: 'results', sessionId: session.id, dark: true })}</div>
          </div>
        </div>
      </div>
      ${disclosure(true)}
    </div>
  </div>`;
  return page({
    title: `Your personal advice: ${names}`,
    description: `Personalised supplement recommendations: ${names}.`,
    pageId: WF_PAGE_IDS.result,
    head,
    body,
    scripts: origin ? '\n  <script src="/js/vendor/qrcode.js"></script>\n  <script src="/js/share-card.js"></script>' : '',
  });
}

/** Shown while the pipeline is still running (the quiz page normally waits for it, this covers reloads and shared links). */
export function renderPendingPage(session: Session): string {
  const body = `${navbar()}
  <div class="div-block-7">
    <div class="sliderblock">
      <div class="frame-250">
        <h3 class="heading-4 results">Your Personal Wellness Advice</h3>
        <div class="text-48"><strong class="bold-text">Currently, AI is preparing your recommendation.</strong></div>
      </div>
      <div class="success-message" style="display:block">
        <img src="/images/New-file-2.gif" loading="lazy" width="400" height="400" alt="" class="image-6">
        <div class="text-block-8">Currently, AI preparing the recommendation. <br>Please wait.</div>
      </div>
    </div>
  </div>`;
  const scripts = `<script>
(function(){
  var id = ${JSON.stringify(session.id)};
  var attempts = 0;
  function poll(){
    if (attempts++ > 60) { window.location.reload(); return; }
    fetch('/api/session/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if (j && j.status !== 'pending') { window.location.reload(); } else { setTimeout(poll, 3000); } })
      .catch(function(){ setTimeout(poll, 5000); });
  }
  setTimeout(poll, 3000);
})();
</script>`;
  return page({ title: 'Preparing your recommendation…', pageId: WF_PAGE_IDS.result, body, scripts });
}

export function renderFailedPage(session: Session): string {
  const body = `${navbar()}
  <div class="div-block-7">
    <div class="sliderblock">
      <div class="frame-250">
        <h3 class="heading-4 results">Something went wrong</h3>
        <div class="text-48"><strong class="bold-text">We could not prepare your recommendation this time. Please try the quiz again.</strong></div>
      </div>
      <a href="/wellness-quiz" class="footerbutton w-inline-block"><div class="text-57">Start Quiz Again</div></a>
      <p class="text-72" style="opacity:.6;margin-top:24px">Reference: ${escapeHtml(session.id)}</p>
    </div>
  </div>`;
  return page({ title: 'Recommendation failed', pageId: WF_PAGE_IDS.result, body });
}
