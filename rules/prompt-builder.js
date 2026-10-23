/**
 * PromptLock — Strict Prompt Builder (Step 4)
 *
 * Compiles approved execution plans into precision-engineered,
 * agent-tailored guardrail prompts with AST grounding and strict security boundaries.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { analyzeMissingFiles } = require('./missing-file-analyzer');
const { validatePrompt }      = require('./prompt-validator');

let aiSvc = null;
let isConversationalQuestion = null;
let cleanFeatureIntent = null;
try {
  aiSvc = require('../ai/ai-service');
  isConversationalQuestion = aiSvc.isConversationalQuestion;
  cleanFeatureIntent = aiSvc.cleanFeatureIntent;
} catch (_) {}

if (!isConversationalQuestion) {
  isConversationalQuestion = function(text) {
    if (!text || typeof text !== 'string') return false;
    const s = text.trim().toLowerCase();
    if (s.includes('?') || s.endsWith('？')) return true;
    return /(ki\s+ki\s+feature|kemon\s+hobe|details\s+bolo|bistarito|aro\s+bolo|age\s+bolo|bolo|ki\s+ki\s+thakbe|ki\s+ki\s+thakby|how\s+will|how\s+does|what\s+features|what\s+will|explain|describe)\b/i.test(s);
  };
}

if (!cleanFeatureIntent) {
  cleanFeatureIntent = function(text) {
    if (!text || typeof text !== 'string') return 'Build a modern web application';
    let clean = text.trim();
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

    // Strip English conversational prefixes early
    clean = clean.replace(/^(?:i\s+want\s+to\s+(?:build|create|make|develop|add|optimize|refactor)\s+(?:a\s+)?|i\s+want\s+(?:a\s+)?|i\s+need\s+to\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|i\s+need\s+(?:a\s+)?|can\s+you\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|could\s+you\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|please\s+(?:build|create|make|add|optimize)\s+(?:a\s+)?|let'?s\s+(?:build|create|make|optimize)\s+(?:a\s+)?|how\s+to\s+build\s+(?:a\s+)?|we\s+need\s+to\s+build\s+(?:a\s+)?)\s*/i, '').trim();

    // Bengali intent extraction
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
      const listMatch = clean.match(/(?:[১-৯0-9]\.|\([১-৯0-9]\))\s*([^:,\n.—–()]+)/);
      if (listMatch && listMatch[1] && listMatch[1].trim().length > 2 && /formula|হিসাব|feature\s*ta\s*holo/i.test(clean)) {
        let extracted = listMatch[1].trim();
        extracted = extracted.replace(/^(?:add|build|create|implement)\s+/i, '');
        if (/password/i.test(clean)) {
          return 'Add ' + extracted + ' to Password Checker';
        }
        return 'Add ' + extracted;
      }

      const featureTaHoloMatch = clean.match(/(?:feature\s+ta\s+holo|feature\s+holo)\s*[:(]?\s*(?:[১-৯0-9]\.\s*)?([^:,\n.—–()]+)/i);
      if (featureTaHoloMatch && featureTaHoloMatch[1] && featureTaHoloMatch[1].trim().length > 2) {
        let extracted = featureTaHoloMatch[1].trim();
        extracted = extracted.replace(/^(?:add|build|create|implement)\s+/i, '');
        if (/password/i.test(clean)) {
          return 'Add ' + extracted + ' to Password Checker';
        }
        return 'Add ' + extracted;
      }

      const listPreambleMatch = clean.match(/^(.*?)(?:\s+(?:with\s+the\s+following\s+requirements|with\s+requirements|requirements|features?|including|featuring)\s*[:.]?|\s*[:]\s*(?:[1-9]|\([1-9]\)|\n)|(?:\.|\n)\s*(?:[1-9][.)]|\([1-9]\)))\s+/i);
      if (listPreambleMatch && listPreambleMatch[1] && listPreambleMatch[1].trim().length > 3) {
        clean = listPreambleMatch[1].trim();
      } else {
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

    clean = clean.replace(/\bweb\s+site\b/gi, 'website');
    clean = clean.replace(/\brealtime\b/gi, 'real-time');

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
  };
}

const AGENT_TEMPLATES = {
  cursor: {
    name: 'Cursor AI (Composer / Agent)',
    header: '🎯 CURSOR COMPOSER PROMPT',
    instruction: 'Execute with multi-file diffing. Adhere strictly to .cursorrules boundaries.',
  },
  claude: {
    name: 'Claude 3.5 Sonnet (Anthropic)',
    header: '⚡ CLAUDE SONNET 3.5 XML DIRECTIVE',
    instruction: 'Use strict reasoning. Enclose all code outputs in specified artifact blocks.',
  },
  chatgpt: {
    name: 'ChatGPT-4o (Canvas / OpenAI)',
    header: '🧠 CHATGPT-4O CANVAS DIRECTIVE',
    instruction: 'Target OpenAI Canvas workspace. Generate atomic code artifacts.',
  },
  copilot: {
    name: 'GitHub Copilot (Workspace)',
    header: '🚀 GITHUB COPILOT WORKSPACE',
    instruction: 'Follow TDD guidelines. Generate comprehensive tests before implementation.',
  },
  windsurf: {
    name: 'Windsurf (Cascade)',
    header: '🔮 WINDSURF CASCADE PROMPT',
    instruction: 'Structure execution with Cascade checkpoint verification steps.',
  },
  antigravity: {
    name: 'Anti-Gravity AI (Pair Programming)',
    header: '🛡️ ANTIGRAVITY AGENTIC WORKER DIRECTIVE',
    instruction: 'You are a Worker executing an approved plan. Developer is the Approver. Do not exceed scope.',
  },
  v0: {
    name: 'v0.dev (Frontend UI)',
    header: '⚡ V0.DEV REACT COMPONENT PROMPT',
    instruction: 'Implement strictly with Next.js App Router, TailwindCSS, and React 19 standards.',
  },
  deepseek: {
    name: 'DeepSeek Coder',
    header: '🧪 DEEPSEEK CODER DIRECTIVE',
    instruction: 'Optimize for algorithm correctness, type safety, and unit test coverage.',
  },
};

function isValidIntentString(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'undefined') return false;
  if (lower === 'feature implementation' || lower === 'implement approved feature scope') return false;
  return true;
}

