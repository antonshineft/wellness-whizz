/** /result/:id — the "Results" CMS template page, rendered from the session's stored recommendations. */
import type { ResultItem, Session } from '../db';
import { escapeHtml } from '../html';
import { page } from './layout';
import { WF_PAGE_IDS, cardBadges, cardImage, navbar, ratingImage } from './partials';

/** Webflow interaction ids of the five cards (fade-in animations in webflow.js are keyed on these). */
const CARD_IDS = [
  '6a0b56ff-9d27-ba1a-c71f-8b784722378e',
  '5fd3f78a-dc21-1048-e10f-03ef8d30d351',
  'edd86115-b74d-bc73-4536-a0f94a331e1f',
  '41c906cb-244d-46f3-69ac-4a28fba2b43f',
  '5c3ddf26-6cc6-2d01-a454-196bc2180c45',
];

function resultCard(item: ResultItem, index: number): string {
  const sup = item.supplement;
  const href = `/supplement/${escapeHtml(sup.slug)}`;
  const wid = CARD_IDS[index] ? ` data-w-id="${CARD_IDS[index]}" style="opacity:0"` : '';
  return `
          <div${wid} class="result-card-frame">
            <div class="inner-frame">
              <a href="${href}" class="div-block-15-image w-inline-block">
                <div class="div-block-15-image">${cardImage(sup, 'sizes="(max-width: 479px) 77vw, (max-width: 767px) 135px, (max-width: 991px) 33vw, 323.994140625px" class="formimage"')}</div>
              </a>
              <div class="stroke">
                <div class="outcarddiv">
                  <div class="outtextdiv">
                    <div class="resultname">${escapeHtml(sup.name)}</div>
                    <div class="badges">${cardBadges(sup)}</div>
                  </div>
                  <div>
                    <p class="paragraph">${escapeHtml(item.reason || sup.summary)}</p>
                  </div>
                  <div class="bottomcard">
                    <div class="w-layout-hflex flex-block">
                      <div class="text-block-7">EFFECTIVITY</div>${ratingImage(sup.effectivity, 'vectors-wrapper-82', 'width="127" height="79.34735107421875"')}
                    </div>
                    <a href="${href}" class="fakebutton w-button">More Details</a>
                  </div>
                </div>
              </div>
            </div>
          </div>`;
}

export function renderResultPage(session: Session, items: ResultItem[]): string {
  const names = items.map((i) => i.supplement.name).join(', ');
  const body = `${navbar()}
  <div class="div-block-7">
    <div class="sliderblock">
      <div class="frame-250">
        <h3 class="heading-4 results">Your Personal Wellness Advice</h3>
        <div class="text-48"><strong class="bold-text">Most suitable supplements according to your responses:</strong></div>
      </div>
      <div class="w-dyn-list">
        <div role="list" class="w-dyn-items">
          <div data-session-id="${escapeHtml(session.id)}" role="listitem" class="resultsclass w-dyn-item">${items.map(resultCard).join('')}
          </div>
        </div>
      </div>
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
