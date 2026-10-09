/**
 * /research: the latest trials and reviews about catalogue supplements, summarised in plain language.
 * Every note is in the HTML (search engines and no-JS readers see the full list); /js/research.js adds the category
 * and study-type filters and shows the list ten notes at a time.
 */
import { escapeHtml } from '../html';
import { noteLabel, pubmedUrl, type ResearchNote } from '../research';
import { page } from './layout';
import { pageShell, quizCta } from './pages';
import { WF_PAGE_IDS } from './partials';

/** How many notes show before the first "Show more". */
export const RESEARCH_PAGE_SIZE = 10;

const STUDY_TYPES: { key: string; label: string; test: RegExp }[] = [
  { key: 'trial', label: 'Trials', test: /trial/i },
  { key: 'review', label: 'Reviews & meta-analyses', test: /review|meta-analysis/i },
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function studyTypes(n: ResearchNote): string[] {
  return STUDY_TYPES.filter((t) => t.test.test(n.pub_type)).map((t) => t.key);
}

function chip(attr: string, value: string, label: string, count: number, active = false): string {
  return `<button type="button" class="ww-tag ww-rchip${active ? ' is-active' : ''}" ${attr}="${escapeHtml(value)}" aria-pressed="${active}">${escapeHtml(label)} <b>${count}</b></button>`;
}

export function renderResearchPage(notes: ResearchNote[], origin: string): string {
  const categories = new Map<string, { label: string; count: number }>();
  const typeCounts = new Map<string, number>();
  for (const n of notes) {
    const label = (n.supplement_category ?? '').trim() || 'Other';
    const key = slugify(label);
    categories.set(key, { label, count: (categories.get(key)?.count ?? 0) + 1 });
    for (const t of studyTypes(n)) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const categoryChips = [...categories.entries()].sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));

  const items = notes.length
    ? notes
        .map(
          (n) => `
        <article class="ww-note" data-category="${escapeHtml(slugify((n.supplement_category ?? '').trim() || 'Other'))}" data-types="${escapeHtml(studyTypes(n).join(' '))}">
          <div class="ww-note-meta"><a class="ww-tag" href="/supplement/${escapeHtml(n.supplement_slug ?? '')}">${escapeHtml(n.supplement_name ?? '')}</a><span>${noteLabel(n)}</span>${n.pub_type ? `<span>${escapeHtml(n.pub_type)}</span>` : ''}</div>
          <h2><a href="${escapeHtml(pubmedUrl(n.pmid))}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a></h2>
          <p>${escapeHtml(n.summary)}</p>
          ${n.takeaway ? `<p class="ww-note-takeaway"><strong>What it means:</strong> ${escapeHtml(n.takeaway)}</p>` : ''}
          <p class="ww-note-links"><a href="${escapeHtml(pubmedUrl(n.pmid))}" target="_blank" rel="noopener">Read on PubMed</a> · <a href="/supplement/${escapeHtml(n.supplement_slug ?? '')}">${escapeHtml(n.supplement_name ?? '')} profile</a></p>
        </article>`,
        )
        .join('')
    : '<p class="ww-blog-intro">The first notes appear as soon as the weekly PubMed check finds new trials or reviews about the supplements in our catalogue.</p>';

  const filters = notes.length
    ? `
      <div class="ww-rfilter" data-research-filter data-page-size="${RESEARCH_PAGE_SIZE}">
        <div class="ww-rfilter-row"><span class="ww-rfilter-label">Category</span><div class="ww-rfilter-chips">${chip('data-category', '', 'All', notes.length, true)}${categoryChips.map(([key, c]) => chip('data-category', key, c.label, c.count)).join('')}</div></div>
        <div class="ww-rfilter-row"><span class="ww-rfilter-label">Study type</span><div class="ww-rfilter-chips">${chip('data-type', '', 'All', notes.length, true)}${STUDY_TYPES.map((t) => chip('data-type', t.key, t.label, typeCounts.get(t.key) ?? 0)).join('')}</div></div>
        <p class="ww-rfilter-count" data-research-count aria-live="polite"></p>
      </div>`
    : '';
  const more = notes.length > RESEARCH_PAGE_SIZE ? `\n      <div class="ww-rmore"><button type="button" class="fakebutton ww-buy w-button" data-research-more hidden>Show more</button></div>` : '';

  const body = `
      <p class="ww-research-intro">Every week we check PubMed for new randomised trials, meta-analyses and systematic reviews about the supplements in our catalogue and summarise them here in plain language. Summaries are written with AI from the published abstract and link to the original paper; they are information, not medical advice.</p>${filters}
      <div class="ww-notes" data-research-list>${items}
      </div>${more}${quizCta()}`;
  const shell = pageShell({
    eyebrow: 'Research notes',
    title: 'What the latest studies say',
    lead: 'New trials and reviews about the supplements we cover, summarised in plain language, with the original paper one click away.',
    body,
    variant: 'plain',
  });
  return page({
    title: 'Research notes',
    description: 'New randomised trials, meta-analyses and reviews about popular supplements, summarised in plain language with links to the original papers.',
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(origin)}/research">`,
    body: shell,
    scripts: notes.length ? '  <script src="/js/research.js"></script>' : '',
  });
}
