/**
 * Article writer: fills the "Holistic Highlights" article and the "Relevant Studies" list of supplements that lack
 * them (the Webflow export had articles for only a fifth of the catalogue, and the quiz pipeline only writes short
 * bullets). Runs from the cron trigger a few supplements at a time, or on demand via /api/admin/backfill.
 */
import type { Supplement } from './db';
import { escapeHtml, linksListHtml } from './html';
import type { AiEnv } from './openai';
import { chatJson, useFakeAi } from './openai';

/** Articles shorter than this (in characters of HTML) are considered missing and get rewritten. */
export const MIN_ARTICLE_LENGTH = 1200;

const articleSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Article headline, e.g. "Magnesium Glycinate: The Calm Mineral".' },
    intro: { type: 'string', description: 'Opening paragraph, 60 to 90 words.' },
    sections: {
      type: 'array',
      description: '4 sections of 80 to 120 words each, practical and specific.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          heading: { type: 'string' },
          paragraphs: { type: 'array', items: { type: 'string' }, description: '1 or 2 paragraphs.' },
        },
        required: ['heading', 'paragraphs'],
      },
    },
    key_takeaways: { type: 'array', items: { type: 'string' }, description: '4 short bullets.' },
    studies: {
      type: 'array',
      description: 'Up to 5 relevant peer-reviewed studies, meta-analyses or reviews you are confident exist, most relevant first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, source: { type: 'string' }, year: { type: 'string' } },
        required: ['title', 'source', 'year'],
      },
    },
  },
  required: ['title', 'intro', 'sections', 'key_takeaways', 'studies'],
} as const;

interface ArticleDraft {
  title: string;
  intro: string;
  sections: { heading: string; paragraphs: string[] }[];
  key_takeaways: string[];
  studies: { title: string; source: string; year: string }[];
}

export interface GeneratedContent {
  holistic_html: string;
  studies_html: string;
}

export async function generateArticle(env: AiEnv, sup: Supplement): Promise<GeneratedContent> {
  const draft = useFakeAi(env) ? fakeArticle(sup) : await requestArticle(env, sup);
  return {
    holistic_html: articleHtml(draft),
    studies_html: linksListHtml(
      (draft.studies ?? []).slice(0, 5).map((s) => ({
        label: [s.title, [s.source, s.year].filter(Boolean).join(', ')].filter(Boolean).join(' — '),
        href: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(s.title)}`,
      })),
    ),
  };
}

async function requestArticle(env: AiEnv, sup: Supplement): Promise<ArticleDraft> {
  const user = [
    `Write the "Holistic Highlights" article for the supplement page about "${sup.name}" (category: ${sup.category}).`,
    sup.summary ? `Page summary: ${sup.summary}` : '',
    'Audience: health-conscious adults choosing supplements online. Tone: warm, clear, evidence-informed, no hype.',
    'Cover what it is and how it works, who benefits most, how to take it (timing, food, typical dose ranges),',
    'how it fits into sleep, diet and training habits, and what to watch out for. Mention when to see a doctor.',
    'About 450 to 550 words in total. No medical claims of curing or treating diseases.',
    'Studies: list up to 5 relevant peer-reviewed studies, meta-analyses or reviews that you are confident exist (exact title, journal, year), most relevant first.',
  ]
    .filter(Boolean)
    .join('\n');
  return chatJson<ArticleDraft>(env, 'supplement_article', articleSchema, user);
}

function articleHtml(draft: ArticleDraft): string {
  const parts: string[] = [];
  if (draft.title) parts.push(`<h3>${escapeHtml(draft.title)}</h3>`);
  if (draft.intro) parts.push(`<p>${escapeHtml(draft.intro)}</p>`);
  for (const section of draft.sections ?? []) {
    if (section.heading) parts.push(`<h4>${escapeHtml(section.heading)}</h4>`);
    for (const p of section.paragraphs ?? []) if (p.trim()) parts.push(`<p>${escapeHtml(p)}</p>`);
  }
  const takeaways = (draft.key_takeaways ?? []).filter((t) => t.trim());
  if (takeaways.length) parts.push(`<h4>Key takeaways</h4><ul>${takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`);
  return parts.join('');
}

function fakeArticle(sup: Supplement): ArticleDraft {
  const n = sup.name;
  const para = (topic: string) =>
    `[Dev mode] ${topic} for ${n}. This placeholder paragraph stands in for the article the live site generates with OpenAI. It is long enough to exercise the layout of the Holistic Highlights section on the supplement page.`;
  return {
    title: `${n}: A Practical Guide`,
    intro: para('Introduction'),
    sections: [
      { heading: 'What it is and how it works', paragraphs: [para('Mechanism')] },
      { heading: 'Who benefits most', paragraphs: [para('Audience')] },
      { heading: 'How to take it', paragraphs: [para('Dosing')] },
      { heading: 'Fitting it into daily life', paragraphs: [para('Lifestyle')] },
    ],
    key_takeaways: ['Start low and be consistent', 'Pair with food', 'Track how you feel', 'Ask a professional if unsure'],
    studies: [{ title: `${n} supplementation: a systematic review`, source: 'Example Journal', year: '2021' }],
  };
}