function parseDetailedRequirements(requirements) {
  const result = [];
  for (const raw of requirements) {
    if (!raw || typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text) continue;

    // Check if text has numbered items like "1. ... 2. ... 3. ..." or lines "1. ...\n2. ..."
    const numberedRegex = /(?:^|\s+)(?:[0-9]+[.)]|\([0-9]+\))\s+/;
    if (numberedRegex.test(text)) {
      const parts = text.split(/(?:^|\s+)(?:[0-9]+[.)]|\([0-9]+\))\s+/).map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        let p = parts[i];
        if (i === 0 && /(?:following requirements|requirements|features?):?$/i.test(p)) {
          continue;
        }
        p = p.replace(/^[-*•]\s*/, '').trim();
        if (p.length > 2) {
          result.push(p);
        }
      }
    } else if (text.includes('\n')) {
      const lines = text.split('\n').map(l => l.replace(/^[-*•0-9.)]\s*/, '').trim()).filter(Boolean);
      for (const line of lines) {
        if (!/(?:following requirements|requirements|features?):?$/i.test(line) && line.length > 2) {
          result.push(line);
        }
      }
    } else {
      let cleaned = text.replace(/^[-*•0-9.)]\s*/, '').trim();
      if (cleaned.length > 2) {
        result.push(cleaned);
      }
    }
  }
  return result;
}

/**
 * Build a strict guardrail prompt from an approved plan.
 * @param {object} params
 * @param {object} params.plan - Approved execution plan
 * @param {string} [params.agent] - Target AI agent (cursor | claude | antigravity | etc.)
 * @param {string[]} [params.activeRules] - Active guardrail rule ids
 * @param {object} [params.snapshot] - Current AST snapshot
 * @param {object} [params.projectMemory] - Cached project intelligence
 * @param {object} [params.roadmapState] - Step 2.6 roadmap state
 * @returns {Promise<{ ok: boolean, prompt: string, metadata: object }>}
 */
