/**
 * The quiz pipeline. This is the Make.com scenario in code:
 *   form submission -> OpenAI recommendations -> look up existing supplements -> create the missing ones with OpenAI
 *   -> store the results for the session -> mark the session ready.
 */
import {
  findSupplementByAlias, getSupplementsByNameKeys, insertSupplement, listSupplementNames, markSession, normalizeNameKey,
  saveSessionResults, type QuizProfile, type Supplement,
} from './db';
import { generateSupplementImage, imageGenerationEnabled, type ImageEnv } from './images';
import { generateSupplementProfile, recommendSupplements, type AiEnv } from './openai';

export interface PipelineEnv extends AiEnv, ImageEnv {
  DB: D1Database;
}

const MIN_RESULTS = 3;

export async function runQuizPipeline(
  env: PipelineEnv,
  sessionId: string,
  profile: QuizProfile,
  background: (work: Promise<unknown>) => void = () => {},
): Promise<void> {
  try {
    const knownNames = await listSupplementNames(env.DB, 300);
    const recommendations = await recommendSupplements(env, profile, knownNames);

    const keys = recommendations.map((r) => normalizeNameKey(r.name));
    const existing = await getSupplementsByNameKeys(env.DB, keys);

    // Generate the missing profiles in parallel (the Make scenario did this one by one). One failed profile should
    // not sink the whole session, so failures are logged and the remaining recommendations are kept.
    const settled = await Promise.allSettled(
      recommendations.map(async (rec, i): Promise<{ supplement: Supplement; reason: string }> => {
        const found = existing.get(keys[i]) ?? (await findSupplementByAlias(env.DB, rec.name));
        if (found) return { supplement: found, reason: rec.reason };
        const draft = await generateSupplementProfile(env, rec);
        const supplement = await insertSupplement(env.DB, draft, 'ai');
        if (supplement.source === 'ai' && !supplement.image && !supplement.products.some((p) => p.image) && imageGenerationEnabled(env)) {
          background(generateSupplementImage(env, supplement).catch((err) => console.error(`illustration for ${supplement.slug} failed: ${String(err)}`)));
        }
        return { supplement, reason: rec.reason };
      }),
    );
    const resolved: { supplement: Supplement; reason: string }[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') resolved.push(outcome.value);
      else console.error(`profile for "${recommendations[i].name}" failed: ${String(outcome.reason)}`);
    });

    // Two recommendations can resolve to the same supplement; keep the first.
    const seen = new Set<number>();
    const items = resolved
      .filter(({ supplement }) => (seen.has(supplement.id) ? false : (seen.add(supplement.id), true)))
      .map(({ supplement, reason }) => ({ supplementId: supplement.id, reason }));

    if (items.length < MIN_RESULTS) {
      throw new Error(`Only ${items.length} of ${recommendations.length} recommendations could be prepared`);
    }
    await saveSessionResults(env.DB, sessionId, items);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`quiz pipeline failed for session ${sessionId}: ${message}`);
    await markSession(env.DB, sessionId, 'failed', message.slice(0, 500));
    throw err;
  }
}
