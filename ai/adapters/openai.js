/**
 * PromptLock — OpenAI Adapter (Step 3 & Polish)
 *
 * Calls OpenAI API (v1/chat/completions).
 * Default model: gpt-4o-mini (customizable via OPENAI_MODEL).
 */

'use strict';

const { getKey } = require('../api-key-store');

const DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 30_000;

function getModelName() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

/**
 * Call OpenAI chat completions API.
 * @param {string|Array<{role: string, content: string}>} promptOrMessages
 * @returns {Promise<string>}
 */
async function call(promptOrMessages, options = {}) {
  const apiKey = getKey('openai') || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing in .env');
  }

  const model = getModelName();
  let messages = [];

  if (typeof promptOrMessages === 'string') {
    messages = [{ role: 'user', content: promptOrMessages }];
  } else if (Array.isArray(promptOrMessages)) {
    messages = promptOrMessages;
  } else {
    throw new Error('Invalid prompt provided to OpenAI adapter');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature !== undefined ? options.temperature : 0.2,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errMsg = data?.error?.message || `OpenAI API returned HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`OpenAI returned empty response for model: ${model}`);
    }

    return content.trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`OpenAI request timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

module.exports = {
  call,
  get model() { return getModelName(); },
  provider: 'openai',
};
