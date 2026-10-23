/**
 * PromptLock — Gemini Adapter (Step 3)
 *
 * Wraps @google/generative-ai for PromptLock's AI service.
 * Default model: gemini-2.0-flash (stable, free-tier compatible)
 * Override via GEMINI_MODEL env variable.
 */

'use strict';

const { getKey } = require('../api-key-store');

// gemini-2.5-flash is confirmed working with this API key.
// gemini-2.0-flash, gemini-1.5-flash, gemini-3.8-flash — all return 404 with current key.
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Call the Gemini API with a text prompt.
 * @param {string} prompt
 * @returns {Promise<string>} Raw text response
 */
async function call(prompt, options = {}) {
  const apiKey = getKey('gemini');
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // Lazy-load to avoid startup overhead if Gemini not used
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const genConfig = {};
  if (options?.temperature !== undefined) {
    genConfig.temperature = options.temperature;
  }
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: Object.keys(genConfig).length > 0 ? genConfig : undefined,
  });

  const result = await model.generateContent(prompt);
  const response = await result.response;

  // Guard: detect blocked / empty responses before calling .text()
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(
      `Gemini response blocked or empty (finishReason: ${finishReason}). ` +
      'This may be due to safety filters or an invalid prompt.'
    );
  }

  const text = response.text();
  if (!text || text.trim() === '') {
    throw new Error(
      `Gemini returned an empty response (model: ${MODEL_NAME}). ` +
      'Check that the model name is valid and the prompt is not empty.'
    );
  }

  return text;
}

module.exports = { call, model: MODEL_NAME, provider: 'gemini' };
