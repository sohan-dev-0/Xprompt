/**
 * PromptLock — Anthropic Adapter (Step 3 & Polish)
 *
 * Calls Anthropic Messages API (v1/messages).
 * Default model: claude-3-5-sonnet-latest (customizable via ANTHROPIC_MODEL).
 */

'use strict';

const { getKey } = require('../api-key-store');

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 30_000;

function getModelName() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/**
 * Call Anthropic messages API.
 * @param {string|Array<{role: string, content: string}>} promptOrMessages
 * @returns {Promise<string>}
 */
async function call(promptOrMessages, options = {}) {
  const apiKey = getKey('anthropic') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing in .env');
  }

  const model = getModelName();
  let messages = [];

  if (typeof promptOrMessages === 'string') {
    messages = [{ role: 'user', content: promptOrMessages }];
  } else if (Array.isArray(promptOrMessages)) {
    messages = promptOrMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  } else {
    throw new Error('Invalid prompt provided to Anthropic adapter');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errMsg = data?.error?.message || `Anthropic API returned HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const content = data?.content?.[0]?.text;
    if (typeof content !== 'string') {
      throw new Error(`Anthropic returned empty response for model: ${model}`);
    }

    return content.trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Anthropic request timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

module.exports = {
  call,
  get model() { return getModelName(); },
  provider: 'anthropic',
};
