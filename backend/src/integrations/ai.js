import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { ApiError, tooMany, unavailable } from '../common/errors.js';

// Language model adapter for the AI assistant (modules/ai). Every call goes through the server, so
// the provider key never reaches the apps. Callers send only the fields they choose (see ai.routes.js).
//   anthropic: Claude through the Anthropic API (ANTHROPIC_API_KEY, AI_MODEL)
//   mock:      canned text for development and tests; refused in production
//   disabled:  no model; the rule-based answers in ai.routes.js still work

// Models that can fall back to another model on the server when a safety classifier declines.
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

let client;
const anthropic = () => (client ??= new Anthropic({ apiKey: env.ai.anthropicApiKey, timeout: 90_000, maxRetries: 2 }));

export function aiStatus() {
  const { provider, model, anthropicApiKey } = env.ai;
  if (provider === 'anthropic') return { enabled: Boolean(anthropicApiKey), provider, model };
  if (provider === 'mock') return { enabled: !env.isProd, provider, model: 'mock' };
  return { enabled: false, provider: 'disabled', model: null };
}

// One request, one answer. `content` is the user turn: a string, or content blocks (a document or
// image followed by text). A block with cache_control ends a prefix Claude keeps for 5 minutes, so a
// follow-up about the same pet or document skips re-reading it. Returns the text and token counts
// for the usage log.
export async function complete({ system, content }) {
  const status = aiStatus();
  if (!status.enabled) throw unavailable('The AI assistant is not switched on');
  if (status.provider === 'mock') return mockComplete(content);

  let response;
  try {
    response = await anthropic().beta.messages.create({
      model: env.ai.model,
      max_tokens: 16000,
      // Thinking is adaptive on current models; medium effort suits short summaries.
      output_config: { effort: 'medium' },
      ...(SERVER_FALLBACK_MODELS.has(env.ai.model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw tooMany('The AI assistant is busy. Please try again in a minute');
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw unavailable('The AI assistant is not set up correctly');
    if (err instanceof Anthropic.BadRequestError) throw new ApiError(502, 'AI_REQUEST_FAILED', 'The AI assistant could not read this request');
    if (err instanceof Anthropic.APIError) throw unavailable('The AI assistant is unavailable right now. Please try again');
    throw err;
  }

  const usage = {
    model: response.model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    // Above zero when a block marked with cache_control was read from (or written to) the prompt cache.
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
  };
  if (response.stop_reason === 'refusal') {
    throw Object.assign(new ApiError(422, 'AI_DECLINED', 'The assistant cannot help with this request'), { usage });
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw Object.assign(new ApiError(502, 'AI_EMPTY', 'The assistant did not return an answer. Please try again'), { usage });
  return { text, ...usage };
}

function mockComplete(content) {
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const kinds = blocks.map((b) => b.type).join(', ');
  return { text: `[mock] Summary of ${blocks.length} input block(s) (${kinds}). Configure AI_PROVIDER=anthropic for real answers.`, model: 'mock', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
