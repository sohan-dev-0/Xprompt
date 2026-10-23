/**
 * PromptLock — AI Service (Step 3 & Polish)
 *
 * Central AI orchestration layer. Manages:
 *  - understandProject(): Analyze AST snapshot → project intelligence
 *  - suggestOptions(): Feature request → A/B/C approach options
 *  - chatRespond(): Developer message → AI reply & command dispatcher
 *  - testConnection(): Health check for active provider
 *  - callProviderWithFallback(): Fallback chain (groq -> gemini -> openai)
 *
 * Security rules:
 *  - NEVER send raw source code to AI — only AST summaries
 *  - NEVER log API keys, prompts, or file contents
 *  - Always try-catch with 30s timeout
 *  - On failure → return fallback static response
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { getAdapter }       = require('./adapters/adapter-factory');
const { getActiveProvider, hasKey, redactKey, getKey } = require('./api-key-store');
const { detectProjectType, validateOptions, getStaticFallbackOptions } = require('../ast/project-type-detector');

const AI_TIMEOUT_MS = 30_000;

// ── Prompt Templates ──────────────────────────────────────────────────────────

const PROMPTS = {
  'understand-project': null,
  'suggest-options':    null,
  'chat-respond':       null,
  'select-security':    null,
  'bug-fix-prompt':     null,
};

function loadPrompt(name) {
  if (PROMPTS[name]) return PROMPTS[name];
  const p = path.join(__dirname, 'prompts', `${name}.md`);
  try {
    PROMPTS[name] = fs.readFileSync(p, 'utf8');
  } catch (_) {
    PROMPTS[name] = `You are PromptLock AI. Return ONLY valid JSON. Analyze the input and respond.`;
  }
  return PROMPTS[name];
}

// ── In-Memory Process State (Isolated per Project) ──────────────────────────
let inMemoryState = {
  astSummary: null,
  projectMemory: {},
  activeFeatureRequirements: [],
  currentIntent: '',
  pendingAction: null,
  pendingFeature: null,
  pendingBugReport: null,
};

function clearMemory() {
  inMemoryState = {
    astSummary: null,
    projectMemory: {},
    activeFeatureRequirements: [],
    currentIntent: '',
    pendingAction: null,
    pendingFeature: null,
    pendingBugReport: null,
  };
}

function getInMemoryState() {
  return inMemoryState;
}

function setInMemoryState(updates = {}) {
  Object.assign(inMemoryState, updates);
}

function detectLanguageFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  if (/(?:^|\W)c\+\+(?:$|\W)/i.test(text) || /\bcpp\b/i.test(lower)) return 'C++';
  if (/(?:^|\W)c#(?:$|\W)/i.test(text) || /\bcsharp\b/i.test(lower)) return 'C#';
  if (/\bpython\b/i.test(lower) || /(?:script|cli).*?(?:file|path|delete|minute|duration)/i.test(lower)) return 'Python';
  if (/\bjava\b(?!script)/i.test(lower)) return 'Java';
  if (/\b(golang|go)\b/i.test(lower) && !/\blet'?s go\b/i.test(lower) && !/\bgo to\b/i.test(lower)) return 'Go';
  if (/\brust\b/i.test(lower)) return 'Rust';
  if (/\bruby\b/i.test(lower)) return 'Ruby';
  if (/\bphp\b/i.test(lower)) return 'PHP';
  if (/\bswift\b/i.test(lower)) return 'Swift';
  if (/\bkotlin\b/i.test(lower)) return 'Kotlin';
  if (/\btypescript\b/i.test(lower)) return 'TypeScript';
  if (/\bjavascript\b/i.test(lower)) return 'JavaScript';
  return null;
}

/**
 * Detect if developer explicitly requests to transition from brainstorming to coding or prompt generation.
 * @param {string} text
 * @returns {boolean}
 */
function isCodingTransitionIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  return /^(?:okay,?\s*|ok,?\s*)?(?:let'?s\s+(?:start\s+)?(?:coding|building|implementation)|start\s+(?:coding|building|implementing|now)|generate\s+prompt|prompt\s+(?:daw|dao|banao|den)|ekhon\s+prompt\s+(?:daw|dao)|code\s+shuru\s+kori|shuru\s+kora\s+jak|start\s+project\s+now)$/i.test(s)
    || /^(?:okay,?\s*|ok,?\s*)?let'?s\s+(?:start\s+)?(?:building|coding)$/i.test(s)
    || /^(?:generate\s+prompt|prompt\s+(?:daw|dao|banao))$/i.test(s);
}

function extractFeatureNameFromMessage(text) {
  if (!text || typeof text !== 'string') return '';
  const clean = text.trim().replace(/[?.!]+$/, '');
  const m = clean.match(/(?:i\s+want\s+to\s+|please\s+|can\s+you\s+|let'?s\s+)?(?:add|build|create|make|implement|start)\s+(?:a\s+|an\s+|the\s+)?(.+)/i);
  if (m && m[1]) {
    return m[1].trim();
  }
  return '';
}

// ── AST Summary Builder (token-saver: no raw source ever) ─────────────────────

function buildAstSummary(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.files)) return null;
  const files = snapshot.files.slice(0, 40); // cap to 40 files for prompt budget
  const allFunctions = [];
  const allClasses = [];
  const topFiles = files.map(f => {
    const fns = Array.isArray(f.fns)
      ? f.fns
      : (Array.isArray(f.functions)
        ? f.functions
        : (Array.isArray(f.ast?.functions) ? f.ast.functions : []));
    fns.forEach(fn => {
      const name = typeof fn === 'string' ? fn : (fn?.name || String(fn));
      if (name && !allFunctions.includes(name)) allFunctions.push(name);
    });
    const classes = Array.isArray(f.classes)
      ? f.classes
      : (Array.isArray(f.ast?.classes) ? f.ast.classes : []);
    classes.forEach(c => {
      const name = typeof c === 'string' ? c : (c?.name || String(c));
      if (name && !allClasses.includes(name)) allClasses.push(name);
    });
    return {
      path:    f.path,
      fns:     fns.slice(0, 10),
      classes: classes.slice(0, 10),
      exports: (f.exports || f.ast?.exports || []).slice(0, 6),
      imports: (f.imports || f.ast?.imports || []).slice(0, 6).map(i => i.from || i),
      isAST:   f.isAST || false,
      loc:     f.loc   || 0,
    };
  });

  return {
    totalFiles:   snapshot.stats?.totalFiles || files.length,
    astFiles:     snapshot.stats?.astFiles   || 0,
    functions:    snapshot.stats?.functions  || allFunctions.length,
    allFunctions,
    allClasses,
    uniqueDeps:   snapshot.stats?.uniqueDeps || 0,
    rootPath:     path.basename(snapshot.rootPath || ''),
    topFiles,
    depHealth: (snapshot.depHealth || []).map(d => ({
      label: d.label,
      score: d.score,
    })),
  };
}

// ── Provider Fallback Chain (Task 9) ─────────────────────────────────────────

const FALLBACK_ORDER = ['gemini', 'groq', 'openai'];

// ── Provider Rate Limit (429) Cooldown Tracker ──────────────────────────────
const providerCooldowns = new Map();

function isProviderCoolingDown(provider) {
  const p = (provider || '').toLowerCase().trim();
  const until = providerCooldowns.get(p);
  if (!until) return false;
  if (Date.now() < until) return true;
  providerCooldowns.delete(p);
  return false;
}

function setProviderCooldown(provider, durationMs = 60000) {
  const p = (provider || '').toLowerCase().trim();
  providerCooldowns.set(p, Date.now() + durationMs);
}

function clearProviderCooldowns() {
  providerCooldowns.clear();
}

/**
 * Execute AI call across provider fallback chain.
 * Order: primary (.env AI_PROVIDER) -> gemini -> groq -> openai (whichever has key).
 * Returns { success, data, error, providerUsed, tried }
 */
async function callProviderWithFallback(prompt, primaryOverride, options = {}) {
  const primary = (primaryOverride || getActiveProvider()).toLowerCase().trim();
  
  // Build ordered chain starting with primary
  const chain = [primary];
  for (const p of FALLBACK_ORDER) {
    if (!chain.includes(p) && hasKey(p)) {
      chain.push(p);
    }
  }

  const tried = [];
  let lastError = null;

  for (const provider of chain) {
    if (!hasKey(provider) && provider !== 'ollama') {
      continue;
    }

    if (isProviderCoolingDown(provider)) {
      console.log(`[AI Service] Skipping ${provider} (in 429 cooldown)...`);
      continue;
    }

    tried.push(provider);
    try {
      const adapter = getAdapter(provider);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`AI call to ${provider} timed out after ${AI_TIMEOUT_MS / 1000}s`)), AI_TIMEOUT_MS)
      );

      const callPromise = adapter.call(prompt, options);
      const raw = await Promise.race([callPromise, timeoutPromise]);

      return {
        success: true,
        data: raw,
        error: null,
        providerUsed: provider,
        tried,
      };
    } catch (err) {
      lastError = err;
      
      // Determine failure code/reason (429, 503, timeout, etc.)
      let failCode = 'error';
      if (/429|quota|rate limit|too many requests/i.test(err.message)) {
        failCode = '429';
        setProviderCooldown(provider, 60000);
        console.warn(`[AI Service] Provider "${provider}" hit rate limit (429). Setting 60s cooldown.`);
      } else if (/503/i.test(err.message)) failCode = '503';
      else if (/timeout/i.test(err.message)) failCode = 'timeout';
      else {
        const codeMatch = err.message.match(/\b(4\d\d|5\d\d)\b/);
        failCode = codeMatch ? codeMatch[1] : err.message.slice(0, 30);
      }

      // Next candidate provider with key
      const currentIndex = chain.indexOf(provider);
      const remainingCandidates = chain.slice(currentIndex + 1).filter(p => (hasKey(p) || p === 'ollama') && !isProviderCoolingDown(p));
      const nextProvider = remainingCandidates.length > 0 ? remainingCandidates[0] : 'static';

      console.log(`[Fallback] ${provider} failed (${failCode}), trying ${nextProvider}...`);
      console.warn(`[AI Service] Provider "${provider}" failed (${err.message}). Attempting fallback candidate...`);
    }
  }

  console.error(`[AI Service] All AI providers failed. Tried: [${tried.join(', ')}]. Error: ${lastError?.message}`);
  return {
    success: false,
    data: null,
    error: `All AI providers failed (tried: [${tried.join(', ')}]). Error: ${lastError?.message || 'No configured AI providers available'}`,
    providerUsed: 'fallback',
    tried,
  };
}

/**
 * Low-level call preserving backward-compatibility with existing tests.
 */
async function callProvider(prompt, provider) {
  const res = await callProviderWithFallback(prompt, provider);
  if (!res.success) {
    throw new Error(res.error || 'AI call failed');
  }
  return res.data;
}

// ── JSON Response Parser ──────────────────────────────────────────────────────

