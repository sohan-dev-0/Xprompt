/**
 * PromptLock — OpenRouter Adapter Stub (Step 3)
 * TODO: Implement with fetch/axios to api.openrouter.ai when key is configured.
 */
'use strict';
const { getKey } = require('../api-key-store');

async function call(prompt) {
  const apiKey = getKey('openrouter');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');
  throw new Error('OpenRouter adapter not yet implemented — set AI_PROVIDER=gemini in .env');
}

module.exports = { call, provider: 'openrouter' };