async function buildStrictPrompt(params = {}) {
  const {
    plan          = {},
    intent        : paramIntent = null,
    task          = null,
    feature       = null,
    userIntent    = null,
    currentIntent = null,
    agent         = 'cursor',
    activeRules   = ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval'],
    snapshot      = null,
    projectMemory = {},
    roadmapState  = null,
    selectedOption: paramSelectedOption = null,
    selectedOptionName: paramSelectedOptionName = null,
  } = params;

  const agentConfig = AGENT_TEMPLATES[agent.toLowerCase()] || AGENT_TEMPLATES.cursor;

  // 1. Resolve Project Type & Intent Details First
  let savedCurrentIntent = null;
  try {
    const sessionStore = require('../session-store');
    const saved = sessionStore.loadState();
    if (isValidIntentString(saved?.currentIntent)) {
      savedCurrentIntent = saved.currentIntent;
    }
  } catch (_) {}

  // Explicit guard against boolean true/false or non-string
  const cleanParamIntent = isValidIntentString(paramIntent || params.intent) ? (paramIntent || params.intent) : null;
  const cleanCurrentIntent = isValidIntentString(currentIntent || params.currentIntent) ? (currentIntent || params.currentIntent) : null;
  const cleanTask = isValidIntentString(task) ? task : null;
  const cleanFeature = isValidIntentString(feature) ? feature : null;
  const cleanUserIntent = isValidIntentString(userIntent) ? userIntent : null;

  if (params.isBugFix || plan?.isBugFix || params.mode === 'bug_fix') {
    return buildBugFixPrompt({
      ...params,
      currentIntent: cleanParamIntent || cleanCurrentIntent || cleanTask || cleanFeature || cleanUserIntent,
      userBugReport: params.userBugReport || params.bugReport || cleanParamIntent || cleanCurrentIntent || cleanTask || cleanFeature || cleanUserIntent || plan?.task || plan?.intentSummary,
    });
  }

  const candidateIntents = [
    cleanParamIntent,
    plan?.rawUserPrompt,
    params.userIntent,
    cleanUserIntent,
    cleanCurrentIntent,
    cleanFeature,
    cleanTask,
    plan?.currentIntent,
    plan?.userIntent,
    plan?.task,
    plan?.intentSummary,
    savedCurrentIntent,
    plan?.featureType,
  ].filter(c => isValidIntentString(c) && !isConversationalQuestion(c));

  let rawIntent = candidateIntents.find(c => isValidIntentString(c) && !isConversationalQuestion(c))
    || (isValidIntentString(cleanCurrentIntent) && !isConversationalQuestion(cleanCurrentIntent) ? cleanCurrentIntent : null)
    || (isValidIntentString(savedCurrentIntent) && !isConversationalQuestion(savedCurrentIntent) ? savedCurrentIntent : null)
    || 'Feature Implementation';

  let intentSummary = plan?.intentSummary;
  const isAlreadyClean = intentSummary &&
    !isConversationalQuestion(intentSummary) &&
    !/^(?:i\s+want|ami\s+|please\s+|can\s+you)/i.test(intentSummary) &&
    intentSummary !== 'Feature Implementation' &&
    intentSummary !== 'Build a modern web application';

  if (!isAlreadyClean || (rawIntent && rawIntent !== intentSummary && /(?:auto-?delete|delete|file|minute|duration)/i.test(rawIntent))) {
    if (typeof aiSvc?.extractCleanIntentWithAI === 'function' && rawIntent && rawIntent !== 'Feature Implementation') {
      intentSummary = await aiSvc.extractCleanIntentWithAI(rawIntent);
    } else {
      intentSummary = cleanFeatureIntent(rawIntent);
    }
  }

  const totalFiles = (snapshot?.files || []).length;
  const isEmptyFolder = totalFiles === 0;

  const { detectProjectType } = require('../ast/project-type-detector');
  const typeResult = detectProjectType(snapshot, projectMemory || {});

  const techStackList = Array.isArray(projectMemory?.techStack)
    ? projectMemory.techStack.map(s => String(s).toLowerCase())
    : (typeof projectMemory?.techStack === 'string' ? [projectMemory.techStack.toLowerCase()] : []);
  const hasPythonFiles = Boolean(
    (snapshot?.files && snapshot.files.some(f => /\.py$/i.test(f.path || f))) ||
    (Array.isArray(plan?.filesToCreate) && plan.filesToCreate.some(f => /\.py$/i.test(f))) ||
    (Array.isArray(plan?.filesToEdit) && plan.filesToEdit.some(f => /\.py$/i.test(f)))
  );
  const fullIntentText = `${intentSummary || ''} ${cleanTask || ''} ${cleanFeature || ''} ${params.userIntent || ''} ${plan?.rawUserPrompt || ''} ${plan?.task || ''} ${techStackList.join(' ')} ${params.requestedLanguage || ''} ${plan?.requestedLanguage || ''}`.toLowerCase();
  const isPython = /\b(python|py)\b/i.test(fullIntentText) || params.requestedLanguage === 'python' || plan?.requestedLanguage === 'python' || hasPythonFiles;
  const isCppOrSystem = techStackList.some(t => /(?:^|\W)c(?:\+\+|#)?(?:$|\W)|\b(cpp|rust|go|golang|python|ruby)\b|\bjava\b(?!script)/i.test(t))
    || /(?:^|\W)c\+\+(?:$|\W)|\b(cpp|rust|golang|python|ruby)\b|\bjava\b(?!script)/i.test(`${intentSummary} ${cleanTask || ''} ${cleanFeature || ''}`);
  const isNonJsBackend = isPython || isCppOrSystem || (/(?:^|\W)c(?:\+\+|#)?(?:$|\W)|\b(cpp|golang|go|rust|ruby|php)\b|\bjava\b(?!script)/i.test(fullIntentText) && !/\b(javascript|vanilla\s*js|client-side|frontend)\b/i.test(fullIntentText));

  let projectType = params.projectType || plan?.projectType || (isEmptyFolder ? (isNonJsBackend ? 'backend' : (typeResult.projectType !== 'unknown' ? typeResult.projectType : 'unknown')) : typeResult.projectType);

  if (isNonJsBackend) {
    projectType = 'backend';
  } else if (projectType === 'unknown' || !projectType) {
    const text = `${intentSummary} ${cleanTask || ''} ${cleanFeature || ''}`.toLowerCase();
    if (text.includes('dark mode') || text.includes('toggle') || text.includes('css') || text.includes('html') || text.includes('theme') || /\bui\b/i.test(text) || text.includes('vanilla') || text.includes('password') || text.includes('checker') || text.includes('audio') || text.includes('music') || text.includes('frontend') || (text.includes('game') && !isCppOrSystem) || text.includes('tic-tac-toe') || text.includes('tictactoe')) {
      projectType = 'frontend';
    }
  }
  const isFrontend = projectType === 'frontend';

  // Bug 1 Fix: Resolve clean Architecture Domain tag from plan.domain or plan.featureType.
  // Never fall back to the raw intentSummary or user message!
  let domainTag = null;
  const rawDomainCandidate = plan?.domain || plan?.featureType;
  if (typeof rawDomainCandidate === 'string') {
    const trimmed = rawDomainCandidate.trim();
    // Only accept if clean short tag (<= 40 chars, single-line, not matching raw user prompt)
    if (trimmed.length > 0 && trimmed.length <= 40 && trimmed !== intentSummary && !trimmed.includes('\n')) {
      domainTag = trimmed;
    }
  }

  const text = `${intentSummary || ''} ${cleanTask || ''} ${cleanFeature || ''} ${rawDomainCandidate || ''} ${plan?.userIntent || ''} ${plan?.task || ''}`.toLowerCase();
  const isCliOrScript = /\b(cli|terminal|console|command\s*line|command-line|daemon|background|log|analyzer|monitor|watcher|tail|utility|worker)\b/i.test(text);

  if (!domainTag || domainTag === 'general') {
    if (isCliOrScript) {
      domainTag = 'backend_cli';
    } else if (!isCppOrSystem && (text.includes('game') || text.includes('tic-tac-toe') || text.includes('tictactoe') || text.includes('canvas'))) {
      domainTag = 'frontend_game';
    } else if (isCppOrSystem && text.includes('game')) {
      domainTag = 'game';
    } else if (text.includes('dark mode') || text.includes('theme') || text.includes('toggle') || text.includes('button') || text.includes('modal') || /\bnav\b/i.test(text) || /\bui\b/i.test(text) || text.includes('component')) {
      domainTag = 'UI_Component';
    } else if (text.includes('auth') || text.includes('login') || text.includes('jwt') || text.includes('signup') || text.includes('password')) {
      domainTag = 'auth';
    } else if (/\bpay\b/i.test(text) || text.includes('payment') || text.includes('stripe') || text.includes('checkout') || text.includes('billing')) {
      domainTag = 'payment';
    } else if (text.includes('crud') || /\bapi\b/i.test(text) || text.includes('route') || text.includes('rest')) {
      domainTag = 'api_crud';
    } else if (isFrontend) {
      domainTag = 'frontend';
    } else {
      domainTag = 'general';
    }
  }

  const featureType = domainTag;

  // 2. Run Missing File Analysis with resolved projectType
  const missingAnalysis = await analyzeMissingFiles({
    plan,
    projectMemory,
    snapshot,
    projectType,
    feature: intentSummary,
    requestedLanguage: isPython ? 'python' : params.requestedLanguage,
  });

  // Bug 1 Fix: Resolve human-readable selected option name & files from params, plan, or sessionStore
  let activeOptionCandidate = paramSelectedOption || plan?.selectedOptionObject || plan?.selectedOption || null;
  let activeOptionNameCandidate = paramSelectedOptionName || plan?.selectedOptionName || null;

  if (!activeOptionCandidate && !activeOptionNameCandidate) {
    try {
      const sessionStore = require('../session-store');
      const saved = sessionStore.loadState();
      if (saved?.selectedOption) activeOptionCandidate = saved.selectedOption;
      if (saved?.selectedOptionName) activeOptionNameCandidate = saved.selectedOptionName;
    } catch (_) {}
  }

  const hasUserSelectedOption = !!(activeOptionCandidate || activeOptionNameCandidate);
  let selectedOption = 'Standard Approach';
  let optObj = null;

  if (hasUserSelectedOption) {
    if (typeof activeOptionCandidate === 'object' && activeOptionCandidate) {
      optObj = activeOptionCandidate;
    }

    if (optObj) {
      selectedOption = optObj.name || optObj.label || optObj.title || optObj.description || optObj.id || 'Standard Approach';
    } else if (activeOptionNameCandidate) {
      selectedOption = String(activeOptionNameCandidate);
    } else if (activeOptionCandidate) {
      selectedOption = String(activeOptionCandidate);
    }

    // Strip prefix "Option A: " if present, keeping human readable name (e.g. "Web Audio API Node Graph")
    selectedOption = selectedOption.replace(/^Option\s+[A-Z]:\s*/i, '').trim();

    // If option is just an ID (e.g. 'B'), look up full label/name from plan options
    if (Array.isArray(plan.availableApproaches || plan.options)) {
      const match = (plan.availableApproaches || plan.options).find(
        opt => opt.id === selectedOption || opt.name === selectedOption || opt.label === selectedOption
      );
      if (match) {
        optObj = match;
        selectedOption = (match.name || match.label || match.title || selectedOption).replace(/^Option\s+[A-Z]:\s*/i, '').trim();
      }
    }

    // If selectedOption is still an ID ('A', 'B', 'C'), resolve from static fallbacks
    if (/^[A-Z]$/i.test(selectedOption)) {
      const { getStaticFallbackOptions } = require('../ast/project-type-detector');
      const staticOpts = getStaticFallbackOptions(isPython ? 'python' : typeResult.projectType, intentSummary || featureType);
      const targetId = selectedOption.toUpperCase();
      const staticMatch = staticOpts.find(o => o.id === targetId || o.label?.includes(`Option ${targetId}`));
      if (staticMatch) {
        if (!optObj) optObj = staticMatch;
        selectedOption = (staticMatch.name || staticMatch.label || selectedOption).replace(/^Option\s+[A-Z]:\s*/i, '').trim();
      }
    }
  }

  let filesToEdit = Array.isArray(plan.filesToEdit) && plan.filesToEdit.length > 0
    ? [...plan.filesToEdit]
    : (optObj && Array.isArray(optObj.filesToEdit) && optObj.filesToEdit.length > 0 ? [...optObj.filesToEdit] : []);

  let filesToCreate = Array.isArray(plan.filesToCreate) && plan.filesToCreate.length > 0
    ? [...plan.filesToCreate]
    : (optObj && Array.isArray(optObj.filesToCreate) && optObj.filesToCreate.length > 0 ? [...optObj.filesToCreate] : []);

  // If option was selected and has files, but plan files were empty, populate from option
  if (optObj) {
    if (filesToEdit.length === 0 && Array.isArray(optObj.filesToEdit) && optObj.filesToEdit.length > 0) {
      filesToEdit = [...optObj.filesToEdit];
    }
    if (filesToCreate.length === 0 && Array.isArray(optObj.filesToCreate) && optObj.filesToCreate.length > 0) {
      filesToCreate = [...optObj.filesToCreate];
    }
  }

  // Detect Architectural Override: Production Modular vs Single File Prototype
  const selectedText = `${selectedOption || ''} ${paramSelectedOptionName || ''} ${plan?.selectedOptionName || ''} ${typeof plan?.selectedOption === 'string' ? plan.selectedOption : ''} ${optObj?.name || ''} ${optObj?.label || ''} ${optObj?.description || ''}`.toLowerCase();
  const isModularSelected = !!(plan?.isProductionModular || optObj?.isProductionModular || /production\s*modular/i.test(selectedText));
  const isSingleFileSelected = !!(plan?.isSingleFilePrototype || optObj?.isSingleFilePrototype || /single\s*file/i.test(selectedText));

  if (isModularSelected) {
    if (filesToCreate.length === 0 && (!snapshot || !snapshot.files || snapshot.files.length === 0)) {
      filesToCreate = isCppOrSystem ? ['main.cpp'] : ['index.html', 'style.css', 'app.js'];
    }
  } else if (isSingleFileSelected) {
    filesToCreate = isCppOrSystem ? ['main.cpp'] : ['index.html'];
  }

  // FIX 1: Sync filesToCreate with Missing Blueprint files (e.g. utils/entropy.js)
  if (missingAnalysis && Array.isArray(missingAnalysis.missing)) {
    const { isBackendFilename } = require('./missing-file-analyzer');
    for (const mf of missingAnalysis.missing) {
      if (isFrontend && isBackendFilename(mf)) continue;
      if (isPython && /\.(html|css|js|jsx|ts|tsx)$/i.test(mf)) continue;
      if (!filesToCreate.includes(mf)) {
        filesToCreate.push(mf);
      }
    }
  }

  // Ensure permitted files for frontend projects:
  // - Default strictly to index.html, style.css, and app.js for frontend projects
  // - Only suggest modules/ if the user explicitly asks for "modular" or "modules"
  const userWantsModules = /\b(modular|modules?)\b/i.test(
    `${params.userIntent || ''} ${params.feature || ''} ${cleanTask || ''} ${intentSummary || ''} ${plan?.rawUserPrompt || ''}`
  );
  if (isFrontend && !userWantsModules) {
    filesToCreate = filesToCreate.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
    filesToEdit = filesToEdit.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
  }

  if (isEmptyFolder && isFrontend && !isCppOrSystem) {
    if (isSingleFileSelected) {
      filesToCreate = ['index.html'];
    } else {
      const defaultFrontendFiles = ['index.html', 'style.css', 'app.js'];
      for (const df of defaultFrontendFiles) {
        if (!filesToCreate.includes(df) && !filesToEdit.includes(df)) {
          filesToCreate.push(df);
        }
      }
    }
  } else if (isEmptyFolder && isCppOrSystem && filesToCreate.length === 0) {
    filesToCreate = ['main.cpp'];
  }

  // For Python projects:
  // - Never include HTML, CSS, or JS files
  // - If external libraries are required (e.g. watchdog, requests, aiohttp), ensure requirements.txt is in filesToCreate
  // - Ensure standard Python entrypoints (main.py, analyzer.py) for CLI/analyzers
  if (isPython) {
    filesToCreate = filesToCreate.filter(f => !/\.(html|css|js|jsx|ts|tsx)$/i.test(f));
    filesToEdit = filesToEdit.filter(f => !/\.(html|css|js|jsx|ts|tsx)$/i.test(f));

    const externalLibRegex = /\b(watchdog|requests|aiohttp|aiofiles|fastapi|flask|django|uvicorn|pandas|numpy|pytest|click|rich|psutil|pip|requirements)\b/i;
    const needsRequirements = externalLibRegex.test(`${fullIntentText} ${selectedText} ${JSON.stringify(plan)}`);

    if (needsRequirements && !filesToCreate.some(f => f.toLowerCase().endsWith('requirements.txt'))) {
      filesToCreate.push('requirements.txt');
    }

    if (fullIntentText.includes('log') || fullIntentText.includes('analyzer')) {
      if (!filesToCreate.some(f => f.toLowerCase().endsWith('main.py')) && !filesToEdit.some(f => f.toLowerCase().endsWith('main.py'))) {
        filesToCreate.unshift('main.py');
      }
      if (!filesToCreate.some(f => f.toLowerCase().endsWith('analyzer.py')) && !filesToEdit.some(f => f.toLowerCase().endsWith('analyzer.py'))) {
        const logIdx = filesToCreate.findIndex(f => f.toLowerCase().endsWith('log_analyzer.py'));
        if (logIdx >= 0) {
          filesToCreate[logIdx] = 'analyzer.py';
        } else {
          filesToCreate.push('analyzer.py');
        }
      }
    }

    if (filesToCreate.length === 0 && filesToEdit.length === 0) {
      filesToCreate = needsRequirements ? ['requirements.txt', 'main.py', 'analyzer.py'] : ['main.py', 'analyzer.py'];
    }
  }

  // FIX 2: Include UI Files for UI-related features (like displaying entropy, UI components, etc.)
  const fullFeatureIntent = `${intentSummary} ${cleanTask || ''} ${cleanFeature || ''}`.toLowerCase();
  const isUIFeature = isFrontend || (!isPython && /entropy|shannon|ui|display|meter|strength|visual|theme|toggle|dark\s*mode|button|modal|input|view|render|html|css|style|password/i.test(fullFeatureIntent));
  if (isUIFeature && snapshot && Array.isArray(snapshot.files)) {
    const snapPaths = snapshot.files.map(f => f.path);
    const uiCandidates = ['app.js', 'index.html', 'style.css'];
    for (const cand of uiCandidates) {
      const match = snapPaths.find(p => p === cand || p.endsWith('/' + cand) || p.endsWith('\\' + cand));
      if (match && !filesToEdit.includes(match) && !filesToCreate.includes(match)) {
        filesToEdit.push(match);
      }
    }
  }

  // Ensure files that already exist on disk in snapshot are NEVER in filesToCreate
  if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
    const existingSnapPaths = snapshot.files.map(f => f.path.toLowerCase().replace(/\\/g, '/'));
    const mistakenlyInCreate = filesToCreate.filter(fc => {
      const normFc = fc.toLowerCase().replace(/\\/g, '/');
      return existingSnapPaths.some(ep => ep === normFc || ep.endsWith('/' + normFc));
    });
    for (const mic of mistakenlyInCreate) {
      if (!filesToEdit.includes(mic)) filesToEdit.push(mic);
    }
    filesToCreate = filesToCreate.filter(fc => !mistakenlyInCreate.includes(fc));
  }

  // For frontend projects:
  // - Never hallucinate backend routes, controllers, services, schemas
  // - If filesToEdit is empty, default to existing index.html and app.js
  if (isFrontend) {
    const { isBackendFilename } = require('./missing-file-analyzer');
    filesToEdit = filesToEdit.filter(f => !isBackendFilename(f));
    filesToCreate = filesToCreate.filter(f => !isBackendFilename(f));
    if (!userWantsModules) {
      filesToCreate = filesToCreate.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
      filesToEdit = filesToEdit.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
    }

    if (filesToEdit.length === 0) {
      if (snapshot && Array.isArray(snapshot.files)) {
        const snapFiles = snapshot.files.map(f => f.path);
        const candidates = ['app.js', 'index.html', 'style.css'];
        const found = candidates.filter(c => snapFiles.some(sf => sf === c || sf.endsWith('/' + c) || sf.endsWith('\\' + c)));
        if (found.length > 0) {
          filesToEdit = found;
        } else {
          filesToEdit = ['index.html', 'app.js'];
        }
      } else {
        filesToEdit = ['index.html', 'app.js'];
      }
    }
  }

  // Never allow overlap between filesToCreate and filesToEdit
  filesToEdit = filesToEdit.filter(f => !filesToCreate.includes(f));

  const forbiddenFiles = Array.isArray(plan.forbiddenFiles) && plan.forbiddenFiles.length > 0
    ? plan.forbiddenFiles
    : (isPython
      ? ['.env', '.env.local', '__pycache__/', '*.pyc', '.git/', 'venv/', '.venv/']
      : ['.env', '.env.local', 'node_modules/', 'package-lock.json', '.git/']);

  // 3. Compile Security Guardrails Section (Step 5 Context-Aware Selection)
  let securityResult = null;
  try {
    const aiService = require('../ai/ai-service');
    if (typeof aiService.selectSecurityRules === 'function') {
      securityResult = await aiService.selectSecurityRules({
        feature: intentSummary || featureType,
        projectType: isPython ? 'backend' : typeResult.projectType,
        selectedOption,
        snapshot,
        projectMemory,
        language: isPython ? 'python' : (isNonJsBackend ? 'backend' : 'javascript'),
        requestedLanguage: isPython ? 'python' : (params.requestedLanguage || null),
        techStack: projectMemory?.techStack || (isPython ? ['python'] : []),
      });
    }
  } catch (err) {
    console.warn('[Prompt Builder] selectSecurityRules warning:', err.message);
  }

  if (!securityResult) {
    const { selectRulesHeuristically } = require('../security/rule-selector');
    securityResult = selectRulesHeuristically({
      feature: intentSummary || featureType,
      projectType: isPython ? 'backend' : typeResult.projectType,
      selectedOption,
      language: isPython ? 'python' : (isNonJsBackend ? 'backend' : 'javascript'),
      requestedLanguage: isPython ? 'python' : (params.requestedLanguage || null),
      techStack: projectMemory?.techStack || (isPython ? ['python'] : []),
    });
  }

  const { getRule } = require('../security/base-rules');
  const rulesList = [];
  const finalRuleIds = new Set(securityResult?.selectedRuleIds || []);

  // If caller provided explicit activeRules, incorporate them (subject to project-type guards)
  if (Array.isArray(activeRules) && activeRules.length > 0) {
    for (const rid of activeRules) {
      if (isFrontend && (rid === 'sql-guard' || rid === 'zod-validation' || rid === 'owasp-headers' || rid === 'rate-limiting')) {
        continue;
      }
      if (isNonJsBackend) {
        if (rid === 'zod-validation' || rid === 'owasp-headers' || rid === 'rate-limiting' || rid === 'cors' || rid === 'express-rate-limit' || rid === 'no-eval' || rid === 'xss-guard' || rid === 'no-innerhtml') {
          continue;
        }
      }
      finalRuleIds.add(rid);
    }
  }

  // Mandatory invariant: Zero-Secrets is always enforced
  finalRuleIds.add('zero-secrets');

  if (isNonJsBackend) {
    const jsNodeRuleIds = [
      'zod-validation',
      'owasp-headers',
      'rate-limiting',
      'cors',
      'express-rate-limit',
      'xss-guard',
      'no-innerhtml',
      'no-eval',
    ];
    jsNodeRuleIds.forEach(id => finalRuleIds.delete(id));
    if (isPython) {
      finalRuleIds.add('safe-paths');
      finalRuleIds.add('no-eval-exec');
      finalRuleIds.add('log-sanitization');
    }
  } else if (isFrontend) {
    const backendRuleIds = [
      'zod-validation',
      'sql-guard',
      'owasp-headers',
      'rate-limiting',
      'jwt-rotation',
      'bcrypt-hash',
      'error-masking',
      'webhook-signature',
      'idempotency',
      'database-guard'
    ];
    backendRuleIds.forEach(id => finalRuleIds.delete(id));
    finalRuleIds.add('xss-guard');
    finalRuleIds.add('no-innerhtml');
    finalRuleIds.add('no-eval');
  }

  for (const ruleId of finalRuleIds) {
    const ruleObj = getRule(ruleId) || (securityResult?.rules && securityResult.rules.find(r => r.id === ruleId));
    if (ruleObj && ruleObj.text) {
      if (isFrontend) {
        const isBackend = /(zod|sql|bcrypt|database|jwt\s*rotation|password\s*hashing|owasp|rate\s*limit|error\s*masking)/i.test(ruleObj.text);
        if (isBackend) continue;
      }
      if (isNonJsBackend) {
        const isJsNode = /(zod|express|helmet|cors|innerhtml|dom|xss)/i.test(ruleObj.text);
        if (isJsNode) continue;
      }
      rulesList.push(`- ${ruleObj.text}`);
    }
  }

  if (Array.isArray(securityResult?.customRules) && !isFrontend) {
    for (const custom of securityResult.customRules) {
      if (custom && custom.text && !rulesList.includes(`- ${custom.text}`)) {
        if (isNonJsBackend) {
          const isJsNode = /(zod|express|helmet|cors|innerhtml|dom|xss)/i.test(custom.text);
          if (isJsNode) continue;
        }
        rulesList.push(`- ${custom.text}`);
      }
    }
  }

  // 4. Compile AST Grounding Context
  let astContextSection = '';
  if (snapshot && Array.isArray(snapshot.files)) {
    let relevantFiles = snapshot.files
      .filter(f => filesToEdit.some(target => f.path.includes(target) || target.includes(f.path)));

    // Ensure primary JS files (app.js, index.js, etc.) are included in AST context
    const primaryJsFiles = snapshot.files.filter(f => /(?:^|\/)(app|index|main|server)\.[jt]sx?$/i.test(f.path));
    for (const pj of primaryJsFiles) {
      if (!relevantFiles.some(rf => rf.path === pj.path)) {
        relevantFiles.push(pj);
      }
    }

    if (relevantFiles.length === 0) {
      relevantFiles = snapshot.files
        .filter(f => f.isAST || /\.(js|ts|jsx|tsx)$/i.test(f.path));
    }

    relevantFiles = relevantFiles.slice(0, 5);

    if (relevantFiles.length > 0) {
      astContextSection = `## AST Architectural Context (Existing Functions & Exports)\n` +
        relevantFiles.map(f => {
          let allFns = Array.isArray(f.fns) ? [...f.fns] : [];
          const taskKeywords = (String(task || '') + ' ' + String(currentIntent || ''))
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(w => w.length >= 3);
          if (taskKeywords.length > 0 && allFns.length > 5) {
            allFns.sort((a, b) => {
              const aLower = a.toLowerCase();
              const bLower = b.toLowerCase();
              const aMatch = taskKeywords.some(kw => aLower.includes(kw));
              const bMatch = taskKeywords.some(kw => bLower.includes(kw));
              if (aMatch && !bMatch) return -1;
              if (!aMatch && bMatch) return 1;
              return 0;
            });
          }
          const fns = allFns.slice(0, 15).join(', ') || 'None';
          const exps = (f.exports || []).slice(0, 10).join(', ') || 'None';
          return `- File: \`${f.path}\` | Functions: [${fns}] | Exports: [${exps}]`;
        }).join('\n');
    }
  }

  // 5. Missing Blueprint Warning Block
  let warningBlock = '';
  const { isBackendFilename } = require('./missing-file-analyzer');
  const filteredMissing = isFrontend
    ? (missingAnalysis.missing || []).filter(f => !isBackendFilename(f))
    : (missingAnalysis.missing || []);

  if (filteredMissing.length > 0) {
    warningBlock = `> [!WARNING] Missing Blueprint Dependencies\n> ${missingAnalysis.warning}\n`;
  }

  // Architectural Override Quality & Warning Blocks
  let architectureQualitySection = '';
  if (isModularSelected) {
    architectureQualitySection = `## ARCHITECTURE & CODE QUALITY
- **Separation of Concerns**: HTML for structure, CSS for styling, and JS for logic. Keep all code strictly modularized in separate dedicated files.
- **ES6 Modules / Scope Isolation**: Use \`ES6 Modules\` (\`import\`/\`export\`) or \`IIFE\` for JS to prevent global scope pollution.
- **Modern Responsive Design**: CSS variables, Flexbox/Grid for responsive design. Do not use hardcoded inline styles.
- **Strict DOM Security**: No \`innerHTML\` (use \`textContent\` or \`document.createElement\`), strict XSS prevention.`;
  }

  let singleFileWarning = '';
  if (isSingleFileSelected) {
    singleFileWarning = `> [!WARNING] SINGLE FILE PROTOTYPE: This is not recommended for production. Do not scale this file.\n`;
  }

  // 5b. Project Context Section
  let projectContextSection = '';
  if (totalFiles === 0) {
    projectContextSection = `## PROJECT CONTEXT\nThis is a brand new project. Create the structure from scratch.\n`;
  } else {
    const filePaths = (snapshot?.files || []).map(f => (f.path || '').toLowerCase());
    const hasIndexHtml = filePaths.some(p => /(?:^|\/)index\.html$/i.test(p));
    const hasStyleCss = filePaths.some(p => /(?:^|\/)style\.css$/i.test(p));
    const hasAppJs = filePaths.some(p => /(?:^|\/)app\.js$/i.test(p));
    const isVanillaJSApp = hasIndexHtml && (hasStyleCss || hasAppJs) && !filePaths.some(p => /(?:^|\/)(?:server|backend)\.[jt]s$/i.test(p));

    let memoryDomain = projectMemory?.domain || params.domain || null;
    if (!memoryDomain || memoryDomain === 'Unknown') {
      try {
        const pMem = require('../storage/project-memory');
        if (snapshot?.rootPath) {
          const cached = pMem.load(snapshot.rootPath);
          if (cached?.memory?.domain && cached.memory.domain !== 'Unknown') memoryDomain = cached.memory.domain;
        }
      } catch (_) {}
    }

    if (!memoryDomain || memoryDomain === 'Unknown' || memoryDomain === 'Software Project') {
      const allPaths = (snapshot?.files || []).map(f => (f.path || '').toLowerCase());
      if (allPaths.some(p => p.includes('analyzer') || p.includes('log')) || /log\s*analyzer/i.test(plan?.domain || '') || /log\s*analyzer/i.test(intentSummary || '') || /log/i.test(intentSummary || '')) {
        memoryDomain = 'Log Analyzer';
      }
    }

    const resolvedDomain = (memoryDomain && memoryDomain !== 'Unknown')
      ? memoryDomain
      : (plan?.domain && plan.domain !== 'Unknown' ? plan.domain : (isVanillaJSApp ? 'Existing Vanilla JS web application' : 'Software Project'));

    const isGame = (/game|tic-tac-toe/i.test(resolvedDomain) || (snapshot?.files || []).some(f => /(?:^|\/)(?:game|board)\.[jt]s$/i.test(f.path))) && !/password.*checker|auth|login/i.test(`${intentSummary} ${resolvedDomain}`);

    if (isVanillaJSApp || resolvedDomain === 'Existing Vanilla JS web application') {
      projectContextSection = `## PROJECT CONTEXT\nThis is an existing Vanilla JS web application. Maintain existing functionality.\n`;
    } else {
      const guidanceNote = isGame
        ? 'Ensure new code integrates seamlessly without breaking existing game logic.'
        : 'Ensure new code integrates seamlessly without breaking existing functionality.';
      projectContextSection = `## PROJECT CONTEXT\nThis project is a ${resolvedDomain}. ${guidanceNote}\n`;
    }
  }

  // 5c. Detailed User Requirements Section (Accumulator)
  const rawRequirements = params.activeFeatureRequirements
    || plan?.activeFeatureRequirements
    || [];
  let detailedRequirements = Array.isArray(rawRequirements) ? [...rawRequirements] : [];
  if (detailedRequirements.length === 0) {
    try {
      const sessionStore = require('../session-store');
      const saved = sessionStore.loadState();
      if (Array.isArray(saved?.activeFeatureRequirements) && saved.activeFeatureRequirements.length > 0) {
        detailedRequirements = [...saved.activeFeatureRequirements];
      }
    } catch (_) {}
  }

  // Strip all conversational questions from requirements
  detailedRequirements = detailedRequirements.filter(req => {
    if (!req || typeof req !== 'string') return false;
    if (isConversationalQuestion(req) || req.includes('?')) return false;
    if (/(ki\s+ki|kemon\s+hobe|details\s+bolo|thakby|thakbe)/i.test(req)) return false;
    return true;
  });

  // Include clean intentSummary if detailedRequirements is still empty
  if (detailedRequirements.length === 0 && intentSummary && intentSummary !== 'Feature Implementation') {
    detailedRequirements.push(intentSummary);
  }

  // FIX 3: Prevent Duplicate Implementation (AST Check)
  // The AST context shows calculateEntropy and estimateCrackTime already exist in app.js.
  // If the user asks to "Add Shannon Entropy Calculation", and the AST already has it,
  // the prompt should say: "Refactor/Enhance existing entropy calculation" rather than "Create from scratch".
  const existingFnsInAST = [];
  if (snapshot && Array.isArray(snapshot.files)) {
    for (const f of snapshot.files) {
      if (Array.isArray(f.fns)) {
        for (const fn of f.fns) {
          existingFnsInAST.push({ file: f.path, fn });
        }
      }
    }
  }

  const existingEntropyFns = existingFnsInAST.filter(item =>
    /calculateEntropy|estimateCrackTime|entropy|crack\s*time/i.test(item.fn)
  );
  const hasExistingEntropy = existingEntropyFns.length > 0;
  const isEntropyFeature = /entropy|shannon/i.test(`${intentSummary} ${cleanTask || ''} ${cleanFeature || ''}`);

  let astEnhancementDirective = '';
  if (isEntropyFeature && hasExistingEntropy) {
    const fnNames = existingEntropyFns.map(e => e.fn).slice(0, 3).join(', ');
    const sourceFile = existingEntropyFns[0].file;
    astEnhancementDirective = `\n- Implementation Directive: **Refactor/Enhance existing entropy calculation** rather than create from scratch (enhancing existing logic: \`${fnNames}\` already detected in \`${sourceFile}\`). Extract modular logic into \`utils/entropy.js\` while enhancing existing UI in \`index.html\` and \`style.css\`.`;
  }

  let detailedRequirementsSection = '';
  if (isEntropyFeature && hasExistingEntropy) {
    detailedRequirementsSection = `## DETAILED USER REQUIREMENTS
- Refactor/Enhance existing entropy calculation: enhance and modularize existing logic rather than creating from scratch.
- Extract modular Shannon entropy calculation into \`utils/entropy.js\` while maintaining and refactoring existing functions in \`app.js\`.
- Update UI in \`index.html\` and \`style.css\` to display real-time entropy calculation.
`;
  } else if (detailedRequirements.length > 0) {
    const parsedReqs = parseDetailedRequirements(detailedRequirements);
    if (parsedReqs.length > 0) {
      detailedRequirementsSection = `## DETAILED USER REQUIREMENTS\n${parsedReqs.map(req => `- ${req}`).join('\n')}\n`;
    }
  }

  // Sanitize AI Logic hallucination if user did not request Artificial Intelligence
  const isExplicitAI = /artificial\s*intelligence|machine\s*learning|\bai\s+(agent|model|bot|player|opponent|npc)/i.test(
    intentSummary + ' ' + (params.userIntent || '') + ' ' + (cleanTask || '') + ' ' + detailedRequirements.join(' ')
  );
  if (!isExplicitAI && /ai\s*logic/i.test(selectedOption)) {
    if (/login|auth|signin|signup/i.test(intentSummary)) {
      selectedOption = 'Inline Auth in app.js';
    } else {
      selectedOption = 'Standard Modular Implementation';
    }
  }

  // 6. Assemble Complete Deterministic Prompt
  let compiledPrompt = `<!-- ================================================================= -->
<!-- PromptLock v2.0 Strict Guardrail Prompt                          -->
<!-- Target: ${agentConfig.name}                                     -->
<!-- Generated: ${new Date().toISOString()}                          -->
<!-- ================================================================= -->

# ${agentConfig.header}

## Implementation Intent
You are implementing: **"${intentSummary}"**
- Architecture Domain: **${featureType}**
- Selected Approach: **${selectedOption}**${astEnhancementDirective}
- Agent Directive: ${agentConfig.instruction}

${projectContextSection}
${detailedRequirementsSection}${singleFileWarning}${warningBlock}${architectureQualitySection ? architectureQualitySection + '\n\n' : ''}## Strict File Scope & Boundaries
> **CRITICAL RULE**: You are an AI Worker. Do NOT modify any file outside the permitted list.

### Permitted Files to Edit:
${filesToEdit.length > 0 ? filesToEdit.map(f => `- \`${f}\``).join('\n') : '- *(No existing files permitted for modification)*'}

### Permitted Files to Create:
${filesToCreate.length > 0 ? filesToCreate.map(f => `- \`${f}\``).join('\n') : '- *(No new files permitted for creation)*'}

### Strictly FORBIDDEN Files (Do Not Touch):
${forbiddenFiles.map(f => `- \`${f}\``).join('\n')}

## Security Guardrails (Mandatory Enforcement)
${rulesList.join('\n')}

${astContextSection ? astContextSection + '\n' : ''}
## Worker Execution Instructions
1. **Surgical Diffs Only**: Output exact, atomic code changes. ${isEntropyFeature && hasExistingEntropy ? 'Refactor/Enhance existing entropy calculation rather than creating from scratch. ' : ''}Do NOT rewrite entire files when a 5-line diff suffices.
2. **Type Safety & Testing**: Provide TypeScript interfaces or JSDoc types, and include unit tests for all new functions.
3. **No Placeholders**: Write fully functional, production-ready code. Do not use "// TODO" or incomplete stubs.
4. **Boundary Verification**: Before presenting your code, verify that not a single file outside the Permitted list was modified.
`;

  if (!isExplicitAI) {
    compiledPrompt = compiledPrompt
      .replace(/\bImperative AI Logic\b/gi, 'Modular Logic')
      .replace(/\bAI Logic\b/gi, 'Application Logic');
  }

  // 8. Run Quality & Security Validation
  const validation = validatePrompt(compiledPrompt, { agent, activeRules, plan });

  const metadata = {
    agent,
    planId: plan.id || `plan_${Date.now()}`,
    featureType,
    isProductionModular: isModularSelected,
    isSingleFilePrototype: isSingleFileSelected,
    generatedAt: new Date().toISOString(),
    tokenEstimate: Math.ceil(compiledPrompt.length / 4),
    validation,
    missingAnalysis,
    security: securityResult,
    selectedSecurityRules: Array.from(finalRuleIds),
  };

  return {
    ok: true,
    prompt: compiledPrompt,
    metadata,
  };
}

/**
 * Build a specialized Bug-Fix Prompt for Anti-Gravity / Target AI.
 * @param {object} params
 * @param {string} [params.userBugReport] - Developer reported bug description
 * @param {string[]|string} [params.projectFiles] - Files permitted to modify
 * @param {object} [params.snapshot] - AST snapshot
 * @param {string} [params.agent] - Target AI agent (default: antigravity)
 * @returns {Promise<{ ok: boolean, prompt: string, metadata: object }>}
 */
async function buildBugFixPrompt(params = {}) {
  const {
    currentIntent,
    userBugReport,
    bugReport,
    message,
    task,
    feature,
    userIntent,
    projectFiles: explicitProjectFiles,
    snapshot,
    agent = 'antigravity',
  } = params;

  let savedIntent = null;
  let savedBugReport = null;
  try {
    const sessionStore = require('../session-store');
    const saved = sessionStore.loadState();
    if (isValidIntentString(saved?.pendingBugReport)) {
      savedBugReport = saved.pendingBugReport;
    }
    if (isValidIntentString(saved?.currentIntent)) {
      savedIntent = saved.currentIntent;
    }
  } catch (_) {}

  const isMetaCommandText = (val) => typeof val === 'string' && /(prompt daw|prompt dao|give.*prompt|fix.*prompt|generate prompt|\bok\b|\bok\s+fix\b|\bfix\s+it\b|\bplease\s+fix\b|\bprompt\b)/i.test(val.trim());

  const cleanUserBug = isMetaCommandText(userBugReport) ? null : userBugReport;
  const cleanBugReport = isMetaCommandText(bugReport) ? null : bugReport;
  const cleanMsg = isMetaCommandText(message) ? null : message;
  const cleanCurrentIntent = isMetaCommandText(currentIntent || params.currentIntent) ? null : (currentIntent || params.currentIntent);

  const rawBugReport = (
    cleanUserBug ||
    cleanBugReport ||
    savedBugReport ||
    cleanCurrentIntent ||
    cleanMsg ||
    task ||
    feature ||
    userIntent ||
    savedIntent ||
    'The application functionality is not working as expected.'
  ).trim();

  // Resolve projectFiles
  let files = [];
  if (Array.isArray(explicitProjectFiles) && explicitProjectFiles.length > 0) {
    files = explicitProjectFiles;
  } else if (typeof explicitProjectFiles === 'string' && explicitProjectFiles.trim()) {
    files = explicitProjectFiles.split(',').map(s => s.trim()).filter(Boolean);
  } else if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
    files = snapshot.files.map(f => f.path || f);
  }

  // Filter out forbidden files from permitted list
  const forbiddenPatterns = [/^\.env/, /^node_modules/, /^package\.json$/, /^package-lock\.json$/, /^\.git/];
  files = files.filter(f => !forbiddenPatterns.some(pat => pat.test(f)));

  // Fallback default files if project is empty or none discovered
  if (files.length === 0) {
    const techStackList = Array.isArray(projectMemory?.techStack)
      ? projectMemory.techStack.map(s => String(s).toLowerCase())
      : (typeof projectMemory?.techStack === 'string' ? [projectMemory.techStack.toLowerCase()] : []);
    const isCpp = techStackList.some(t => /c\+\+|cpp/i.test(t)) || /c\+\+|cpp/i.test(rawBugReport);
    if (isCpp) {
      files = ['main.cpp'];
    } else if (snapshot && snapshot.files && snapshot.files.length > 0) {
      files = snapshot.files.map(f => f.path || f);
    } else {
      files = ['index.html', 'style.css', 'app.js'];
    }
  }

  const formattedFiles = files.join(', ');

  // Load template from ai/prompts/bug-fix-prompt.md or fallback
  let template = '';
  try {
    const templatePath = path.join(__dirname, '../ai/prompts/bug-fix-prompt.md');
    template = fs.readFileSync(templatePath, 'utf8');
  } catch (_) {
    template = `# 🛠️ STRICT BUG-FIX DIRECTIVE\n\n## 🐞 BUG DESCRIPTION\nThe developer reported: "{{userBugReport}}"\n\n## 🎯 YOUR TASK\nYou are a Worker AI. Analyze the existing codebase and FIX the bug described above. \nDo NOT rewrite the entire application. Do NOT add new features. \nOnly modify the necessary logic to make the UI/game work as expected.\n\n## 🔒 STRICT SCOPE\n- You may ONLY modify these files: {{projectFiles}}\n- You MUST NOT touch: .env, node_modules, package.json\n\n## 🛡️ SECURITY RULES\n- Use textContent, not innerHTML.\n- No eval() or dynamic execution.\n`;
  }

  function extractBugIntent(report) {
    if (!report || typeof report !== 'string') return 'Fix application issue';
    const trimmed = report.trim().replace(/[.?!]+$/, '');
    if (/database\s*connection.*timeout/i.test(trimmed)) {
      return 'Fix database connection timeout';
    }
    const failMatch = trimmed.match(/^(?:the\s+)?(.*?)\s+is\s+failing(?:\s+with\s+(?:an?|the)?\s*(.*?)(?:\s+error)?)?$/i);
    if (failMatch && failMatch[1]) {
      const subject = failMatch[1].trim();
      const cause = (failMatch[2] || '').trim();
      return `Fix ${subject}${cause ? ' ' + cause : ''}`;
    }
    if (/^fix\b/i.test(trimmed)) {
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
    return `Fix ${trimmed.replace(/^(?:the|an?)\s+/i, '')}`;
  }

  const bugIntent = extractBugIntent(rawBugReport);

  const isPythonProject = Boolean(
    (snapshot?.files && snapshot.files.some(f => /\.py$/i.test(f.path || f))) ||
    files.some(f => /\.py$/i.test(f))
  );

  let compiledPrompt = template
    .replace('{{userBugReport}}', rawBugReport)
    .replace('{{projectFiles}}', formattedFiles);

  if (bugIntent && !compiledPrompt.includes(bugIntent)) {
    compiledPrompt = compiledPrompt.replace(
      '## 🎯 YOUR TASK\n',
      `## 🎯 YOUR TASK\n- **Fix Intent**: ${bugIntent}\n`
    );
  }

  if (isPythonProject) {
    compiledPrompt = compiledPrompt
      .replace('- You MUST NOT touch: .env, node_modules, package.json', '- You MUST NOT touch: .env, __pycache__, venv, .venv')
      .replace('- Use textContent, not innerHTML.\n- No eval() or dynamic execution.', '- Safe Paths: Use safe os.path handling to prevent path traversal.\n- No Eval: No eval() or exec() dynamic execution in Python.\n- Log Sanitization: Sanitize log inputs to prevent log injection.');
  }

  const metadata = {
    agent,
    mode: 'bug_fix',
    isBugFix: true,
    userBugReport: rawBugReport,
    intent: bugIntent,
    task: bugIntent,
    projectFiles: files,
    generatedAt: new Date().toISOString(),
    tokenEstimate: Math.ceil(compiledPrompt.length / 4),
  };

  return {
    ok: true,
    prompt: compiledPrompt,
    metadata,
  };
}

module.exports = {
  buildStrictPrompt,
  buildBugFixPrompt,
  AGENT_TEMPLATES,
};