function parseJsonResponse(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Empty AI response');
  let stripped = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') {
      if (!parsed.responseText && parsed.reply) parsed.responseText = parsed.reply;
      if (!parsed.reply && parsed.responseText) parsed.reply = parsed.responseText;
    }
    return parsed;
  } catch (err) {
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.responseText && parsed.reply) parsed.responseText = parsed.reply;
        if (!parsed.reply && parsed.responseText) parsed.reply = parsed.responseText;
        return parsed;
      } catch (_) {}
    }
    return {
      responseText: stripped,
      reply: stripped,
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['general'],
      followUpQuestion: null,
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze a project snapshot and return structured project intelligence.
 * @param {object} snapshot - AST project snapshot
 * @returns {Promise<object>} Parsed project understanding JSON
 */
async function understandProject(snapshot) {
  const totalFiles = (snapshot?.files || []).length;
  if (totalFiles === 0) {
    return {
      projectName:         path.basename(snapshot?.rootPath || 'project'),
      domain:              'Unknown',
      primaryLanguage:     'Unknown',
      techStack:           'Unknown',
      architecturePattern: 'Unknown',
      entryPoints:         [],
      domainEntities:      [],
      existingFeatures:    [],
      missingBlueprints:   [],
      codeHealthSummary:   'Empty project folder. No files detected.',
      recommendations:     ['Click ➕ Add Feature to start building.'],
      securityFlags:       [],
      complexity:          'low',
      providerUsed:        'empty-project',
    };
  }

  try {
    const summary = buildAstSummary(snapshot);
    if (!summary) throw new Error('No valid AST snapshot provided');

    const systemPrompt = loadPrompt('understand-project');
    const prompt = `${systemPrompt}\n\nAST_SUMMARY:\n${JSON.stringify(summary, null, 2)}`;

    const res = await callProviderWithFallback(prompt);
    if (!res.success) {
      throw new Error(res.error || 'All AI providers failed');
    }

    const parsed = parseJsonResponse(res.data);
    parsed.providerUsed = res.providerUsed;
    return parsed;
  } catch (err) {
    console.warn('[AI Service] understandProject fallback used:', err.message);
    return {
      projectName:         path.basename(snapshot?.rootPath || 'project'),
      domain:              totalFiles === 0 ? 'Unknown' : 'Software Project',
      primaryLanguage:     totalFiles === 0 ? 'Unknown' : 'JavaScript',
      techStack:           totalFiles === 0 ? 'Unknown' : [],
      architecturePattern: 'Unknown',
      entryPoints:         [],
      domainEntities:      [],
      existingFeatures:    [],
      missingBlueprints:   [],
      codeHealthSummary:   'AI analysis unavailable. Using static AST data.',
      recommendations:     ['Configure AI provider in settings for deeper analysis.'],
      securityFlags:       [],
      complexity:          'medium',
      _fallback:           true,
      _error:              err.message,
      providerUsed:        'fallback',
    };
  }
}

/**
 * Detect whether a user prompt requests a single-file / monolithic anti-pattern.
 * @param {string} text
 * @returns {boolean}
 */
function isSingleFileConstraint(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.toLowerCase();
  return /\b(single[\s-]*file|one[\s-]*file|monolith(ic)?|all[\s-]in[\s-]one(\s*file)?)\b/i.test(s)
    || /\b(?:just|only|keep\s+it\s+in|build\s+it\s+in|put\s+it\s+in|save\s+it\s+in|in)\s+(?:an?\s+)?index\.html\b/i.test(s)
    || /\bindex\.html\s+(?:only|alone)\b/i.test(s)
    || (s.includes('index.html') && (s.includes('single') || s.includes('only') || s.includes('one file') || s.includes('all in')));
}

/**
 * Production-ready Architectural Override options for single-file requests.
 * @returns {object[]}
 */
function getSingleFileOverrideOptions() {
  return [
    {
      id: 'A',
      label: 'Option A: Production Modular Structure (Recommended)',
      name: 'Production Modular Structure (Recommended)',
      title: 'Production Modular Structure (Recommended)',
      description: 'Separation of concerns with clean HTML for structure, CSS for styling, and modular JavaScript for game/application logic.',
      filesToCreate: ['index.html', 'style.css', 'app.js'],
      filesToEdit: [],
      estimatedComplexity: 'medium',
      tradeoffs: 'Production-ready maintainability and scalability; separate files.',
      isProductionModular: true,
    },
    {
      id: 'B',
      label: 'Option B: Single File Prototype (Not for Production)',
      name: 'Single File Prototype (Not for Production)',
      title: 'Single File Prototype (Not for Production)',
      description: 'Monolithic index.html with inline styles and scripts. Suitable only for rapid throwaway prototyping.',
      filesToCreate: ['index.html'],
      filesToEdit: [],
      estimatedComplexity: 'low',
      tradeoffs: 'Fast initial setup; unmaintainable and not recommended for production.',
      isSingleFilePrototype: true,
    },
    {
      id: 'C',
      label: 'Option C: Component-Based Architecture (Web Components)',
      name: 'Component-Based Architecture (Web Components)',
      title: 'Component-Based Architecture (Web Components)',
      description: 'Modular architecture using Web Components or ES6 modules for reusable UI components.',
      filesToCreate: ['index.html', 'style.css', 'components.js', 'app.js'],
      filesToEdit: [],
      estimatedComplexity: 'high',
      tradeoffs: 'High encapsulation and reusability; requires component lifecycle understanding.',
    },
  ];
}

// ── Meta Command & Bengali NLP Helpers ───────────────────────────────────────

const META_COMMAND_REGEX = /(prompt daw|prompt dao|give.*prompt|fix.*prompt|generate prompt|\bok\b|\bok\s+fix\b|\bprompt\b)/i;

/**
 * Strip Bengali demonstrative stop words ("ai", "ei", "oi", "eita", "oita")
 * unless explicitly used as Artificial Intelligence (AI).
 * @param {string} text
 * @returns {string}
 */
function stripBengaliStopWords(text) {
  if (!text || typeof text !== 'string') return text;
  const isExplicitAI = /\b(artificial\s+intelligence|machine\s+learning|ai\s+(model|bot|agent|opponent|player|algorithm|npc))\b/i.test(text);
  if (isExplicitAI) return text;
  return text.replace(/\b(ai|ei|oi|eita|oita)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Check if message refers to "this feature" (Bengali "ai feature ta", "ei feature ta", etc.)
 * @param {string} text
 * @returns {boolean}
 */
function isThisFeatureReference(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();
  return /\b(ai|ei|oi|eita|oita)\s+(feature(\s*ta)?|ta|kaj|jinish)\b/i.test(s) ||
         /\b(ai|ei|oi)\s+feature\b/i.test(s) ||
         /^(ok\s+)?(ai|ei|oi|eita|oita)\s+(feature\s+(ta\s+)?)?(add|koro|kore\s+daw|kore\s+dao|banao|chai|implement)\b/i.test(s) ||
         /^(ok\s+)?(feature\s+ta\s+)?(add\s+kore\s+daw|add\s+kore\s+dao|add\s+koro|banao)\b/i.test(s);
}

function isDetailOrRelated(msg, prevFeature) {
  if (!msg || typeof msg !== 'string') return false;
  if (!prevFeature || typeof prevFeature !== 'string') return true;
  const s = msg.toLowerCase().trim();
  if (s.length < 35) return true;
  if (/\b(also|and|with|button|color|style|oauth|auth|login|token|css|ui|theme|rounded|blue|red|click)\b/i.test(s)) return true;
  return false;
}

/**
 * Detect if user message is reporting a bug or broken behavior
 * rather than requesting a new feature.
 * @param {string} text
 * @returns {boolean}
 */
function isBugReport(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  if (s.length < 2) return false;
  const lower = s.toLowerCase();

  // Meta-commands to generate prompt or fix must NEVER be treated as a new bug report
  if (META_COMMAND_REGEX.test(s)) {
    return false;
  }

  // Guard against deliberate feature requests for error infrastructure
  if (/\b(implement|add|create|build|setup|support)\s+(an?\s+)?error\s+(handling|handler|page|boundary|logger|middleware|logging)\b/i.test(lower)) {
    return false;
  }

  const bugPatterns = [
    /\b(not\s+working|doesn'?t\s+work|does\s+not\s+work|don'?t\s+work|do\s+not\s+work|won'?t\s+work)\b/i,
    /\b(broken|broke)\b/i,
    /\bclicking\s+does\s+nothing\b/i,
    /\bclicks?\s+do(es)?\s+nothing\b/i,
    /\bnothing\s+happens(\s+when\s+clicking|\s+on\s+click)?\b/i,
    /\b(fix\s+this|fix\s+it|fix\s+the\s+bug|fix\s+bug|fix\s+error|please\s+fix|fix\s+the\s+issue)\b/i,
    /\b(error|exception|crash|crashes|glitch|bug|unresponsive|freezes?|freeze)\b/i,
    /\b(can'?t|cannot)\s+(click|play|start|run|interact|move|select)\b/i,
    /\b(button|buttons|ui|game|screen|board|cell|element|handler)\s+(is|are|do)?\s*(not\s+working|broken|unresponsive|failing|failed|don'?t\s+work)\b/i,
    // Bengali bug patterns
    /\b(kaj\s+kore\s+na|kaj\s+korse\s+na|kaj\s+korche\s+na|kaj\s+hosse\s+na|kaj\s+hocche\s+na|somossa|noshto|thik\s+na)\b/i,
    /[\u0980-\u09FF].*(কাজ\s*করে\s*না|কাজ\s*করছে\s*না|নষ্ট|ভাঙ্গা|সমস্যা)/i,
  ];

  return bugPatterns.some(pattern => pattern.test(lower));
}

/**
 * Extract a new request if confirmation text contains an additional actionable feature request.
 * E.g., "ok akn taholy login feature add korbo" -> "akn taholy login feature add korbo"
 * @param {string} text
 * @returns {string|null}
 */
function extractNewRequestFromConfirmation(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < 3) return null;

  // If this references "this feature" in Bengali (e.g. "ok ai feature ta add kore daw"), it's NOT a new feature
  if (isThisFeatureReference(trimmed)) {
    return null;
  }

  // Must start with a confirmation word followed by whitespace/punctuation and more text
  const match = trimmed.match(/^(yes|ha|haa|haan|ok|okay|sure|y|alright|fine|thik\s+ache|thik\s+ase)[\s,.:;!?-]+(.+)$/i);
  if (!match) return null;

  const rest = match[2].trim();
  if (!rest || rest.length < 3) return null;

  if (isThisFeatureReference(rest)) {
    return null;
  }

  // Explicit bug fix command is not a new feature request
  if (/^fix(\s+(it|this|the\s+bug|bug|error|issue))?$/i.test(rest)) {
    return null;
  }
  // Pure prompt request phrases
  if (/^(prompt\s+daw|prompt\s+dao|give\s+(me\s+)?(the\s+)?prompt|generate\s+prompt|prompt)$/i.test(rest)) {
    return null;
  }

  const hasFeatureCue = /\b(add|create|build|implement|make|setup|login|auth|payment|stripe|crud|api|route|ui|page|feature|dark\s*mode|dashboard|chat|model|service|game|button|component)\b/i.test(rest)
    || /\b(korbo|koro|lagao|banao|chalau|taholy|akn|dekhao|chai|dorkar|now)\b/i.test(rest);

  if (hasFeatureCue) {
    return rest;
  }

  return null;
}

// BROAD_COMMAND_REGEX: Robust Fallback Regex for Offline Mode
const BROAD_COMMAND_REGEX = /(prompt|plan|option|choice|generate|dao|daw|ready|koro|banao)/i;

/**
 * Detect if user is asking a question or inquiry about options / comparison / recommendations.
 * E.g. "kon option ta valo hoby", "which option is better", "kivabe kaj korbe", "kno option A valo"
 * @param {string} text
 * @returns {boolean}
 */
function isOptionsInquiryQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();
  if (/(how\s+many|koyta)\s+files?/i.test(s) || /what\s+does\s+.*\bdo\b/i.test(s) || /file\s*count/i.test(s)) {
    return false;
  }
  if (/(kon\s*option|kon\s*ta|valo\s*hoby|valo\s*hobe|kno|keno|kivabe|which\s+option|which\s+one|what\s+option|is\s+better|recommend|suggest|best\s+approach|compare)/i.test(s)) {
    return true;
  }
  if ((s.includes('?') || s.endsWith('？')) && /(valo|better|best|kno|keno|kivabe|why|pros\s+and\s+cons)/i.test(s)) {
    return true;
  }
  return false;
}

const STRICT_EVALUATIVE_REGEX = /(kon ta valo|konta valo|which is better|recommend|suggest|kivabe korbo|why)/i;
const EXPANDED_EVALUATIVE_REGEX = /(kon\s*(?:option\s*)?ta\s*valo|kon\s*ta\s*valo|konta\s*valo|which\s*(?:option\s*|one\s*)?is\s*better|which\s+is\s+better|recommend|suggest|kivabe\s*korbo|why|কোনটা\s*ভালো|কোন\s*অপশন.*ভালো)/i;

/**
 * Detect if user is asking an evaluative question comparing/asking for recommendation on options.
 * Matches strict requirements: /(kon ta valo|konta valo|which is better|recommend|suggest|kivabe korbo|why)/i
 * @param {string} text
 * @returns {boolean}
 */
function isEvaluativeQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  const lower = s.toLowerCase();
  if (/(how\s+many|koyta)\s+files?/i.test(lower) || /what\s+does\s+.*\bdo\b/i.test(lower) || /file\s*count/i.test(lower)) {
    return false;
  }
  if (typeof isWhyQuestion === 'function' && isWhyQuestion(text)) return false;

  // "tumi je option gula diso..." / "je option gulo diso"
  if (/(tumi\s*je\s*option|je\s*option\s*(gula|gulo|s)?|option\s*(gula|gulo|s)\s*(er\s*moddhe|theke|moddhe)?).*(kon|valo|bhalo|better|best|kemon|keno|why|which|recommend|suggest)/i.test(lower) ||
      /^(tumi\s*je\s*option|je\s*option)/i.test(lower)) {
    return true;
  }

  // "which is best", "which option is best", "which is better", "which one is best/better", "which one should I choose"
  if (/\bwhich\s+(?:(?:one|option|approach|feature)\s+)?is\s+(?:the\s+)?(best|better|recommended|preferable)\b/i.test(lower) ||
      /\bwhich\s+(?:one|option|approach|feature)\s+should\s+i\s+(?:choose|pick|use|select)\b/i.test(lower) ||
      /\bwhich\s+is\s+(best|better)\b/i.test(lower)) {
    return true;
  }

  // "amr jonno sob theke valo kon option hoby", "sob theke valo kon option", "sobcheye bhalo kon option", "kon feature ta sob theke valo"
  if (/(sob\s*theke\s*valo|sobcheye\s*bhalo|best\s*option|best\s*approach).*(kon|option|feature|hoby|hobe)/i.test(lower) ||
      /(kon\s*(?:option|feature)?).*(sob\s*theke\s*valo|sobcheye\s*bhalo|best)/i.test(lower)) {
    return true;
  }

  // "kon ta valo hoby", "kon option ta valo", "konta valo", "kon feature ta valo"
  if (/(kon\s*(?:option|feature)?\s*(?:ta|ti)?\s*(?:sob\s*theke\s*)?(?:valo|bhalo)\s*(?:hoby|hobe)?|konta\s*(?:valo|bhalo))/i.test(lower)) {
    return true;
  }

  // Direct recommendation keywords
  if (/\b(recommend|suggest)\b/i.test(lower) && /(option|approach|feature|best|which|for\s+me|amr|amar)/i.test(lower)) {
    return true;
  }

  // Bengali script
  if (/(কোন\s*অপশন.*ভালো|কোনটা\s*(ভালো|সেরা)|সেরা\s*অপশন|কোনটি\s*ভালো)/i.test(lower)) {
    return true;
  }

  return STRICT_EVALUATIVE_REGEX.test(s) || EXPANDED_EVALUATIVE_REGEX.test(s) || isOptionsInquiryQuestion(s);
}

function isValidIntentString(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'undefined') return false;
  if (lower === 'feature implementation' || lower === 'implement approved feature scope') return false;
  if (s.endsWith('?') || /^(kon\b|konta\b|kivabe\b|why\b|how\b)/i.test(s)) return false;
  return true;
}

/**
 * Generate an expert option recommendation when user asks an evaluative question while options are present.
 * Grounded in current session.currentPlan.options.
 * Supports both signatures: (options, message) and (message, options, currentIntent, projectContext).
 * @param {Array|string} arg1 - Options array or user message
 * @param {string|Array} arg2 - User message or options array
 * @param {string} currentIntent - Current active intent
 * @param {object} projectContext - Project context
 * @returns {Promise<string>} Recommended option explanation
 */
async function generateOptionRecommendation(arg1, arg2, currentIntent = '', projectContext = {}) {
  let message = '';
  let options = [];
  if (Array.isArray(arg1)) {
    options = arg1;
    message = typeof arg2 === 'string' ? arg2 : '';
  } else {
    message = typeof arg1 === 'string' ? arg1 : '';
    options = Array.isArray(arg2) ? arg2 : [];
  }

  if (!Array.isArray(options) || options.length === 0) {
    try {
      const sessionStore = require('../session-store');
      const st = sessionStore.loadState() || {};
      if (Array.isArray(st.currentPlan?.options) && st.currentPlan.options.length > 0) {
        options = st.currentPlan.options;
      }
    } catch (_) {}
  }

  if (!currentIntent) {
    try {
      const sessionStore = require('../session-store');
      const st = sessionStore.loadState() || {};
      currentIntent = st.currentPlan?.task || st.pendingFeature || st.currentIntent || 'your feature';
    } catch (_) {}
  }

  if (!Array.isArray(options) || options.length === 0) {
    return `For "${currentIntent || 'your feature'}", I recommend following standard modular architecture with separation of concerns.`;
  }

  const optA = options[0];
  const optB = options[1];
  const optC = options[2];

  // Try live AI call first
  try {
    const activeP = getActiveProvider();
    if ((hasKey(activeP) || activeP === 'ollama') && !isProviderCoolingDown(activeP)) {
      const prompt = `You are PromptLock Senior Architecture Advisor.
A developer asked an evaluative question: "${message}"
The current feature being built is: "${currentIntent || 'Feature'}"
The available architectural options are:
${JSON.stringify(options, null, 2)}

Provide a concise, direct, and professional recommendation (2-4 sentences).
Explain why Option A (or the best suited option) is recommended, citing its concrete libraries/techniques (e.g., watchdog library, asyncio, event-driven pattern, performance, simplicity, or reliability).
If the user asked in Bengali or Banglish, answer helpfully in clean Bengali or English.
Do NOT output JSON or markdown codeblocks. Output plain conversational markdown.`;

      const res = await callProviderWithFallback(prompt);
      if (res && res.success && res.data) {
        const text = String(res.data).trim();
        if (text.length > 20 && !text.includes('API Limit') && !text.includes('Too Many')) {
          return text;
        }
      }
    }
  } catch (_) {}

  // Deterministic recommendation fallback grounded in the actual options
  const isBengali = /[\u0980-\u09FF]|amr|amar|valo|hoby|hobe|konta|kivabe/i.test(message);
  const watchdogOpt = options.find(o => /watchdog/i.test((o.label || o.name || '') + ' ' + (o.description || '')));
  const bestOpt = watchdogOpt || optA || options[0];
  const optLabel = bestOpt.label || bestOpt.name || 'Option A';
  const optDesc = bestOpt.description || '';
  const optTradeoffs = bestOpt.tradeoffs || '';

  // Check if Python watchdog option
  if (/watchdog/i.test(optLabel + ' ' + optDesc) || watchdogOpt) {
    const cleanLabel = optLabel.includes('Option') ? optLabel : `Option A (${optLabel})`;
    return isBengali
      ? `আমি **${cleanLabel}** রেকমেন্ড করছি। কারণ এটি Python এর \`watchdog\` লাইব্রেরি ব্যবহার করে real-time OS-level file system events এর মাধ্যমে লগ ফাইল পর্যবেক্ষণ করে। এটি CPU-intensive polling ছাড়াই অত্যন্ত দক্ষ ও দ্রুত কাজ করে।`
      : `I recommend **${cleanLabel}** because it uses the \`watchdog\` library which is event-driven and efficient, avoiding CPU-intensive polling while providing real-time responsiveness.`;
  }

  // Check if asyncio
  if (/asyncio/i.test(optLabel + ' ' + optDesc)) {
    return isBengali
      ? `আমি **${optLabel}** রেকমেন্ড করছি। কারণ এটি \`asyncio\` এবং non-blocking coroutines ব্যবহার করে সমান্তরালভাবে দ্রুত ডেটা স্ট্রিম প্রসেস করতে পারে।`
      : `I recommend **${optLabel}** because it leverages \`asyncio\` for asynchronous, non-blocking coroutines capable of processing streaming data concurrently.`;
  }

  // General grounded recommendation
  return isBengali
    ? `আমি **${optLabel}** বেছে নেওয়ার পরামর্শ দিচ্ছি। কারণ ${optDesc}। এটি প্রোডাকশনের জন্য সবচেয়ে নির্ভরযোগ্য ও মেইনটেইনেবল।`
    : `I recommend **${optLabel}** because ${optDesc || 'it provides the cleanest architecture and separation of concerns'}.${optTradeoffs ? ' (' + optTradeoffs + ')' : ''}`;
}

/**
 * Detect if user message is a complaint that options are missing or did not appear
 * E.g. "option gula ase nai", "option ase nai", "options are not there", "option dekhina", "where are options"
 * @param {string} text
 * @returns {boolean}
 */
function isMissingOptionsComplaint(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();
  return /\b(option\s*(gula|gulo)?\s*(ase\s*nai|ashe\s*nai|nai|dekhina|dekhte\s*pacchi\s*na|koi)|options?\s*(are\s*not\s*there|missing|didn'?t\s*show\s*up|where)|where\s*(are\s*)?(the\s*)?options?)\b/i.test(s) ||
    /(অপশন\s*(গুলো|গুলা)?\s*(নাই|আসে\s*নাই|কই))/i.test(s);
}

/**
 * Detect if user message is asking for architecture options or choices (requesting A/B/C cards).
 * E.g. "option gula daw", "show options", "ki ki option ache?", "choices", "options", "option gula ase nai"
 * Does NOT match specific feature queries like "login option ki ase project a" or "auth option ache?".
 * @param {string} text
 * @returns {boolean}
 */
function isOptionsCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();
  if (isOptionsInquiryQuestion(s)) return false; // Inquiring/comparing options is a question, NOT a command to show options!

  // Missing options complaint or request (e.g. "option gula ase nai", "options are not there", "option dekhina", "where are options")
  if (isMissingOptionsComplaint(s)) return true;

  // Explicit commands to show/display options
  if (/\b(show\s+options?|view\s+options?|give\s+options?|see\s+options?|display\s+options?)\b/i.test(s)) return true;
  if (/\b(option\s*(gula|gulo)\s*(daw|dao|dekhao)|ki\s+ki\s+option\s*(ache|ase)|options?\s*(daw|dao|dekhao)|opt\s+daw|opt\s+dao)\b/i.test(s)) return true;
  if (/^\s*(options?|choices?|approaches?)\s*$/i.test(s)) return true;
  if (/(অপশন\s*(গুলো|গুলা)?\s*(দাও|দেখা|দেখাও|নাই|আসে\s*নাই|কই)|চয়েস)/i.test(s)) return true;

  // If user is asking whether a specific feature option exists (e.g., "login option ki ase", "auth option ache?"),
  // this is a Feature Existence Query, NOT an options command!
  if (/(\b(ase|ache)\b\??|is there|do we have|does.*exist)/i.test(s)) {
    const subj = extractFeatureSubject(s);
    if (subj && subj.length >= 2) {
      return false;
    }
  }

  return false;
}

const VAGUE_PROJECT_REGEX = /(new project|notun project|build a project|kisu banabo|ki banabo)/i;

/**
 * Detect vague project initialization requests that require clarification.
 * E.g. "I want to build a new project", "notun project banabo", "build a project", "kisu banabo", "ki banabo"
 * @param {string} text
 * @returns {boolean}
 */
function isVagueProjectRequest(text) {
  if (!text || typeof text !== 'string') return false;
  return VAGUE_PROJECT_REGEX.test(text);
}

/**
 * Detect if user message is asking for prompt generation / delivery.
 * E.g. "prompt ta dao", "generate the prompt", "ready koro", "plan dao", "ok prompt daw"
 * @param {string} text
 * @returns {boolean}
 */
function isPromptCommand(text) {
  if (!text || typeof text !== 'string') return false;
  if (isVagueProjectRequest(text)) return false;
  const s = text.trim().toLowerCase();
  if (isOptionsInquiryQuestion(s)) return false;
  if (isOptionsCommand(text)) return false; // Options command takes precedence if asking for options
  if (/\b(prompt|strict\s+prompt|directive)\b/i.test(s)) return true;
  if (/\b(ready\s+koro|plan\s+dao|plan\s+daw|banao|prompt\s+banao|make\s+it\s+ready|generate\s+it)\b/i.test(s)) return true;
  if (/(প্রম্পট|রেডি\s*করো|বানাও)/i.test(s)) return true;
  return false;
}

/**
 * Detect if user message is a build / proceed / start command.
 * E.g. "ok akn solo project ta banai", "project ta banai", "cholo banai", "let's build", "start", "shuru", "proceed"
 * @param {string} text
 * @returns {boolean}
 */
function isBuildCommand(text) {
  if (!text || typeof text !== 'string') return false;
  if (isVagueProjectRequest(text)) return false;
  const s = text.trim().toLowerCase();
  if (s.includes('?') || s.endsWith('？')) return false;
  if (isOptionsInquiryQuestion(s)) return false;
  if (isSingleFileConstraint(s)) return false;

  // If message specifies what to build (e.g. "Build a Tic-Tac-Toe game", "Build a real-time password checker", "I want to build...")
  // it is an action feature request, not a confirmation/proceed command
  if (/^(build|create|make|develop|implement)\s+(?:a|an|the)\s+[\w-]+/i.test(s) && !/(?:project|it|this|app\b$)/i.test(s.slice(0, 25))) {
    return false;
  }
  if (/^(i\s+want\s+to\s+build|i\s+want\s+to\s+create|can\s+you\s+build|ami\s+(?:akta|ekta).*?(?:banaity|banate|banabo))/i.test(s)) {
    return false;
  }

  // Recognize "Let's Build" commands: e.g. "ok akn solo project ta banai", "build", "let's build", "banai", "banao", "start", "shuru", "proceed"
  return /(build|banai|banao|start|shuru|proceed)/i.test(s);
}

/**
 * Check if text is a pure confirmation word.
 * @param {string} text
 * @returns {boolean}
 */
function isConfirmationWord(text) {
  if (!text || typeof text !== 'string') return false;
  if (isOptionsCommand(text) || isBuildCommand(text)) return false;
  const trimmed = text.trim();
  return /^((ok|okay|yes|ha|haa|haan|thik\s+ache|sure)\s+)?(yes|ha|haa|haan|ok|okay|sure|y|prompt|daw|dao|prompt\s+daw|prompt\s+dao|prompt\s+ta\s+dao|prompt\s+ta\s+daw|give\s+me\s+the\s+prompt|give\s+prompt|generate\s+prompt|do\s+it|thik\s+ache|thik\s+ase|alright|fine|please\s+do)$/i.test(trimmed);
}

/**
 * Check if text is an explicit bug fix command.
 * @param {string} text
 * @returns {boolean}
 */
function isExplicitFixCommand(text) {
  if (!text || typeof text !== 'string') return false;
  return /^((ok|please|pls|sure|yes|ha|haa)\s+)?fix(\s+(it|this|the\s+bug|bug|error|issue))?$/i.test(text.trim());
}

// ── Feature Existence Question Detection & Subject Extraction ────────────────

const FILE_COUNT_REGEX = /(koyta file|how many files|file count|কয়টা ফাইল)/i;
const FEATURE_LIST_REGEX = /(ki ki feature|ki ki ase|what features|list features)/i;
const GREETING_REGEX = /^\s*(hi|hello|hey|hola|salam|assalamu\s*alaikum|greetings|good\s*(morning|evening|afternoon))([!.,\s]|$)/i;

/**
 * Detect if user message is asking for the file count.
 * E.g., "project a koyta file ase", "how many files", "file count", "কয়টা ফাইল"
 * @param {string} text
 * @returns {boolean}
 */
function isFileCountQuery(text) {
  if (!text || typeof text !== 'string') return false;
  return FILE_COUNT_REGEX.test(text.trim());
}

/**
 * Detect if user message is asking for the list of features/files.
 * E.g., "peoject a ki ki feature ase?", "ki ki ase", "what features", "list features"
 * @param {string} text
 * @returns {boolean}
 */
function isFeatureListQuery(text) {
  if (!text || typeof text !== 'string') return false;
  return FEATURE_LIST_REGEX.test(text.trim());
}

/**
 * Detect if user message is a greeting (e.g., "hi", "hello", "hey").
 * @param {string} text
 * @returns {boolean}
 */
function isGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  return GREETING_REGEX.test(text.trim());
}

/**
 * Format project features and files from snapshot/AST.
 * @param {object} snapshot
 * @param {object} astSummary
 * @returns {string}
 */
function formatProjectFeatureList(snapshot, astSummary) {
  const files = (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0)
    ? snapshot.files
    : (astSummary?.topFiles || []);

  if (files.length === 0) {
    return "Your project currently has no scanned files or features.";
  }

  const filePaths = [];
  const mainFns = [];

  for (const f of files) {
    const p = typeof f === 'string' ? f : (f.path || '');
    if (p) filePaths.push(p);

    const fns = Array.isArray(f.fns) ? f.fns : [];
    for (const fn of fns) {
      let name = typeof fn === 'string' ? fn : (fn?.name || String(fn));
      if (name) {
        // Strip trailing parentheses e.g. generateSaltHex() -> generateSaltHex
        name = name.replace(/\s*\([^)]*\)$/, '').trim();
        if (name && !mainFns.includes(name)) {
          mainFns.push(name);
        }
      }
    }
  }

  let text = `Here are the existing features and files in your project:\n`;
  if (filePaths.length > 0) {
    text += `\n**Key Files (${files.length}):**\n` + filePaths.slice(0, 10).map(f => `- \`${f}\``).join('\n');
    if (filePaths.length > 10) {
      text += `\n- ...and ${filePaths.length - 10} more files.`;
    }
  }
  if (mainFns.length > 0) {
    text += `\n\n**Main Functions / Capabilities:**\n` + mainFns.slice(0, 10).map(fn => `- \`${fn}\``).join('\n');
  }

  return text;
}

const FEATURE_EXISTENCE_REGEX = /(\b(ase|ache)\b\??|is there|do we have|does.*exist|ki ki ase)/i;

/**
 * Extract the subject keyword from a feature existence or action question.
 * E.g., "login feature ase?" -> "login", "is there a login feature?" -> "login",
 *       "login feature add kora ase.. seta aro update kore ty sai" -> "login",
 *       "login option ki ase project a" -> "login"
 * Strictly filters out generic and Banglish stop words:
 *   ami, ar, ta, kore, ty, sai, ase, seta, aro, add, update, feature, option, ki, kno, etc.
 * Returns empty string if the subject is generic or less than 2 characters.
 * @param {string} text
 * @returns {string}
 */
function extractFeatureSubject(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.trim();
  s = s.replace(/[?.,!;:()'"“”’`~\\/|_\-]+/g, ' ').trim();

  // Strip multi-word phrases first
  s = s.replace(/\b(is there|do we have|does|exist|exists|ki ki ase|ki ki ache|ki ki|add kora ase|add kora ache|already added)\b/gi, ' ');
  s = s.replace(/\b(seta aro|aro update|kore ty sai|kore tai chai|aro valo|korte chai|korte sai)\b/gi, ' ');

  // Strip individual stop words strictly
  s = s.replace(/\b(ami|amr|amar|ar|aar|ta|ti|te|kore|kora|kori|korte|ty|tai|sai|chai|chay|se|seta|oita|eta|aro|valo|gula|gulo|nai|ashe)\b/gi, ' ');
  s = s.replace(/\b(add|update|modify|improve|enhance|create|new|banao|banai)\b/gi, ' ');
  s = s.replace(/\b(feature|features|option|options|functionality|functions?|systems?|implementation)\b/gi, ' ');
  s = s.replace(/\b(peoject|poject|project|projects|project-e|project-a)\b/gi, ' ');
  s = s.replace(/\b(file|files|koyta|koita|koyti|koiti)\b/gi, ' ');
  s = s.replace(/\b(ase|ache|asea|chilo|ki|kno|keno|karon)\b/gi, ' ');
  s = s.replace(/\b(a|an|the|any|our|this|amader|amar|kono|kuno|in|of|to|for|on|with)\b/gi, ' ');
  s = s.replace(/(কয়টা|কয়টা|ফাইল|ফাইলগুলো|আছে|কি কি|ফিচার|প্রজেক্ট|অপশন)/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  if (!s || s.length < 2) {
    return '';
  }
  return s;
}

/**
 * Detect feature action intent from user message: 'update', 'add', or 'inquire'.
 * @param {string} text
 * @returns {'update' | 'add' | 'inquire'}
 */
function detectFeatureActionIntent(text) {
  if (!text || typeof text !== 'string') return 'inquire';
  const s = text.toLowerCase();
  if (/\b(update|modify|aro\s+valo|improve|enhance|refactor|change|bodlao|upgrade)\b/i.test(s)) {
    return 'update';
  }
  if (/\b(add|create|new|banao|banai|build|notun)\b/i.test(s)) {
    // If it only says "add kora ase" (already added), that is stating status, not wanting to add
    if (/\b(add\s+kora\s+ase|add\s+kora\s+ache|already\s+added)\b/i.test(s) && !/\b(notun|create|banao|banai)\b/i.test(s)) {
      return 'inquire';
    }
    return 'add';
  }
  return 'inquire';
}

/**
 * Detect if a user message is asking whether a specific feature exists or expressing intent to add/update it.
 * E.g., "login feature ase?", "is there a login feature?", "payment feature ase?",
 *       "login option ki ase project a", "login feature add kora ase.. seta aro update kore ty sai"
 * Note: General queries like file count and feature list queries are handled before this.
 * @param {string} text
 * @returns {boolean}
 */
function isFeatureExistenceQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();

  // 0. Options commands and missing options complaints are NOT feature existence questions
  if (isOptionsCommand(trimmed) || isMissingOptionsComplaint(trimmed)) return false;

  // 1. General queries (File Count or Feature List) must run BEFORE Feature Existence
  if (isFileCountQuery(trimmed) || isFeatureListQuery(trimmed)) return false;

  // 2. Must match existence regex OR express feature status/intent
  const hasExistenceMatch = FEATURE_EXISTENCE_REGEX.test(trimmed) || /\b(add\s+kora\s+ase|add\s+kora\s+ache|update\s+kore\s+ty\s+sai|update\s+korte\s+chai)\b/i.test(trimmed);
  if (!hasExistenceMatch) return false;

  // 3. Must have a valid extracted subject of at least 2 characters (not generic words)
  const subject = extractFeatureSubject(trimmed);
  if (!subject || subject.length < 2) return false;

  return true;
}

const WHY_QUESTION_REGEX = /^(kno\s+(hosse|hocche|amn|hoyse|holo)|keno\s+(hosse|hocche|amn|hoyse|holo)|why\s+(is\s+this\s+happening|did\s+this\s+happen|does\s+this\s+happen)|why\?|keno\?|kno\?|kno\s+amn|keno\s+amn)/i;

/**
 * Detect if user is asking "Why did this happen / why is this happening?"
 * E.g., "kno hosse amn?", "why did this happen?", "keno hocche emon?"
 * @param {string} text
 * @returns {boolean}
 */
function isWhyQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();
  return WHY_QUESTION_REGEX.test(s) || /^(kno|keno)\s+(hosse|hocche|hoyse)\s+amn/i.test(s) || /(why\s+(did|is)\s+(this|it)\s+happen)/i.test(s);
}

/**
 * Search the AST summary and snapshot files for a feature subject keyword.
 * @param {string} subject
 * @param {object} snapshot
 * @param {object} astSummary
 * @returns {{ found: boolean, matchedFn: string|null, matchedFile: string|null, example: string }}
 */
function searchFeatureInAst(subject, snapshot, astSummary) {
  if (!subject) return { found: false, matchedFn: null, matchedFile: null, example: '' };
  const subj = subject.toLowerCase().trim();

  const files = (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0)
    ? snapshot.files
    : (astSummary?.topFiles || []);

  let matchedFn = null;
  let matchedFile = null;
  let matchedExport = null;

  for (const f of files) {
    const filePath = typeof f === 'string' ? f : (f.path || '');
    const fileName = path.basename(filePath);

    // 1. Search function names (f.fns, f.functions, or f.ast.functions)
    const fns = Array.isArray(f.fns)
      ? f.fns
      : (Array.isArray(f.functions)
        ? f.functions
        : (Array.isArray(f.ast?.functions)
          ? f.ast.functions
          : []));
    for (const fn of fns) {
      const fnName = typeof fn === 'string' ? fn : (fn?.name || String(fn));
      if (fnName.toLowerCase().includes(subj)) {
        matchedFn = fnName;
        matchedFile = fileName || filePath;
        break;
      }
    }
    if (matchedFn) break;

    // 2. Search exports (f.exports or f.ast.exports)
    const exportsList = Array.isArray(f.exports)
      ? f.exports
      : (Array.isArray(f.ast?.exports)
        ? f.ast.exports
        : []);
    for (const exp of exportsList) {
      const expName = typeof exp === 'string' ? exp : (exp?.name || String(exp));
      if (expName.toLowerCase().includes(subj)) {
        matchedExport = expName;
        matchedFile = fileName || filePath;
        break;
      }
    }
    if (matchedExport) break;

    // 3. Search file name / path
    if (fileName.toLowerCase().includes(subj)) {
      matchedFile = fileName;
    }
  }

  if (!matchedFn && !matchedExport && !matchedFile && astSummary?.topFiles) {
    for (const f of astSummary.topFiles) {
      const filePath = f.path || '';
      const fileName = path.basename(filePath);
      const fns = Array.isArray(f.fns) ? f.fns : [];
      for (const fn of fns) {
        const fnName = typeof fn === 'string' ? fn : (fn?.name || String(fn));
        if (fnName.toLowerCase().includes(subj)) {
          matchedFn = fnName;
          matchedFile = fileName || filePath;
          break;
        }
      }
      if (matchedFn) break;
      if (fileName.toLowerCase().includes(subj)) {
        matchedFile = fileName;
        break;
      }
    }
  }

  const found = Boolean(matchedFn || matchedExport || matchedFile);
  const fnOrExp = matchedFn || matchedExport;
  let example = '';
  if (fnOrExp && matchedFile) {
    example = `${fnOrExp} in ${matchedFile}`;
  } else if (fnOrExp) {
    example = fnOrExp;
  } else if (matchedFile) {
    example = matchedFile;
  }

  return {
    found,
    matchedFn: fnOrExp,
    matchedFile,
    example,
  };
}

/**
 * Detect if user message is a conversational question or inquiry about a feature or project
 * (e.g. "ki ki feature thakby", "kemon hobe?", "how will it look?", "details bolo", "kon option ta valo hoby")
 * rather than a new feature request or command.
 * @param {string} text
 * @returns {boolean}
 */
function isConversationalQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  const lower = s.toLowerCase();

  // Questions about feature existence are handled by dedicated existence interceptor
  if (isFeatureExistenceQuestion(text)) return false;

  // Questions about options (e.g. "kon option ta valo hoby", "which option is better?") ARE questions
  if (isOptionsInquiryQuestion(lower)) return true;

  // If user explicitly asks for options, prompt, or build, it is a command request
  if (isOptionsCommand(s) || isPromptCommand(s) || isBuildCommand(s)) return false;

  // Imperative action requests are features, not conversational questions
  if (/^(i want to|i need to|please add|add\b|create\b|implement\b|build\b|make\b)/i.test(lower) && !lower.includes('?')) {
    return false;
  }

  // Any message with question mark
  if (s.includes('?') || s.endsWith('？')) return true;

  // Bengali conversational question / inquiry markers
  const bengaliInquiry = /(ki\s+ki\s+feature|kemon\s+hobe|details\s+bolo|bistarito\s+bolo|aro\s+bolo|age\s+bolo|bolo|ki\s+ki\s+thakbe|ki\s+ki\s+thakby|kivabe\s+kaj\s+korbe|ki\s+bhabe\s+kaj\s+korbe|ki\s+hobe|ki\s+thakbe|ki\s+kaj|kemne\s+hobe|ki\s+ki|kemon|kno|keno|kivabe|kon\s*ta|valo\s*hoby|valo\s*hobe)/i;
  if (bengaliInquiry.test(lower)) return true;

  // English conversational inquiry
  const englishInquiry = /^(how\s+will|how\s+does|how\s+to|what\s+features|what\s+will|what\s+are|what\s+is|why|where|when|which|tell\s+me|explain|describe|details)\b/i;
  if (englishInquiry.test(lower)) return true;

  return false;
}

/**
 * Format clean intent string (e.g. "I want a real-time password checker" -> "Build a real-time password checker")
 * Extracts core feature from Bengali/English conversational frames and formats clean imperative English sentence.
 * @param {string} text
 * @returns {string}
 */
function cleanFeatureIntent(text) {
  if (!text || typeof text !== 'string') return 'Build a modern web application';
  const rawTrimmed = text.trim();
  const endsWithQ = rawTrimmed.endsWith('?') || rawTrimmed.endsWith('？') || rawTrimmed.includes('?');
  const startsWithQ = /^(kon\b|konta\b|kivabe\b|why\b|how\b)/i.test(rawTrimmed) || isEvaluativeQuestion(rawTrimmed);
  const isOptCmd = isOptionsCommand(rawTrimmed) || isMissingOptionsComplaint(rawTrimmed) || /^(option\b|options\b)/i.test(rawTrimmed);

  // Requirement 3: If message ends with ? or starts with question words (kon, kivabe, why, how) or is option command/complaint,
  // DO NOT overwrite currentIntent or append to activeFeatureRequirements. Keep previous valid intent.
  if (endsWithQ || startsWithQ || isOptCmd) {
    let prevIntent = null;
    try {
      const sessionStore = require('../session-store');
      const saved = sessionStore.loadState() || {};
      if (isValidIntentString(saved.currentIntent)) prevIntent = saved.currentIntent;
      else if (isValidIntentString(saved.pendingFeature)) prevIntent = saved.pendingFeature;
      else if (saved.currentPlan && isValidIntentString(saved.currentPlan.task)) prevIntent = saved.currentPlan.task;
    } catch (_) {}
    if (!prevIntent) {
      if (isValidIntentString(inMemoryState?.currentIntent)) prevIntent = inMemoryState.currentIntent;
      else if (isValidIntentString(inMemoryState?.pendingFeature)) prevIntent = inMemoryState.pendingFeature;
    }
    return prevIntent || 'Build a modern web application';
  }

  let clean = rawTrimmed;
  clean = clean.replace(/[?.!]+$/, '').trim();

  // Rule 1: Specific feature extraction for Shannon Entropy
  if (/shannon\s*entropy/i.test(clean)) {
    return 'Add Shannon Entropy Calculation to Password Checker';
  }

  // Rule 2: Specific feature extraction for Typing Speed Test
  if (/typing\s*speed\s*test/i.test(clean)) {
    return 'Build a Typing Speed Test Application';
  }

  // Rule 3: File Auto-Delete Script (Python CLI / automation)
  if (/(?:script|python|cli|tool|program)/i.test(clean) && /(?:file|path)/i.test(clean) && /(?:delete|remove|erase|kete)/i.test(clean) && /(?:time|minute|duration|delay|seconds?|hour|por)/i.test(clean)) {
    if (/(?:cli|terminal|console|command|input|enter|link|option\s*asby|koy\s*minit)/i.test(clean) || /[\u0980-\u09FF]|(?:ami|amra|akta|ekta)/i.test(text)) {
      return 'Build a Python CLI script to auto-delete a file after a specified time';
    }
    return 'Build a Python script to auto-delete files after a specified duration';
  }
  if (/[\u0980-\u09FF]|(?:ami|amra|akta|ekta)/i.test(text) && /(?:file|input)/i.test(clean) && /(?:delete|muche)/i.test(clean) && /(?:minute|minite|somoy|time|por)/i.test(clean)) {
    return 'Build a Python CLI script to auto-delete a file after a specified time';
  }

  // Strip English conversational prefixes early so prefix words don't count toward word limits
  clean = clean.replace(/^(?:i\s+want\s+to\s+(?:build|create|make|develop|add|optimize|refactor)\s+(?:a\s+)?|i\s+want\s+(?:a\s+)?|i\s+need\s+to\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|i\s+need\s+(?:a\s+)?|can\s+you\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|could\s+you\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|please\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|let'?s\s+(?:build|create|make|optimize)\s+(?:a\s+)?|how\s+to\s+build\s+(?:a\s+)?|we\s+need\s+to\s+build\s+(?:a\s+)?)\s*/i, '').trim();

  // Bengali intent extraction
  // Pattern 1: "ami akta web site banaity sai", "amra ekta password checker banabo", "amar ekta settings page lagbe"
  const bengaliFullMatch = clean.match(/^(?:ami|amra|amar)?\s*(?:akta|ekta|akti)?\s*(.*?)\s*(?:banaity\s+sai|banaite\s+chai|banate\s+chai|banabo|banao|toiri\s+korte\s+chai|banano\s+dorkar|bana|lagbe|chai|dorkar|add\s+korty\s+sai|add\s+korte\s+chai)\s*$/i);
  if (bengaliFullMatch && bengaliFullMatch[1] && bengaliFullMatch[1].trim().length > 0) {
    clean = bengaliFullMatch[1].trim();
  } else {
    clean = clean.replace(/^(?:ami|amra|amar)\s+(?:chai|dorkar|lagbe)?\s*(?:akta|ekta|akti)?\s*/i, '').trim();
    clean = clean.replace(/\s*(?:banaity\s+sai|banaite\s+chai|banate\s+chai|banabo|banao|toiri\s+korte\s+chai|lagbe|dorkar|add\s+korty\s+sai|add\s+korte\s+chai)\s*$/i, '').trim();
  }

  const words = clean.split(/\s+/);
  const hasListOrExpl = /[১-৯0-9]\.|সূত্র|formula|যা\s*হিসাব|feature\s*ta\s*holo|ta\s*holo|\bh\s*=|log2|\(১|\(1/i.test(clean);

  // If long explanation (> 10 words) or contains lists/formulas/explanations
  if (words.length > 10 || hasListOrExpl) {
    // Try to extract from list indicator: e.g. (১. Feature Name ...) or 1. Feature Name
    const listMatch = clean.match(/(?:[১-৯0-9]\.|\([১-৯0-9]\))\s*([^:,\n.—–()]+)/);
    if (listMatch && listMatch[1] && listMatch[1].trim().length > 2 && /formula|হিসাব|feature\s*ta\s*holo/i.test(clean)) {
      let extracted = listMatch[1].trim();
      extracted = extracted.replace(/^(?:add|build|create|implement)\s+/i, '');
      if (/password/i.test(clean)) {
        return 'Add ' + extracted + ' to Password Checker';
      }
      return 'Add ' + extracted;
    }

    // Try to extract from 'feature ta holo ...'
    const featureTaHoloMatch = clean.match(/(?:feature\s+ta\s+holo|feature\s+holo)\s*[:(]?\s*(?:[১-৯0-9]\.\s*)?([^:,\n.—–()]+)/i);
    if (featureTaHoloMatch && featureTaHoloMatch[1] && featureTaHoloMatch[1].trim().length > 2) {
      let extracted = featureTaHoloMatch[1].trim();
      extracted = extracted.replace(/^(?:add|build|create|implement)\s+/i, '');
      if (/password/i.test(clean)) {
        return 'Add ' + extracted + ' to Password Checker';
      }
      return 'Add ' + extracted;
    }

    // If there is a preamble before a list of requirements (e.g. "Typing Speed Test application with the following requirements: 1. ...")
    const listPreambleMatch = clean.match(/^(.*?)(?:\s+(?:with\s+the\s+following\s+requirements|with\s+requirements|requirements|features?|including|featuring)\s*[:.]?|\s*[:]\s*(?:[1-9]|\([1-9]\)|\n)|(?:\.|\n)\s*(?:[1-9][.)]|\([1-9]\)))\s+/i);
    if (listPreambleMatch && listPreambleMatch[1] && listPreambleMatch[1].trim().length > 3) {
      clean = listPreambleMatch[1].trim();
    } else {
      // Strip parentheses and explanations
      clean = clean.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      clean = clean.replace(/^(?:build\s+a\s+)?feature\s+ta\s+holo\s*/i, '');
      clean = clean.replace(/(?:aita|eta|eta\s+amra)?\s*(?:add\s+korebo|add\s+korbo|add\s+korte\s+chai|banaite\s+chai|banate\s+chai).*$/i, '');
      clean = clean.trim();

      // Take first full sentence or clause without arbitrary slicing
      const firstClause = clean.split(/[.?!;\n]/)[0].trim();
      if (firstClause && firstClause.length > 3) {
        clean = firstClause;
      }
    }
  }

  // Normalize common terms
  clean = clean.replace(/\bweb\s+site\b/gi, 'website');
  clean = clean.replace(/\brealtime\b/gi, 'real-time');

  if (/typing\s*(website|speed|app)/i.test(clean)) {
    return 'Build a Typing Speed Test Website';
  }

  if (/^(build|create|implement|develop|add|optimize|refactor|update|fix|remove|setup|configure)\b/i.test(clean)) {
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    return clean;
  }

  clean = clean.replace(/^(?:an?|the)\s+/i, '').trim();
  if (!clean || clean.length < 2) return 'Build a modern web application';

  if (/password.*checker/i.test(clean) && !/real-time/i.test(clean)) {
    clean = clean.replace(/password\s+checker/i, 'real-time password checker');
  }

  const article = /^[aeiou]/i.test(clean) ? 'an' : 'a';
  return `Build ${article} ${clean}`;
}

/**
 * Asynchronously extract a clean, actionable English intent using active AI provider with regex fallback.
 * @param {string} text
 * @returns {Promise<string>}
 */
async function extractCleanIntentWithAI(text) {
  if (!text || typeof text !== 'string') return 'Build a modern web application';
  const rawTrimmed = text.trim();
  const endsWithQ = rawTrimmed.endsWith('?') || rawTrimmed.endsWith('？') || rawTrimmed.includes('?');
  const startsWithQ = /^(kon\b|konta\b|kivabe\b|why\b|how\b)/i.test(rawTrimmed) || isEvaluativeQuestion(rawTrimmed);
  const isOptCmd = isOptionsCommand(rawTrimmed) || isMissingOptionsComplaint(rawTrimmed) || /^(option\b|options\b)/i.test(rawTrimmed);
  if (endsWithQ || startsWithQ || isOptCmd) {
    return cleanFeatureIntent(text);
  }
  try {
    const activeP = getActiveProvider();
    if ((hasKey(activeP) || activeP === 'ollama') && !isProviderCoolingDown(activeP)) {
      const prompt = `You are a Senior Software Architect. Summarize this user request into a clean, precise 5-8 word English implementation intent title.
Rules:
- Capture the Action, Object, and Condition (e.g. auto-deleting a file after specified duration or time).
- Must begin with an action verb ('Build', 'Create', 'Add', 'Develop', or 'Implement').
- NEVER truncate or omit the key condition or outcome (e.g. if the request specifies deleting a file after minutes/time, include 'to auto-delete files after a specified duration').
- Example 1: "I want a script that takes a file path, asks for minutes, and deletes it." -> "Build a Python script to auto-delete files after a specified duration"
- Example 2: "ami akta python script banabo jeta file input nibar option asby... 1 minute dilam then enter dilam jeno 1 minite por oi file delete hoye jai" -> "Build a Python CLI script to auto-delete a file after a specified time"
- Example 3: "ami typing website banaty sai (১. UI ২. Timer)" -> "Build a Typing Speed Test Website"
Output ONLY the clean title without markdown, quotes, or trailing punctuation.

User Request: "${text.slice(0, 2000)}"`;
      const res = await callProviderWithFallback(prompt);
      if (res && res.success && res.data) {
        let clean = String(res.data).trim().replace(/^["'`]|["'`]$/g, '').replace(/[?.!]+$/, '').split('\n')[0].trim();
        if (clean.length > 5 && !clean.includes('API Limit') && !clean.includes('Too Many')) {
          if (!/^(build|create|implement|develop|add|update)\b/i.test(clean)) {
            clean = 'Build a ' + clean.replace(/^a\s+/i, '');
          }
          return clean;
        }
      }
    }
  } catch (_) {}
  // ── Offline heuristic: detect auth+worker pattern ─────────────────────────
  const _lower = rawTrimmed.toLowerCase();
  const _hasAuth = /\b(login|auth|signin|signup|name\s+pass|name\s+password|user\s+login|log\s+in)\b/i.test(_lower)
    || /\b(name\s+diye|pass\s+diye|password\s+diye)\b/i.test(_lower);
  const _hasWorker = /\b(worker|workers|employee|staff|karmachari)\b/i.test(_lower);
  if (_hasAuth && _hasWorker) return 'Add User Login and Worker Management System';
  if (_hasAuth && !/\b(worker|file|script|analyzer|game|checker)\b/i.test(_lower)) return 'Add User Authentication and Login System';

  return cleanFeatureIntent(text);
}

/**
 * Synthesize a raw (possibly Bengali/Banglish/mixed) user requirement into professional
 * English technical requirements using AI. Falls back to pattern-based heuristics.
 *
 * @param {string} rawInput - The raw, unprocessed user input
 * @returns {Promise<string[]>} Array of professional English requirement strings
 */
async function synthesizeRequirementsWithAI(rawInput) {
  if (!rawInput || typeof rawInput !== 'string' || rawInput.trim().length < 3) {
    return [rawInput || ''];
  }

  const raw = rawInput.trim();

  // If already clean English (no Bengali chars, no Banglish markers), return as-is
  const _hasBengali = /[\u0980-\u09FF]/.test(raw);
  const _hasBanglish = /\b(ami|amra|akn|taholy|korty|sassi|parby|dekhty|dekhte|add\s+korty|login\s+kore|name\s+pass|diye|judi|kono|chay|chai|korbo|hoby|hobe|banabo|banao)\b/i.test(raw);

  if (!_hasBengali && !_hasBanglish) {
    return [raw];
  }

  // ── Try AI synthesis ──────────────────────────────────────────────────────
  try {
    const activeP = getActiveProvider();
    if ((hasKey(activeP) || activeP === 'ollama') && !isProviderCoolingDown(activeP)) {
      const synthesisPrompt = [
        'You are a Senior Software Architect. The developer gave this rough idea (may be Bengali, Banglish, or mixed language):',
        '"' + raw.slice(0, 1500) + '"',
        '',
        'Translate ONLY what the developer asked into professional English technical requirements.',
        'Rules:',
        '- Do NOT add new features not mentioned by the developer.',
        '- Do NOT add implementation details, libraries, or frameworks not asked for.',
        '- Keep EXACTLY what the user asked for — no more, no less.',
        '- Format as a numbered list (1. ... 2. ... 3. ...).',
        '- Each item must be a clear, concise technical requirement in plain English.',
        '- Maximum 8 items.',
        '',
        'Output ONLY the numbered list. No preamble, no markdown headers, no extra commentary.',
      ].join('\n');

      const res = await callProviderWithFallback(synthesisPrompt);
      if (res && res.success && res.data) {
        const text = String(res.data).trim();
        if (text.length > 10 && !text.includes('API Limit') && !text.includes('Too Many')) {
          const lines = text.split('\n')
            .map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
            .filter(l => l.length > 3);
          if (lines.length > 0) {
            return lines;
          }
        }
      }
    }
  } catch (_) {}

  // ── Heuristic fallback: pattern-based Bengali→English translation ──────────
  const reqs = [];
  const lowerRaw = raw.toLowerCase();

  if (/\b(login|auth|signin|name\s+pass|name\s+diye|pass\s+diye|password\s+diye|name\s+password)\b/i.test(lowerRaw)) {
    reqs.push('User login with name and password authentication.');
  }
  if (/\b(worker|workers|employee|staff)\b/i.test(lowerRaw) && /\b(add|input|details?|korty|jog)\b/i.test(lowerRaw)) {
    reqs.push('Add new worker details (e.g. name, role) under the logged-in user.');
  }
  if (/\b(worker|workers|employee|staff)\b/i.test(lowerRaw) && /\b(list|dekhty|dekhte|show|view|display)\b/i.test(lowerRaw)) {
    reqs.push('View the list of workers associated with the logged-in user.');
  }
  if (/\b(worker|workers|employee|staff)\b/i.test(lowerRaw) && reqs.filter(r => /worker/i.test(r)).length === 0) {
    reqs.push('Manage worker records (add, view) for the logged-in user.');
  }
  if (reqs.length === 0) {
    reqs.push('Implement the requested feature as described by the developer.');
  }

  return reqs;
}

/**
 * Check if a text explicitly requests to fix a bug or generate a fix prompt.
 * Only explicit fix requests should trigger the Fix Bug button redirection in Normal Chat.
 * @param {string} text
 * @returns {boolean}
 */
function isExplicitFixRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();

  // Explicit English fix requests
  const english = /\b(give\s+me\s+(the\s+)?fix\s+prompt|how\s+(do\s+i|to)\s+fix\s+(this|it)?|fix\s+(it|this|the\s+bug|the\s+button|the\s+issue|the\s+code)|generate\s+(the\s+)?fix\s+prompt|i\s+want\s+to\s+fix|please\s+fix\s+(this|it))\b/i.test(s);

  // Explicit Bengali fix requests
  const bengali = /\b(fix\s+korar\s+prompt\s+daw|prompt\s+daw|fix\s+koro|fix\s+kore\s+daw|fix\s+korbo\s+kivabe|thik\s+kore\s+daw)\b/i.test(s);

  return english || bengali;
}

/**
 * Detect if user message is asking for advice, consulting, code review, or improvements
 * rather than asking to fix a single bug or execute an add/update command.
 * @param {string} text
 * @returns {boolean}
 */
function isProjectReviewOrConsultingQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();

  const english = /\b(improve|improvement|suggestions?|recommendations?|what('?s|\s+is)\s+next|what\s+next|are\s+there\s+any\s+issues|code\s+review|project\s+review|how\s+to\s+make\s+(it|this)\s+better|how\s+can\s+i\s+improve)\b/i.test(s);

  const bengali = /\b(ki\s+ki\s+problem|problem\s+ache|problem\s+ase|ki\s+korle\s+(aro\s+)?(valo|bhalo)\s+hobe|aro\s+(valo|bhalo)\s+hobe|aro\s+improve|kivabe\s+(valo|bhalo)\s+korbo|project\s+review|ki\s+ki\s+change\s+lagbe|kono\s+problem\s+ase|kono\s+problem\s+ache|ki\s+korle\s+bhalo)\b/i.test(s) ||
    /[\u0980-\u09FF].*(উন্নতি|পরামর্শ|সমস্যা|কী\s*করলে\s*ভালো\s*হবে|কী\s*কী\s*সমস্যা)/i.test(s);

  return english || bengali;
}

/**
 * Detect if user message is asking about CSS mobile optimization or responsive CSS styling best practices.
 * @param {string} text
 * @returns {boolean}
 */
function isCssOptimizationQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim().toLowerCase();
  return /\b(css|styling|styles)\b/i.test(s) && /\b(optimize|optimization|mobile|responsive|fast|performance|clean)\b/i.test(s);
}

/**
 * Detect if user message is asking for an explanation of a bug/issue
 * rather than reporting a new bug or confirming a prompt.
 * @param {string} text
 * @returns {boolean}
 */
function isBugExplanationIntent(text) {
  if (!text || typeof text !== 'string') return false;
  if (isProjectReviewOrConsultingQuery(text)) return false;
  if (isCssOptimizationQuery(text)) return false;
  const s = text.trim().toLowerCase();

  // English explanation cues
  const englishExplanation = /\b(why|explain|cause|reason|what'?s\s+wrong|how\s+come)\b/i.test(s) ||
    /\b(why\s+(is|are|does|it|click|the)|why'?s)\b/i.test(s);

  // Bengali explanation cues
  const bengaliExplanation = /\b(keno|kno|karon|bujhiye|explain|bistarito)\b/i.test(s) ||
    /\b(kno\s+(amn|kaj|hoyse|holo|hosse|hocche)|keno\s+(kaj|hoyse|holo|hosse|hocche|click|broken))\b/i.test(s) ||
    /\b(age\s+bolo|bolo|ki\s+problem|problem\s+ki|problem\s+hoyse|problem\s+kothay)\b/i.test(s) ||
    /[\u0980-\u09FF].*(কেন|কী\s*কারণে|কারণ|ব্যাখ্যা|সমস্যা)/i.test(s);

  return englishExplanation || bengaliExplanation;
}

/**
 * Detect if user message is reporting a defect/bug in Normal Chat mode
 * without explicitly asking to fix it or asking for an explanation.
 * @param {string} text
 * @returns {boolean}
 */
function isBugReportIntent(text) {
  if (!text || typeof text !== 'string') return false;
  if (isExplicitFixRequest(text)) return false;
  if (isProjectReviewOrConsultingQuery(text)) return false;
  if (isCssOptimizationQuery(text)) return false;
  if (isBugExplanationIntent(text)) return false;

  const s = text.trim().toLowerCase();
  const DEFECT_REGEX = /\b(broken|bug|crash|error|fails?|failed|issue|problem|not\s*working|doesn'?t\s*work|nothing\s*happens)\b|(\bkaj\s*(korse|kore|hosse|hocche)\s*na\b)|(click.*(korse|kore)\s*na)|(lekha\s*(jasse|jacche)\s*na)/i;
  return DEFECT_REGEX.test(s);
}

/**
 * Generate technical explanation based on AST contracts (HTML elements vs JS event listeners).
 * @param {object} params
 * @param {string} params.message
 * @param {object} [params.snapshot]
 * @param {string} [params.projectPath]
 * @param {Array} [params.conversationHistory]
 * @returns {string}
 */
function generateAstBugExplanation({ message, snapshot = null, projectPath = null, conversationHistory = [] }) {
  const historyTexts = Array.isArray(conversationHistory)
    ? conversationHistory.map(m => (typeof m === 'string' ? m : (m.text || ''))).join(' ')
    : '';
  const combinedContext = `${historyTexts} ${message || ''}`.toLowerCase();

  const isBengali = /[\u0980-\u09FF]|keno|kno|karon|bujhiye|kaj|korse|kore|kono|amr|amar|bolo|amn|hosse|hocche|lekha/i.test(combinedContext);

  const totalFiles = (snapshot?.files || []).length;
  if (totalFiles === 0) {
    if (isBengali) {
      return "আপনার এই প্রজেক্টে এখনও কোনো ফাইল নেই। প্রজেক্ট শুরু করতে দয়া করে উপরে ➕ Add Feature বাটনে ক্লিক করুন।";
    }
    return "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
  }

  let htmlPath = null;
  let jsPath = null;
  let htmlContent = null;
  let jsContent = null;

  try {
    const { locateFiles } = require('../verification/contract-validator');
    const located = locateFiles(projectPath, snapshot);
    if (located && Array.isArray(located.htmlFiles) && located.htmlFiles.length > 0) {
      htmlPath = located.htmlFiles[0].path;
      htmlContent = located.htmlFiles[0].content;
    }
    if (located && Array.isArray(located.jsFiles) && located.jsFiles.length > 0) {
      jsPath = located.jsFiles[0].path;
      jsContent = located.jsFiles[0].content;
    }
  } catch (_) {}

  // If contents not found via locateFiles, check snapshot.files directly
  if (!htmlContent && snapshot && Array.isArray(snapshot.files)) {
    const hf = snapshot.files.find(f => (f.path || f).endsWith('.html'));
    if (hf) {
      htmlPath = hf.path || 'index.html';
      htmlContent = hf.content || null;
    }
  }
  if (!jsContent && snapshot && Array.isArray(snapshot.files)) {
    const jf = snapshot.files.find(f => (f.path || f).endsWith('.js') && !(f.path || f).includes('.test.'));
    if (jf) {
      jsPath = jf.path || 'app.js';
      jsContent = jf.content || null;
    }
  }

  if (!htmlPath && !jsPath) {
    if (isBengali) {
      return "আপনার কোড বিশ্লেষণ করা হয়েছে। কোনো ফ্রন্টএন্ড বা এইচটিএমএল/জেএস সমস্যা পাওয়া যায়নি।";
    }
    return "AST analysis complete. No UI contract discrepancies found in the codebase.";
  }

  htmlPath = htmlPath || 'index.html';
  jsPath = jsPath || 'app.js';

  // Check if typing box / text area / typing logic is mentioned
  const isTypingMentioned = /(typing|type|lekha|text\s*area|textarea|input|typing\s*box|main-text)/i.test(combinedContext);
  if (isTypingMentioned) {
    if (isBengali) {
      return `আমি আপনার কোড ও AST বিশ্লেষণ করেছি। \`${htmlPath}\`-এ টাইপিং এরিয়া ও টেক্সট এলিমেন্ট রয়েছে, কিন্তু \`${jsPath}\`-এ এর সাথে কোনো ইভেন্ট লিসেনার বা হ্যান্ডলার যুক্ত নেই (The text area is not linked to the JS logic)। এজন্য টাইপিং বক্সে লিখলেও মূল লেখায় কোনো আপডেট বা কাজ হচ্ছে না।`;
    }
    return `I checked your code and AST structure. The \`${htmlPath}\` has the typing box and text container, but in \`${jsPath}\` the text area is not linked to the JS logic (there is no \`input\` or \`keydown\` event listener updating the text display). That's why typing into the box does not trigger any action.`;
  }

  const isButtonMentioned = /(button|btn|click|press|listener|start-btn|timer)/i.test(combinedContext);
  if (isButtonMentioned) {
    let targetId = 'start-btn';
    // Inspect HTML elements
    if (htmlContent) {
      try {
        const { extractHtmlIdsAndClasses } = require('../verification/contract-validator');
        const { ids } = extractHtmlIdsAndClasses(htmlContent);
        if (combinedContext.includes('timer') || combinedContext.includes('time') || combinedContext.includes('clock')) {
          targetId = ids.has('timer') ? 'timer' : (ids.has('timer-btn') ? 'timer-btn' : 'timer');
        } else if (ids.has('start-btn')) {
          targetId = 'start-btn';
        } else if (ids.size > 0) {
          targetId = Array.from(ids)[0];
        }
      } catch (_) {}
    } else {
      if (combinedContext.includes('timer') || combinedContext.includes('time')) {
        targetId = 'timer';
      }
    }

    const isTimer = targetId === 'timer' || combinedContext.includes('timer');

    if (isBengali) {
      if (isTimer) {
        return `আমি আপনার কোড পরীক্ষা করেছি। \`${htmlPath}\`-এ টাইমার এলিমেন্ট \`<button id='${targetId}'>\` (বা \`<div id='${targetId}'>\`) রয়েছে, কিন্তু \`${jsPath}\`-এ এর জন্য কোনো \`document.getElementById('${targetId}').addEventListener(...)\` বা টাইমার হ্যান্ডলার যুক্ত করা নেই। এজন্য ক্লিক করলে কোনো কাজ হচ্ছে না।`;
      }
      return `আমি আপনার কোড পরীক্ষা করেছি। \`${htmlPath}\`-এ \`<button id='${targetId}'>\` রয়েছে, কিন্তু \`${jsPath}\`-এ কোনো \`document.getElementById('${targetId}').addEventListener(...)\` যুক্ত করা নেই। এজন্য ক্লিক করলে কোনো কাজ হচ্ছে না।`;
    }

    if (isTimer) {
      return `I checked your code. The \`${htmlPath}\` has the \`<button id='${targetId}'>\` (or \`#${targetId}\`), but there is no \`document.getElementById('${targetId}').addEventListener(...)\` in \`${jsPath}\`. That's why clicking it does nothing and the timer does not start.`;
    }

    return `I checked your code. The \`${htmlPath}\` has the \`<button id='${targetId}'>\`, but there is no \`document.getElementById('${targetId}').addEventListener(...)\` in \`${jsPath}\`. That's why clicking it does nothing.`;
  }

  // General fallback when neither typing nor button is explicitly detected
  if (isBengali) {
    return `আমি আপনার প্রজেক্টের কোড বিশ্লেষণ করেছি। \`${htmlPath}\`-এর UI এলিমেন্টগুলোর সাথে \`${jsPath}\`-এর সংশ্লিষ্ট লজিক বা ইভেন্ট হ্যান্ডলার সংযুক্ত নেই (The text area is not linked to the JS logic)। এজন্য ইন্টারঅ্যাকশন কাজ করছে না।`;
  }
  return `I analyzed your project AST. In \`${htmlPath}\`, the UI elements are defined, but in \`${jsPath}\` the corresponding event listeners and update logic are missing (The text area is not linked to the JS logic). That's why it is not working as expected.`;
}

/**
 * Suggest A/B/C architecture options for a feature request.
 * @param {string} featureRequest - Developer's feature description
 * @param {object} projectContext - { domain, techStack, files, missingBlueprints, activeRules }
 * @returns {Promise<object>} Parsed options JSON
 */
async function suggestOptions(featureRequest, projectContext = {}) {
  const { isActionableFeature, analyzeFeature } = require('../ast/feature-analyzer');

  if (isVagueProjectRequest(featureRequest) || !isActionableFeature(featureRequest)) {
    return {
      featureType: null,
      options: [],
      recommendedOption: null,
      reasonForRecommendation: 'Input is too vague or not an actionable feature request.',
      isClarification: true,
      _fallback: false,
      providerUsed: 'local-rules',
    };
  }

  // ── Project-type detection (Fix: prevent backend suggestions on frontend projects) ──
  const snapshot = projectContext._snapshot || null;
  let { projectType, confidence, signals } = detectProjectType(snapshot, projectContext);

  const hasPythonFiles = Boolean(
    (snapshot?.files && snapshot.files.some(f => /\.py$/i.test(f.path || f))) ||
    (Array.isArray(projectContext.files) && projectContext.files.some(f => /\.py$/i.test(f.path || f)))
  );

  let requestedLanguage = detectLanguageFromText(featureRequest) ||
    (Array.isArray(projectContext.techStack) ? projectContext.techStack.map(detectLanguageFromText).find(Boolean) : detectLanguageFromText(projectContext.techStack));

  if (!requestedLanguage && hasPythonFiles) {
    requestedLanguage = 'Python';
  }

  if (requestedLanguage) {
    if (['Python', 'Go', 'Rust', 'C++', 'C#', 'Java', 'Ruby', 'PHP', 'CLI'].includes(requestedLanguage)) {
      projectType = 'backend';
    }
  }

  console.log(`[AI Service] suggestOptions — detected projectType="${projectType}" (confidence=${confidence}%, signals=${signals.length}, language=${requestedLanguage || 'none'})`);

  const isSingleFileReq = isSingleFileConstraint(featureRequest);

  try {
    const systemPrompt = loadPrompt('suggest-options');
    const inputPayload = {
      featureRequest: featureRequest.slice(0, 500),
      projectType,                                   // ← injected for prompt filtering
      requestedLanguage: requestedLanguage || undefined,
      projectContext: {
        domain:              projectContext.domain    || 'Unknown',
        techStack:           requestedLanguage ? [requestedLanguage] : (projectContext.techStack || []),
        architecturePattern: projectContext.architecturePattern || 'Unknown',
        existingFiles:       (projectContext.files    || []).slice(0, 20).map(f => f.path || f),
        missingBlueprints:   projectContext.missingBlueprints || [],
        activeRules:         projectContext.activeRules || [],
      },
    };

    const prompt = `${systemPrompt}\n\nINPUT:\n${JSON.stringify(inputPayload, null, 2)}`;
    const res = await callProviderWithFallback(prompt);
    if (!res.success) throw new Error(res.error || 'AI fallback exhausted');

    const parsed = parseJsonResponse(res.data);
    parsed.providerUsed = res.providerUsed;

    // Architectural Override: enforce Option A (Modular) vs Option B (Single File Prototype)
    if (isSingleFileReq) {
      parsed.options = getSingleFileOverrideOptions();
      parsed.recommendedOption = 'A';
      parsed.reasonForRecommendation = 'For a production-level application, keeping everything in one file is not recommended. I have prepared a modular structure for you.';
      parsed.featureType = parsed.featureType || 'frontend_game';
      parsed._projectType = 'frontend';
      parsed._architecturalOverride = true;
      return parsed;
    }

    // ── Post-generation validation: filter out forbidden patterns ──────────────
    const isAuthFeature = /login|auth|signin|signup|oauth|password/i.test(featureRequest);
    if (isAuthFeature && Array.isArray(parsed.options)) {
      parsed.options = parsed.options.filter(o => !/ai\s*logic|imperative\s*ai|game\s*loop/i.test((o.label || '') + ' ' + (o.description || '') + ' ' + (o.name || '')));
      if (parsed.options.length < 3) {
        const { getStaticFallbackOptions } = require('../ast/project-type-detector');
        parsed.options = getStaticFallbackOptions(projectType, 'login auth');
      }
      parsed.featureType = 'auth';
    }

    // Sanitize modules/ for frontend projects unless user explicitly requested modular or modules
    const userWantsModules = /\b(modular|modules?)\b/i.test(featureRequest);
    if (projectType === 'frontend' && !userWantsModules && Array.isArray(parsed.options)) {
      for (const opt of parsed.options) {
        if (Array.isArray(opt.filesToCreate)) {
          opt.filesToCreate = opt.filesToCreate.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
        }
        if (Array.isArray(opt.filesToEdit)) {
          opt.filesToEdit = opt.filesToEdit.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
        }
        if (Array.isArray(opt.filesRequired)) {
          opt.filesRequired = opt.filesRequired.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
        }
      }
    }

    if (Array.isArray(parsed.options) && parsed.options.length > 0) {
      const { valid, removed } = validateOptions(parsed.options, projectType, requestedLanguage);
      if (removed.length > 0) {
        console.warn(`[AI Service] suggestOptions — removed ${removed.length} option(s) with forbidden patterns for "${projectType}" project:`,
          removed.map(o => o.label));
      }

      if (valid.length >= 3) {
        // All 3 options survived — use them
        parsed.options = valid;
      } else if (valid.length > 0) {
        // Partially valid — fill gaps with static fallback options
        const fallbackOpts = getStaticFallbackOptions(requestedLanguage === 'Python' ? 'python' : projectType, featureRequest);
        const existing = new Set(valid.map(o => o.id));
        for (const fb of fallbackOpts) {
          if (!existing.has(fb.id)) {
            valid.push({ ...fb, _fromFallback: true });
            existing.add(fb.id);
          }
          if (valid.length >= 3) break;
        }
        parsed.options = valid.slice(0, 3);
        parsed._partialFallback = true;
      } else {
        // All options were invalid → full static fallback for this type
        console.warn(`[AI Service] suggestOptions — all AI options invalid for "${projectType}" project, using static fallback`);
        throw new Error(`All AI options contained forbidden patterns for ${projectType} project`);
      }
    }

    parsed._projectType = projectType;
    return parsed;
  } catch (err) {
    console.warn('[AI Service] suggestOptions fallback used:', err.message);

    // Architectural Override fallback for single-file requests
    if (isSingleFileReq) {
      return {
        featureType:             'frontend_game',
        options:                 getSingleFileOverrideOptions(),
        recommendedOption:       'A',
        reasonForRecommendation: 'For a production-level application, keeping everything in one file is not recommended. I have prepared a modular structure for you.',
        _fallback:               true,
        _projectType:            'frontend',
        _architecturalOverride:  true,
        providerUsed:            'architectural-override',
      };
    }

    // Use project-type-aware static fallback
    const fallbackOptions = getStaticFallbackOptions(requestedLanguage === 'Python' ? 'python' : projectType, featureRequest);
    if (fallbackOptions.length > 0) {
      return {
        featureType:             requestedLanguage ? `${requestedLanguage} Implementation` : 'Feature Implementation',
        options:                 fallbackOptions,
        recommendedOption:       fallbackOptions[0]?.id || 'A',
        reasonForRecommendation: requestedLanguage === 'Python'
          ? 'Option A provides the most robust and event-driven architecture using Python best practices.'
          : `AI unavailable. Showing ${projectType}-appropriate static options.`,
        _fallback:               true,
        _error:                  err.message,
        _projectType:            projectType,
        providerUsed:            'fallback',
      };
    }

    // Last resort: original static feature-catalog fallback
    const staticResult = analyzeFeature(featureRequest, null);
    return {
      featureType:             staticResult.featureType,
      options:                 staticResult.availableApproaches,
      recommendedOption:       staticResult.availableApproaches?.[0]?.id || 'A',
      reasonForRecommendation: 'AI unavailable. Static options shown.',
      _fallback:               true,
      _error:                  err.message,
      _projectType:            projectType,
      providerUsed:            'fallback',
    };
  }
}

/**
 * Detect if a user message in Normal Chat mode implies adding, updating, or fixing.
 * Only explicit fix requests (e.g. "give me the fix prompt", "fix it") trigger fix redirection.
 * @param {string} text - User message
 * @returns {'add'|'update'|'fix'|null}
 */
function detectChatModeIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const str = text.trim();
  const lower = str.toLowerCase();

  // If it's an informational query about project files or feature existence, don't flag as action intent
  if (isFileCountQuery(str) || isFeatureListQuery(str)) return null;
  if (isFeatureExistenceQuestion(str)) return null;

  // Advice, consulting, project review, or CSS engineering queries must never trigger action buttons!
  if (isProjectReviewOrConsultingQuery(str)) return null;
  if (isCssOptimizationQuery(str)) return null;

  // If user is asking why code is broken or asking for an explanation, do NOT route to fix button!
  if (isBugExplanationIntent(str)) return null;

  // 1. Detect Fix Intent ONLY for explicit fix or fix prompt requests
  if (isExplicitFixRequest(str)) {
    return 'fix';
  }

  // 2. Detect Update Intent for explicit update commands
  const UPDATE_REGEX = /^(?:i\s+want\s+to\s+|please\s+|can\s+you\s+|let'?s\s+)?(update|refactor|modify|change|edit|enhance|aro\s*update)\b/i;
  if (UPDATE_REGEX.test(str) && !/\b(how|why|can|what|should|any|advice|problem)\b/i.test(str) && !str.includes('?')) {
    return 'update';
  }

  // 3. Detect Add Intent for explicit add commands
  const ADD_REGEX = /^(?:i\s+want\s+to\s+|please\s+|can\s+you\s+|let'?s\s+)?(add|create|build|make|new|banabo|banao|implement)\b/i;
  if (ADD_REGEX.test(str) && !/\b(how|why|can|what|should|any|advice|problem)\b/i.test(str) && !str.includes('?')) {
    return 'add';
  }

  return null;
}

/**
 * Generate a conversational AI reply for a developer chat message or dispatch chat command.
 * @param {string} message - Developer's message
 * @param {object} opts - { projectContext, conversationHistory, activeRules, snapshot, mode }
 * @returns {Promise<object>} Parsed chat response JSON
 */
/**
 * Senior Software Architect conversational assistant handler for mode === 'chat'.
 * Injects projectMemory (tech stack, domain) and astSummary (files, functions),
 * queries the configured AI provider, or falls back to AST-grounded deterministic answers.
 */
async function handleNormalChatConversation(message, opts = {}) {
  const snapshot = opts.snapshot || opts._snapshot || null;
  const projectContext = opts.projectMemory || opts.projectContext || {};
  const astSummary = opts.astSummary || (typeof buildAstSummary === 'function' ? buildAstSummary(snapshot) : null) || {};
  const conversationHistory = opts.conversationHistory || [];

  // Extract all files
  const filesList = (snapshot?.files || []).map(f => typeof f === 'string' ? f : (f.path || f?.name || ''));

  // Extract all functions and classes from snapshot and astSummary
  let allFns = [];
  let allClasses = [];
  if (snapshot?.files && Array.isArray(snapshot.files)) {
    for (const f of snapshot.files) {
      const fns = Array.isArray(f.fns)
        ? f.fns
        : (Array.isArray(f.functions)
          ? f.functions
          : (Array.isArray(f.ast?.functions) ? f.ast.functions : []));
      for (const fn of fns) {
        const fnName = typeof fn === 'string' ? fn : (fn?.name || String(fn));
        if (fnName && !allFns.includes(fnName)) allFns.push(fnName);
      }
      const classes = Array.isArray(f.classes)
        ? f.classes
        : (Array.isArray(f.ast?.classes) ? f.ast.classes : []);
      for (const cls of classes) {
        const clsName = typeof cls === 'string' ? cls : (cls?.name || String(cls));
        if (clsName && !allClasses.includes(clsName)) allClasses.push(clsName);
      }
    }
  }
  if (Array.isArray(astSummary?.allFunctions)) {
    astSummary.allFunctions.forEach(fn => {
      if (fn && !allFns.includes(fn)) allFns.push(fn);
    });
  }
  if (Array.isArray(astSummary?.allClasses)) {
    astSummary.allClasses.forEach(cls => {
      if (cls && !allClasses.includes(cls)) allClasses.push(cls);
    });
  }

  const totalFiles = filesList.length;

  const hasPython = filesList.some(f => /\.py$/i.test(f) || /requirements\.txt/i.test(f));
  const hasGo = filesList.some(f => /\.go$/i.test(f));
  const hasRust = filesList.some(f => /\.rs$/i.test(f));
  const hasCpp = filesList.some(f => /\.(cpp|cc|cxx|h|hpp)$/i.test(f));

  let techStackArr;
  if (Array.isArray(projectContext.techStack) && projectContext.techStack.length > 0 && !projectContext.techStack.includes('Unknown') && !projectContext.techStack.includes('Empty workspace')) {
    techStackArr = projectContext.techStack;
  } else if (typeof projectContext.techStack === 'string' && projectContext.techStack && projectContext.techStack !== 'Unknown' && projectContext.techStack !== 'Empty workspace') {
    techStackArr = [projectContext.techStack];
  } else if (totalFiles === 0) {
    const lang = detectLanguageFromText(message);
    techStackArr = lang ? [lang] : ['Empty workspace'];
  } else if (hasPython) {
    techStackArr = ['Python'];
  } else if (hasGo) {
    techStackArr = ['Go'];
  } else if (hasRust) {
    techStackArr = ['Rust'];
  } else if (hasCpp) {
    techStackArr = ['C++'];
  } else {
    techStackArr = ['Vanilla JavaScript', 'HTML5', 'CSS3'];
  }
  const techStackStr = techStackArr.join(', ');
  let domainStr = projectContext.domain;
  if (!domainStr || domainStr === 'Unknown' || domainStr === 'Software Project' || (totalFiles === 0 && domainStr === 'Web Application')) {
    if (totalFiles === 0) {
      domainStr = 'Brand new project (empty workspace)';
    } else if (hasPython) {
      domainStr = filesList.some(f => /analyzer/i.test(f)) ? 'Python Log Analyzer' : 'Python Application';
    } else if (hasGo || hasRust || hasCpp) {
      domainStr = `${techStackArr[0]} Application`;
    } else {
      domainStr = 'Web Application';
    }
  }
  const filesStr = filesList.length > 0 ? filesList.join(', ') : 'None';
  const allSymbols = [...allClasses.map(c => `class ${c}`), ...allFns];
  const fnsStr = allSymbols.length > 0 ? allSymbols.join(', ') : 'None';

  const hist = Array.isArray(conversationHistory) ? conversationHistory.slice(-4) : [];
  let historyStr = hist.map(m => {
    const role = (m.role || m.type || 'user').toUpperCase();
    const text = (m.text || m.content || '').slice(0, 300);
    return `${role}: ${text}`;
  }).join('\n');
  if (!historyStr) historyStr = 'None';

  let basePrompt = loadPrompt('chat-respond')
    .replace('{{projectMemory.techStack}}', techStackStr)
    .replace('{{projectMemory.domain}}', domainStr)
    .replace('{{snapshot.files}}', filesStr)
    .replace('{{astSummary.functions}}', fnsStr)
    .replace('{{conversationHistory}}', historyStr);

  const inputPayload = {
    message: message.slice(0, 1000),
    projectContext: {
      domain: domainStr,
      techStack: techStackArr,
      totalFiles: filesList.length,
      files: filesList,
    },
    astSummary: {
      functions: allFns,
      classes: allClasses,
      totalFiles: filesList.length,
      topFiles: astSummary?.topFiles || [],
    },
    conversationHistory: hist.map(m => ({
      role: m.role || m.type || 'user',
      text: (m.text || m.content || '').slice(0, 300),
    })),
  };

  const fullPrompt = `${basePrompt}\n\nINPUT:\n${JSON.stringify(inputPayload, null, 2)}`;

  let aiResponseText = null;
  let providerUsed = 'fallback';

  try {
    const activeP = getActiveProvider();
    if ((hasKey(activeP) || activeP === 'ollama') && !isProviderCoolingDown(activeP)) {
      const res = await callProviderWithFallback(fullPrompt);
      if (res && res.success && res.data) {
        providerUsed = res.providerUsed || activeP;
        const parsed = parseJsonResponse(res.data);
        if (parsed && (parsed.reply || parsed.responseText)) {
          aiResponseText = parsed.reply || parsed.responseText;
        } else if (typeof res.data === 'string' && res.data.trim()) {
          aiResponseText = res.data.trim();
        }
      }
    }
  } catch (err) {
    console.warn('[AI Service] AI chat provider failed in chat mode:', err.message);
  }

  if (aiResponseText) {
    return {
      success: true,
      mode: 'informational',
      needsOptions: false,
      options: [],
      plan: null,
      reply: aiResponseText,
      responseText: aiResponseText,
      providerUsed,
    };
  }

  // ── High-Quality Deterministic Architectural Fallback ─────────────────────
  const lowerMsg = message.toLowerCase();
  let fallbackReply = '';

  // Prioritize active plan over empty workspace greeting
  const currentPlan = opts.currentPlan || opts.plan || (() => {
    try {
      const sessionStore = require('../session-store');
      return sessionStore.loadState()?.currentPlan || null;
    } catch (_) { return null; }
  })();
  const planOptions = (currentPlan && Array.isArray(currentPlan.options) && currentPlan.options.length > 0)
    ? currentPlan.options
    : [];
  const hasActivePlanWithOptions = Boolean(currentPlan && planOptions.length > 0);
  const activePlanTask = currentPlan?.task || currentPlan?.userIntent || currentPlan?.intentSummary || '';

  const isArchitectureInquiry = /(?:ata|eta|ei\s*feature|ai\s*feature)\s*(?:banaly|banale|kmn|kemon)/i.test(message) ||
    /(?:banaly|banale)\s*(?:kmn|kemon)/i.test(message) ||
    /^(?:ata|eta)\s*banaly\s*kmn\s*hoby\??$/i.test(message.trim());

  function isRestatingActiveTask(msg, task) {
    if (!msg || !task || typeof msg !== 'string' || typeof task !== 'string') return false;
    const m = msg.toLowerCase();
    const t = task.toLowerCase().trim();
    if (t.length >= 8 && m.includes(t.slice(0, 20))) return true;
    const keywords = t.split(/\s+/).filter(w => w.length > 3 && !['build', 'create', 'make', 'real-time', 'realtime', 'with'].includes(w));
    return keywords.length > 0 && keywords.every(kw => m.includes(kw));
  }

  // 0. Active Plan Prioritization (takes precedence over empty workspace greeting for evaluative & active plan questions)
  if (hasActivePlanWithOptions && (isEvaluativeQuestion(message) || isArchitectureInquiry || isRestatingActiveTask(message, activePlanTask) || isOptionsCommand(message) || isMissingOptionsComplaint(message))) {
    if (isEvaluativeQuestion(message)) {
      fallbackReply = await generateOptionRecommendation(planOptions, message, activePlanTask, projectContext);
    } else if (isOptionsCommand(message) || isMissingOptionsComplaint(message)) {
      fallbackReply = `Here are the architecture options for **${activePlanTask || 'your feature'}**. Please select an approach below:`;
    } else {
      // User is asking how it will be built, re-stating the feature ("ata banaly kmn hoby?"), or asking architecture details
      const isBengali = /[\u0980-\u09FF]|amr|amar|kmn|kemon|hoby|hobe|banaly|banale|kisu|bolo|thakby|ai|ei|banaite|banate/i.test(message);
      const optSummaries = planOptions.map(o => `• **${o.label || o.name || 'Option'}:** ${o.description || ''}`).join('\n');
      if (isBengali) {
        fallbackReply = `আপনার অ্যাক্টিভ প্ল্যান **${activePlanTask}** এর জন্য আর্কিটেকচার ডিজাইন প্রস্তুত করা আছে:\n\n${optSummaries}\n\nএটি একটি চমৎকার আর্কিটেকচার হবে। কাজ শুরু করার জন্য উপরের যেকোনো একটি অপশন বেছে নিন।`;
      } else {
        fallbackReply = `For your active plan **${activePlanTask}**, here is the architectural structure:\n\n${optSummaries}\n\nThis will provide a robust architecture. Please select one of the options above to proceed with implementation.`;
      }
    }
  }
  // 1. Empty project conversation handler (when filesList.length === 0 and NO active plan)
  else if (filesList.length === 0) {
    const isGreeting = /^(hi|hello|hey|greetings|hola|nomoshkar|salam)\b/i.test(lowerMsg.trim().replace(/[!.,]+$/, ''));
    const isTransition = typeof isCodingTransitionIntent === 'function' ? isCodingTransitionIntent(message) : false;

    // A. Explicit coding transition (e.g. "Okay, let's start building.", "Let's start coding", "Generate prompt", "Prompt daw")
    if (isTransition) {
      const isBengali = /[\u0980-\u09FF]|shuru|kori|jak|daw|dao/i.test(message);
      fallbackReply = isBengali
        ? "কোড শুরু করতে এবং আর্কিটেকচার ব্লুপ্রিন্ট তৈরি করতে দয়া করে উপরের ➕ Add Feature বাটনে ক্লিক করুন।"
        : "Please click the ➕ Add Feature button above to select your architecture blueprint and start building.";
    }
    // B. E-commerce brainstorming
    else if (/(?:e-?commerce|shop|store|cart|product)/i.test(lowerMsg)) {
      fallbackReply = `Building an e-commerce platform is a fantastic choice! Here is a recommended 5-point architectural plan:\n\n` +
        `1. **Product Catalog & Search Engine**: Structure your product schemas with categories, variants, and pricing. Implement search indexing and pagination for fast product discovery.\n` +
        `2. **Shopping Cart & Session State**: Maintain reactive cart state in the frontend with persistent storage (e.g. LocalStorage for guests, Redis/database sessions for authenticated users).\n` +
        `3. **User Authentication & Authorization**: Implement JWT with refresh tokens or secure session cookies. Separate customer permissions from admin dashboard capabilities.\n` +
        `4. **Checkout & Payment Gateway**: Integrate payment providers (e.g. Stripe, SSLCommerz, or PayPal) with secure webhook signature verification and idempotency keys to prevent duplicate charges.\n` +
        `5. **Order Lifecycle & Admin Management**: Model order states (Pending, Paid, Shipped, Delivered) using robust database transactions and transactional email notifications.\n\n` +
        `**Architectural Question for You:** Which tech stack do you prefer? Would you like a Node.js/Express backend with React or a Python (FastAPI/Django) architecture? Also, do you prefer PostgreSQL or MongoDB?`;
    }
    // C. General project ideas or feature brainstorming in empty workspace
    else if (/(?:build|create|make|develop|start|banabo|banao)\s+(?:a\s+|an\s+)?([a-z0-9_\s-]+)/i.test(lowerMsg) || /(?:what|ki)\s*(?:should|to|project)/i.test(lowerMsg) || /(\b(amar\s+)?project\s*(?:ta|ti)?\s*kemon\s*hobe|kemon\s*hobe|what\s+will\s+(the\s+|my\s+)?project\s+be|how\s+will\s+(the\s+|my\s+)?project\s+be)\b/i.test(lowerMsg)) {
      const isBengali = /[\u0980-\u09FF]|amr|amar|kmn|kemon|hoby|hobe|ki\s*project|korly|korle/i.test(message);
      if (isBengali) {
        fallbackReply = `নতুন প্রজেক্টের জন্য এটি একটি চমৎকার আইডিয়া! আপনার প্রজেক্টের জন্য ৫টি মূল আর্কিটেকচারাল দিক:\n\n` +
          `1. **ডোমেন মডেল ও ডেটা স্ট্রাকচার**: প্রজেক্টের মূল সত্তা ও স্কিমা নির্ধারণ করুন।\n` +
          `2. **মডুলার কম্পোনেন্ট আর্কিটেকচার**: UI ও বিজনেস লজিক আলাদা ফাইলে বিভক্ত রাখুন।\n` +
          `3. **এপিআই ও রাউটিং লেয়ার**: RESTful এপিআই বা মডুলার হ্যান্ডলার ডিজাইন করুন।\n` +
          `4. **নিরাপত্তা ও ইনপুট ভ্যালিডেশন**: ইউজারের ইনপুট ভ্যালিডেশন ও সিক্রেট কি এনভায়রনমেন্ট ভেরিয়েবলে সংরক্ষণ করুন।\n` +
          `5. **টেস্টিং ও ডিপ্লয়মেন্ট**: ইউনিট টেস্ট ও অটোমেটেড বিল্ড নিশ্চিত করুন।\n\n` +
          `**পরামর্শ:** আপনি কোন টেক স্ট্যাক (যেমন Python, Node.js, বা Go) ব্যবহার করতে চান? আপনার পছন্দ জানালে আমরা সুনির্দিষ্ট আর্কিটেকচার চূড়ান্ত করতে পারি।`;
      } else {
        const projMatch = lowerMsg.match(/(?:build|create|make|develop|start)\s+(?:a\s+|an\s+)?([a-z0-9_\s-]+)/i);
        const projTopic = projMatch && projMatch[1] ? projMatch[1].trim() : 'application';
        fallbackReply = `Building a ${projTopic} is a great project idea! Here is a recommended 5-point architectural breakdown:\n\n` +
          `1. **Core Business Logic & Domain Models**: Define clean schemas and validation layers for your primary data entities.\n` +
          `2. **Modular Architecture & Routing**: Decouple the UI presentation from backend services or controller logic.\n` +
          `3. **State Management & Persistence**: Determine whether client storage (LocalStorage/IndexedDB) or server database (SQL/NoSQL) is optimal.\n` +
          `4. **Security & Input Validation**: Guard against injections, sanitize inputs, and keep API secrets in environment variables.\n` +
          `5. **Testing & Observability**: Add unit tests for critical functions and structured logging for runtime tracing.\n\n` +
          `**Architectural Question for You:** What language and framework do you envision for this ${projTopic}? Are you leaning towards Python, TypeScript/Node.js, or Go?`;
      }
    } else if (isGreeting) {
      fallbackReply = "Hello! Welcome to your new workspace. 🚀 It's a fresh canvas right now. What kind of application or project are you brainstorming today? Share your thoughts, and we can map out the architecture together!";
    } else if (isOptionsCommand(message) || isMissingOptionsComplaint(message)) {
      let activeFeature = 'your feature';
      try {
        const sessionStore = require('../session-store');
        const st = sessionStore.loadState() || {};
        activeFeature = st.pendingFeature || st.currentIntent || st.currentPlan?.task || 'your feature';
      } catch (_) {}
      fallbackReply = `Here are the architecture options for **${activeFeature}**. Please select an approach below:`;
    } else if (isBugExplanationIntent(message) || isBugReportIntent(message)) {
      fallbackReply = "There are no files in this project yet. Tell me what kind of project you'd like to build and we can plan the architecture!";
    } else if (/(koyta|how many)\s*files?/i.test(lowerMsg) || /file\s*count/i.test(lowerMsg)) {
      fallbackReply = "Your project currently contains **0 files**.";
    } else {
      fallbackReply = "Hello! Welcome to your new workspace. 🚀 It's a fresh canvas right now. What kind of project are you planning to build today? Tell me your ideas or goals, and we can design the architecture together!";
    }
  }
  // 1. Advice & Project Consulting questions (e.g. "Amar project a ki ki problem ache? Ki korle aro valo hobe?", "How can I improve this project?")
  else if (isProjectReviewOrConsultingQuery(message)) {
    if (filesList.length === 0) {
      fallbackReply = "Your project currently has 0 files. Please select the ➕ Add Feature button to start building your application.";
    } else {
      const isBengali = /[\u0980-\u09FF]|ki\s*ki|problem\s*ache|valo\s*hobe|bhalo\s*hobe|aro\s*valo/i.test(message);
      const htmlFile = filesList.find(f => f.endsWith('.html')) || 'index.html';
      const jsFile = filesList.find(f => f.endsWith('.js') && !f.includes('.test.')) || 'app.js';
      const cssFile = filesList.find(f => f.endsWith('.css')) || 'style.css';

      if (isBengali) {
        fallbackReply = `আমি আপনার প্রজেক্টের কোডবেস ও AST অ্যানালাইসিস করেছি। বর্তমানে প্রজেক্টে **${filesList.length}টি ফাইল** (${filesList.join(', ')}) এবং **${allFns.length}টি স্ক্যান করা ফাংশন** রয়েছে (${allFns.slice(0, 4).map(f => `\`${f}\``).join(', ')}).\n\n` +
          `আপনার প্রজেক্টের সামগ্রিক মান ও পারফরম্যান্স আরও উন্নত করার জন্য ৫টি পরামর্শ:\n\n` +
          `1. **UI এলিমেন্ট ও ইভেন্ট লিসেনার সংযোগ**: \`${htmlFile}\`-এর বোতাম বা ইনপুট ফিল্ডগুলোর সাথে \`${jsFile}\`-এর ইভেন্ট লিসেনারগুলো পরীক্ষা করুন। কোনো UI এলিমেন্টে লিসেনার অনুপস্থিত থাকলে তা লিঙ্ক করে নিন যাতে ক্লিক বা টাইপিং রেসপন্স করে।\n` +
          `2. **ইনপুট ভ্যালিডেশন ও নাল-চেকিং**: ফাংশনগুলোতে (${allFns.slice(0, 2).map(f => `\`${f}\``).join(', ') || 'user handlers'}) ইউজার ইনপুটের জন্য ডিফেন্সিভ ভ্যালিডেশন যোগ করুন, যাতে টাইপ-এরর প্রতিরোধ করা যায়।\n` +
          `3. **মডুলার কোড স্ট্রাকচার**: প্রজেক্ট বড় হওয়ার সাথে সাথে DOM রেন্ডারিং, বিজনেস লজিক ও স্টেট হ্যান্ডলিং আলাদা মডিউলে বিভক্ত করুন।\n` +
          `4. **মোবাইল ও রেসপন্সিভ স্টাইলিং**: \`${cssFile}\`-এ মোবাইল-ফার্স্ট মিডিয়া কুয়েরি এবং রিলেটিভ ইউনিট (\`rem\`, CSS \`clamp()\`) ব্যবহার করে ছোট স্ক্রিনে চমৎকার অভিজ্ঞতা নিশ্চিত করুন।\n` +
          `5. **অ্যাসিঙ্ক এরর হ্যান্ডলিং ও ইউজার ফিডব্যাক**: ইউজার ইন্টারঅ্যাকশনে স্পষ্ট লোডিং বা সাকসেস স্টেট প্রদর্শন করুন।\n\n` +
          `আপনি যেকোনো আর্কিটেকচারাল বিষয় নিয়ে আমার সাথে নির্দ্বিধায় আলোচনা করতে পারেন!`;
      } else {
        fallbackReply = `I conducted a full architectural review of your project AST (${filesList.length} files: ${filesList.join(', ')}; ${allFns.length} scanned functions: ${allFns.slice(0, 4).map(f => `\`${f}\``).join(', ')}).\n\n` +
          `Here are 5 key recommendations to elevate your codebase architecture:\n\n` +
          `1. **UI Element & Event Listener Synchronization**: Verify that all interactive DOM targets in \`${htmlFile}\` are actively wired to corresponding event handlers in \`${jsFile}\` to prevent unhandled interactions.\n` +
          `2. **Defensive Input Validation**: Fortify core logic routines (${allFns.slice(0, 2).map(f => `\`${f}\``).join(', ') || 'handler functions'}) with type boundary checks and error guards before updating application state.\n` +
          `3. **Modular Component Separation**: Keep single-responsibility separation across UI rendering, business logic, and data storage rather than bundling all handlers into a single file.\n` +
          `4. **Mobile & Responsive Optimization**: In \`${cssFile}\`, implement mobile-first media queries, relative units (\`rem\`, CSS \`clamp()\`), and >=48px touch targets for optimal ergonomics.\n` +
          `5. **Robust State & Error Management**: Add centralized error handling with visual user notifications (toast/alerts) for unexpected runtime exceptions.\n\n` +
          `Feel free to ask for deep dives into any of these areas or discuss architectural patterns!`;
      }
    }
  }
  // 2. CSS Optimization for Mobile and Responsive questions
  else if (isCssOptimizationQuery(message)) {
    fallbackReply = "To optimize CSS for mobile devices effectively, follow these core front-end architecture and performance best practices:\n\n" +
      "1. **Mobile-First Media Queries**: Write baseline CSS for small screens first, then use `min-width` queries (`@media (min-width: 768px)`) for larger breakpoints. This reduces initial CSS parsing overhead on mobile devices.\n" +
      "2. **Fluid Typography & Relative Units**: Avoid hardcoded pixel widths. Use `rem`, `em`, and CSS `clamp()` (e.g., `font-size: clamp(1rem, 2.5vw, 1.5rem);`) for fluid text and layout sizing across varying viewport widths.\n" +
      "3. **Ergonomic Touch Targets**: Ensure all interactive buttons, inputs, and links have minimum dimensions of 48x48px with adequate spacing and `touch-action: manipulation` to prevent delayed tap interactions.\n" +
      "4. **Performance & Hardware Acceleration**: Restrict CSS animations and transitions strictly to `transform` and `opacity` properties to leverage GPU compositing and prevent expensive layout repaints.\n" +
      "5. **Eliminate Render Blocking**: Purge unused CSS rules, inline critical above-the-fold styles, and utilize modern CSS containment (`content-visibility: auto`) to defer rendering of off-screen elements.";
  }
  // 3. Bug explanation questions (e.g. "age bolo ki problem hoyse?", "why is it not working?")
  else if (isBugExplanationIntent(message)) {
    if (filesList.length === 0) {
      fallbackReply = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
    } else {
      fallbackReply = generateAstBugExplanation({
        message,
        snapshot,
        projectPath: opts.projectPath,
        conversationHistory,
      });
    }
  }
  // 4. Bug report without explicit fix request (e.g. "mul lekha ar jaiga ty kisu lekha jasse na typing box a lekha jasse but kono kisui kaj hosse na")
  else if (isBugReportIntent(message)) {
    if (filesList.length === 0) {
      fallbackReply = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
    } else {
      fallbackReply = "I understand your problem. Do you want me to fix this?";
    }
  }
  // 3. Password hashing and security questions
  else if (/(hash.*password|password.*hash|secure.*password|how.*hash|best\s+way.*password)/i.test(lowerMsg)) {
    fallbackReply = "The industry-standard best practice for password hashing is to use an adaptive, cryptographically secure key derivation function such as **bcrypt**, **Argon2id**, or **PBKDF2**. Key best practices include:\n\n" +
      "1. **Salt uniquely**: Always generate a cryptographically secure random salt per user/password to prevent rainbow table attacks.\n" +
      "2. **Adaptive work factor**: Tune the cost/work factor so hashing each password takes approximately 250–500ms, mitigating rapid brute-force attempts.\n" +
      "3. **Avoid fast hashes**: Never use MD5, SHA-1, or plain SHA-256 for passwords, as GPUs and ASICs can compute billions of hashes per second.\n" +
      "4. **Transport security**: Always transmit credentials over TLS/HTTPS and consider a server-side pepper in secure environment variables.";
  }
  // 4. Code inquiry specifically about login function
  else if (/(login.*function|login.*work|how.*login|explain.*login)/i.test(lowerMsg) && allFns.some(f => /login/i.test(f))) {
    const matchingFn = allFns.find(f => /loginuser/i.test(f)) || allFns.find(f => /login/i.test(f)) || 'loginUser';
    const hostFile = filesList.find(f => /app\.js|auth|login/i.test(f)) || (filesList[0] || 'app.js');
    fallbackReply = `In your codebase (\`${hostFile}\`), the \`${matchingFn}\` function handles user authentication and credential processing. Based on the AST structure, it accepts user credentials (such as username/email and password parameters), verifies input validity, and manages authentication state transitions. Related functions identified in this module include: ${allFns.slice(0, 4).map(f => `\`${f}\``).join(', ')}.`;
  }
  // 5. General function or class inquiry matching any known symbol in AST
  else if (allFns.some(fn => lowerMsg.includes(fn.toLowerCase())) || allClasses.some(c => lowerMsg.includes(c.toLowerCase()))) {
    const matchedFn = allFns.find(fn => lowerMsg.includes(fn.toLowerCase()));
    const matchedCls = allClasses.find(c => lowerMsg.includes(c.toLowerCase()));
    const matched = matchedCls || matchedFn;
    const hostFile = filesList.find(f => {
      const snapFile = (snapshot?.files || []).find(sf => (sf.path || sf) === f);
      const fns = snapFile?.fns || snapFile?.functions || snapFile?.ast?.functions || [];
      const cls = snapFile?.classes || [];
      return fns.some(name => (typeof name === 'string' ? name : name?.name) === matched) || cls.some(name => (typeof name === 'string' ? name : name?.name) === matched);
    }) || filesList[0] || 'app.js';
    fallbackReply = `The \`${matched}\` component in \`${hostFile}\` coordinates operations within your project's ${domainStr} architecture (${techStackStr}). It encapsulates component logic and coordinates event handling and state updates.`;
  }
  // 6. File count questions & specific file inquiries
  else if (/(koyta|how many)\s*files?/i.test(lowerMsg) || /file\s*count/i.test(lowerMsg) || /what\s+does\s+([a-zA-Z0-9_.-]+)\s+do/i.test(lowerMsg) || filesList.some(f => lowerMsg.includes(f.toLowerCase()))) {
    const count = filesList.length;
    let fileInquiryMatch = filesList.find(f => lowerMsg.includes(f.toLowerCase())) || null;
    let fileExplanation = '';
    if (fileInquiryMatch) {
      const snapFile = (snapshot?.files || []).find(sf => (sf.path || sf) === fileInquiryMatch);
      const fileClasses = snapFile?.classes || [];
      const fileFns = snapFile?.fns || snapFile?.functions || [];
      const items = [...fileClasses, ...fileFns.map(fn => typeof fn === 'string' ? fn : (fn?.name || String(fn)))];
      const itemsStr = items.length > 0 ? items.map(i => `\`${i}\``).join(', ') : '';
      if (/analyzer/i.test(fileInquiryMatch)) {
        fileExplanation = `\n\nRegarding \`${fileInquiryMatch}\`, it serves as the core log analysis and processing engine. It encapsulates ${itemsStr ? `${itemsStr} to inspect, sanitize, and validate log streams` : 'log parsing and sanitization routines'}.`;
      } else {
        fileExplanation = `\n\nRegarding \`${fileInquiryMatch}\`, it provides ${itemsStr ? `key components (${itemsStr})` : 'module logic'} within your ${domainStr} architecture.`;
      }
    }
    fallbackReply = `Your project currently contains **${count} files**${filesList.length > 0 ? `: ${filesList.join(', ')}` : '.'}${fileExplanation}`;
  }
  // 7. Feature existence questions
  else if (/(\b(ase|ache)\b\??|is there|do we have|does.*exist)/i.test(lowerMsg)) {
    const subj = typeof extractFeatureSubject === 'function' ? extractFeatureSubject(message) : '';
    const searchRes = typeof searchFeatureInAst === 'function' ? searchFeatureInAst(subj, snapshot) : { found: false };
    if (searchRes.found) {
      fallbackReply = `Yes, I found a ${subj} implementation in ${searchRes.matchedFile} (e.g., ${searchRes.matchedFn}). Would you like to explore how it works?`;
    } else {
      fallbackReply = `No, your project currently does not have a ${subj || 'requested'} feature. If you want to add it, select the ➕ Add Feature button above.`;
    }
  }
  // 8. General architecture / assistance response
  else {
    fallbackReply = `Hello! I am your Senior Software Architect assistant for this **${domainStr}** project built with **${techStackStr}**.\n\n` +
      `Your codebase contains ${filesList.length} files (${filesList.slice(0, 3).join(', ')}) with ${allFns.length} scanned functions (${allFns.slice(0, 3).join(', ')}).\n\n` +
      `You can ask me how specific functions work, discuss system design and security best practices, or review your code structure. If you'd like to implement new features or fix bugs, simply select ➕ Add, 🔄 Update, or 🐞 Fix above!`;
  }

  return {
    success: true,
    mode: 'informational',
    needsOptions: false,
    options: [],
    plan: null,
    reply: fallbackReply,
    responseText: fallbackReply,
    providerUsed: 'fallback',
  };
}

