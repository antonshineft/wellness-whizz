/**
 * Claude (Anthropic) calls, paid from the plan's monthly API credits. One function: a JSON answer that matches a
 * schema, the same contract as the OpenAI path in src/openai.ts, so every caller (quiz, profiles, articles, FAQs,
 * research notes, X posts, the Reddit digest) goes through chatJson() and never knows which provider answered.
 *
 * Models (wrangler.jsonc vars): CLAUDE_MODEL for the main work (quiz, profiles, articles, FAQs), CLAUDE_MODEL_FAST for
 * bulk and short jobs (research notes, X posts, digest drafting) and CLAUDE_MODEL_SCREEN for cheap classification.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeEnv {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MODEL_FAST?: string;
  CLAUDE_MODEL_SCREEN?: string;
}

export type ModelTier = 'main' | 'fast' | 'screen';
export type Effort = 'low' | 'medium' | 'high';

export interface ClaudeOptions {
  /** Which configured model answers; default "main". */
  tier?: ModelTier;
  /** Thinking depth; default "medium" (the quiz uses "low" so the browser is still connected when it finishes). */
  effort?: Effort;
  /** Hard limit on the answer; default 8000 tokens. */
  maxTokens?: number;
  /** Per-request timeout in milliseconds; default 90 s (the quiz passes 45 s). */
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors inside the SDK; default 1. */
  maxRetries?: number;
}

const DEFAULT_MODELS: Record<ModelTier, string> = {
  main: 'claude-opus-5-5',
  fast: 'claude-sonnet-5-5',
  screen: 'claude-haiku-5-5',
};

export function claudeEnabled(env: ClaudeEnv): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

export function claudeModel(env: ClaudeEnv, tier: ModelTier = 'main'): string {
  const configured = tier === 'main' ? env.CLAUDE_MODEL : tier === 'fast' ? env.CLAUDE_MODEL_FAST : env.CLAUDE_MODEL_SCREEN;
  return (configured ?? '').trim() || DEFAULT_MODELS[tier];
}

/** Thrown for answers the caller cannot use (refusal, truncated JSON, empty answer); never worth retrying on OpenAI blindly, but safe to. */
export class ClaudeAnswerError extends Error {
  constructor(message: string, readonly stopReason: string | null) {
    super(message);
    this.name = 'ClaudeAnswerError';
  }
}

/**
 * One request, one JSON object that matches `schema` (structured outputs). `system` is the standing instruction,
 * `user` the task. The schema is the same JSON Schema the OpenAI strict mode takes (object, additionalProperties
 * false, every property required), so both providers share one definition.
 */
export async function claudeJson<T>(env: ClaudeEnv, system: string, user: string, schema: unknown, opts: ClaudeOptions = {}): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: opts.timeoutMs ?? 90_000,
    maxRetries: opts.maxRetries ?? 1,
  });
  const response = await client.messages.create({
    model: claudeModel(env, opts.tier ?? 'main'),
    max_tokens: opts.maxTokens ?? 8000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: opts.effort ?? 'medium',
      format: { type: 'json_schema', schema: schema as Record<string, unknown> },
    },
  });
  if (response.stop_reason === 'refusal') {
    throw new ClaudeAnswerError(`Claude declined the request${response.stop_details ? ` (${JSON.stringify(response.stop_details)})` : ''}`, response.stop_reason);
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text.trim()) throw new ClaudeAnswerError('Claude returned an empty answer', response.stop_reason);
  if (response.stop_reason === 'max_tokens') throw new ClaudeAnswerError('Claude ran out of output tokens before finishing the JSON', response.stop_reason);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ClaudeAnswerError(`Claude returned text that is not JSON: ${text.slice(0, 120)}`, response.stop_reason);
  }
}

/** True for failures where trying the other provider makes sense (anything but a bad request we authored). */
export function claudeRetryableElsewhere(err: unknown): boolean {
  if (err instanceof Anthropic.BadRequestError) return false;
  return true;
}
