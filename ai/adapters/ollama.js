/**
 * PromptLock — Ollama Adapter Stub (Step 3)
 * TODO: Implement with local Ollama API (http://localhost:11434).
 */
'use strict';
const { getKey } = require('../api-key-store');

async function call(prompt) {
  const host = getKey('ollama') || process.env.OLLAMA_HOST || 'http://localhost:11434';
  throw new Error('Ollama adapter not yet implemented — set AI_PROVIDER=gemini in .env');
}

module.exports = { call, provider: 'ollama' };
