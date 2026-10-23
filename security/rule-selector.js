/**
 * PromptLock — Context-Aware Security Rule Selector (Step 5)
 *
 * Intelligently analyzes feature intent, project type, and architecture option
 * to select ONLY relevant security rules instead of fixed hardcoded lists.
 * Features:
 *  - AI-based rule selection with `select-security.md` template
 *  - Robust, deterministic heuristic fallback for offline/instant execution
 *  - Mandatory zero-secrets enforcement
 *  - Frontend vs Backend vs Fullstack domain isolation
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { BASE_RULES, getRule, getAllRules, getFrontendRules, getCoreRules } = require('./base-rules');
const { detectProjectType } = require('../ast/project-type-detector');

/**
 * Detect language signals from feature, selectedOption, and explicit language/techStack params.
 */
function detectLanguageSignals(feature, selectedOption, language, requestedLanguage, techStack) {
  const featStr = String(feature || '').toLowerCase();
  const optStr = (typeof selectedOption === 'object' && selectedOption
    ? (selectedOption.name || selectedOption.label || selectedOption.title || selectedOption.description || '')
    : String(selectedOption || '')).toLowerCase();
  const techArr = Array.isArray(techStack) ? techStack : (typeof techStack === 'string' ? [techStack] : []);
  const combined = `${featStr} ${optStr} ${language || ''} ${requestedLanguage || ''} ${techArr.join(' ')}`.toLowerCase();

  const isPython = /\b(python|py)\b/i.test(combined);
  const isGo = /\b(golang|go)\b/i.test(combined) && !/\blet'?s go\b/i.test(combined);
  const isRust = /\brust\b/i.test(combined);
  const isCpp = /(?:^|\W)c\+\+(?:$|\W)/i.test(combined) || /\bcpp\b/i.test(combined);
  const isNonJsBackend = isPython || isGo || isRust || isCpp || /\b(c#|csharp|java|ruby|php)\b/i.test(combined);

  return { isPython, isNonJsBackend };
}

/**
 * Deterministic static heuristic rule selector (Offline / Fallback engine).
 * @param {object} params
 * @param {string} params.feature - Developer's feature request / intent
 * @param {string} params.projectType - "frontend" | "backend" | "fullstack"
 * @param {string|object} [params.selectedOption] - Architectural approach
 * @param {string} [params.language] - Programming language
 * @param {string} [params.requestedLanguage] - Detected requested language
 * @param {string[]|string} [params.techStack] - Tech stack
 * @returns {{ selectedRuleIds: string[], rules: object[], customRules: object[], reasoning: string }}
 */
function selectRulesHeuristically({ feature = '', projectType = 'backend', selectedOption = null, language = null, requestedLanguage = null, techStack = null }) {
  const featStr = String(feature || '').toLowerCase();
  const optStr = (typeof selectedOption === 'object' && selectedOption ? (selectedOption.name || selectedOption.label || selectedOption.title || '') : String(selectedOption || '')).toLowerCase();
  const combined = `${featStr} ${optStr}`;

  const { isPython, isNonJsBackend } = detectLanguageSignals(feature, selectedOption, language, requestedLanguage, techStack);

  const isAuth = /(auth|login|signin|sign-in|jwt|password|bearer|oauth|signup|sign-up|register|credential|role|permission|user session)/i.test(combined);
  const isPayment = /(payment|stripe|paypal|checkout|billing|subscription|invoice|webhook|charge|wallet|credit)/i.test(combined);
  const isDatabase = /(database|db|sql|postgres|mysql|sqlite|mongo|prisma|orm|migration|table|query|repository)/i.test(combined);

  const selectedRuleIds = new Set();
  const customRules = [];
  let reasoning = '';

  // Mandatory: zero-secrets always enforced
  selectedRuleIds.add('zero-secrets');

  if (isNonJsBackend) {
    selectedRuleIds.add('error-masking');

    if (isPython) {
      selectedRuleIds.add('safe-paths');
      selectedRuleIds.add('no-eval-exec');
      selectedRuleIds.add('log-sanitization');
      reasoning = 'Python backend/CLI detected: Enforced safe paths, no eval/exec, log sanitization, and zero secrets. Stripped Node/JS guardrails.';
    } else {
      reasoning = 'Non-JS backend detected: Enforced zero secrets and error masking. Stripped Node/JS guardrails.';
    }

    if (isDatabase) {
      selectedRuleIds.add('sql-guard');
    }
    if (isAuth) {
      selectedRuleIds.add('bcrypt-hash');
    }
    if (isPayment) {
      selectedRuleIds.add('webhook-signature');
      selectedRuleIds.add('idempotency');
    }

    // Strictly eliminate any Node/JS rules
    selectedRuleIds.delete('zod-validation');
    selectedRuleIds.delete('owasp-headers');
    selectedRuleIds.delete('rate-limiting');
    selectedRuleIds.delete('cors');
    selectedRuleIds.delete('express-rate-limit');
    selectedRuleIds.delete('xss-guard');
    selectedRuleIds.delete('no-innerhtml');
    selectedRuleIds.delete('no-eval');
  } else if (projectType === 'frontend') {
    // Frontend projects: DOM & Client-side security
    selectedRuleIds.add('xss-guard');
    selectedRuleIds.add('no-innerhtml');
    selectedRuleIds.add('no-eval');

    // Never inject backend rules for frontend
    selectedRuleIds.delete('sql-guard');
    selectedRuleIds.delete('zod-validation');
    selectedRuleIds.delete('owasp-headers');
    selectedRuleIds.delete('rate-limiting');
    selectedRuleIds.delete('jwt-rotation');
    selectedRuleIds.delete('bcrypt-hash');
    selectedRuleIds.delete('error-masking');
    selectedRuleIds.delete('webhook-signature');
    selectedRuleIds.delete('idempotency');
    selectedRuleIds.delete('database-guard');
    selectedRuleIds.delete('safe-paths');
    selectedRuleIds.delete('no-eval-exec');
    selectedRuleIds.delete('log-sanitization');

    reasoning = `Client-side frontend project detected: Enforced XSS Guard, No innerHTML, and No eval. Suppressed SQL and server validation rules.`;
  } else {
    // Backend or Fullstack projects (Node.js / JavaScript)
    selectedRuleIds.add('error-masking');

    let hasDomain = false;

    if (isPayment) {
      hasDomain = true;
      selectedRuleIds.add('zod-validation');
      selectedRuleIds.add('webhook-signature');
      selectedRuleIds.add('idempotency');
      selectedRuleIds.add('owasp-headers');
      selectedRuleIds.add('rate-limiting');
      reasoning = `Payment/billing feature detected: Enforced webhook signature verification, idempotency keys, and schema sanitization.`;
    }

    if (isAuth) {
      hasDomain = true;
      selectedRuleIds.add('rate-limiting');
      selectedRuleIds.add('sql-guard');
      selectedRuleIds.add('zod-validation');
      selectedRuleIds.add('jwt-rotation');
      selectedRuleIds.add('bcrypt-hash');
      selectedRuleIds.add('owasp-headers');
      reasoning = reasoning ? `${reasoning} + Auth security enforced.` : `Authentication backend feature detected: Enforced rate limiting, password hashing, JWT rotation, and SQL guard.`;
    }

    if (isDatabase && !isAuth && !isPayment) {
      hasDomain = true;
      selectedRuleIds.add('sql-guard');
      selectedRuleIds.add('zod-validation');
      selectedRuleIds.add('owasp-headers');
      reasoning = `Database access feature detected: Enforced SQL/NoSQL injection protection and input validation schemas.`;
    }

    if (!hasDomain) {
      // General backend API
      selectedRuleIds.add('zod-validation');
      selectedRuleIds.add('sql-guard');
      selectedRuleIds.add('owasp-headers');
      reasoning = `Standard backend feature: Enforced OWASP headers, input sanitization, and database query guards.`;
    }

    if (projectType === 'fullstack') {
      selectedRuleIds.add('xss-guard');
    }
  }

  const ruleIdArray = Array.from(selectedRuleIds);
  const rules = ruleIdArray.map(id => getRule(id) || { id, name: id, text: id });

  return {
    selectedRuleIds: ruleIdArray,
    rules,
    customRules,
    reasoning,
    isAiSelected: false,
  };
}

/**
 * Select security rules using AI when available, with automatic static heuristic fallback.
 * @param {object} params
 * @param {string} params.feature - Feature intent
 * @param {string} [params.projectType] - "frontend" | "backend" | "fullstack"
 * @param {string|object} [params.selectedOption] - Architectural option
 * @param {object} [params.snapshot] - AST snapshot
 * @param {object} [params.projectMemory] - Project intelligence cache
 * @param {string} [params.language] - Programming language
 * @param {string} [params.requestedLanguage] - Detected requested language
 * @param {string[]|string} [params.techStack] - Tech stack
 * @param {object} [aiServiceRef] - Reference to aiService to avoid circular require
 * @returns {Promise<{ selectedRuleIds: string[], rules: object[], customRules: object[], reasoning: string, isAiSelected: boolean }>}
 */
async function selectSecurityRules(params = {}, aiServiceRef = null) {
  let {
    feature = '',
    projectType = null,
    selectedOption = null,
    snapshot = null,
    projectMemory = null,
    language = null,
    requestedLanguage = null,
    techStack = null,
  } = params;

  const { isPython, isNonJsBackend } = detectLanguageSignals(
    feature,
    selectedOption,
    language,
    requestedLanguage,
    techStack || projectMemory?.techStack
  );

  // Resolve project type if not provided
  if (!projectType) {
    const isEmpty = snapshot && Array.isArray(snapshot.files) && snapshot.files.length === 0;
    if (isEmpty) {
      projectType = isNonJsBackend ? 'backend' : 'frontend';
    } else if (snapshot || projectMemory) {
      const typeResult = detectProjectType(snapshot, projectMemory || {});
      projectType = typeResult.projectType === 'unknown' ? (isNonJsBackend ? 'backend' : 'frontend') : typeResult.projectType;
    } else {
      projectType = isNonJsBackend ? 'backend' : 'frontend';
    }
  }

  // Normalize project type
  const normType = isNonJsBackend
    ? 'backend'
    : (String(projectType).toLowerCase().includes('front') ? 'frontend'
      : (String(projectType).toLowerCase().includes('full') ? 'fullstack' : 'backend'));

  // Generate deterministic heuristic baseline
  const heuristicBaseline = selectRulesHeuristically({
    feature,
    projectType: normType,
    selectedOption,
    language,
    requestedLanguage,
    techStack,
  });

  // Try AI service if available
  let aiService = aiServiceRef;
  if (!aiService) {
    try {
      aiService = require('../ai/ai-service');
    } catch (_) {}
  }

  if (aiService && typeof aiService.callProviderWithFallback === 'function') {
    try {
      let promptTemplate = '';
      const promptPath = path.join(__dirname, '../ai/prompts/select-security.md');
      if (fs.existsSync(promptPath)) {
        promptTemplate = fs.readFileSync(promptPath, 'utf8');
      }

      if (promptTemplate) {
        const availableRulesText = BASE_RULES.map(r => `- [${r.id}] ${r.name}: ${r.text}`).join('\n');
        const optLabel = typeof selectedOption === 'object' && selectedOption
          ? (selectedOption.name || selectedOption.label || selectedOption.title || 'Standard Approach')
          : String(selectedOption || 'Standard Approach');

        const prompt = promptTemplate
          .replace('{{feature}}', feature || 'Feature Implementation')
          .replace('{{projectType}}', normType)
          .replace('{{selectedOption}}', optLabel)
          .replace('{{availableRules}}', availableRulesText);

        const aiResponse = await aiService.callProviderWithFallback(prompt);
        if (aiResponse && aiResponse.success && aiResponse.data) {
          let parsed = null;
          if (typeof aiResponse.data === 'object' && Array.isArray(aiResponse.data.selectedRuleIds)) {
            parsed = aiResponse.data;
          } else if (typeof aiResponse.data === 'string') {
            try {
              const clean = aiResponse.data.replace(/```json/gi, '').replace(/```/g, '').trim();
              parsed = JSON.parse(clean);
            } catch (_) {}
          }

          if (parsed && Array.isArray(parsed.selectedRuleIds) && parsed.selectedRuleIds.length > 0) {
            const ruleIds = new Set(parsed.selectedRuleIds);
            // Mandatory invariant
            ruleIds.add('zero-secrets');

            // Sanitize against hallucinations based on project type & language
            if (isNonJsBackend) {
              ruleIds.delete('zod-validation');
              ruleIds.delete('owasp-headers');
              ruleIds.delete('rate-limiting');
              ruleIds.delete('cors');
              ruleIds.delete('express-rate-limit');
              ruleIds.delete('xss-guard');
              ruleIds.delete('no-innerhtml');
              ruleIds.delete('no-eval');
              if (isPython) {
                ruleIds.add('safe-paths');
                ruleIds.add('no-eval-exec');
                ruleIds.add('log-sanitization');
              }
            } else if (normType === 'frontend') {
              ruleIds.delete('sql-guard');
              ruleIds.delete('zod-validation');
              ruleIds.delete('owasp-headers');
              ruleIds.delete('rate-limiting');
              ruleIds.delete('jwt-rotation');
              ruleIds.delete('bcrypt-hash');
              ruleIds.delete('error-masking');
              ruleIds.delete('webhook-signature');
              ruleIds.delete('idempotency');
              ruleIds.delete('database-guard');
              ruleIds.delete('safe-paths');
              ruleIds.delete('no-eval-exec');
              ruleIds.delete('log-sanitization');
              ruleIds.add('xss-guard');
              ruleIds.add('no-innerhtml');
              ruleIds.add('no-eval');
            }

            const customRules = Array.isArray(parsed.customRules) ? parsed.customRules : [];
            const resolvedRules = Array.from(ruleIds).map(id => {
              const base = getRule(id);
              if (base) return base;
              const custom = customRules.find(c => c.id === id);
              return custom || { id, name: id, text: id };
            });

            return {
              selectedRuleIds: Array.from(ruleIds),
              rules: resolvedRules,
              customRules,
              reasoning: parsed.reasoning || 'AI-selected contextual security rules',
              isAiSelected: true,
              providerUsed: aiResponse.providerUsed,
            };
          }
        }
      }
    } catch (err) {
      console.warn('[Rule Selector] AI rule selection fallback used:', err.message);
    }
  }

  return heuristicBaseline;
}

module.exports = {
  selectSecurityRules,
  selectRulesHeuristically,
};
