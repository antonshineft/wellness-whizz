/** /research: the latest trials and reviews about catalogue supplements, summarised in plain language. */
import { escapeHtml } from '../html';
import { noteLabel, pubmedUrl, type ResearchNote } from '../research';
import { page } from './layout';
import { pageShell, quizCta } from './pages';
import { WF_PAGE_IDS } from './partials';

export function renderResearchPage(notes: ResearchNote[], origin: string): string {
  const items = notes.length
    ? notes
        .map(
          (n) => `
        <article class="ww-note">
          <div class="ww-note-meta"><a class="ww-tag" href="/supplement/${escapeHtml(n.supplement_slug ?? '')}">${escapeHtml(n.supplement_name ?? '')}</a><span>${noteLabel(n)}</span>${n.pub_type ? `<span>${escapeHtml(n.pub_type)}</span>` : ''}</div>
          <h2><a href="${escapeHtml(pubmedUrl(n.pmid))}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a></h2>
          <p>${escapeHtml(n.summary)}</p>
          ${n.takeaway ? `<p class="ww-note-takeaway"><strong>What it means:</strong> ${escapeHtml(n.takeaway)}</p>` : ''}
          <p class="ww-note-links"><a href="${escapeHtml(pubmedUrl(n.pmid))}" target="_blank" rel="noopener">Read on PubMed</a> · <a href="/supplement/${escapeHtml(n.supplement_slug ?? '')}">${escapeHtml(n.supplement_name ?? '')} profile</a></p>
        </article>`,
        )
        .join('')
    : '<p class="ww-blog-intro">The first notes appear as soon as the weekly PubMed check finds new trials or reviews about the supplements in our catalogue.</p>';
  const body = `
      <p class="ww-research-intro">Every week we check PubMed for new randomised trials, meta-analyses and systematic reviews about the supplements in our catalogue and summarise them here in plain language. Summaries are written with AI from the published abstract and link to the original paper; they are information, not medical advice.</p>
      <div class="ww-notes">${items}
      </div>${quizCta()}`;
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
  });
}
