/**
 * /research: the latest trials and reviews about catalogue supplements, summarised in plain language.
 * Every note is in the HTML (search engines and no-JS readers see the full list); /js/research.js adds the category
 * and study-type filters and shows the list ten notes at a time.
 */
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { noteLabel, notePath, pubmedUrl, type ResearchNote } from '../research';
import { page } from './layout';
import { formatDate, pageShell, quizCta, reviewedLine } from './pages';
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
        <article class="ww-note" id="pmid-${escapeHtml(n.pmid)}" data-category="${escapeHtml(slugify((n.supplement_category ?? '').trim() || 'Other'))}" data-types="${escapeHtml(studyTypes(n).join(' '))}">
          <div class="ww-note-meta"><a class="ww-tag" href="/supplement/${escapeHtml(n.supplement_slug ?? '')}">${escapeHtml(n.supplement_name ?? '')}</a><span>${noteLabel(n)}</span>${n.pub_type ? `<span>${escapeHtml(n.pub_type)}</span>` : ''}</div>
          <h2><a href="${escapeHtml(notePath(n))}">${escapeHtml(n.title)}</a></h2>
          <p>${escapeHtml(n.summary)}</p>
          ${n.takeaway ? `<p class="ww-note-takeaway"><strong>What it means:</strong> ${escapeHtml(n.takeaway)}</p>` : ''}
          <p class="ww-note-links"><a href="${escapeHtml(notePath(n))}">Read the note</a> · <a href="${escapeHtml(pubmedUrl(n.pmid))}" target="_blank" rel="noopener">Read on PubMed</a> · <a href="/supplement/${escapeHtml(n.supplement_slug ?? '')}">${escapeHtml(n.supplement_name ?? '')} profile</a></p>
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

// ---------- one note on its own page ----------

const NOTE_DISCLAIMER =
  'This note summarises one study in plain language and is not medical advice. Supplements can interact with medicines and conditions; talk to a pharmacist or doctor before starting one.';

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}

/**
 * /research/<pmid>-<slug>: the plain-language summary, the takeaway, a short profile of the supplement with a link
 * to its guide, the other notes about it, and the paper on PubMed. English only; the Spanish site gets the chrome.
 */
export function renderResearchNote(n: ResearchNote, sup: Supplement | null, related: readonly ResearchNote[], origin: string): string {
  const path = notePath(n);
  const url = `${origin}${path}`;
  const name = n.supplement_name ?? sup?.name ?? '';
  const supSlug = n.supplement_slug ?? sup?.slug ?? '';
  const description = clip(n.takeaway || n.summary, 155);
  const filed = n.created_at.slice(0, 10);
  const about = sup
    ? `
          <h2>About ${escapeHtml(name)}</h2>
          <p>${escapeHtml(sup.summary)}</p>${sup.why_consider ? `\n          <p>${escapeHtml(sup.why_consider)}</p>` : ''}
          <p><a href="/supplement/${escapeHtml(supSlug)}" class="fakebutton ww-buy w-button ww-rnote-btn">Open the ${escapeHtml(name)} guide</a></p>`
    : '';
  const relatedHtml = related.length
    ? `
          <section class="ww-rnote-related">
            <h2>More research on ${escapeHtml(name)}</h2>
            <ul>${related.map((r) => `\n              <li><a href="${escapeHtml(notePath(r))}">${escapeHtml(r.title)}</a><span>${noteLabel(r)}</span></li>`).join('')}
            </ul>
          </section>`
    : '';
  const body = `
      <article class="ww-prose ww-rnote">
        <div class="ww-article-meta"><a class="ww-tag" href="/supplement/${escapeHtml(supSlug)}">${escapeHtml(name)}</a><span>${noteLabel(n)}</span>${n.pub_type ? `<span>${escapeHtml(n.pub_type)}</span>` : ''}<span>Filed ${escapeHtml(formatDate(filed))}</span></div>
        ${reviewedLine(filed, 'ww-reviewed-top')}
        <h2>In plain language</h2>
        <p>${escapeHtml(n.summary)}</p>${n.takeaway ? `
        <h2>What it means for you</h2>
        <p>${escapeHtml(n.takeaway)}</p>` : ''}
        <p class="ww-note-links"><a href="${escapeHtml(pubmedUrl(n.pmid))}" target="_blank" rel="noopener">Read the paper on PubMed</a> · <a href="/research">All research notes</a></p>${about}${relatedHtml}
        <p class="ww-note">${escapeHtml(NOTE_DISCLAIMER)} <a href="/about#disclaimer">Read our full medical disclaimer.</a></p>
      </article>${quizCta()}`;
  const shell = pageShell({
    eyebrow: name ? `Research notes · ${name}` : 'Research notes',
    title: n.title,
    lead: clip(n.summary, 220),
    body,
    variant: 'plain',
  });
  const safe = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
  const article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: n.title,
    description,
    datePublished: filed,
    dateModified: filed,
    author: { '@type': 'Organization', name: 'Wellness Whizz editorial team', url: `${origin}/about` },
    publisher: { '@type': 'Organization', name: 'Wellness Whizz', url: origin, logo: { '@type': 'ImageObject', url: `${origin}/images/webclip.png` } },
    mainEntityOfPage: url,
    ...(name ? { about: { '@type': 'Substance', name } } : {}),
    citation: { '@type': 'ScholarlyArticle', headline: n.title, url: pubmedUrl(n.pmid), ...(n.journal ? { publisher: { '@type': 'Organization', name: n.journal } } : {}) },
  };
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: 'Research notes', item: `${origin}/research` },
      { '@type': 'ListItem', position: 3, name: n.title, item: url },
    ],
  };
  return page({
    title: clip(name && !n.title.toLowerCase().includes(name.toLowerCase()) ? `${name} study: ${n.title}` : n.title, 60),
    description,
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head: `\n  <link rel="canonical" href="${escapeHtml(url)}">\n  <meta property="og:type" content="article">\n  <meta property="article:published_time" content="${escapeHtml(filed)}">\n  <script type="application/ld+json">${safe(article)}</script>\n  <script type="application/ld+json">${safe(breadcrumbs)}</script>`,
    body: shell,
  });
}
