/**
 * PromptLock — API Key Store (Step 3)
 *
 * Reads API credentials exclusively from process.env (loaded by dotenv).
 * NEVER logs keys. NEVER exposes raw keys to renderer.
 */

'use strict';

const PROVIDERS = {
  groq:        'GROQ_API_KEY',
  gemini:      'GEMINI_API_KEY',
  openai:      'OPENAI_API_KEY',
  anthropic:   'ANTHROPIC_API_KEY',
  openrouter:  'OPENROUTER_API_KEY',
  ollama:      'OLLAMA_HOST',
};

/**
 * Get the currently configured provider name.
 * @returns {string}
 */
function getActiveProvider() {
  return (process.env.AI_PROVIDER || 'gemini').toLowerCase().trim();
}

/**
 * Get the API key (or host URL) for the given provider.
 * Returns the env value — NEVER returns it in logs or renderer.
 * @param {string} [provider]
 * @returns {string|null}
 */
function getKey(provider) {
  const p = (provider || getActiveProvider()).toLowerCase().trim();
  const envVar = PROVIDERS[p];
  if (!envVar) return null;
  const val = process.env[envVar];
  return val && val.trim() ? val.trim() : null;
}

/**
 * Check whether a usable key exists for the given provider.
 * @param {string} [provider]
 * @returns {boolean}
 */
function hasKey(provider) {
  return !!getKey(provider);
}

/**
 * Redact a key string for safe display (shows first 4 + last 4 chars).
 * @param {string} key
 * @returns {string}
 */
function redactKey(key) {
  if (!key || key.length < 10) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Dynamically override a key at runtime (from settings modal save).
 * Stores in process.env only — never written to disk.
 * @param {string} provider
 * @param {string} key
 */
function setKeyRuntime(provider, key) {
  const p = (provider || '').toLowerCase().trim();
  const envVar = PROVIDERS[p];
  if (envVar && key && typeof key === 'string') {
    process.env[envVar] = key.trim();
  }
}

module.exports = {
  getActiveProvider,
  getKey,
  hasKey,
  redactKey,
  setKeyRuntime,
};