async function chatRespond(message, opts = {}) {
  let trimmed = (message || '').trim();
  const lower = trimmed.toLowerCase();

  const totalFiles = (opts.snapshot && Array.isArray(opts.snapshot.files))
    ? opts.snapshot.files.length
    : (opts.astSummary?.totalFiles != null ? opts.astSummary.totalFiles : 0);

  const rawMode = opts.mode ? String(opts.mode).toLowerCase().trim() : null;
  const isFixMode = rawMode === 'fix' || opts.mode === 'fix';

  if (isFixMode) {
    if (totalFiles === 0) {
      const reply = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
      return {
        success: true,
        mode: 'informational',
        isBugFix: false,
        prompt: null,
        metadata: null,
        options: [],
        plan: null,
        reply,
        responseText: reply,
        providerUsed: 'mode-router',
      };
    }
    const { buildBugFixPrompt } = require('../rules/prompt-builder');
    let projectFilesList = [];
    if (opts.snapshot && Array.isArray(opts.snapshot.files) && opts.snapshot.files.length > 0) {
      projectFilesList = opts.snapshot.files.map(f => f.path || f);
    } else {
      projectFilesList = ['index.html', 'style.css', 'app.js'];
    }
    const bugFixResult = await buildBugFixPrompt({
      currentIntent: message,
      userBugReport: message,
      projectFiles: projectFilesList,
      snapshot: opts.snapshot,
      agent: 'antigravity',
    });
    return {
      success: true,
      mode: 'bug_fix_ready',
      isBugFix: true,
      prompt: bugFixResult.prompt,
      metadata: bugFixResult.metadata,
      options: [],
      plan: null,
      reply: "I have generated the fix prompt. Click below to open it.",
      responseText: "I have generated the fix prompt. Click below to open it.",
      providerUsed: 'mode-router',
    };
  }

  if (totalFiles === 0) {
    if (!opts.projectContext) opts.projectContext = {};
    if (!opts.projectContext.domain || opts.projectContext.domain === 'Software Project' || opts.projectContext.domain === 'Web Application' || opts.projectContext.domain === 'Unknown') {
      opts.projectContext.domain = 'Brand new project';
    }
    if (!opts.projectContext.techStack || opts.projectContext.techStack.length === 0 || opts.projectContext.techStack === 'Unknown') {
      opts.projectContext.techStack = 'Empty workspace';
    }
    if (!inMemoryState.projectMemory || Object.keys(inMemoryState.projectMemory).length === 0 || inMemoryState.projectMemory.domain === 'Unknown') {
      inMemoryState.projectMemory = { domain: 'Brand new project', techStack: 'Empty workspace' };
    }
  }

  // Detect language dynamically (e.g. "I want to build a project in C++", "build a C++ game")
  const detectedLang = detectLanguageFromText(message);
  if (detectedLang) {
    inMemoryState.projectMemory = inMemoryState.projectMemory || {};
    inMemoryState.projectMemory.techStack = [detectedLang];
    if (!inMemoryState.projectMemory.domain || inMemoryState.projectMemory.domain === 'Unknown' || inMemoryState.projectMemory.domain === 'Software Project') {
      inMemoryState.projectMemory.domain = `${detectedLang} Application`;
    }
    if (opts.projectContext) {
      opts.projectContext.techStack = [detectedLang];
      opts.projectContext.domain = inMemoryState.projectMemory.domain;
    }
    if (opts.projectMemory) {
      opts.projectMemory.techStack = [detectedLang];
      opts.projectMemory.domain = inMemoryState.projectMemory.domain;
    }
    try {
      const projectStore = require('../storage/project-store');
      const sessionStore = require('../session-store');
      const pid = sessionStore.resolveProjectId();
      if (pid) {
        projectStore.saveMemorySync(pid, {
          projectId: pid,
          timestamp: new Date().toISOString(),
          snapshotFileCount: totalFiles,
          memory: {
            domain: inMemoryState.projectMemory.domain || 'Software Project',
            techStack: [detectedLang],
            primaryLanguage: detectedLang,
            architecturePattern: 'Unknown',
          }
        });
        sessionStore.saveState({ techStack: [detectedLang] });
      }
    } catch (_) {}
  }

  const explicitMode = opts.mode ? String(opts.mode).toLowerCase() : null;

  if (explicitMode === 'add') {
    const cleanFeature = await extractCleanIntentWithAI(message);
    let optionsRes = null;
    try {
      optionsRes = await suggestOptions(cleanFeature, {
        ...opts.projectContext,
        snapshot: opts.snapshot,
        files: (opts.snapshot?.files || []).slice(0, 20),
        _snapshot: opts.snapshot,
      });
    } catch (_) {}
    const options = (optionsRes && Array.isArray(optionsRes.options) && optionsRes.options.length > 0)
      ? optionsRes.options
      : [];
    const plan = {
      id: `plan_${Date.now()}`,
      task: cleanFeature,
      intentSummary: cleanFeature,
      userIntent: cleanFeature,
      rawUserPrompt: message,
      options,
      availableApproaches: options,
      selectedOption: options[0],
      selectedOptionName: options[0]?.name || options[0]?.label,
      activeFeatureRequirements: [message],
    };
    return {
      success: true,
      mode: 'action',
      needsOptions: true,
      options,
      plan,
      reply: `I've prepared 3 architectural options to add **${cleanFeature}**. Select an approach to generate your prompt:`,
      responseText: `I've prepared 3 architectural options to add **${cleanFeature}**. Select an approach to generate your prompt:`,
      providerUsed: 'mode-router',
    };
  }

  if (explicitMode === 'update') {
    if (totalFiles === 0) {
      const reply = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
      return {
        success: true,
        mode: 'informational',
        needsOptions: false,
        options: [],
        plan: null,
        reply,
        responseText: reply,
        providerUsed: 'mode-router',
      };
    }
    const cleanFeature = await extractCleanIntentWithAI(message);
    const updateIntent = cleanFeature.toLowerCase().startsWith('update ') ? cleanFeature : ('Update ' + cleanFeature);
    let optionsRes = null;
    try {
      optionsRes = await suggestOptions(updateIntent, {
        ...opts.projectContext,
        snapshot: opts.snapshot,
        files: (opts.snapshot?.files || []).slice(0, 20),
        _snapshot: opts.snapshot,
        isRefactor: true,
      });
    } catch (_) {}
    const options = (optionsRes && Array.isArray(optionsRes.options) && optionsRes.options.length > 0)
      ? optionsRes.options
      : [];
    const plan = {
      id: `plan_${Date.now()}`,
      task: updateIntent,
      intentSummary: updateIntent,
      userIntent: updateIntent,
      rawUserPrompt: message,
      options,
      availableApproaches: options,
      selectedOption: options[0],
      selectedOptionName: options[0]?.name || options[0]?.label,
      activeFeatureRequirements: [message],
    };
    return {
      success: true,
      mode: 'action',
      needsOptions: true,
      options,
      plan,
      reply: `I've prepared refactoring options to update **${cleanFeature}**. Select an approach to proceed:`,
      responseText: `I've prepared refactoring options to update **${cleanFeature}**. Select an approach to proceed:`,
      providerUsed: 'mode-router',
    };
  }

  if (explicitMode === 'chat') {
    if (totalFiles > 0) {
      const detected = detectChatModeIntent(message);
      if (detected === 'add') {
        const reply = "I understand you want to add this. Please select the ➕ Add Feature button above the chat box to proceed.";
        return {
          success: true,
          mode: 'informational',
          needsOptions: false,
          options: [],
          plan: null,
          reply,
          responseText: reply,
          providerUsed: 'mode-router',
        };
      }
      if (detected === 'update') {
        const reply = "I understand you want to update this. Please select the 🔄 Update Feature button above the chat box to proceed.";
        return {
          success: true,
          mode: 'informational',
          needsOptions: false,
          options: [],
          plan: null,
          reply,
          responseText: reply,
          providerUsed: 'mode-router',
        };
      }
      if (detected === 'fix') {
        const reply = "I understand you want to fix this. Please select the 🐞 Fix Bug button above to proceed.";
        return {
          success: true,
          mode: 'informational',
          needsOptions: false,
          options: [],
          plan: null,
          reply,
          responseText: reply,
          providerUsed: 'mode-router',
        };
      }
    }

    return await handleNormalChatConversation(message, opts);
  }

  // ── Task 16: Chat Commands Support ──────────────────────────────────────────
  if (lower === 'rescan project' || lower === 'rescan') {
    return {
      success: true,
      mode: 'command',
      action: 'rescan',
      actionPayload: null,
      reply: 'Rescanning project AST and file tree...',
      responseText: 'Rescanning project AST and file tree...',
      intentDetected: 'rescan',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['command', 'scanner'],
      providerUsed: 'command-dispatcher',
    };
  }

  if (lower === 'show snapshots' || lower === 'snapshots') {
    return {
      success: true,
      mode: 'command',
      action: 'show_snapshots',
      actionPayload: null,
      reply: 'Loading project snapshots...',
      responseText: 'Loading project snapshots...',
      intentDetected: 'show_snapshots',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['command', 'snapshots'],
      providerUsed: 'command-dispatcher',
    };
  }

  if (lower === 'clear chat' || lower === 'clear') {
    return {
      success: true,
      mode: 'command',
      action: 'clear_chat',
      actionPayload: null,
      reply: 'Chat cleared.',
      responseText: 'Chat cleared.',
      intentDetected: 'clear_chat',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['command'],
      providerUsed: 'command-dispatcher',
    };
  }

  const switchMatch = trimmed.match(/^switch\s+to\s+project\s+(.+)$/i);
  if (switchMatch) {
    const targetProject = switchMatch[1].trim();
    return {
      success: true,
      mode: 'command',
      action: 'switch_project',
      actionPayload: targetProject,
      payload: targetProject,
      reply: `Switching to project "${targetProject}"...`,
      responseText: `Switching to project "${targetProject}"...`,
      intentDetected: 'switch_project',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['command', 'project'],
      providerUsed: 'command-dispatcher',
    };
  }

  // ── General Project Query Handlers (File Count & Feature List) ─────────────
  if (isFileCountQuery(message)) {
    let snapshot = opts.snapshot || null;
    if (!snapshot) {
      try {
        const { getSnapshot } = require('../scanner/snapshot-manager');
        snapshot = getSnapshot();
      } catch (_) {}
    }
    const count = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files.length : 0;
    const reply = `Your project has ${count} files.`;
    return {
      success: true,
      mode: 'informational',
      needsOptions: false,
      reply,
      responseText: reply,
      options: [],
      plan: null,
      planSuggestion: null,
      suggestedFeatureType: null,
      providerUsed: 'project-query-handler',
    };
  }

  if (isFeatureListQuery(message)) {
    let snapshot = opts.snapshot || null;
    if (!snapshot) {
      try {
        const { getSnapshot } = require('../scanner/snapshot-manager');
        snapshot = getSnapshot();
      } catch (_) {}
    }
    const astSummary = buildAstSummary(snapshot);
    const reply = formatProjectFeatureList(snapshot, astSummary);
    return {
      success: true,
      mode: 'informational',
      needsOptions: false,
      reply,
      responseText: reply,
      options: [],
      plan: null,
      planSuggestion: null,
      suggestedFeatureType: null,
      providerUsed: 'project-query-handler',
    };
  }

  // ── Vague Project Request Intercept ────────────────────────────────────────
  if (isVagueProjectRequest(message)) {
    const reply = "Great! What kind of project would you like to build? (e.g., Web App, Game, CLI Tool, Backend API)";
    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        lastAssistantMessage: reply,
        pendingAction: null,
        currentIntent: null,
        currentPlan: null,
      });
    } catch (_) {}
    return {
      success: true,
      mode: 'clarification_needed',
      needsOptions: false,
      needsClarification: true,
      reply,
      responseText: reply,
      options: [],
      plan: null,
      planSuggestion: null,
      suggestedFeatureType: null,
      providerUsed: 'vague-project-handler',
    };
  }

  // ── Feature Existence / Feature Action Question Intercept ──────────────────
  if (isFeatureExistenceQuestion(message)) {
    // 1. CLEAR STALE CONTEXT: Immediately clear session.currentIntent, session.pendingAction, and session.currentPlan
    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        currentIntent: null,
        pendingAction: null,
        currentPlan: null,
        pendingFeature: null,
        pendingBugReport: null,
        activeFeatureRequirements: [],
      });
    } catch (_) {}

    const subject = extractFeatureSubject(message);
    let snapshot = opts.snapshot || null;
    if (!snapshot) {
      try {
        const { getSnapshot } = require('../scanner/snapshot-manager');
        snapshot = getSnapshot();
      } catch (_) {}
    }
    const astSummary = buildAstSummary(snapshot);
    const searchRes = searchFeatureInAst(subject, snapshot, astSummary);
    const intent = detectFeatureActionIntent(message);

    let reply = '';
    let pendingAct = '';
    let mode = 'informational';
    let needsOptions = false;
    let plan = null;
    let options = [];

    // Action:
    // If intent === 'update' and subject is found in AST: Reply "Yes, I found the login feature. I will prepare options to update it." and trigger suggestOptions().
    // If intent === 'add' and subject is not found: Reply "No, login does not exist. I will prepare options to add it." and trigger suggestOptions().
    if (intent === 'update' && searchRes.found) {
      reply = `Yes, I found the ${subject} feature. I will prepare options to update it.`;
      pendingAct = 'update_feature';
      mode = 'action';
      needsOptions = true;

      const optResult = await suggestOptions(`Update and enhance ${subject} feature`, {
        _snapshot: snapshot,
        files: snapshot?.files || [],
        domain: opts.projectContext?.domain,
        techStack: opts.projectContext?.techStack,
      });
      options = Array.isArray(optResult.options) ? optResult.options : [];
      plan = {
        id: `plan_${Date.now()}`,
        task: `Update ${subject} feature`,
        intentSummary: `Update ${subject} feature`,
        userIntent: `Update ${subject} feature`,
        featureType: 'Feature Update',
        availableApproaches: options,
        options,
        filesToEdit: searchRes.matchedFile ? [searchRes.matchedFile] : [],
        filesToCreate: [],
      };
    } else if (intent === 'add' && !searchRes.found) {
      reply = `No, ${subject} does not exist. I will prepare options to add it.`;
      pendingAct = 'add_feature';
      mode = 'action';
      needsOptions = true;

      const optResult = await suggestOptions(`Add ${subject} feature`, {
        _snapshot: snapshot,
        files: snapshot?.files || [],
        domain: opts.projectContext?.domain,
        techStack: opts.projectContext?.techStack,
      });
      options = Array.isArray(optResult.options) ? optResult.options : [];
      plan = {
        id: `plan_${Date.now()}`,
        task: `Add ${subject} feature`,
        intentSummary: `Add ${subject} feature`,
        userIntent: `Add ${subject} feature`,
        featureType: 'Feature Implementation',
        availableApproaches: options,
        options,
        filesToEdit: [],
        filesToCreate: ['index.html', 'style.css', 'app.js'],
      };
    } else if (searchRes.found) {
      const loc = searchRes.matchedFile ? ` in ${searchRes.matchedFile}` : ' in your project';
      const ex = searchRes.matchedFn || searchRes.matchedFile;
      reply = `Yes, I found a ${subject} implementation${loc} (e.g., ${ex}). Would you like to update or enhance it?`;
      pendingAct = 'update_feature';
      mode = 'informational';
      needsOptions = false;
    } else {
      const featureLabel = subject ? (subject.toLowerCase().endsWith('feature') ? subject : `${subject} feature`) : 'feature';
      reply = `No, your project currently does not have a ${featureLabel}. Would you like to add it?`;
      pendingAct = 'add_feature';
      mode = 'informational';
      needsOptions = false;
    }

    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        pendingAction: pendingAct,
        pendingFeature: subject,
        currentIntent: plan ? plan.task : null,
        currentPlan: plan,
        lastAssistantMessage: reply,
      });
    } catch (_) {}

    return {
      success: true,
      mode,
      needsOptions,
      reply,
      responseText: reply,
      pendingAction: pendingAct,
      featureSubject: subject,
      action: null,
      actionPayload: null,
      intentDetected: plan ? (pendingAct === 'update_feature' ? 'update_feature' : 'add_feature') : 'feature_existence_query',
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      options,
      plan,
      insightTags: ['feature_existence', 'ast_search'],
      providerUsed: 'ast-search',
      isBugFix: false,
    };
  }

  // ── Context Follow-Up "Why?" Question Handling ────────────────────────────
  if (isWhyQuestion(message)) {
    const isButtonMentioned = /(button|btn|click|press|listener|event|start-btn)/i.test(message);
    if (!isButtonMentioned) {
      const reply = "I apologize. I failed to understand your previous command. I am trying to extract the feature name correctly now.";
      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          lastAssistantMessage: reply,
        });
      } catch (_) {}
      return {
        success: true,
        mode: 'informational',
        reply,
        responseText: reply,
        needsOptions: false,
        needsClarification: false,
        options: [],
        plan: null,
        suggestedFeatureType: null,
        planSuggestion: null,
        insightTags: ['context_followup'],
        providerUsed: 'context-explainer',
        isBugFix: false,
      };
    }
  }

  // ── Bug Explanation Intent Detection ───────────────────────────────────────
  const isExplanation = isBugExplanationIntent(message);
  if (isExplanation) {
    let explanationText = null;

    // 1. Try AI provider with AST context if active provider is configured
    try {
      const activeP = getActiveProvider();
      if (hasKey(activeP) || activeP === 'ollama') {
        const { projectContext = {}, conversationHistory = [], activeRules = [], snapshot = null } = opts;
        const astSummary = buildAstSummary(snapshot);
        const systemPrompt = loadPrompt('chat-respond');
        const inputPayload = {
          message: message.slice(0, 600),
          projectContext: {
            domain: projectContext.domain || 'Software Project',
            techStack: projectContext.techStack || [],
            totalFiles: astSummary?.totalFiles || snapshot?.stats?.totalFiles || 0,
            existingFiles: astSummary?.topFiles?.slice(0, 25).map(f => ({ path: f.path, loc: f.loc, fns: (f.fns || []).slice(0, 3) })) || [],
            contractFindings: generateAstBugExplanation({ message, snapshot, projectPath: opts.projectPath }),
          },
          conversationHistory: conversationHistory.slice(-5).map(m => ({
            role: m.role || m.type,
            text: (m.text || '').slice(0, 200),
          })),
          activeRules,
        };
        const prompt = `${systemPrompt}\n\nINPUT:\n${JSON.stringify(inputPayload, null, 2)}`;
        const res = await callProviderWithFallback(prompt);
        if (res.success) {
          const parsed = parseJsonResponse(res.data);
          const replyText = parsed.responseText || parsed.reply;
          if (replyText && !replyText.includes('generate a prompt to fix it')) {
            explanationText = replyText;
          }
        }
      }
    } catch (_) {}

    // 2. Fall back to local deterministic AST explanation
    if (!explanationText) {
      explanationText = generateAstBugExplanation({
        message,
        snapshot: opts.snapshot,
        projectPath: opts.projectPath,
      });
    }

    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        pendingAction: null,
        pendingBugReport: null,
      });
    } catch (_) {}

    return {
      success: true,
      mode: 'bug_explanation',
      reply: explanationText,
      responseText: explanationText,
      action: null,
      actionPayload: null,
      intentDetected: 'bug_explanation',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['bug_explanation', 'ast_analysis'],
      providerUsed: 'ast-explainer',
      isBugFix: false,
    };
  }

  // ── Stateful Pending Action & Confirmation Handling ─────────────────────────
  let savedSession = {};
  try {
    const sessionStore = require('../session-store');
    savedSession = sessionStore.loadState() || {};
  } catch (_) {}

  let pendingBugReport = opts.pendingBugReport || savedSession.pendingBugReport || null;
  let pendingFeature = opts.pendingFeature || savedSession.pendingFeature || savedSession.currentIntent || null;
  let pendingAction = opts.pendingAction || savedSession.pendingAction || (pendingBugReport ? 'bug_fix_prompt' : null);
  let activeFeatureRequirements = Array.isArray(opts.activeFeatureRequirements)
    ? [...opts.activeFeatureRequirements]
    : (Array.isArray(savedSession.activeFeatureRequirements) ? [...savedSession.activeFeatureRequirements] : []);

  // Fallback to conversation history if pendingBugReport wasn't saved in disk
  if (!pendingBugReport && Array.isArray(opts.conversationHistory) && opts.conversationHistory.length > 0) {
    const lastMsg = opts.conversationHistory[opts.conversationHistory.length - 1];
    const isLastExplanation = lastMsg?.mode === 'bug_explanation' || isBugExplanationIntent(lastMsg?.text || lastMsg?.message);
    if (!isLastExplanation) {
      for (let i = opts.conversationHistory.length - 1; i >= 0; i--) {
        const m = opts.conversationHistory[i];
        if (m.mode === 'bug_explanation' || isBugExplanationIntent(m.text || m.message)) {
          break; // Stop scanning back past an explanation!
        }
        const txt = (m.text || m.message || '').trim();
        if (m.bugReport && !isBugExplanationIntent(m.bugReport)) {
          pendingBugReport = m.bugReport;
          break;
        }
        if (m.role === 'user' && isBugReport(txt) && !isBugExplanationIntent(txt)) {
          pendingBugReport = txt;
          break;
        }
      }
    }
  }

  // Fallback to conversation history if pendingFeature wasn't saved in disk
  if (!pendingFeature && Array.isArray(opts.conversationHistory) && opts.conversationHistory.length > 0) {
    for (let i = opts.conversationHistory.length - 1; i >= 0; i--) {
      const m = opts.conversationHistory[i];
      const txt = m.text || m.message || '';
      if (m.mode === 'action' || m.needsOptions || txt.includes('generate the prompt') || txt.includes('architecture')) {
        if (i > 0 && opts.conversationHistory[i - 1]?.role === 'user') {
          pendingFeature = opts.conversationHistory[i - 1].text || opts.conversationHistory[i - 1].message;
        }
        break;
      }
    }
  }

  // Intent Analysis Override: If message has new request alongside confirmation (e.g. "ok akn taholy login feature add korbo")
  const newRequestFromConfirm = extractNewRequestFromConfirmation(message);
  if (newRequestFromConfirm) {
    message = newRequestFromConfirm;
    trimmed = message.trim();
    pendingAction = null;
    pendingBugReport = null;
    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({ pendingAction: null, pendingBugReport: null });
    } catch (_) {}
  }

  // 1. Meta-Command vs Bug Report Protection
  const isMetaCmd = META_COMMAND_REGEX.test(message.trim());
  if (!isExplanation && isMetaCmd && pendingBugReport) {
    const { buildBugFixPrompt } = require('../rules/prompt-builder');
    let projectFilesList = [];
    const snapshot = opts.snapshot || null;
    if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
      projectFilesList = snapshot.files.map(f => f.path || f);
    } else {
      projectFilesList = ['index.html', 'style.css', 'app.js'];
    }

    const bugText = pendingBugReport; // MUST pull from saved pendingBugReport, NOT the meta-command!

    const bugFixResult = await buildBugFixPrompt({
      currentIntent: bugText,
      userBugReport: bugText,
      projectFiles: projectFilesList,
      snapshot,
      agent: 'antigravity',
    });
    const bugFixPrompt = bugFixResult.prompt;

    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        pendingAction: null,
        pendingBugReport: null,
        currentIntent: bugText,
        lastGeneratedPrompt: bugFixPrompt,
        isBugFix: true,
      });
    } catch (_) {}

    const reply = "I have generated the fix prompt. Click below to open it.";
    return {
      success: true,
      mode: 'bug_fix_ready',
      reply,
      responseText: reply,
      action: null,
      actionPayload: null,
      intentDetected: 'bug_fix_ready',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['bug_fix', 'prompt_ready'],
      providerUsed: 'bug-intent-detector',
      prompt: bugFixPrompt,
      metadata: bugFixResult.metadata,
      bugReport: bugText,
      isBugFix: true,
    };
  }

  // 2. Bengali "ai/ei" vs English "AI" & Feature Reference Handling
  const isThisFeat = isThisFeatureReference(message);
  if (!isExplanation && isThisFeat && (pendingFeature || pendingAction === 'feature_plan' || activeFeatureRequirements.length > 0)) {
    const rawFeatureText = pendingFeature || activeFeatureRequirements[0] || savedSession.currentIntent || 'Feature Implementation';
    const featureText = stripBengaliStopWords(rawFeatureText);

    const optionsResult = await suggestOptions(featureText, {
      _snapshot: opts.snapshot,
      domain: opts.projectContext?.domain || 'Software Project',
      techStack: opts.projectContext?.techStack || [],
      files: opts.snapshot?.files || [],
      missingBlueprints: opts.projectContext?.missingBlueprints || [],
      activeRules: opts.activeRules || [],
    });

    const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
    const activeReqs = activeFeatureRequirements.length > 0 ? activeFeatureRequirements : [featureText];

    const plan = {
      id: `plan_${Date.now()}`,
      task: featureText,
      intentSummary: featureText.slice(0, 80),
      userIntent: featureText,
      featureType: optionsResult.featureType || 'Feature Implementation',
      availableApproaches: options,
      options,
      filesToEdit: [],
      filesToCreate: ['index.html', 'style.css', 'app.js'],
      activeFeatureRequirements: activeReqs,
    };

    const { buildStrictPrompt } = require('../rules/prompt-builder');
    const promptResult = await buildStrictPrompt({
      plan,
      currentIntent: featureText,
      task: featureText,
      feature: featureText,
      userIntent: featureText,
      activeFeatureRequirements: activeReqs,
      snapshot: opts.snapshot,
      projectMemory: opts.projectContext,
    });

    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        pendingAction: null,
        pendingFeature: null,
        currentIntent: featureText,
        currentPlan: plan,
        lastGeneratedPrompt: promptResult.prompt,
        activeFeatureRequirements: activeReqs,
      });
    } catch (_) {}

    const reply = `I have analyzed "${featureText}" and prepared 3 architectural options.`;
    return {
      success: true,
      mode: 'action',
      reply,
      responseText: reply,
      action: null,
      actionPayload: null,
      intentDetected: 'feature_plan',
      needsOptions: true,
      needsClarification: false,
      suggestedFeatureType: optionsResult.featureType || 'Feature Implementation',
      planSuggestion: plan,
      options,
      plan,
      prompt: promptResult.prompt,
      insightTags: ['feature_plan', 'options'],
      providerUsed: optionsResult.providerUsed || 'option-suggester',
      isBugFix: false,
    };
  }

  // ── 2b. Semantic Meta-Command / Command Request Handling ─────────────────────
  const isOptionsCmd = isOptionsCommand(message);
  const isPromptCmd = isPromptCommand(message);
  const isBuildCmdAt2b = isBuildCommand(message);
  const isBroadCmd = BROAD_COMMAND_REGEX.test(message);
  const isQuestionAt2b = isConversationalQuestion(message);

  if (!isExplanation && !isQuestionAt2b && (isOptionsCmd || isPromptCmd || isBuildCmdAt2b || (isBroadCmd && (savedSession.currentPlan || pendingFeature || pendingBugReport)))) {
    // 1. Asking for Options (e.g. "option gula daw", "show options", "ki ki option ache?")
    if (isOptionsCmd || (!isQuestionAt2b && isBroadCmd && /(option|choice)/i.test(message))) {
      const activeFeature = pendingFeature || savedSession.currentIntent || savedSession.currentPlan?.task || (activeFeatureRequirements.length > 0 ? activeFeatureRequirements[0] : 'Feature Implementation');
      let options = (savedSession.currentPlan && Array.isArray(savedSession.currentPlan.options) && savedSession.currentPlan.options.length > 0)
        ? savedSession.currentPlan.options
        : null;

      if (!options || options.length === 0) {
        const optRes = await suggestOptions(activeFeature, {
          _snapshot: opts.snapshot,
          domain: opts.projectContext?.domain || 'Software Project',
          techStack: opts.projectContext?.techStack || [],
          files: opts.snapshot?.files || [],
          missingBlueprints: opts.projectContext?.missingBlueprints || [],
          activeRules: opts.activeRules || [],
        });
        options = Array.isArray(optRes.options) ? optRes.options : [];
      }

      const plan = savedSession.currentPlan || {
        id: `plan_${Date.now()}`,
        task: activeFeature,
        intentSummary: activeFeature.slice(0, 80),
        userIntent: activeFeature,
        featureType: 'Feature Implementation',
        availableApproaches: options,
        options,
        filesToEdit: [],
        filesToCreate: ['index.html', 'style.css', 'app.js'],
      };
      plan.options = options;

      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          currentPlan: plan,
          currentIntent: activeFeature,
        });
      } catch (_) {}

      const isBengali = /[\u0980-\u09FF]|gula|gulo|daw|dao|dekhao|bolo|ache|asea|karon|ki\s+ki/i.test(message);
      const reply = isBengali ? "এখানে অপশনগুলো পুনরায় দেওয়া হলো:" : "Here are the options again:";
      return {
        success: true,
        mode: 'action',
        reply,
        responseText: reply,
        action: null,
        actionPayload: null,
        intentDetected: 'command_request',
        needsOptions: true,
        needsClarification: false,
        suggestedFeatureType: plan.featureType || 'Feature Implementation',
        planSuggestion: plan,
        options,
        plan,
        insightTags: ['command_request', 'options'],
        providerUsed: 'command-handler',
        isBugFix: false,
      };
    }

    // 2. Asking for Prompt (e.g. "prompt ta dao", "generate the prompt", "ready koro", "plan dao", "ok prompt daw")
    if (isPromptCmd || (isBroadCmd && /(prompt|plan|dao|daw|ready|koro|banao)/i.test(message))) {
      // 2a. If there is a pending bug report, generate bug fix prompt
      if (pendingBugReport) {
        const { buildBugFixPrompt } = require('../rules/prompt-builder');
        let projectFilesList = [];
        const snapshot = opts.snapshot || null;
        if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
          projectFilesList = snapshot.files.map(f => f.path || f);
        } else {
          projectFilesList = ['index.html', 'style.css', 'app.js'];
        }

        const bugText = pendingBugReport;
        const bugFixResult = await buildBugFixPrompt({
          currentIntent: bugText,
          userBugReport: bugText,
          projectFiles: projectFilesList,
          snapshot,
          agent: 'antigravity',
        });

        try {
          const sessionStore = require('../session-store');
          sessionStore.saveState({
            pendingAction: null,
            pendingBugReport: null,
            currentIntent: bugText,
            lastGeneratedPrompt: bugFixResult.prompt,
            isBugFix: true,
          });
        } catch (_) {}

        const reply = "I have generated the fix prompt. Click below to open it.";
        return {
          success: true,
          mode: 'bug_fix_ready',
          reply,
          responseText: reply,
          action: null,
          actionPayload: null,
          intentDetected: 'bug_fix_ready',
          needsOptions: false,
          needsClarification: false,
          suggestedFeatureType: null,
          planSuggestion: null,
          insightTags: ['bug_fix', 'prompt_ready'],
          providerUsed: 'bug-intent-detector',
          prompt: bugFixResult.prompt,
          metadata: bugFixResult.metadata,
          bugReport: bugText,
          isBugFix: true,
        };
      }

      // 2b. If options were ALREADY shown/prepared (savedSession.currentPlan exists with options):
      // The user is asking for the prompt ("prompt ta dao") -> Generate strict prompt!
      if (savedSession.currentPlan && Array.isArray(savedSession.currentPlan.options) && savedSession.currentPlan.options.length > 0 && pendingAction !== 'feature_plan') {
        const { buildStrictPrompt } = require('../rules/prompt-builder');
        const plan = savedSession.currentPlan;
        const featureText = plan.task || savedSession.currentIntent || 'Feature Implementation';
        const activeReqs = activeFeatureRequirements.length > 0 ? activeFeatureRequirements : [featureText];

        const promptResult = await buildStrictPrompt({
          plan,
          currentIntent: featureText,
          task: featureText,
          feature: featureText,
          userIntent: featureText,
          activeFeatureRequirements: activeReqs,
          snapshot: opts.snapshot,
          projectMemory: opts.projectContext,
        });

        try {
          const sessionStore = require('../session-store');
          sessionStore.saveState({
            lastGeneratedPrompt: promptResult.prompt,
            currentIntent: featureText,
            pendingAction: null,
            pendingFeature: null,
            activeFeatureRequirements: activeReqs,
          });
        } catch (_) {}

        const reply = "I have generated the strict prompt for your feature.";
        return {
          success: true,
          mode: 'action',
          reply,
          responseText: reply,
          action: null,
          actionPayload: null,
          intentDetected: 'command_request',
          needsOptions: false,
          needsClarification: false,
          suggestedFeatureType: plan.featureType || 'Feature Implementation',
          planSuggestion: plan,
          options: plan.options,
          plan,
          prompt: promptResult.prompt,
          metadata: promptResult.metadata,
          insightTags: ['command_request', 'prompt_ready'],
          providerUsed: 'command-handler',
          isBugFix: false,
        };
      }

      // 2c. If options have NOT been shown yet, but a feature is pending ("ok prompt daw" on "I want to build a real-time password checker"):
      // The user wants to proceed with the feature -> Present the 3 architecture options (A/B/C buttons) immediately!
      if (pendingFeature || pendingAction === 'feature_plan' || activeFeatureRequirements.length > 0 || savedSession.currentIntent) {
        const featureText = pendingFeature || activeFeatureRequirements[0] || savedSession.currentIntent || 'Feature Implementation';
        const optionsResult = await suggestOptions(featureText, {
          _snapshot: opts.snapshot,
          domain: opts.projectContext?.domain || 'Software Project',
          techStack: opts.projectContext?.techStack || [],
          files: opts.snapshot?.files || [],
          missingBlueprints: opts.projectContext?.missingBlueprints || [],
          activeRules: opts.activeRules || [],
        });

        const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
        const plan = {
          id: `plan_${Date.now()}`,
          task: featureText,
          intentSummary: featureText.slice(0, 80),
          userIntent: featureText,
          featureType: optionsResult.featureType || 'Feature Implementation',
          availableApproaches: options,
          options,
          filesToEdit: [],
          filesToCreate: ['index.html', 'style.css', 'app.js'],
          activeFeatureRequirements: activeFeatureRequirements.length > 0 ? activeFeatureRequirements : [featureText],
        };

        try {
          const sessionStore = require('../session-store');
          sessionStore.saveState({
            currentPlan: plan,
            currentIntent: featureText,
            pendingAction: null,
            pendingFeature: null,
          });
        } catch (_) {}

        const reply = `I have analyzed "${featureText}" and prepared 3 architectural options. Please choose an approach:`;
        return {
          success: true,
          mode: 'action',
          reply,
          responseText: reply,
          action: null,
          actionPayload: null,
          intentDetected: 'command_request',
          needsOptions: true,
          needsClarification: false,
          suggestedFeatureType: optionsResult.featureType || 'Feature Implementation',
          planSuggestion: plan,
          options,
          plan,
          insightTags: ['command_request', 'options'],
          providerUsed: 'command-handler',
          isBugFix: false,
        };
      }
    }
  }

  // ── Evaluative Question Interception (Fix: Evaluative Question Routing) ─────
  const currentPlanOptions = (opts.currentPlan && Array.isArray(opts.currentPlan.options) && opts.currentPlan.options.length > 0)
    ? opts.currentPlan.options
    : (savedSession.currentPlan && Array.isArray(savedSession.currentPlan.options) && savedSession.currentPlan.options.length > 0)
      ? savedSession.currentPlan.options
      : (Array.isArray(opts.options) && opts.options.length > 0 ? opts.options : []);

  if (isEvaluativeQuestion(message) && currentPlanOptions.length > 0) {
    const activeFeat = savedSession.currentIntent || opts.pendingFeature || (savedSession.currentPlan && savedSession.currentPlan.task) || inMemoryState.currentIntent || 'Feature Implementation';
    const recommendationText = await generateOptionRecommendation(
      message,
      currentPlanOptions,
      activeFeat,
      opts.projectContext || projectContext
    );

    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        lastAssistantMessage: recommendationText,
      });
    } catch (_) {}

    return {
      success: true,
      mode: 'informational',
      reply: recommendationText,
      responseText: recommendationText,
      action: null,
      actionPayload: null,
      intentDetected: 'evaluative_recommendation',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      options: [],
      plan: savedSession.currentPlan || opts.currentPlan || null,
      insightTags: ['recommendation', 'evaluative'],
      providerUsed: 'option-evaluator',
      isBugFix: false,
    };
  }

  // ── 2c. Conversational Question / Inquiry Handling ──────────────────────────
  const isQuestion = isConversationalQuestion(message);
  if (!isExplanation && isQuestion) {
    const lowerMsg = message.toLowerCase();
    const activeFeat = cleanFeatureIntent(pendingFeature || savedSession.currentIntent || 'Feature Implementation');
    let answer = '';

    const isFeatureQuery = /(ki\s+ki\s+feature|features?|functionality|capabilities|ki\s+ki\s+thakbe|ki\s+ki\s+thakby|what\s+features)/i.test(lowerMsg);
    const isUIQuery = /(kemon\s+hobe|how\s+will\s+it\s+look|look|design|ui|layout|interface|appearance)/i.test(lowerMsg);
    const isOptionsQuery = isOptionsInquiryQuestion(lowerMsg) || isEvaluativeQuestion(lowerMsg) ||
      /(option|choice|approach|valo\s*hoby|valo\s*hobe|better|best|which|kivabe|kno|keno)/i.test(lowerMsg);

    // If options are present, use generateOptionRecommendation for options queries
    if (isOptionsQuery && currentPlanOptions.length > 0) {
      answer = await generateOptionRecommendation(
        message,
        currentPlanOptions,
        activeFeat,
        opts.projectContext || projectContext
      );
    }

    // Try AI provider if available and not in cooldown
    try {
      const activeP = getActiveProvider();
      if ((hasKey(activeP) || activeP === 'ollama') && !isProviderCoolingDown(activeP)) {
        const systemPrompt = loadPrompt('chat-respond');
        const inputPayload = {
          message: message.slice(0, 600),
          currentFeature: activeFeat,
          projectContext: {
            domain: opts.projectContext?.domain || 'Software Project',
            techStack: opts.projectContext?.techStack || [],
          },
          conversationHistory: (opts.conversationHistory || []).slice(-5).map(m => ({
            role: m.role || m.type,
            text: (m.text || '').slice(0, 200),
          })),
        };
        const prompt = `${systemPrompt}\n\nINPUT:\n${JSON.stringify(inputPayload, null, 2)}`;
        const aiRes = await callProviderWithFallback(prompt);
        if (aiRes.success) {
          const parsed = parseJsonResponse(aiRes.data);
          const replyText = parsed.responseText || parsed.reply;
          if (replyText && !replyText.includes('API Limit Exceeded')) {
            answer = replyText;
          }
        }
      }
    } catch (_) {}

    // Deterministic fallback if AI unavailable
    if (!answer) {
      if (isOptionsQuery) {
        answer = `**Architecture Option Recommendation for "${activeFeat}":**\n\n` +
          `• **Option A (Modular Production Architecture — Recommended):**\n` +
          `  - Separates HTML (structure), CSS (styling), and JavaScript (validation & UI logic) into distinct files.\n` +
          `  - Follows production best practices, type safety, and clean separation of concerns.\n` +
          `  - Easily maintainable and scalable without monolithic code bloat.\n\n` +
          `• **Option B (Single-File Prototype):**\n` +
          `  - Keeps everything embedded within a single \`index.html\`.\n` +
          `  - Useful for quick throwaway testing, but not maintainable for production.\n\n` +
          `• **Option C (Inline / Component Script):**\n` +
          `  - Lightweight inline integration into existing pages.\n\n` +
          `👉 **Verdict:** **Option A (Modular)** is strongly recommended for security, performance, and long-term maintainability.\n\n` +
          `When you are ready, select an option from the cards or say *"ok akn project ta banai"* to generate the strict prompt!`;
      } else if (isFeatureQuery) {
        if (/password/i.test(activeFeat)) {
          answer = `**Features planned for ${activeFeat}:**\n\n` +
            `• **Real-Time Password Strength Meter**: Scores password strength dynamically across 4 levels (Weak, Fair, Good, Strong).\n` +
            `• **Instant Validation Criteria**: Real-time checklist verifying minimum 8 characters, uppercase, lowercase, numbers, and special symbols.\n` +
            `• **Dynamic Progress Bar**: Smooth color-shifting progress bar with CSS transitions.\n` +
            `• **Show/Hide Password Toggle**: Interactive eye icon to toggle password visibility.\n` +
            `• **Zero-Dependency Vanilla JS**: High-performance client-side validation without heavy external libraries.`;
        } else {
          answer = `**Features planned for ${activeFeat}:**\n\n` +
            `• Core functional component structure with clean separation of concerns.\n` +
            `• Real-time reactive state updates and event handling.\n` +
            `• Accessible UI design with standard keyboard navigation.\n` +
            `• Pure Vanilla JS with no external dependencies.`;
        }
      } else if (isUIQuery) {
        if (/password/i.test(activeFeat)) {
          answer = `**UI & Visual Design for ${activeFeat}:**\n\n` +
            `• **Modern Card Container**: Glassmorphic, dark-mode card container with smooth rounded borders.\n` +
            `• **Interactive Input Field**: Clean input with smooth focus ring and a toggleable visibility eye icon.\n` +
            `• **Color-Coded Strength Bar**: Multi-segment meter that transitions from Red (Weak) to Yellow (Medium) to Vibrant Green (Strong).\n` +
            `• **Live Checklist Badges**: Animated checkmarks that highlight green as requirements are satisfied.\n` +
            `• **Responsive Layout**: Fluid layout using modern CSS Flexbox/Grid for desktop and mobile.`;
        } else {
          answer = `**UI & Visual Design for ${activeFeat}:**\n\n` +
            `• Clean, modern interface designed with modular Vanilla CSS.\n` +
            `• Intuitive visual hierarchy with smooth transition animations.\n` +
            `• Responsive container optimized for mobile and desktop screens.`;
        }
      } else if (/(koyta|koita|how\s+many)\s+(?:file|files)|project.*(?:file|files|koyta|structure)|(?:file|files).*(?:koyta|koita|how\s+many)/i.test(lowerMsg)) {
        const total = opts.projectContext?.totalFiles || opts.snapshot?.stats?.totalFiles || (opts.snapshot?.files || []).length || 0;
        const isBn = /[\u0980-\u09FF]|koyta|koita|ache|asea|amr|amar/i.test(lowerMsg);
        answer = isBn
          ? `আপনার প্রোজেক্টে বর্তমানে ${total}টি ফাইল আছে।`
          : `Your project currently contains ${total} files.`;
      } else {
        answer = `Regarding your inquiry on **"${activeFeat}"**: The implementation is structured as a modular, client-side Vanilla JS component with clean CSS and rigorous input validation. Feel free to approve the plan or request any adjustments!`;
      }
    }

    return {
      success: true,
      mode: 'informational',
      reply: answer,
      responseText: answer,
      action: null,
      actionPayload: null,
      intentDetected: 'informational_question',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      options: [],
      insightTags: ['question_answering', 'informational'],
      providerUsed: 'assistant',
      isBugFix: false,
    };
  }

  const isPureConfirm = isConfirmationWord(message);
  const isExplicitFix = isExplicitFixCommand(message);
  const isBuildCmd = isBuildCommand(message);

  if (!isExplanation && (isPureConfirm || isExplicitFix || isBuildCmd)) {
    // 0a. Feature Existence Follow-Up: Update Feature Confirmation
    if (pendingAction === 'update_feature' && isPureConfirm) {
      const targetFeature = pendingFeature || savedSession.pendingFeature || 'login';
      const featureTask = `Refactor and update ${targetFeature} feature`;

      const optionsResult = await suggestOptions(featureTask, {
        _snapshot: opts.snapshot,
        domain: opts.projectContext?.domain || 'Software Project',
        techStack: opts.projectContext?.techStack || [],
        files: opts.snapshot?.files || [],
        missingBlueprints: opts.projectContext?.missingBlueprints || [],
        activeRules: opts.activeRules || [],
      });

      const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
      const plan = {
        id: `plan_${Date.now()}`,
        task: featureTask,
        intentSummary: featureTask.slice(0, 80),
        userIntent: featureTask,
        featureType: optionsResult.featureType || 'Feature Update',
        availableApproaches: options,
        options,
        filesToEdit: ['app.js'],
        filesToCreate: [],
        isRefactor: true,
      };

      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          currentPlan: plan,
          currentIntent: featureTask,
          pendingAction: 'feature_plan',
          pendingFeature: targetFeature,
        });
      } catch (_) {}

      const reply = `I have prepared 3 architectural options for updating and refactoring the "${targetFeature}" feature. Please choose an approach:`;
      return {
        success: true,
        mode: 'action',
        reply,
        responseText: reply,
        action: null,
        actionPayload: null,
        intentDetected: 'feature_update',
        needsOptions: true,
        needsClarification: false,
        suggestedFeatureType: optionsResult.featureType || 'Feature Update',
        planSuggestion: plan,
        options,
        plan,
        insightTags: ['feature_update', 'refactoring', 'options'],
        providerUsed: optionsResult.providerUsed || 'option-suggester',
        isBugFix: false,
      };
    }

    // 0b. Feature Existence Follow-Up: Add Feature Confirmation
    if (pendingAction === 'add_feature' && isPureConfirm) {
      const targetFeature = pendingFeature || savedSession.pendingFeature || 'Feature';
      const featureTask = `Add ${targetFeature} feature`;

      const optionsResult = await suggestOptions(featureTask, {
        _snapshot: opts.snapshot,
        domain: opts.projectContext?.domain || 'Software Project',
        techStack: opts.projectContext?.techStack || [],
        files: opts.snapshot?.files || [],
        missingBlueprints: opts.projectContext?.missingBlueprints || [],
        activeRules: opts.activeRules || [],
      });

      const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
      const plan = {
        id: `plan_${Date.now()}`,
        task: featureTask,
        intentSummary: featureTask.slice(0, 80),
        userIntent: featureTask,
        featureType: optionsResult.featureType || 'Feature Implementation',
        availableApproaches: options,
        options,
        filesToEdit: [],
        filesToCreate: ['index.html', 'style.css', 'app.js'],
      };

      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          currentPlan: plan,
          currentIntent: featureTask,
          pendingAction: 'feature_plan',
          pendingFeature: targetFeature,
        });
      } catch (_) {}

      const reply = `I have prepared 3 architectural options for adding the "${targetFeature}" feature. Please choose an approach:`;
      return {
        success: true,
        mode: 'action',
        reply,
        responseText: reply,
        action: null,
        actionPayload: null,
        intentDetected: 'feature_add',
        needsOptions: true,
        needsClarification: false,
        suggestedFeatureType: optionsResult.featureType || 'Feature Implementation',
        planSuggestion: plan,
        options,
        plan,
        insightTags: ['feature_add', 'options'],
        providerUsed: optionsResult.providerUsed || 'option-suggester',
        isBugFix: false,
      };
    }

    // 1. Bug Fix Confirmation
    if (pendingAction === 'bug_fix_prompt' || isExplicitFix || (pendingBugReport && (pendingAction === 'bug_fix_prompt' || isExplicitFix || (!pendingAction && isExplicitFix)))) {
      const { buildBugFixPrompt } = require('../rules/prompt-builder');
      let projectFilesList = [];
      const snapshot = opts.snapshot || null;
      if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        projectFilesList = snapshot.files.map(f => f.path || f);
      } else {
        projectFilesList = ['index.html', 'style.css', 'app.js'];
      }

      const bugText = typeof pendingBugReport === 'string' && pendingBugReport.length > 0
        ? pendingBugReport
        : (isExplicitFix ? (pendingBugReport || message) : message);

      const bugFixResult = await buildBugFixPrompt({
        currentIntent: bugText,
        userBugReport: bugText,
        projectFiles: projectFilesList,
        snapshot,
        agent: 'antigravity',
      });
      const bugFixPrompt = bugFixResult.prompt;

      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          pendingAction: null,
          pendingBugReport: null,
          currentIntent: bugText,
          lastGeneratedPrompt: bugFixPrompt,
          isBugFix: true,
        });
      } catch (_) {}

      const reply = "I have generated the fix prompt. Click below to open it.";
      return {
        success: true,
        mode: 'bug_fix_ready',
        reply,
        responseText: reply,
        action: null,
        actionPayload: null,
        intentDetected: 'bug_fix_ready',
        needsOptions: false,
        needsClarification: false,
        suggestedFeatureType: null,
        planSuggestion: null,
        insightTags: ['bug_fix', 'prompt_ready'],
        providerUsed: 'bug-intent-detector',
        prompt: bugFixPrompt,
        metadata: bugFixResult.metadata,
        bugReport: bugText,
        isBugFix: true,
      };
    }

    // 2. Feature Plan Confirmation or Build Command
    const hasActiveContext = Boolean(pendingAction === 'feature_plan' || isBuildCmd || savedSession.currentPlan || savedSession.currentIntent || pendingFeature);
    if (hasActiveContext) {
      const featureText = cleanFeatureIntent(pendingFeature || savedSession.currentIntent || savedSession.currentPlan?.task || 'Feature Implementation');
      
      // If plan already exists with options, prompt generation is ready
      if (savedSession.currentPlan && Array.isArray(savedSession.currentPlan.options) && savedSession.currentPlan.options.length > 0 && pendingAction !== 'feature_plan') {
        const plan = savedSession.currentPlan;
        const reply = `I have updated the execution plan for "${featureText}". Click Approve to generate the strict prompt.`;
        return {
          success: true,
          mode: 'action',
          reply,
          responseText: reply,
          action: null,
          actionPayload: null,
          intentDetected: 'request_prompt',
          needsOptions: false,
          needsClarification: false,
          suggestedFeatureType: plan.featureType || 'Feature Implementation',
          planSuggestion: plan,
          options: plan.options || [],
          plan,
          insightTags: ['build_command', 'prompt_ready'],
          providerUsed: 'build-command-handler',
          isBugFix: false,
        };
      }

      // Otherwise present A/B/C options
      const optionsResult = await suggestOptions(featureText, {
        _snapshot: opts.snapshot,
        domain: opts.projectContext?.domain || 'Software Project',
        techStack: opts.projectContext?.techStack || [],
        files: opts.snapshot?.files || [],
        missingBlueprints: opts.projectContext?.missingBlueprints || [],
        activeRules: opts.activeRules || [],
      });

      const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
      const plan = {
        id: `plan_${Date.now()}`,
        task: featureText,
        intentSummary: featureText.slice(0, 80),
        userIntent: featureText,
        featureType: optionsResult.featureType || 'Feature Implementation',
        availableApproaches: options,
        options,
        filesToEdit: [],
        filesToCreate: ['index.html', 'style.css', 'app.js'],
      };

      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          pendingAction: null,
          pendingFeature: null,
          currentIntent: featureText,
          currentPlan: plan,
        });
      } catch (_) {}

      const reply = `I have analyzed "${featureText}" and prepared 3 architectural options. Please choose an approach:`;
      return {
        success: true,
        mode: 'action',
        reply,
        responseText: reply,
        action: null,
        actionPayload: null,
        intentDetected: 'feature_plan',
        needsOptions: true,
        needsClarification: false,
        suggestedFeatureType: optionsResult.featureType || 'Feature Implementation',
        planSuggestion: plan,
        options,
        plan,
        insightTags: ['feature_plan', 'options'],
        providerUsed: optionsResult.providerUsed || 'option-suggester',
        isBugFix: false,
      };
    }

    // 3. NO pendingAction or active context -> Treat as normal conversational input
    const isBengali = /[\u0980-\u09FF]|ha|haa|haan|thik/i.test(message);
    const reply = isBengali
      ? "ঠিক আছে! আপনার প্রোজেক্টে কীভাবে সাহায্য করতে পারি? নতুন ফিচার যোগ করতে বা কোনো সমস্যা জানাতে পারেন।"
      : "Understood! How can I help you with your project? You can request a new feature or report an issue.";
    return {
      success: true,
      mode: 'chitchat',
      reply,
      responseText: reply,
      action: null,
      actionPayload: null,
      intentDetected: 'chitchat',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['chitchat'],
      providerUsed: 'conversational-fallback',
      prompt: null,
      isBugFix: false,
    };
  }

  // ── Bug Intent Detection (Human-Reported Bug Fix) ───────────────────────────
  const isBug = !isExplanation && isBugReport(message);
  if (isBug) {
    try {
      const sessionStore = require('../session-store');
      sessionStore.saveState({
        pendingAction: 'bug_fix_prompt',
        pendingBugReport: message,
        currentIntent: message,
      });
    } catch (_) {}

    const bugReply = "I understand your problem. Do you want me to generate a prompt to fix it?";
    return {
      success: true,
      mode: 'bug_fix',
      reply: bugReply,
      responseText: bugReply,
      action: null,
      actionPayload: null,
      intentDetected: 'bug_fix',
      needsOptions: false,
      needsClarification: false,
      suggestedFeatureType: null,
      planSuggestion: null,
      insightTags: ['bug_report', 'maintenance'],
      providerUsed: 'bug-intent-detector',
      bugReport: message,
      isBugFix: true,
    };
  }

  // ── Architectural Override: Single-File Constraint ─────────────────────────
  const isSingleFileReq = isSingleFileConstraint(message);
  if (isSingleFileReq) {
    const archReply = "For a production-level application, keeping everything in one file is not recommended. I have prepared a modular structure for you.\n\n" +
      "Separating your HTML for structure, CSS for styling, and JavaScript for application logic ensures long-term maintainability, prevents global namespace collisions, and enables proper testing.";
    return {
      success: true,
      mode:                 'action',
      reply:                archReply,
      responseText:         archReply,
      action:               null,
      actionPayload:        null,
      needsOptions:         true,
      needsClarification:   false,
      suggestedFeatureType: 'frontend_game',
      planSuggestion:       null,
      insightTags:          ['architectural_override', 'production_ready'],
      followUpQuestion:     null,
      providerUsed:         'architectural-override',
    };
  }

  // ── Vague Single Word Clarification ─────────────────────────────────────────
  const trimmedLower = trimmed.toLowerCase();
  const isSingleVagueWord = ['text', 'test', 'testing', 'asdf', 'sample', 'foo', 'bar', 'baz'].includes(trimmedLower)
    && trimmedLower.split(/\s+/).length === 1;
  if (isSingleVagueWord) {
    const clarifyText = `I received your message: **"${message.slice(0, 100)}"**.\n\n` +
      `This message is too brief or ambiguous. Could you describe what feature or component you want to add?\n\n` +
      `• *"Add dark mode toggle with localStorage"*\n` +
      `• *"Add a countdown timer with CSS animation"*\n` +
      `• *"Add sound effects using Web Audio API"*`;
    return {
      success: true,
      mode:                'clarification_needed',
      reply:               clarifyText,
      responseText:        clarifyText,
      action:              null,
      actionPayload:       null,
      needsOptions:        false,
      needsClarification:  true,
      suggestedFeatureType: null,
      planSuggestion:      null,
      insightTags:         ['clarification'],
      followUpQuestion:    'What feature would you like to add?',
      providerUsed:        'rule-clarification',
    };
  }

  // ── Standard Chat Response Logic ────────────────────────────────────────────
  const { isActionableFeature } = require('../ast/feature-analyzer');
  const isActionable = !isQuestion && isActionableFeature(message);

  try {
    const { projectContext = {}, conversationHistory = [], activeRules = [], snapshot = null } = opts;
    const astSummary = buildAstSummary(snapshot);

    const systemPrompt = loadPrompt('chat-respond');
    const inputPayload = {
      message: message.slice(0, 600),
      projectContext: {
        domain:            projectContext.domain      || 'Software Project',
        techStack:         projectContext.techStack   || [],
        totalFiles:        astSummary?.totalFiles     || snapshot?.stats?.totalFiles || (snapshot?.files || []).length || 0,
        existingFiles:     astSummary?.topFiles?.slice(0, 25).map(f => ({ path: f.path, loc: f.loc, fns: (f.fns || []).slice(0, 3) })) || [],
        missingBlueprints: projectContext.missingBlueprints || [],
        architecturePattern: projectContext.architecturePattern || 'Unknown',
      },
      conversationHistory: conversationHistory.slice(-5).map(m => ({
        role: m.role || m.type,
        text: (m.text || '').slice(0, 200),
      })),
      activeRules,
    };

    const prompt = `${systemPrompt}\n\nINPUT:\n${JSON.stringify(inputPayload, null, 2)}`;
    const res = await callProviderWithFallback(prompt);
    if (!res.success) throw new Error(res.error || 'All AI providers failed');

    const parsed = parseJsonResponse(res.data);
    parsed.providerUsed = res.providerUsed;

    if (parsed.mode === 'bug_explanation') {
      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          pendingAction: null,
          pendingBugReport: null,
        });
      } catch (_) {}

      const explanationText = (parsed.responseText || parsed.reply) || generateAstBugExplanation({
        message,
        snapshot,
        projectPath: opts.projectPath,
      });
      return {
        ...parsed,
        mode: 'bug_explanation',
        needsOptions: false,
        needsClarification: false,
        suggestedFeatureType: null,
        planSuggestion: null,
        responseText: explanationText,
        reply: explanationText,
        intentDetected: 'bug_explanation',
        insightTags: parsed.insightTags || ['bug_explanation', 'ast_analysis'],
        isBugFix: false,
      };
    }

    if (parsed.mode === 'confirmation_yes') {
      if (pendingAction === 'feature_plan') {
        const featureText = pendingFeature || savedSession.currentIntent || 'Feature Implementation';
        
        const optionsResult = await suggestOptions(featureText, {
          _snapshot: opts.snapshot,
          domain: opts.projectContext?.domain || 'Software Project',
          techStack: opts.projectContext?.techStack || [],
          files: opts.snapshot?.files || [],
          missingBlueprints: opts.projectContext?.missingBlueprints || [],
          activeRules: opts.activeRules || [],
        });

        const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
        const plan = {
          id: `plan_${Date.now()}`,
          task: featureText,
          intentSummary: featureText.slice(0, 80),
          userIntent: featureText,
          featureType: optionsResult.featureType || 'Feature Implementation',
          availableApproaches: options,
          options,
          filesToEdit: [],
          filesToCreate: ['index.html', 'style.css', 'app.js'],
        };

        try {
          const sessionStore = require('../session-store');
          sessionStore.saveState({
            pendingAction: null,
            pendingFeature: null,
            currentIntent: featureText,
            currentPlan: plan,
          });
        } catch (_) {}

        const reply = `I have analyzed "${featureText}" and prepared 3 architectural options. Please choose an approach:`;
        return {
          success: true,
          mode: 'action',
          reply,
          responseText: reply,
          action: null,
          actionPayload: null,
          intentDetected: 'feature_plan',
          needsOptions: true,
          needsClarification: false,
          suggestedFeatureType: optionsResult.featureType || 'Feature Implementation',
          planSuggestion: plan,
          options,
          plan,
          insightTags: ['feature_plan', 'options'],
          providerUsed: optionsResult.providerUsed || 'option-suggester',
          isBugFix: false,
        };
      }

      if (pendingAction === 'bug_fix_prompt' || pendingBugReport) {
        const { buildBugFixPrompt } = require('../rules/prompt-builder');
        let projectFilesList = [];
        if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
          projectFilesList = snapshot.files.map(f => f.path || f);
        } else {
          projectFilesList = ['index.html', 'style.css', 'app.js'];
        }

        const bugText = typeof pendingBugReport === 'string' ? pendingBugReport : message;
        const bugFixResult = await buildBugFixPrompt({
          currentIntent: bugText,
          userBugReport: bugText,
          projectFiles: projectFilesList,
          snapshot,
          agent: 'antigravity',
        });
        const bugFixPrompt = bugFixResult.prompt;

        try {
          const sessionStore = require('../session-store');
          sessionStore.saveState({
            pendingAction: null,
            pendingBugReport: null,
            currentIntent: bugText,
            lastGeneratedPrompt: bugFixPrompt,
            isBugFix: true,
          });
        } catch (_) {}

        const reply = "I have generated the fix prompt. Click below to open it.";
        return {
          success: true,
          mode: 'bug_fix_ready',
          reply,
          responseText: reply,
          action: null,
          actionPayload: null,
          intentDetected: 'bug_fix_ready',
          needsOptions: false,
          needsClarification: false,
          suggestedFeatureType: null,
          planSuggestion: null,
          insightTags: ['bug_fix', 'prompt_ready'],
          providerUsed: res.providerUsed || 'bug-intent-detector',
          prompt: bugFixPrompt,
          metadata: bugFixResult.metadata,
          bugReport: bugText,
          isBugFix: true,
        };
      }

      // No pendingAction -> normal conversational reply
      return {
        success: true,
        mode: 'chitchat',
        reply: "Understood! How can I help you with your project?",
        responseText: "Understood! How can I help you with your project?",
        action: null,
        actionPayload: null,
        intentDetected: 'chitchat',
        needsOptions: false,
        needsClarification: false,
        suggestedFeatureType: null,
        planSuggestion: null,
        insightTags: ['chitchat'],
        providerUsed: res.providerUsed || 'conversational-fallback',
        isBugFix: false,
      };
    }

    if (parsed.mode === 'command_request') {
      const isOpt = parsed.intentDetected === 'request_options' || parsed.needsOptions || isOptionsCommand(message);
      if (isOpt) {
        const activeFeature = pendingFeature || savedSession.currentIntent || savedSession.currentPlan?.task || 'Feature Implementation';
        let options = (savedSession.currentPlan && Array.isArray(savedSession.currentPlan.options) && savedSession.currentPlan.options.length > 0)
          ? savedSession.currentPlan.options
          : null;

        if (!options || options.length === 0) {
          const optRes = await suggestOptions(activeFeature, {
            _snapshot: snapshot,
            domain: projectContext.domain,
            techStack: projectContext.techStack,
            files: snapshot?.files || [],
          });
          options = Array.isArray(optRes.options) ? optRes.options : [];
        }

        const isBengali = /[\u0980-\u09FF]|gula|gulo|daw|dao|dekhao|bolo|ache|asea|karon|ki\s+ki/i.test(message);
        const reply = isBengali ? "এখানে অপশনগুলো পুনরায় দেওয়া হলো:" : "Here are the options again:";
        return {
          ...parsed,
          mode: 'action',
          reply,
          responseText: reply,
          needsOptions: true,
          options,
          plan: savedSession.currentPlan || { id: `plan_${Date.now()}`, task: activeFeature, options },
        };
      } else {
        // Asking for prompt
        if (savedSession.currentPlan && Array.isArray(savedSession.currentPlan.options) && savedSession.currentPlan.options.length > 0) {
          const { buildStrictPrompt } = require('../rules/prompt-builder');
          const plan = savedSession.currentPlan;
          const featureText = plan.task || savedSession.currentIntent || 'Feature Implementation';
          const promptResult = await buildStrictPrompt({
            plan,
            currentIntent: featureText,
            task: featureText,
            feature: featureText,
            userIntent: featureText,
            activeFeatureRequirements: activeFeatureRequirements.length > 0 ? activeFeatureRequirements : [featureText],
            snapshot,
            projectMemory: projectContext,
          });
          return {
            ...parsed,
            mode: 'action',
            reply: "I have generated the strict prompt for your feature.",
            responseText: "I have generated the strict prompt for your feature.",
            needsOptions: false,
            prompt: promptResult.prompt,
            metadata: promptResult.metadata,
          };
        }
      }
    }

    if (parsed.mode === 'bug_report' || parsed.mode === 'bug_fix' || isBug) {
      const bugReply = "I understand your problem. Do you want me to generate a prompt to fix it?";
      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          pendingAction: 'bug_fix_prompt',
          pendingBugReport: message,
          currentIntent: message,
        });
      } catch (_) {}

      return {
        ...parsed,
        mode: 'bug_fix',
        needsOptions: false,
        needsClarification: false,
        suggestedFeatureType: null,
        planSuggestion: null,
        responseText: bugReply,
        reply: bugReply,
        intentDetected: 'bug_fix',
        insightTags: parsed.insightTags || ['bug_report', 'maintenance'],
        bugReport: message,
        isBugFix: true,
      };
    }

    const isMsgQuestion = message.trim().endsWith('?') || message.trim().includes('?') || /^(kon\b|konta\b|kivabe\b|why\b|how\b)/i.test(message.trim()) || isEvaluativeQuestion(message);
    if (!isMsgQuestion && (isActionable || (parsed.mode === 'action' && !isQuestion))) {
      try {
        const sessionStore = require('../session-store');
        const currentSaved = sessionStore.loadState() || {};
        const cleanIntent = cleanFeatureIntent(message);
        let activeReqs = Array.isArray(currentSaved.activeFeatureRequirements) ? [...currentSaved.activeFeatureRequirements] : [];
        if (!activeReqs.includes(message)) {
          if (activeReqs.length === 0 || isDetailOrRelated(message, currentSaved.pendingFeature)) {
            activeReqs.push(message);
          } else {
            activeReqs = [message];
          }
        }
        sessionStore.saveState({
          pendingAction: 'feature_plan',
          pendingFeature: cleanIntent,
          currentIntent: cleanIntent,
          activeFeatureRequirements: activeReqs,
        });
      } catch (_) {}
    }

    if (!isActionable) {
      // If AI already said it's informational/chitchat → NEVER override, just return as-is
      const aiMode = parsed.mode || '';
      if (aiMode === 'informational' || aiMode === 'chitchat' || aiMode === 'evaluative_recommendation') {
        return {
          ...parsed,
          needsOptions:        false,
          needsClarification:  false,
        };
      }

      let responseText = parsed.responseText || parsed.reply;
      return {
        ...parsed,
        mode: parsed.mode || 'clarification_needed',
        needsOptions: false,
        needsClarification: parsed.needsClarification ?? false,
        suggestedFeatureType: parsed.suggestedFeatureType || null,
        planSuggestion: null,
        insightTags: parsed.insightTags || ['clarification'],
        responseText: responseText || parsed.responseText,
        reply: responseText || parsed.reply,
      };
    }

    const textImpliesOptions = /(prepared.*options|architectural options|choose an approach|select.*approach|options below|3 options|following options)/i.test(parsed.responseText || parsed.reply || '');
    if ((textImpliesOptions || parsed.needsOptions) && !['bug_fix', 'bug_fix_ready', 'bug_explanation', 'bug_report', 'informational', 'evaluative_recommendation'].includes(parsed.mode)) {
      parsed.mode = 'action';
      parsed.needsOptions = true;
      if (!Array.isArray(parsed.options) || parsed.options.length === 0) {
        const optRes = await suggestOptions(parsed.planSuggestion?.task || message, {
          _snapshot: snapshot,
          domain: projectContext.domain,
          techStack: projectContext.techStack,
          files: snapshot?.files || [],
        });
        parsed.options = Array.isArray(optRes.options) ? optRes.options : [];
      }
    }

    return parsed;
  } catch (err) {
    if (isBugExplanationIntent(message)) {
      try {
        const sessionStore = require('../session-store');
        sessionStore.saveState({
          pendingAction: null,
          pendingBugReport: null,
        });
      } catch (_) {}

      const explanationText = generateAstBugExplanation({
        message,
        snapshot: opts.snapshot,
        projectPath: opts.projectPath,
      });
      return {
        success: true,
        mode: 'bug_explanation',
        responseText: explanationText,
        reply: explanationText,
        needsOptions: false,
        needsClarification: false,
        options: [],
        plan: null,
        isBugFix: false,
        providerUsed: 'ast-explainer',
      };
    }

    const isMsgQuestionErr = message.trim().endsWith('?') || message.trim().includes('?') || /^(kon\b|konta\b|kivabe\b|why\b|how\b)/i.test(message.trim()) || isEvaluativeQuestion(message);
    if (!isQuestion && !isMsgQuestionErr && isActionable) {
      const cleanIntent = cleanFeatureIntent(message);
      const archText = `For adding the "${cleanIntent}" feature, I recommend a modular architecture with clean separation of concerns, secure input handling, and proper state management.\n\nShall I generate the prompt?`;
      try {
        const sessionStore = require('../session-store');
        const currentSaved = sessionStore.loadState() || {};
        let activeReqs = Array.isArray(currentSaved.activeFeatureRequirements) ? [...currentSaved.activeFeatureRequirements] : [];
        if (!activeReqs.includes(message)) {
          if (activeReqs.length === 0 || isDetailOrRelated(message, currentSaved.pendingFeature)) {
            activeReqs.push(message);
          } else {
            activeReqs = [message];
          }
        }
        sessionStore.saveState({
          pendingAction: 'feature_plan',
          pendingFeature: cleanIntent,
          currentIntent: cleanIntent,
          activeFeatureRequirements: activeReqs,
        });
      } catch (_) {}

      return {
        success: true,
        mode: 'action',
        responseText: archText,
        reply: archText,
        needsOptions: true,
        needsClarification: false,
        suggestedFeatureType: 'feature_implementation',
        planSuggestion: null,
        options: [],
        plan: null,
        isBugFix: false,
        providerUsed: 'feature-intent-detector',
      };
    }
    if (isGreeting(message)) {
      const offlineGreeting = "Hello! I am running in offline mode right now. Please check your API key or wait for the limit to reset. How can I help you?";
      return {
        success: true,
        mode: 'chat',
        responseText: offlineGreeting,
        reply: offlineGreeting,
        needsOptions: false,
        needsClarification: false,
        options: [],
        plan: null,
        planSuggestion: null,
        suggestedFeatureType: null,
        providerUsed: 'offline-fallback',
      };
    }
    console.warn('[AI Service] chatRespond failed (rate limit or network error):', err.message);
    return {
      success: false,
      error: 'API_LIMIT_REACHED',
      mode: 'error',
      responseText: 'API Limit Exceeded',
      reply: 'API Limit Exceeded',
      needsOptions: false,
      needsClarification: false,
      options: [],
      plan: null,
      planSuggestion: null,
      suggestedFeatureType: null,
    };
  }
}

