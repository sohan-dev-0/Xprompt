/**
 * PromptLock — Adapter Factory (Step 3)
 *
 * Returns the correct AI adapter module based on provider name.
 * All adapters must implement: async call(prompt) → string
 */

'use strict';

const ADAPTERS = {
  groq:       () => require('./groq'),
  gemini:     () => require('./gemini'),
  openai:     () => require('./openai'),
  anthropic:  () => require('./anthropic'),
  openrouter: () => require('./openrouter'),
  ollama:     () => require('./ollama'),
};

/**
 * Get an adapter by provider name.
 * @param {string} provider
 * @returns {{ call: (prompt: string) => Promise<string>, provider: string }}
 */
function getAdapter(provider) {
  const key = (provider || 'gemini').toLowerCase().trim();
  const factory = ADAPTERS[key];
  if (!factory) {
    throw new Error(`Unknown AI provider: "${provider}". Supported: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return factory();
}

/**
 * List all supported provider names.
 * @returns {string[]}
 */
function listProviders() {
  return Object.keys(ADAPTERS);
}

module.exports = { getAdapter, listProviders };
