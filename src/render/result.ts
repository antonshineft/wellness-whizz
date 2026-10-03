/** /result/:id — the "Results" CMS template page, rendered from the session's stored recommendations. */
import type { QuizProfile, ResultItem, Session } from '../db';
import { escapeHtml } from '../html';
import type { LinkEnv } from '../links';
import { page } from './layout';
import { primaryProduct, shopUrl } from '../links';
import { WF_PAGE_IDS, blendAttr, buyButton, captureBox, cardImage, cardTags, disclosure, navbar, productThumbs } from './partials';

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

export function renderResultPage(session: Session, items: ResultItem[], env: LinkEnv): string {
  const names = items.map((i) => i.supplement.name).join(', ');
  const body = `${navbar()}
  <div class="div-block-7">
    <div class="sliderblock">
      <div class="frame-250">
        <h3 class="heading-4 results">Your Personal Wellness Advice</h3>
        <div class="text-48"><strong class="bold-text">${escapeHtml(answersSummary(session))}</strong></div>
      </div>
      <div class="w-dyn-list">
        <div role="list" class="w-dyn-items">
          <div data-session-id="${escapeHtml(session.id)}" role="listitem" class="resultsclass w-dyn-item">${items.map((item, i) => resultCard(env, item, i)).join('')}
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
    body,
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
