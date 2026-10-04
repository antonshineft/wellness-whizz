/**
 * FAQ writer: the "Common Questions" block of a supplement page, five or six answers to the phrases people actually
 * type into Google for that supplement (data/faq-questions.json, built from a Semrush keyword export by
 * scripts/semrush-faq-questions.mjs). Runs from the cron trigger a few supplements at a time, or on demand via
 * /api/admin/faq. Supplements Semrush had nothing for get a generic set of questions.
 */
import questionsJson from '../data/faq-questions.json';
import type { Faq, Supplement } from './db';
import { chatJson, useFakeAi, type AiEnv } from './openai';

interface SearchQuestion {
  /** The search phrase as typed. */
  q: string;
  /** Monthly searches and keyword difficulty, informative only. */
  v: number;
  kd: number;
}

const QUESTIONS = questionsJson as Record<string, SearchQuestion[]>;

export const FAQ_MIN = 3;
export const FAQ_MAX = 6;

const faqSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    faqs: {
      type: 'array',
      description: '5 or 6 distinct question and answer pairs, most searched topic first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: {
            type: 'string',
            description: 'The question as a reader would ask it, under 90 characters, keeping the key words of the search phrase it answers.',
          },
          answer: {
            type: 'string',
            description: '40 to 80 words of plain language: specific where the evidence is solid, honest where it is weak, one safety sentence when relevant. No brand names, no links, no cure claims.',
          },
        },
        required: ['question', 'answer'],
      },
    },
  },
  required: ['faqs'],
} as const;

interface FaqDraft {
  faqs: { question: string; answer: string }[];
}

/** The search phrases for a supplement; generic questions when the keyword export had none for it. */
export function searchQuestionsFor(sup: Supplement): SearchQuestion[] {
  const list = QUESTIONS[sup.slug] ?? QUESTIONS[sup.slug.replace(/-[0-9a-f]{5}$/, '')];
  if (list?.length) return list;
  const n = sup.name.toLowerCase();
  return [
    `how much ${n} per day`,
    `best time to take ${n}`,
    `${n} side effects`,
    `who should not take ${n}`,
    `how long does ${n} take to work`,
    `can you take ${n} every day`,
  ].map((q) => ({ q, v: 0, kd: 0 }));
}

export async function generateFaqs(env: AiEnv, sup: Supplement): Promise<Faq[]> {
  const questions = searchQuestionsFor(sup);
  const draft = useFakeAi(env) ? fakeFaqs(sup, questions) : await requestFaqs(env, sup, questions);
  const faqs = (draft.faqs ?? [])
    .map((f) => ({ q: clean(f.question), a: clean(f.answer) }))
    .filter((f) => f.q.length >= 8 && f.a.length >= 40)
    .slice(0, FAQ_MAX);
  if (faqs.length < FAQ_MIN) throw new Error(`The model returned only ${faqs.length} usable FAQ entries`);
  return faqs;
}

async function requestFaqs(env: AiEnv, sup: Supplement, questions: SearchQuestion[]): Promise<FaqDraft> {
  const phrases = questions.map((q) => (q.v ? `- ${q.q} (${q.v} searches a month)` : `- ${q.q}`)).join('\n');
  const user = [
    `Write the "Common Questions" block for the supplement page about "${sup.name}" (category: ${sup.category}).`,
    sup.summary ? `Page summary: ${sup.summary}` : '',
    'What the page already says, for consistency (do not contradict it, do not repeat it word for word):',
    sup.benefits_html ? `Benefits: ${text(sup.benefits_html)}` : '',
    sup.contraindications_html ? `Contraindications: ${text(sup.contraindications_html)}` : '',
    sup.interactions_html ? `Interactions: ${text(sup.interactions_html)}` : '',
    '',
    'Readers reach this page by searching these phrases, most searched first:',
    phrases,
    '',
    'Turn them into 5 or 6 distinct questions and answers. Merge phrases that mean the same thing. Skip phrases that',
    'are not a real question about choosing or taking this supplement (brand names, other products, fragments).',
    'Write each question the way a reader would ask it and keep the key words of the search phrase in it.',
    'Answers: 40 to 80 words, plain language, warm and direct. Be specific where the evidence is solid (typical dose',
    'ranges, timing, how long until effects are noticeable) and honest where it is weak or mixed. Add one sentence',
    'of caution when the question touches pregnancy, medication, children, high doses or a medical condition, and',
    'say when to check with a doctor or pharmacist. Never diagnose, never promise cures, no brand names, no links.',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return chatJson<FaqDraft>(env, 'supplement_faq', faqSchema, user);
}

/** Rich text to a short plain-text excerpt for the prompt. */
function text(html: string): string {
  return html
    .replace(/<\/(li|p|h[1-6])>/gi, '; ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/(; )+$/, '')
    .trim()
    .slice(0, 600);
}

function clean(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function fakeFaqs(sup: Supplement, questions: SearchQuestion[]): FaqDraft {
  return {
    faqs: questions.slice(0, 5).map((q) => ({
      question: `${q.q.charAt(0).toUpperCase()}${q.q.slice(1)}?`,
      answer: `[Dev mode] This placeholder answers "${q.q}" for ${sup.name}. The live site writes a 40 to 80 word answer here with OpenAI, consistent with the benefits and contraindications shown above, plus a safety note when the question calls for one.`,
    })),
  };
}
