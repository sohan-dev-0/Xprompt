/**
 * PromptLock — Groq Adapter (Step 3)
 *
 * Calls Groq Cloud API (OpenAI-compatible) with ultra-low latency.
 * Default model: qwen/qwen3.8-27b (customizable via GROQ_MODEL).
 */

'use strict';

const { getKey } = require('../api-key-store');

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const GROQ_API_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS    = 30_000;

function getModelName() {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

/**
 * Call Groq chat completions API with a prompt or message array.
 * @param {string|Array<{role: string, content: string}>} promptOrMessages
 * @returns {Promise<string>} Raw text completion
 */
async function call(promptOrMessages, options = {}) {
  const apiKey = getKey('groq');
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured in .env or Settings');
  }

  const model = getModelName();
  let messages = [];

  if (typeof promptOrMessages === 'string') {
    messages = [{ role: 'user', content: promptOrMessages }];
  } else if (Array.isArray(promptOrMessages)) {
    messages = promptOrMessages;
  } else {
    throw new Error('Invalid prompt provided to Groq adapter');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature !== undefined ? options.temperature : 0.2,
        max_tokens: options?.max_tokens !== undefined ? options.max_tokens : 800,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errMsg = data?.error?.message || `Groq API returned HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`Groq returned empty response for model: ${model}`);
    }

    return content.trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Groq request timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

module.exports = {
  call,
  get model() { return getModelName(); },
  provider: 'groq',
};