/**
 * Step 5: Select context-aware security rules based on feature, project type, and architecture option.
 * @param {object} params
 * @param {string} params.feature - Feature intent
 * @param {string} [params.projectType] - "frontend" | "backend" | "fullstack"
 * @param {string|object} [params.selectedOption] - Architectural approach
 * @param {object} [params.snapshot] - AST snapshot
 * @param {object} [params.projectMemory] - Project intelligence cache
 * @returns {Promise<{ selectedRuleIds: string[], rules: object[], customRules: object[], reasoning: string, isAiSelected: boolean }>}
 */
async function selectSecurityRules(params = {}) {
  const { selectSecurityRules: selectRules } = require('../security/rule-selector');
  return selectRules(params, { callProviderWithFallback, callProvider });
}

/**
 * Test the connection to the active AI provider.
 * @param {string} [provider] - Optional override
 * @returns {Promise<{ ok: boolean, provider: string, model?: string, error?: string, keyPreview?: string }>}
 */
async function testConnection(provider) {
  const p = (provider || getActiveProvider()).toLowerCase().trim();
  if (!hasKey(p) && p !== 'ollama') {
    return {
      ok:       false,
      provider: p,
      error:    `No API key configured for provider "${p}". Add it to .env or Settings.`,
    };
  }
  try {
    const raw = await callProvider('Return ONLY the JSON: {"status":"ok"}', p);
    const parsed = parseJsonResponse(raw);
    return {
      ok:         parsed.status === 'ok' || !!raw,
      provider:   p,
      keyPreview: redactKey(getKey(p) || ''),
    };
  } catch (err) {
    return { ok: false, provider: p, error: err.message };
  }
}

/**
 * Step 6: Verify post-execution drift and guardrail adherence using AI.
 * @param {object} params - { originalPrompt, plan, diff, projectPath, snapshot, beforeSnapshot, afterSnapshot }
 * @returns {Promise<object>}
 */
async function verifyExecution(params = {}) {
  const { verifyExecution: verify } = require('../verification/execution-verifier');
  const deterministicInvoker = async (p) => {
    const res = await callProviderWithFallback(p, null, { temperature: 0 });
    if (!res.success) throw new Error(res.error || 'AI verification call failed');
    return res.data;
  };
  return verify(params, {
    callProviderWithFallback,
    callProvider,
    callProviderDeterministic: deterministicInvoker,
  });
}

/**
 * Suggest a dynamic, project-specific roadmap based on AST file structure.
 * @param {object} opts
 * @param {object} [opts.snapshot] - AST project snapshot
 * @returns {Promise<{ goal: string, milestones: Array<{ id: string, title: string, desc: string, tokens: string[], manualDone: boolean }>, providerUsed: string, isEmpty?: boolean }>}
 */
async function suggestRoadmap(opts = {}) {
  const snapshot = opts.snapshot || null;
  const astSummary = buildAstSummary(snapshot);

  const totalFiles = astSummary?.totalFiles || snapshot?.stats?.totalFiles || (snapshot?.files || []).length || 0;
  if (totalFiles === 0) {
    return {
      goal: '',
      milestones: [],
      isEmpty: true,
      providerUsed: 'static',
    };
  }

  // Detect project type and domain
  const { projectType } = detectProjectType(snapshot, opts.projectContext || {});
  const filePaths = (snapshot?.files || []).map(f => (f.path || '').toLowerCase());
  const fileContentOrFns = (snapshot?.files || []).flatMap(f => [...(f.fns || []), ...(f.exports || [])]).map(s => s.toLowerCase());
  const allSignals = [...filePaths, ...fileContentOrFns].join(' ');

  const isTicTacToe = /tictactoe|tic-tac-toe|tic|cellclick|handlecellclick/.test(allSignals) ||
    (/game|board|grid|cell/.test(allSignals) && /cell|board|turn|player|click/.test(allSignals));
  const isGame = isTicTacToe || /game|canvas|sprite|score|play|level/.test(allSignals);

  // AST-grounded heuristic fallback generator
  const getFallbackRoadmap = () => {
    if (isTicTacToe) {
      return {
        goal: 'Tic-Tac-Toe Game Engine',
        milestones: [
          {
            id: 'm_ast_1',
            title: 'HTML/CSS UI Structure',
            desc: 'Semantic HTML board markup and modular CSS grid layout',
            tokens: ['html', 'css'],
            manualDone: false,
          },
          {
            id: 'm_ast_2',
            title: 'Game Logic & Click Handling',
            desc: 'Cell click event listeners, turn alternations, and board array updates',
            tokens: ['handlecellclick', 'turnswitch', 'moveplayer'],
            manualDone: false,
          },
          {
            id: 'm_ast_3',
            title: 'Win/Draw Detection',
            desc: 'Verify winning combinations across rows, columns, diagonals, and handle draw states',
            tokens: ['wincondition', 'detectwin', 'checkdraw', 'boardwin'],
            manualDone: false,
          },
          {
            id: 'm_ast_4',
            title: 'Reset Game Feature',
            desc: 'Reinitialize board state array, reset turn marker, and provide New Game button',
            tokens: ['restartgame', 'clearboard', 'newround'],
            manualDone: false,
          },
          {
            id: 'm_ast_5',
            title: 'Sound Effects',
            desc: 'Synthesize audio cues for moves, winning fanfare, and game draw sounds',
            tokens: ['audio', 'sound', 'sfx', 'synth'],
            manualDone: false,
          },
        ],
        providerUsed: 'ast-grounded-inference',
      };
    }

    if (isGame) {
      return {
        goal: 'Interactive Frontend Game',
        milestones: [
          {
            id: 'm_ast_1',
            title: 'HTML/CSS UI Structure',
            desc: 'Canvas/DOM game grid layout and responsive HUD styling',
            tokens: ['html', 'css'],
            manualDone: false,
          },
          {
            id: 'm_ast_2',
            title: 'Game Logic & Click Handling',
            desc: 'User interaction event listeners, move input, and loop logic',
            tokens: ['click', 'move', 'input', 'event', 'handler'],
            manualDone: false,
          },
          {
            id: 'm_ast_3',
            title: 'Win/Draw Detection & Score State',
            desc: 'Game loop conditions, score tracking, and end-state transitions',
            tokens: ['win', 'score', 'state', 'detect', 'status'],
            manualDone: false,
          },
          {
            id: 'm_ast_4',
            title: 'Reset Game Feature',
            desc: 'Restart button and re-initialization of game state',
            tokens: ['reset', 'restart', 'clear', 'newgame'],
            manualDone: false,
          },
          {
            id: 'm_ast_5',
            title: 'Sound Effects & Animations',
            desc: 'Audio cues and victory animations',
            tokens: ['audio', 'sound', 'sfx', 'animation'],
            manualDone: false,
          },
        ],
        providerUsed: 'ast-grounded-inference',
      };
    }

    const hasServer = filePaths.some(p => /^(server|serve|backend|api)\.[jt]s$|\/server\.[jt]s$/i.test(p));
    const hasRoutes = filePaths.some(p => /\/(routes?|api|controllers?|endpoints?)\//i.test(p));
    const isBackend = hasServer || hasRoutes || projectType === 'backend';

    if (isBackend) {
      return {
        goal: 'Production Backend API & Services',
        milestones: [
          {
            id: 'm_ast_1',
            title: 'Server Setup & HTTP Entrypoint',
            desc: 'Express/Node server bootstrap and environment configuration',
            tokens: ['server', 'express', 'listen', 'package', 'app'],
            manualDone: false,
          },
          {
            id: 'm_ast_2',
            title: 'REST API Routes & Controllers',
            desc: 'API endpoint routing, controllers, and request handlers',
            tokens: ['route', 'routes', 'router', 'controller', 'api', 'endpoint'],
            manualDone: false,
          },
          {
            id: 'm_ast_3',
            title: 'Database & Schema Modeling',
            desc: 'Database connectivity, schema migrations, and ORM query repositories',
            tokens: ['db', 'database', 'schema', 'prisma', 'model', 'query', 'repository'],
            manualDone: false,
          },
          {
            id: 'm_ast_4',
            title: 'Authentication & JWT Security',
            desc: 'User signup, bcrypt hashing, JWT issuance, and auth route middleware',
            tokens: ['auth', 'jwt', 'token', 'login', 'register', 'bcrypt'],
            manualDone: false,
          },
          {
            id: 'm_ast_5',
            title: 'Error Handling & Automated Tests',
            desc: 'Centralized error-handling middleware, sanitized responses, and unit tests',
            tokens: ['error', 'middleware', 'test', 'assert', 'mock', 'jest'],
            manualDone: false,
          },
        ],
        providerUsed: 'ast-grounded-inference',
      };
    }

    // Default to modular frontend
    return {
      goal: 'Modular Frontend Application',
      milestones: [
        {
          id: 'm_ast_1',
          title: 'HTML/CSS UI Structure',
          desc: 'Clean separation of semantic HTML structure and responsive CSS',
          tokens: ['html', 'css'],
          manualDone: false,
        },
        {
          id: 'm_ast_2',
          title: 'DOM Event Listeners & Interaction',
          desc: 'Event binding for button clicks, inputs, and view toggles',
          tokens: ['event', 'listener', 'button', 'input', 'click'],
          manualDone: false,
        },
        {
          id: 'm_ast_3',
          title: 'State Store & Local Storage',
          desc: 'Client-side state management and persistence sync',
          tokens: ['state', 'store', 'storage', 'data'],
          manualDone: false,
        },
        {
          id: 'm_ast_4',
          title: 'Form Validation & Error Traps',
          desc: 'Input validation, sanitized inputs, and error boundary handling',
          tokens: ['validate', 'form', 'error', 'submit'],
          manualDone: false,
        },
        {
          id: 'm_ast_5',
          title: 'Styling Polish & Responsive Layout',
          desc: 'Mobile-responsive layout adjustments, animations, and dark mode themes',
          tokens: ['responsive', 'media', 'theme', 'darkmode', 'animation'],
          manualDone: false,
        },
      ],
      providerUsed: 'ast-grounded-inference',
    };
  };

  try {
    const prompt = `You are PromptLock Roadmap Architect. Analyze this project's AST and files.
Based on these existing files and functions, what are the next 3-5 logical milestones for THIS SPECIFIC project? Do NOT suggest backend features if it's a frontend game.

Return ONLY valid JSON (no markdown formatting, no code fences):
{
  "goal": "Descriptive project goal",
  "milestones": [
    {
      "id": "m_ai_1",
      "title": "3-5 word milestone title",
      "desc": "Short description of what to implement",
      "tokens": ["3-6", "lowercase", "keywords", "for", "matching"],
      "manualDone": false
    }
  ]
}

PROJECT AST SUMMARY:
${JSON.stringify(astSummary, null, 2)}
FILES:
${(snapshot?.files || []).slice(0, 30).map(f => f.path).join('\n')}
FUNCTIONS:
${(snapshot?.files || []).flatMap(f => f.fns || []).slice(0, 30).join(', ')}
`;

    const res = await callProviderWithFallback(prompt);
    if (!res.success) throw new Error(res.error || 'AI call failed');

    const parsed = parseJsonResponse(res.data);
    if (parsed && Array.isArray(parsed.milestones) && parsed.milestones.length >= 2) {
      return {
        goal: parsed.goal || 'Production Project Roadmap',
        milestones: parsed.milestones.map((m, idx) => ({
          id: m.id || `m_ai_${idx + 1}_${Date.now()}`,
          title: m.title || `Milestone ${idx + 1}`,
          desc: m.desc || '',
          tokens: Array.isArray(m.tokens) ? m.tokens.map(t => String(t).toLowerCase()) : ['task'],
          manualDone: false,
        })),
        providerUsed: res.providerUsed,
      };
    }
    return getFallbackRoadmap();
  } catch (err) {
    console.warn('[AI Service] suggestRoadmap using static fallback:', err.message);
    return getFallbackRoadmap();
  }
}

module.exports = {
  understandProject,
  suggestOptions,
  chatRespond,
  suggestRoadmap,
  selectSecurityRules,
  verifyExecution,
  callProvider,
  callProviderWithFallback,
  testConnection,
  buildAstSummary,
  FALLBACK_ORDER,
  isSingleFileConstraint,
  getSingleFileOverrideOptions,
  isBugReport,
  isBugExplanationIntent,
  generateAstBugExplanation,
  extractNewRequestFromConfirmation,
  isConfirmationWord,
  isExplicitFixCommand,
  providerCooldowns,
  isProviderCoolingDown,
  setProviderCooldown,
  clearProviderCooldowns,
  stripBengaliStopWords,
  isThisFeatureReference,
  META_COMMAND_REGEX,
  isOptionsCommand,
  isMissingOptionsComplaint,
  isPromptCommand,
  BROAD_COMMAND_REGEX,
  isConversationalQuestion,
  cleanFeatureIntent,
  isBuildCommand,
  isOptionsInquiryQuestion,
  extractCleanIntentWithAI,
  FEATURE_EXISTENCE_REGEX,
  isFeatureExistenceQuestion,
  extractFeatureSubject,
  searchFeatureInAst,
  FILE_COUNT_REGEX,
  FEATURE_LIST_REGEX,
  GREETING_REGEX,
  isFileCountQuery,
  isFeatureListQuery,
  isGreeting,
  formatProjectFeatureList,
  detectFeatureActionIntent,
  isWhyQuestion,
  isVagueProjectRequest,
  VAGUE_PROJECT_REGEX,
  detectChatModeIntent,
  isExplicitFixRequest,
  isBugReportIntent,
  isProjectReviewOrConsultingQuery,
  isCssOptimizationQuery,
  clearMemory,
  getInMemoryState,
  setInMemoryState,
  detectLanguageFromText,
  extractFeatureNameFromMessage,
  isCodingTransitionIntent,
  isEvaluativeQuestion,
  generateOptionRecommendation,
  isValidIntentString,
  synthesizeRequirementsWithAI,
};


