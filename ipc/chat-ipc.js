/**
 * PromptLock — Chat & Orchestrator IPC Handler (Step 1 & 2 Upgrade)
 *
 * Implements chat-based developer-tool orchestration:
 *  - Developer converses with PromptLock via chat messages
 *  - PromptLock analyzes feature requests via AST Feature Analyzer
 *  - Generates A/B/C options and inline execution plans with Approval/Rejection/Modification
 *  - Provides snapshot progress metrics
 */

'use strict';

const { ipcMain } = require('electron');
const { analyzeFeature } = require('../ast/feature-analyzer');
const { calculateProgress } = require('../scanner/progress-calculator');
const { buildStrictPrompt } = require('../rules/prompt-builder');
const projectMemory = require('../ai/project-memory');
const sessionStore = require('../session-store');
const aiService = require('../ai/ai-service');

/** In-memory plan & conversation state */
const activePlans = new Map();

function clearChatState() {
  activePlans.clear();
}

let isRegistered = false;

function isValidIntentString(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'undefined') return false;
  if (lower === 'feature implementation' || lower === 'implement approved feature scope') return false;
  return true;
}

/**
 * Register chat and progress IPC handlers.
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {object} astEngineRef
 */
function registerChatIPC(getWindow, astEngineRef) {
  if (isRegistered) return;
  isRegistered = true;

  ['chat:send', 'chat:options', 'progress:get', 'progress:update'].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  });

  /**
   * chat:send
   * Renderer → Main: Developer sends a prompt/intent in chat.
   * Analyzes intent against AST metadata and returns AI guidance with A/B/C options & plan.
   */
  ipcMain.handle('chat:send', async (_event, payload) => {
    if (!payload || typeof payload.message !== 'string') {
      return { ok: false, error: 'Message text required' };
    }

    let message = payload.message.trim().slice(0, 3000);
    if (message.length < 2) {
      return { ok: false, error: 'Please enter a valid request' };
    }

    console.log('[Chat IPC] chat:send received');

    // Get current AST snapshot
    let snapshot = payload?.snapshot || null;
    try {
      if (!snapshot && astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
        snapshot = astEngineRef.getSnapshot();
      }
    } catch (_) {}
    if (!snapshot) {
      try {
        const { getSnapshot } = require('../scanner/snapshot-manager');
        snapshot = getSnapshot();
      } catch (_) {}
    }

    // ── FIX BUG MODE INTERCEPTION (STRICT PRIORITY) ──────────────────────────
    // Intercept immediately if payload.mode === 'fix' OR explicitMode === 'fix'
    // BYPASS all suggestOptions(), currentPlan, evaluative questions, and option interceptors.
    const rawMode = payload && typeof payload.mode === 'string' ? payload.mode.toLowerCase().trim() : null;
    const isFixMode = rawMode === 'fix' || payload?.mode === 'fix';

    if (isFixMode) {
      console.log('[Chat IPC] Received mode in payload: fix');
      console.log('[Chat IPC] Explicit Mode Routing: FIX BUG (Immediate Intercept) for', message);
      const totalFiles = (snapshot?.files || []).length;
      if (totalFiles === 0) {
        const replyText = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
        const response = {
          id: `msg_ai_${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: replyText,
          reply: replyText,
          responseText: replyText,
          mode: 'normal',
          options: [],
          plan: null,
          isBugFix: false,
          isClarification: false,
        };
        return { ok: true, response };
      }

      const { buildBugFixPrompt } = require('../rules/prompt-builder');
      let projectFilesList = [];
      if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        projectFilesList = snapshot.files.map(f => f.path || f);
      } else {
        projectFilesList = ['index.html', 'style.css', 'app.js'];
      }

      const bugFixResult = await buildBugFixPrompt({
        currentIntent: message,
        userBugReport: message,
        projectFiles: projectFilesList,
        snapshot,
        agent: 'antigravity',
      });
      const bugFixPrompt = bugFixResult.prompt;
      const bugFixMetadata = bugFixResult.metadata;
      const bugIntent = bugFixMetadata?.intent || message;

      const savedState = sessionStore.loadState() || {};
      const updatedPromptHistory = [
        ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
        {
          prompt: bugFixPrompt,
          feature: 'Bug Fix: ' + (bugIntent || message).slice(0, 60),
          featureName: 'Bug Fix',
          task: bugIntent || message,
          intent: bugIntent,
          timestamp: Date.now(),
          generatedAt: new Date().toISOString(),
          agent: 'antigravity',
          promptPreview: bugFixPrompt.slice(0, 160),
          isBugFix: true,
        },
      ];

      sessionStore.saveState({
        currentIntent: message,
        bugIntent,
        pendingFeature: null,
        activeFeatureRequirements: [message],
        lastGeneratedPrompt: bugFixPrompt,
        promptHistory: updatedPromptHistory,
        isBugFix: true,
        pendingAction: null,
        pendingBugReport: null,
      });

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: bugFixPrompt,
          metadata: bugFixMetadata,
          promptHistory: updatedPromptHistory,
          isBugFix: true,
        });
      }

      const replyText = "I have analyzed the bug and generated the fix prompt. Click below to open it.";
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        reply: replyText,
        responseText: replyText,
        mode: 'bug_fix_ready',
        needsOptions: false,
        options: [],
        plan: null,
        isBugFix: true,
        intent: bugIntent,
        task: bugIntent,
        prompt: bugFixPrompt,
        metadata: bugFixMetadata,
        promptHistory: updatedPromptHistory,
      };
      return { ok: true, response };
    }

    // 1. Load project memory for context injection
    let projectContextForAI = {};
    try {
      if (snapshot?.rootPath) {
        const cached = projectMemory.load(snapshot.rootPath);
        if (cached?.memory) {
          projectContextForAI = {
            domain:              cached.memory.domain              || 'Software Project',
            techStack:           cached.memory.techStack           || [],
            architecturePattern: cached.memory.architecturePattern || 'Unknown',
            missingBlueprints:   cached.memory.missingBlueprints   || [],
            existingFeatures:    cached.memory.existingFeatures    || [],
          };
        }
      }
    } catch (_) {}

    const totalFilesInSnapshot = (snapshot?.files || []).length;
    if (totalFilesInSnapshot === 0) {
      if (!projectContextForAI.domain || projectContextForAI.domain === 'Software Project' || projectContextForAI.domain === 'Unknown') {
        projectContextForAI.domain = 'Brand new project';
      }
      if (!projectContextForAI.techStack || projectContextForAI.techStack.length === 0 || projectContextForAI.techStack === 'Vanilla JavaScript' || projectContextForAI.techStack === 'Unknown') {
        projectContextForAI.techStack = 'Empty workspace';
      }
    }

    const detectedLang = typeof aiService.detectLanguageFromText === 'function'
      ? aiService.detectLanguageFromText(message)
      : null;
    if (detectedLang) {
      projectContextForAI.techStack = [detectedLang];
      if (snapshot?.rootPath) {
        try {
          projectMemory.update(snapshot.rootPath, {
            techStack: [detectedLang],
          });
        } catch (_) {}
      }
      try {
        sessionStore.saveState({
          techStack: [detectedLang],
        });
      } catch (_) {}
    }

    if (snapshot?.files && snapshot.files.some(f => /\.py$/i.test(f.path || f))) {
      if (!projectContextForAI.techStack || projectContextForAI.techStack.length === 0 || projectContextForAI.techStack.includes('Unknown') || projectContextForAI.techStack.includes('Empty workspace')) {
        projectContextForAI.techStack = ['Python'];
      }
      if (!projectContextForAI.domain || projectContextForAI.domain === 'Software Project' || projectContextForAI.domain === 'Unknown' || projectContextForAI.domain === 'Web Application') {
        projectContextForAI.domain = snapshot.files.some(f => /analyzer/i.test(f.path || f)) ? 'Python Log Analyzer' : 'Python Application';
      }
    }

    // Load saved state
    const savedState = sessionStore.loadState() || {};

    // ── EVALUATIVE QUESTION INTERCEPTION (when options are present) ────────────
    const optionsPresent = (savedState.currentPlan && Array.isArray(savedState.currentPlan.options) && savedState.currentPlan.options.length > 0)
      ? savedState.currentPlan.options
      : (Array.isArray(savedState.options) && savedState.options.length > 0 ? savedState.options : []);

    const isFileQueryEarly = /(how\s+many|koyta)\s+files?/i.test(message) || /what\s+does\s+.*\bdo\b/i.test(message) || /file\s*count/i.test(message);
    const isWhyQuestionEarly = typeof aiService.isWhyQuestion === 'function' && aiService.isWhyQuestion(message);
    const isEvalQuestion = !isFileQueryEarly && !isWhyQuestionEarly && (typeof aiService.isEvaluativeQuestion === 'function'
      ? aiService.isEvaluativeQuestion(message)
      : /(kon\s*(?:option\s*)?ta\s*valo|kon\s*ta\s*valo|konta\s*valo|which\s*(?:option\s*|one\s*)?is\s*better|which\s+is\s+better|recommend|suggest|kivabe\s*korbo)/i.test(message.trim()));

    if (!['add', 'update', 'fix'].includes(rawMode) && isEvalQuestion && optionsPresent.length > 0) {
      console.log('[Chat IPC] Evaluative question intercepted while options are present:', message);
      const activeIntent = savedState.currentIntent || savedState.pendingFeature || (savedState.currentPlan && savedState.currentPlan.task) || 'Feature Implementation';
      const recText = typeof aiService.generateOptionRecommendation === 'function'
        ? await aiService.generateOptionRecommendation(optionsPresent, message, activeIntent, projectContextForAI)
        : `I recommend Option A because it provides the cleanest and most efficient architecture.`;

      const priorHistory = Array.isArray(payload?.conversationHistory) && payload.conversationHistory.length > 0
        ? payload.conversationHistory
        : (Array.isArray(savedState?.chatHistory) ? savedState.chatHistory : []);
      const updatedHistory = [
        ...priorHistory.slice(-500),
        { role: 'user', text: message },
        { role: 'assistant', text: recText },
      ];

      sessionStore.saveState({
        chatHistory: updatedHistory,
        lastAssistantMessage: recText,
      });

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: recText,
        reply: recText,
        responseText: recText,
        mode: 'informational',
        needsOptions: false,
        options: [],
        plan: savedState.currentPlan || null,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    // ── ACTIVE PLAN ARCHITECTURAL INQUIRY & RESTATED FEATURE GUARD ───────────
    const isArchitectureInquiryEarly = /(?:ata|eta|ei\s*feature|ai\s*feature)\s*(?:banaly|banale|kmn|kemon)/i.test(message) ||
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

    const activeTaskLowerEarly = ((savedState.currentPlan?.task || savedState.pendingFeature || savedState.currentIntent) || '');
    const isRestatingFeatureEarly = isRestatingActiveTask(message, activeTaskLowerEarly);

    if (!['add', 'update', 'fix'].includes(rawMode) && optionsPresent.length > 0 && (isArchitectureInquiryEarly || isRestatingFeatureEarly)) {
      console.log('[Chat IPC] Active plan inquiry / restated feature intercepted early:', message);
      const isBengali = /[\u0980-\u09FF]|amr|amar|kmn|kemon|hoby|hobe|banaly|banale|kisu|bolo|thakby|ai|ei|banaite|banate/i.test(message);
      const taskName = savedState.currentPlan?.task || savedState.pendingFeature || 'Feature Implementation';
      const optSummaries = optionsPresent.map(o => `• **${o.label || o.name || 'Option'}:** ${o.description || ''}`).join('\n');
      const replyText = isBengali
        ? `আপনার **${taskName}** প্রজেক্টের জন্য আর্কিটেকচার প্ল্যান প্রস্তুত করা আছে:\n\n${optSummaries}\n\nএটি একটি চমৎকার আর্কিটেকচার হবে। কাজ শুরু করার জন্য উপরের যেকোনো একটি অপশন বেছে নিন।`
        : `For your active plan **${taskName}**, here is the architectural structure:\n\n${optSummaries}\n\nThis will provide a robust architecture. Please select one of the options above to proceed with implementation.`;

      const priorHistory = Array.isArray(payload?.conversationHistory) && payload.conversationHistory.length > 0
        ? payload.conversationHistory
        : (Array.isArray(savedState?.chatHistory) ? savedState.chatHistory : []);
      const updatedHistory = [
        ...priorHistory.slice(-500),
        { role: 'user', text: message },
        { role: 'assistant', text: replyText },
      ];

      sessionStore.saveState({
        chatHistory: updatedHistory,
        lastAssistantMessage: replyText,
      });

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        reply: replyText,
        responseText: replyText,
        mode: 'informational',
        needsOptions: false,
        options: [],
        plan: savedState.currentPlan || null,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    // ── OPTIONS COMMAND & MISSING OPTIONS INTERCEPTOR ─────────────────────────
    const isFeatureExistEarly = typeof aiService.isFeatureExistenceQuestion === 'function'
      ? aiService.isFeatureExistenceQuestion(message)
      : false;

    const isOptionsCmdEarly = !isFeatureExistEarly && (
      (typeof aiService.isOptionsCommand === 'function' && aiService.isOptionsCommand(message)) ||
      (typeof aiService.isMissingOptionsComplaint === 'function' && aiService.isMissingOptionsComplaint(message)) ||
      /\b(option\s*(gula|gulo)?\s*(daw|dao|dekhao|ase\s*nai|ashe\s*nai|nai|dekhina|dekhte\s*pacchi\s*na|koi)|options?\s*(daw|dao|dekhao|missing|are\s*not\s*there|where))\b/i.test(message) ||
      /(অপশন\s*(গুলো|গুলা)?\s*(দাও|দেখা|দেখাও|নাই|আসে\s*নাই|কই))/i.test(message)
    );

    if (!['add', 'update', 'fix'].includes(rawMode) && isOptionsCmdEarly) {
      console.log('[Chat IPC] Options command / missing options complaint intercepted:', message);
      const activeFeature = (savedState.currentPlan && (savedState.currentPlan.task || savedState.currentPlan.userIntent))
        || savedState.pendingFeature
        || savedState.currentIntent
        || 'Feature Implementation';

      let options = (savedState.currentPlan && Array.isArray(savedState.currentPlan.options) && savedState.currentPlan.options.length > 0)
        ? savedState.currentPlan.options
        : (Array.isArray(savedState.currentPlan?.availableApproaches) && savedState.currentPlan.availableApproaches.length > 0 ? savedState.currentPlan.availableApproaches : null);

      if (!options || options.length === 0) {
        try {
          const optResult = await aiService.suggestOptions(activeFeature, {
            ...projectContextForAI,
            files: (snapshot?.files || []).slice(0, 20),
            _snapshot: snapshot,
          });
          if (optResult && Array.isArray(optResult.options) && optResult.options.length > 0) {
            options = optResult.options;
          }
        } catch (err) {
          console.warn('[Chat IPC] suggestOptions error in early options interceptor:', err.message);
        }
      }

      if (!options || options.length === 0) {
        const { getStaticFallbackOptions } = require('../ast/project-type-detector');
        options = getStaticFallbackOptions('unknown', activeFeature);
      }

      const plan = savedState.currentPlan || {
        id: `plan_${Date.now()}`,
        task: activeFeature,
        intentSummary: activeFeature.slice(0, 80),
        userIntent: activeFeature,
        featureType: 'Feature Implementation',
        availableApproaches: options,
        options,
        filesToEdit: [],
        filesToCreate: [],
      };
      plan.options = options;
      plan.availableApproaches = options;
      if (!plan.task) plan.task = activeFeature;

      sessionStore.saveState({
        currentPlan: plan,
        currentIntent: activeFeature,
        pendingFeature: activeFeature,
        pendingAction: 'feature_plan',
      });

      const isBengali = /[\u0980-\u09FF]|gula|gulo|daw|dao|dekhao|bolo|ache|asea|karon|ki\s+ki|nai|ase\s*nai/i.test(message);
      const replyText = isBengali
        ? `এখানে **${activeFeature}** এর জন্য ৩টি আর্কিটেকচার অপশন দেওয়া হলো। নিচে যেকোনো একটি অপশন বেছে নিন:`
        : `Here are the 3 architecture options for **${activeFeature}**. Please select an approach below:`;

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'action',
        needsOptions: true,
        options,
        plan,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    // ── EXPLICIT MODE ROUTING (Add, Update, Fix, Chat) ─────────────────────────
    if (!rawMode) {
      console.error('[Chat IPC] Error: payload.mode was not received in chat:send payload!');
    } else {
      console.log('[Chat IPC] Received mode in payload:', rawMode);
    }
    const explicitMode = ['add', 'update', 'fix', 'chat'].includes(rawMode) ? rawMode : null;

    if (explicitMode === 'add') {
      console.log('[Chat IPC] Explicit Mode Routing: ADD FEATURE for', message);
      const cleanFeature = typeof aiService.extractCleanIntentWithAI === 'function'
        ? await aiService.extractCleanIntentWithAI(message)
        : (typeof aiService.cleanFeatureIntent === 'function' ? aiService.cleanFeatureIntent(message) : message);

      let aiOptions = [];
      try {
        const optResult = await aiService.suggestOptions(cleanFeature, {
          ...projectContextForAI,
          files: (snapshot?.files || []).slice(0, 20),
          _snapshot: snapshot,
        });
        if (optResult && Array.isArray(optResult.options) && optResult.options.length > 0) {
          aiOptions = optResult.options;
        }
      } catch (err) {
        console.warn('[Chat IPC] suggestOptions failed in add mode:', err.message);
      }

      const analysis = analyzeFeature(cleanFeature, snapshot);
      let finalOptions = aiOptions.length > 0 ? aiOptions : analysis.availableApproaches;

      const { detectProjectType } = require('../ast/project-type-detector');
      const typeResult = detectProjectType(snapshot, projectContextForAI || {});
      const isFrontendProj = typeResult.projectType === 'frontend';

      let initialFilesToCreate = [];
      let initialFilesToEdit = (snapshot?.files || []).slice(0, 3).map(f => f.path);
      if (finalOptions.length > 0 && finalOptions[0]) {
        const topOpt = finalOptions[0];
        if (Array.isArray(topOpt.filesToCreate) && topOpt.filesToCreate.length > 0) {
          initialFilesToCreate = [...topOpt.filesToCreate];
        }
        if (Array.isArray(topOpt.filesToEdit) && topOpt.filesToEdit.length > 0) {
          initialFilesToEdit = [...topOpt.filesToEdit];
        }
      }

      const userWantsModules = /\b(modular|modules?)\b/i.test(message);
      if (isFrontendProj && !userWantsModules) {
        initialFilesToCreate = initialFilesToCreate.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
        initialFilesToEdit = initialFilesToEdit.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
      }

      const detectedMessageLang = typeof aiService.detectLanguageFromText === 'function'
        ? aiService.detectLanguageFromText(message)
        : null;
      const isCppOrSystem = (Array.isArray(projectContextForAI.techStack) ? projectContextForAI.techStack : [projectContextForAI.techStack])
        .some(t => /c\+\+|cpp|c|rust|go|python|java|ruby|c#/i.test(String(t)))
        || (detectedMessageLang && ['C++', 'Rust', 'Go', 'Python', 'Java', 'Ruby', 'C#'].includes(detectedMessageLang))
        || /(?:^|\W)(?:c\+\+|cpp|rust|golang|python|java|ruby)(?:$|\W)/i.test(message);

      if (isCppOrSystem) {
        initialFilesToCreate = initialFilesToCreate.filter(f => !/\.(html|js|css)$/i.test(f));
        initialFilesToEdit = initialFilesToEdit.filter(f => !/\.(html|js|css)$/i.test(f));
          if (/delete|clean|timer|delay/i.test(message)) {
            initialFilesToCreate = ['file_cleaner.py'];
          } else if (/python/i.test(message) || detectedMessageLang === 'Python' || (Array.isArray(projectContextForAI.techStack) && projectContextForAI.techStack.includes('Python'))) {
            initialFilesToCreate = ['log_analyzer.py'];
          } else {
            initialFilesToCreate = ['main.cpp'];
          }
      } else if (isFrontendProj && (!snapshot || !snapshot.files || snapshot.files.length === 0)) {
        initialFilesToCreate = ['index.html', 'style.css', 'app.js'];
        initialFilesToEdit = [];
      }

      // ── Synthesize raw input into professional English requirements ─────────────
      let synthesizedRequirements = [message];
      try {
        if (typeof aiService.synthesizeRequirementsWithAI === 'function') {
          synthesizedRequirements = await aiService.synthesizeRequirementsWithAI(message);
        }
      } catch (err) {
        console.warn('[Chat IPC] synthesizeRequirementsWithAI failed:', err.message);
      }

      // ── Clear stale selectedOption/selectedApproach for new feature ────────────
      // A new feature must never inherit options from a previous plan
      const planId = `plan_${Date.now()}`;
      const plan = {
        id: planId,
        task: cleanFeature,
        intentSummary: cleanFeature,
        userIntent: cleanFeature,
        rawUserPrompt: message,
        selectedOption: null,        // ← cleared: user must pick an option
        selectedOptionName: null,    // ← cleared: user must pick an option
        filesToEdit: initialFilesToEdit,
        filesToCreate: initialFilesToCreate,
        options: finalOptions,
        availableApproaches: finalOptions,
        status: 'proposed',
        activeFeatureRequirements: synthesizedRequirements,
      };

      sessionStore.saveState({
        currentIntent: cleanFeature,
        pendingFeature: cleanFeature,
        currentPlan: plan,
        pendingAction: 'feature_plan',
        selectedOption: null,         // ← clear stale approach from session
        selectedOptionName: null,     // ← clear stale approach from session
        selectedApproach: null,       // ← clear stale approach from session
        activeFeatureRequirements: synthesizedRequirements,
      });

      const replyText = `I have prepared 3 architecture options to add **${cleanFeature}**. Select an approach below:`;
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'action',
        needsOptions: true,
        options: finalOptions,
        plan,
        isClarification: false,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    if (explicitMode === 'update') {
      console.log('[Chat IPC] Explicit Mode Routing: UPDATE FEATURE for', message);
      const cleanFeature = typeof aiService.extractCleanIntentWithAI === 'function'
        ? await aiService.extractCleanIntentWithAI(message)
        : (typeof aiService.cleanFeatureIntent === 'function' ? aiService.cleanFeatureIntent(message) : message);
      const updateIntent = cleanFeature.toLowerCase().startsWith('update ')
        ? cleanFeature
        : ('Update ' + cleanFeature);

      let aiOptions = [];
      try {
        const optResult = await aiService.suggestOptions(updateIntent, {
          ...projectContextForAI,
          files: (snapshot?.files || []).slice(0, 20),
          _snapshot: snapshot,
          isRefactor: true,
        });
        if (optResult && Array.isArray(optResult.options) && optResult.options.length > 0) {
          aiOptions = optResult.options;
        }
      } catch (err) {
        console.warn('[Chat IPC] suggestOptions failed in update mode:', err.message);
      }

      const analysis = analyzeFeature(updateIntent, snapshot);
      let finalOptions = aiOptions.length > 0 ? aiOptions : analysis.availableApproaches;

      const { detectProjectType } = require('../ast/project-type-detector');
      const typeResult = detectProjectType(snapshot, projectContextForAI || {});
      const isFrontendProj = typeResult.projectType === 'frontend';

      let initialFilesToCreate = [];
      let initialFilesToEdit = (snapshot?.files || []).slice(0, 3).map(f => f.path);
      if (finalOptions.length > 0 && finalOptions[0]) {
        const topOpt = finalOptions[0];
        if (Array.isArray(topOpt.filesToCreate) && topOpt.filesToCreate.length > 0) {
          initialFilesToCreate = [...topOpt.filesToCreate];
        }
        if (Array.isArray(topOpt.filesToEdit) && topOpt.filesToEdit.length > 0) {
          initialFilesToEdit = [...topOpt.filesToEdit];
        }
      }

      const userWantsModules = /\b(modular|modules?)\b/i.test(message);
      if (isFrontendProj && !userWantsModules) {
        initialFilesToCreate = initialFilesToCreate.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
        initialFilesToEdit = initialFilesToEdit.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
      }

      const planId = `plan_${Date.now()}`;
      const plan = {
        id: planId,
        task: updateIntent,
        intentSummary: updateIntent,
        userIntent: updateIntent,
        rawUserPrompt: message,
        selectedOption: finalOptions.length > 0 ? finalOptions[0] : undefined,
        selectedOptionName: finalOptions.length > 0 ? (finalOptions[0].name || finalOptions[0].label) : undefined,
        filesToEdit: initialFilesToEdit,
        filesToCreate: initialFilesToCreate,
        options: finalOptions,
        availableApproaches: finalOptions,
        status: 'proposed',
        activeFeatureRequirements: [message],
      };

      sessionStore.saveState({
        currentIntent: updateIntent,
        pendingFeature: cleanFeature,
        currentPlan: plan,
        pendingAction: 'update_feature',
        activeFeatureRequirements: [message],
      });

      const replyText = `I have prepared refactoring options to update **${cleanFeature}**. Select an approach below:`;
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'action',
        needsOptions: true,
        options: finalOptions,
        plan,
        isClarification: false,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    if (explicitMode === 'fix') {
      console.log('[Chat IPC] Explicit Mode Routing: FIX BUG for', message);
      const totalFiles = (snapshot?.files || []).length;
      if (totalFiles === 0) {
        const replyText = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
        const response = {
          id: `msg_ai_${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: replyText,
          mode: 'normal',
          options: [],
          plan: null,
          isBugFix: false,
          isClarification: false,
        };
        return { ok: true, response };
      }

      const { buildBugFixPrompt } = require('../rules/prompt-builder');
      let projectFilesList = [];
      if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        projectFilesList = snapshot.files.map(f => f.path || f);
      } else {
        projectFilesList = ['index.html', 'style.css', 'app.js'];
      }

      const bugFixResult = await buildBugFixPrompt({
        currentIntent: message,
        userBugReport: message,
        projectFiles: projectFilesList,
        snapshot,
        agent: 'antigravity',
      });
      const bugFixPrompt = bugFixResult.prompt;
      const bugFixMetadata = bugFixResult.metadata;
      const bugIntent = bugFixMetadata?.intent || message;
      const updatedPromptHistory = [
        ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
        {
          prompt: bugFixPrompt,
          feature: 'Bug Fix: ' + (bugIntent || message).slice(0, 60),
          featureName: 'Bug Fix',
          task: bugIntent || message,
          intent: bugIntent,
          timestamp: Date.now(),
          generatedAt: new Date().toISOString(),
          agent: 'antigravity',
          promptPreview: bugFixPrompt.slice(0, 160),
          isBugFix: true,
        },
      ];

      sessionStore.saveState({
        currentIntent: message,
        bugIntent,
        pendingFeature: null,
        activeFeatureRequirements: [message],
        lastGeneratedPrompt: bugFixPrompt,
        promptHistory: updatedPromptHistory,
        isBugFix: true,
        pendingAction: null,
        pendingBugReport: null,
      });

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: bugFixPrompt,
          metadata: bugFixMetadata,
          promptHistory: updatedPromptHistory,
          isBugFix: true,
        });
      }

      const replyText = "I have analyzed the bug and generated the fix prompt. Click below to open it.";
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'bug_fix_ready',
        options: [],
        plan: null,
        isBugFix: true,
        intent: bugIntent,
        task: bugIntent,
        prompt: bugFixPrompt,
        metadata: bugFixMetadata,
        promptHistory: updatedPromptHistory,
      };
      return { ok: true, response };
    }

    if (explicitMode === 'chat') {
      console.log('[Chat IPC] Explicit Mode Routing: NORMAL CHAT for', message);
      // Retrieve and preserve conversation history across turns
      const conversationHistory = Array.isArray(payload?.conversationHistory) && payload.conversationHistory.length > 0
        ? payload.conversationHistory
        : (Array.isArray(savedState?.chatHistory) ? savedState.chatHistory : []);

      function saveAndReturnChat(replyText, extra = {}) {
        const updatedChatHistory = [
          ...conversationHistory.slice(-500),
          { role: 'user', text: message },
          { role: 'assistant', text: replyText },
        ];
        sessionStore.saveState({
          chatHistory: updatedChatHistory,
          lastAssistantMessage: replyText,
        });
        return {
          ok: true,
          response: {
            id: `msg_ai_${Date.now()}`,
            role: 'assistant',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            text: replyText,
            mode: 'informational',
            options: [],
            plan: null,
            needsOptions: false,
            isBugFix: false,
            isClarification: false,
            ...extra,
          }
        };
      }

      const hasPlanOptions = Boolean(savedState.currentPlan && Array.isArray(savedState.currentPlan.options) && savedState.currentPlan.options.length > 0);
      const planOptionsList = hasPlanOptions ? savedState.currentPlan.options : [];
      const isEval = typeof aiService.isEvaluativeQuestion === 'function'
        ? aiService.isEvaluativeQuestion(message)
        : false;

      // 1. Evaluative question routing in chat mode
      if (hasPlanOptions && isEval) {
        console.log('[Chat IPC] Chat mode evaluative question with active plan:', message);
        const activeIntent = savedState.currentPlan?.task || savedState.currentIntent || 'Feature Implementation';
        const recText = typeof aiService.generateOptionRecommendation === 'function'
          ? await aiService.generateOptionRecommendation(planOptionsList, message, activeIntent, projectContextForAI)
          : `I recommend Option A because it provides the cleanest and most efficient architecture.`;

        return saveAndReturnChat(recText, {
          mode: 'informational',
          needsOptions: false,
          options: [],
          plan: savedState.currentPlan,
        });
      }

      const actionIntent = typeof aiService.detectChatModeIntent === 'function'
        ? aiService.detectChatModeIntent(message)
        : null;

      // 2. Prevent "Empty Workspace" hijack when user re-states feature or asks architecture questions ("ata banaly kmn hoby?")
      const isArchitectureInquiry = /(?:ata|eta|ei\s*feature|ai\s*feature)\s*(?:banaly|banale|kmn|kemon)/i.test(message) ||
        /(?:banaly|banale)\s*(?:kmn|kemon)/i.test(message) ||
        /^(?:ata|eta)\s*banaly\s*kmn\s*hoby\??$/i.test(message.trim());

      const activeTaskLower = ((savedState.currentPlan?.task || savedState.pendingFeature || savedState.currentIntent) || '');
      const isRestatingFeature = isRestatingActiveTask(message, activeTaskLower);

      if (hasPlanOptions && (isArchitectureInquiry || isRestatingFeature)) {
        console.log('[Chat IPC] Active plan inquiry / restated feature intercepted in chat mode:', message);
        const isBengali = /[\u0980-\u09FF]|amr|amar|kmn|kemon|hoby|hobe|banaly|banale|kisu|bolo|thakby|ai|ei|banaite|banate/i.test(message);
        const taskName = savedState.currentPlan.task || 'Feature';
        const optSummaries = planOptionsList.map(o => `• **${o.label || o.name || 'Option'}:** ${o.description || ''}`).join('\n');
        const replyText = isBengali
          ? `আপনার **${taskName}** প্রজেক্টের জন্য আর্কিটেকচার অপশনগুলো প্রস্তুত আছে:\n\n${optSummaries}\n\nএটি একটি চমৎকার আর্কিটেকচার হবে। কাজ শুরু করার জন্য উপরের যেকোনো একটি অপশন বেছে নিন।`
          : `For your active plan **${taskName}**, here is the architectural structure:\n\n${optSummaries}\n\nThis will provide a robust architecture. Please select one of the options above to proceed with implementation.`;

        return saveAndReturnChat(replyText, {
          mode: 'informational',
          needsOptions: false,
          options: [],
          plan: savedState.currentPlan,
        });
      }

      // Explicit coding transition: Developer is ready to build/generate prompt
      const isCodingTransition = typeof aiService.isCodingTransitionIntent === 'function'
        ? aiService.isCodingTransitionIntent(message)
        : /^(?:okay,?\s*|ok,?\s*)?(?:let'?s\s+(?:start\s+)?(?:coding|building|implementation)|start\s+(?:coding|building|implementing|now)|generate\s+prompt|prompt\s+(?:daw|dao|banao|den)|ekhon\s+prompt\s+(?:daw|dao)|code\s+shuru\s+kori|shuru\s+kora\s+jak|start\s+project\s+now)$/i.test(message.trim().replace(/[.!?,]+$/, ''));

      if (isCodingTransition) {
        const isBengali = /[\u0980-\u09FF]|shuru|kori|jak|daw|dao/i.test(message);
        const replyText = isBengali
          ? "কোড শুরু করতে এবং আর্কিটেকচার ব্লুপ্রিন্ট তৈরি করতে দয়া করে উপরের ➕ Add Feature বাটনে ক্লিক করুন।"
          : "Please click the ➕ Add Feature button above to select your architecture blueprint and start building.";
        return saveAndReturnChat(replyText);
      }

      const totalFiles = (snapshot?.files || []).length;
      if (totalFiles > 0) {
        if (actionIntent === 'add') {
          const replyText = "I understand you want to add this. Please select the ➕ Add Feature button above the chat box to proceed.";
          return saveAndReturnChat(replyText);
        }
        if (actionIntent === 'update') {
          const replyText = "I understand you want to update this. Please select the 🔄 Update Feature button above the chat box to proceed.";
          return saveAndReturnChat(replyText);
        }
        if (actionIntent === 'fix') {
          const replyText = "I understand you want to fix this. Please select the 🐞 Fix Bug button above to proceed.";
          return saveAndReturnChat(replyText);
        }
      }

      // Remove static regex checks: Pass full projectMemory, astSummary, and conversationHistory to aiService.chatRespond
      const astSummary = typeof aiService.buildAstSummary === 'function'
        ? aiService.buildAstSummary(snapshot)
        : null;

      let aiText = '';
      let chatRes = null;
      try {
        chatRes = await aiService.chatRespond(message, {
          snapshot,
          astSummary,
          projectContext: projectContextForAI,
          projectMemory: projectContextForAI,
          conversationHistory,
          projectPath: savedState?.currentProjectPath || snapshot?.rootPath,
          mode: 'chat',
          currentPlan: savedState?.currentPlan,
          session: savedState,
        });
        aiText = chatRes.responseText || chatRes.reply || "I am here to discuss your project. Use the mode buttons above to add, update, or fix code.";
      } catch (err) {
        console.warn('[Chat IPC] chatRespond error in chat mode:', err.message);
        aiText = "I am here to discuss your project. Use the mode buttons above to add, update, or fix code.";
      }

      // If AI generated options or response text indicates architecture options are prepared:
      const hasDirectOptions = chatRes && Array.isArray(chatRes.options) && chatRes.options.length > 0;
      const textHasOptions = /(prepared.*options|architectural options|choose an approach|select.*approach|options below|3 options)/i.test(aiText);

      if (hasDirectOptions || (chatRes && chatRes.needsOptions) || textHasOptions) {
        let options = hasDirectOptions
          ? chatRes.options
          : (Array.isArray(chatRes?.plan?.options) && chatRes.plan.options.length > 0 ? chatRes.plan.options : (savedState.currentPlan?.options || []));

        const activeFeature = savedState.currentPlan?.task || savedState.pendingFeature || savedState.currentIntent || message;

        if (options.length === 0) {
          try {
            const optResult = await aiService.suggestOptions(activeFeature, {
              ...projectContextForAI,
              files: (snapshot?.files || []).slice(0, 20),
              _snapshot: snapshot,
            });
            if (optResult && Array.isArray(optResult.options) && optResult.options.length > 0) {
              options = optResult.options;
            }
          } catch (_) {}
        }

        if (options.length > 0) {
          const plan = chatRes?.plan || savedState.currentPlan || {
            id: `plan_${Date.now()}`,
            task: activeFeature,
            options,
          };
          plan.options = options;

          sessionStore.saveState({
            currentPlan: plan,
            currentIntent: plan.task || savedState.currentIntent,
            pendingFeature: plan.task || savedState.pendingFeature,
            pendingAction: 'feature_plan',
          });

          return {
            ok: true,
            response: {
              id: `msg_ai_${Date.now()}`,
              role: 'assistant',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              text: aiText,
              mode: 'action',
              needsOptions: true,
              options,
              plan,
              isBugFix: false,
              isClarification: false,
            }
          };
        }
      }

      return saveAndReturnChat(aiText);
    }

    // 0a. General Project Queries (File count & Feature list) - run BEFORE Feature Existence
    const FILE_COUNT_REGEX = /(koyta file|how many files|file count|কয়টা ফাইল)/i;
    const FEATURE_LIST_REGEX = /(ki ki feature|ki ki ase|what features|list features)/i;

    const isFileCount = typeof aiService.isFileCountQuery === 'function'
      ? aiService.isFileCountQuery(message)
      : FILE_COUNT_REGEX.test(message);

    const isFeatureList = typeof aiService.isFeatureListQuery === 'function'
      ? aiService.isFeatureListQuery(message)
      : FEATURE_LIST_REGEX.test(message);

    if (isFileCount) {
      const fileCount = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files.length : 0;
      const replyText = `Your project has ${fileCount} files.`;
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'informational',
        options: [],
        plan: null,
        needsOptions: false,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    if (isFeatureList) {
      const astSummary = typeof aiService.buildAstSummary === 'function'
        ? aiService.buildAstSummary(snapshot)
        : null;
      const replyText = typeof aiService.formatProjectFeatureList === 'function'
        ? aiService.formatProjectFeatureList(snapshot, astSummary)
        : `Here are the existing features and files in your project:\n${(snapshot?.files || []).map(f => `- ${f.path || f}`).join('\n')}`;

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'informational',
        options: [],
        plan: null,
        needsOptions: false,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    // 0b. Intercept Feature Existence Questions (Clear stale context immediately)
    const FEATURE_EXISTENCE_REGEX = /(\b(ase|ache)\b\??|is there|do we have|does.*exist|ki ki ase)/i;
    const isFeatureExistence = typeof aiService.isFeatureExistenceQuestion === 'function'
      ? aiService.isFeatureExistenceQuestion(message)
      : (FEATURE_EXISTENCE_REGEX.test(message) && !isFileCount && !isFeatureList);

    if (isFeatureExistence) {
      console.log('[Chat IPC] Feature existence question intercepted, clearing stale context');
      savedState.currentIntent = null;
      savedState.pendingAction = null;
      savedState.currentPlan = null;
      savedState.pendingFeature = null;
      savedState.pendingBugReport = null;
      savedState.activeFeatureRequirements = [];
      sessionStore.saveState({
        currentIntent: null,
        pendingAction: null,
        currentPlan: null,
        pendingFeature: null,
        pendingBugReport: null,
        activeFeatureRequirements: [],
      });
    }

    // 0c. Intercept Vague Project Requests (Ask for clarification)
    const isVagueProject = typeof aiService.isVagueProjectRequest === 'function'
      ? aiService.isVagueProjectRequest(message)
      : /(new project|notun project|build a project|kisu banabo|ki banabo)/i.test(message);

    if (isVagueProject) {
      console.log('[Chat IPC] Vague project request intercepted:', message);
      const replyText = "Great! What kind of project would you like to build? (e.g., Web App, Game, CLI Tool, Backend API)";
      sessionStore.saveState({
        pendingAction: null,
        currentIntent: null,
        currentPlan: null,
        lastAssistantMessage: replyText,
      });
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'clarification_needed',
        options: [],
        plan: null,
        needsOptions: false,
        isBugFix: false,
        isClarification: true,
      };
      return { ok: true, response };
    }

    // 1. Check for Meta-Commands with active Bug Report before AI call
    let newRequestFromConfirm = typeof aiService.extractNewRequestFromConfirmation === 'function'
      ? aiService.extractNewRequestFromConfirmation(message)
      : null;

    if (newRequestFromConfirm) {
      console.log('[Chat IPC] Override confirmation with new feature request:', newRequestFromConfirm);
      message = newRequestFromConfirm;
      savedState.pendingAction = null;
      savedState.pendingBugReport = null;
      sessionStore.saveState({ pendingAction: null, pendingBugReport: null });
    }

    const META_COMMAND_REGEX = /(prompt daw|prompt dao|give.*prompt|fix.*prompt|generate prompt|\bok\b|\bok\s+fix\b|\bprompt\b)/i;
    const isMetaCommand = META_COMMAND_REGEX.test(message.trim());
    if (isMetaCommand && savedState.pendingBugReport) {
      console.log('[Chat IPC] Meta-command with pending bug report -> Generating Bug Fix Prompt:', savedState.pendingBugReport);
      const { buildBugFixPrompt } = require('../rules/prompt-builder');
      let projectFilesList = [];
      if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        projectFilesList = snapshot.files.map(f => f.path || f);
      } else {
        projectFilesList = ['index.html', 'style.css', 'app.js'];
      }

      const bugReportText = savedState.pendingBugReport;
      const bugFixResult = await buildBugFixPrompt({
        currentIntent: bugReportText,
        userBugReport: bugReportText,
        projectFiles: projectFilesList,
        snapshot,
        agent: 'antigravity',
      });
      const bugFixPrompt = bugFixResult.prompt;
      const bugFixMetadata = bugFixResult.metadata;

      const updatedPromptHistory = [
        ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
        {
          prompt: bugFixPrompt,
          feature: 'Bug Fix: ' + bugReportText.slice(0, 60),
          featureName: 'Bug Fix',
          task: bugReportText,
          timestamp: Date.now(),
          generatedAt: new Date().toISOString(),
          agent: 'antigravity',
          promptPreview: bugFixPrompt.slice(0, 160),
          isBugFix: true,
        },
      ];

      sessionStore.saveState({
        currentIntent: bugReportText,
        lastGeneratedPrompt: bugFixPrompt,
        promptHistory: updatedPromptHistory,
        isBugFix: true,
        pendingAction: null,
        pendingBugReport: null,
      });

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: bugFixPrompt,
          metadata: bugFixMetadata,
          promptHistory: updatedPromptHistory,
          isBugFix: true,
        });
      }

      const replyText = "I have generated the fix prompt. Click below to open it.";
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'bug_fix_ready',
        options: [],
        plan: null,
        isBugFix: true,
        prompt: bugFixPrompt,
        metadata: bugFixMetadata,
        promptHistory: updatedPromptHistory,
      };
      return { ok: true, response };
    }

    // 1b. Call AI Service for live conversational intelligence
    let aiRes = null;
    try {
      aiRes = await aiService.chatRespond(message, {
        snapshot,
        projectContext: projectContextForAI,
        conversationHistory: savedState?.chatHistory || [],
        activeRules: savedState?.activeRules || [],
      });
    } catch (err) {
      console.warn('[Chat IPC] AI chat error, API limit reached or network failed:', err.message);
      aiRes = { success: false, error: 'API_LIMIT_REACHED' };
    }

    const isOptionsCmd = !isFeatureExistence && (typeof aiService.isOptionsCommand === 'function'
      ? aiService.isOptionsCommand(message)
      : /\b(options?|choices?|approaches?)\b|(অপশন|চয়েস)/i.test(message));

    const isPromptCmd = typeof aiService.isPromptCommand === 'function'
      ? aiService.isPromptCommand(message)
      : /\b(prompt|strict\s+prompt|directive|ready\s+koro|plan\s+dao|plan\s+daw|banao)\b|(প্রম্পট|রেডি\s*করো|বানাও)/i.test(message);

    const isBuildCmd = typeof aiService.isBuildCommand === 'function'
      ? aiService.isBuildCommand(message)
      : /(build|banai|banao|start|shuru|proceed)/i.test(message);

    const isBroadCmd = /(prompt|plan|option|choice|generate|dao|daw|ready|koro|banao|build|banai|start|shuru|proceed)/i.test(message);
    const isCommandOrContextual = isOptionsCmd || isPromptCmd || isBuildCmd || isBroadCmd || isMetaCommand || savedState.pendingBugReport || savedState.pendingFeature || savedState.currentPlan;

    // Fail-Fast: If AI hit rate limits (429) or all providers failed, check for greeting first
    if (aiRes && (aiRes.error === 'API_LIMIT_REACHED' || aiRes.success === false) && !isCommandOrContextual) {
      const isGreeting = typeof aiService.isGreeting === 'function'
        ? aiService.isGreeting(message)
        : /^\s*(hi|hello|hey)\b/i.test(message);

      if (isGreeting) {
        const offlineGreeting = "Hello! I am running in offline mode right now. Please check your API key or wait for the limit to reset. How can I help you?";
        const response = {
          id: `msg_ai_${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: offlineGreeting,
          mode: 'chat',
          options: [],
          plan: null,
        };
        sessionStore.saveState({ lastAssistantMessage: offlineGreeting });
        return { ok: true, response };
      }

      const isBengali = /[\u0980-\u09FF]|koyta|ache|asea|amr|amar|bolo|sondor|kaj|korse|kno|hosse|daw/i.test(message);
      const text = isBengali
        ? "🚫 **API লিমিট শেষ।** দয়া করে কিছুক্ষণ অপেক্ষা করুন, অথবা Settings থেকে নতুন API Key দিন।"
        : "🚫 **API Limit Exceeded.** Please wait for the limit to reset, or change your API key in Settings.";

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text,
        error: 'API_LIMIT_REACHED',
        isError: true,
        options: [],
        plan: null,
      };
      sessionStore.saveState({ lastAssistantMessage: text });
      return { ok: true, response };
    }

    // 1b-0. Feature Existence / Action Query Response
    if (isFeatureExistence) {
      console.log('[Chat IPC] Feature existence query answered:', aiRes?.reply);
      const replyText = aiRes?.responseText || aiRes?.reply || "I checked your project for this feature.";
      const pendingAct = aiRes?.pendingAction || 'add_feature';
      const featureSubj = aiRes?.featureSubject || (typeof aiService.extractFeatureSubject === 'function' ? aiService.extractFeatureSubject(message) : '');
      const mode = aiRes?.mode || 'informational';
      const needsOptions = aiRes?.needsOptions ?? false;
      const options = Array.isArray(aiRes?.options) ? aiRes.options : [];
      const plan = aiRes?.plan || null;

      sessionStore.saveState({
        currentIntent: plan ? plan.task : null,
        currentPlan: plan,
        pendingAction: pendingAct,
        pendingFeature: featureSubj,
        lastAssistantMessage: replyText,
      });

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode,
        options,
        plan,
        needsOptions,
        pendingAction: pendingAct,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    // 1b-00. Context Follow-Up "Why?" Question Handling
    const isWhy = typeof aiService.isWhyQuestion === 'function' && aiService.isWhyQuestion(message);
    if (isWhy) {
      const isButtonMentioned = /(button|btn|click|press|listener|event|start-btn)/i.test(message);
      if (!isButtonMentioned) {
        const replyText = (aiRes && aiRes.reply && !aiRes.reply.includes('start-btn'))
          ? (aiRes.responseText || aiRes.reply)
          : "I apologize. I failed to understand your previous command. I am trying to extract the feature name correctly now.";
        sessionStore.saveState({ lastAssistantMessage: replyText });
        const response = {
          id: `msg_ai_${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: replyText,
          mode: 'informational',
          options: [],
          plan: null,
          needsOptions: false,
          isBugFix: false,
          isClarification: false,
        };
        return { ok: true, response };
      }
    }

    // 1b. Bug Explanation Detection (Explaining cause using AST)
    const isExplanation = (aiRes && aiRes.mode === 'bug_explanation') ||
      (typeof aiService.isBugExplanationIntent === 'function' && aiService.isBugExplanationIntent(message));

    // 1b-2. Conversational Questions & Inquiries (e.g. "ki ki feature thakby", "kemon hobe", "how will it look", "details bolo")
    const isQuestion = typeof aiService.isConversationalQuestion === 'function'
      ? aiService.isConversationalQuestion(message)
      : (message.includes('?') || /(ki\s+ki|kemon\s+hobe|details\s+bolo|bistarito|thakby|thakbe)/i.test(message));

    if (!isExplanation && !isOptionsCmd && !isPromptCmd && !isBuildCmd && isQuestion) {
      console.log('[Chat IPC] Conversational question detected, preserving intent:', savedState.currentIntent);
      let replyText = (aiRes && (aiRes.responseText || aiRes.reply)) ? (aiRes.responseText || aiRes.reply) : null;
      if (!replyText || replyText.includes('API Limit Exceeded')) {
        const fallRes = await aiService.chatRespond(message, {
          snapshot,
          projectContext: projectContextForAI,
          pendingFeature: savedState.pendingFeature || savedState.currentIntent,
        });
        replyText = fallRes?.responseText || fallRes?.reply || "Here are the details for your request.";
      }

      // DO NOT overwrite currentIntent, pendingFeature, or activeFeatureRequirements!
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'informational',
        options: [],
        plan: savedState.currentPlan || null,
        needsOptions: false,
        isBugFix: false,
        isClarification: false,
      };
      return { ok: true, response };
    }

    if (isExplanation) {
      console.log('[Chat IPC] Bug Explanation detected for message:', message);
      let explanationText = (aiRes && aiRes.mode === 'bug_explanation' && (aiRes.responseText || aiRes.reply))
        ? (aiRes.responseText || aiRes.reply)
        : null;

      if (!explanationText || explanationText.includes('generate a prompt to fix it')) {
        const totalFiles = (snapshot?.files || []).length;
        if (totalFiles === 0) {
          explanationText = "There are no files in this project yet. Please select the ➕ Add Feature button to start your project.";
        } else {
          explanationText = typeof aiService.generateAstBugExplanation === 'function'
            ? aiService.generateAstBugExplanation({
                message,
                snapshot,
                projectPath: savedState.currentProjectPath,
              })
            : 'I checked your code. Please review the relevant source files.';
        }
      }

      sessionStore.saveState({
        pendingAction: null,
        pendingBugReport: null,
      });

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: explanationText,
        mode: 'bug_explanation',
        options: [],
        plan: null,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    // 1c. Semantic Meta-Command / Command Request Handling (Offline / Fallback Safe)
    if (!isExplanation && (isOptionsCmd || (isBroadCmd && /(option|choice)/i.test(message)))) {
      console.log('[Chat IPC] Command Request for Options:', message);
      const activeFeature = savedState.pendingFeature || savedState.currentIntent || savedState.currentPlan?.task || 'Feature Implementation';
      let options = (savedState.currentPlan && Array.isArray(savedState.currentPlan.options) && savedState.currentPlan.options.length > 0)
        ? savedState.currentPlan.options
        : null;

      if (!options || options.length === 0) {
        const optResult = await aiService.suggestOptions(activeFeature, {
          ...projectContextForAI,
          files: (snapshot?.files || []).slice(0, 20),
          _snapshot: snapshot,
        });
        options = Array.isArray(optResult.options) ? optResult.options : [];
      }

      const plan = savedState.currentPlan || {
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

      sessionStore.saveState({
        currentPlan: plan,
        currentIntent: activeFeature,
      });

      const isBengali = /[\u0980-\u09FF]|gula|gulo|daw|dao|dekhao|bolo|ache|asea|karon|ki\s+ki/i.test(message);
      const replyText = isBengali ? "এখানে অপশনগুলো পুনরায় দেওয়া হলো:" : "Here are the options again:";

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'action',
        options,
        plan,
        needsOptions: true,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    if (!isExplanation && (isPromptCmd || isBuildCmd || (isBroadCmd && /(prompt|plan|dao|daw|ready|koro|banao|build|banai|start|shuru|proceed)/i.test(message)))) {
      if (savedState.pendingBugReport) {
        // Will be handled in bug fix confirmation
      } else if (savedState.currentPlan && Array.isArray(savedState.currentPlan.options) && savedState.currentPlan.options.length > 0 && savedState.pendingAction !== 'feature_plan') {
        console.log('[Chat IPC] Command Request for Prompt with active plan:', savedState.currentPlan.task);
        const { buildStrictPrompt } = require('../rules/prompt-builder');
        const plan = savedState.currentPlan;
        const featureTask = plan.task || plan.intentSummary || plan.userIntent || savedState.currentIntent || 'Feature Implementation';
        let activeSnap = snapshot;
        let projRoot = savedState.lastActiveProjectPath || null;
        if (!projRoot) {
          try {
            const pIpc = require('./project-ipc');
            projRoot = pIpc.getActiveRootPath();
          } catch (_) {}
        }
        if (projRoot && astEngineRef) {
          try {
            if (typeof astEngineRef.scan === 'function') activeSnap = await astEngineRef.scan(projRoot);
            else if (typeof astEngineRef.rescan === 'function') activeSnap = await astEngineRef.rescan(projRoot);
          } catch (_) {}
        }

        const promptResult = await buildStrictPrompt({
          plan,
          currentIntent: featureTask,
          task: featureTask,
          feature: featureTask,
          userIntent: featureTask,
          activeFeatureRequirements: savedState.activeFeatureRequirements || [featureTask],
          snapshot: activeSnap || snapshot,
          projectMemory: projectContextForAI,
        });

        const updatedPromptHistory = [
          ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
          {
            prompt: promptResult.prompt,
            feature: featureTask,
            featureName: featureTask,
            task: featureTask,
            timestamp: Date.now(),
            generatedAt: new Date().toISOString(),
            agent: savedState.selectedTargetAI || 'cursor',
            planId: plan.id,
            promptPreview: promptResult.prompt.slice(0, 160),
            isBugFix: false,
          },
        ];

        sessionStore.saveState({
          currentIntent: featureTask,
          lastGeneratedPrompt: promptResult.prompt,
          currentPlan: plan,
          promptHistory: updatedPromptHistory,
          pendingAction: null,
          pendingFeature: null,
        });

        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('prompt:ready', {
            prompt: promptResult.prompt,
            metadata: promptResult.metadata || {},
            promptHistory: updatedPromptHistory,
            isBugFix: false,
          });
        }

        const response = {
          id: `msg_ai_${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "I have generated the strict prompt for your feature.",
          mode: 'action',
          options: plan.options || [],
          plan,
          prompt: promptResult.prompt,
          metadata: promptResult.metadata,
          promptHistory: updatedPromptHistory,
          needsOptions: false,
          isBugFix: false,
        };
        return { ok: true, response };
      } else if (savedState.pendingFeature || savedState.pendingAction === 'feature_plan' || savedState.currentIntent) {
        console.log('[Chat IPC] Command Request for Prompt on pending feature -> Presenting Options:', savedState.pendingFeature);
        const featureText = savedState.pendingFeature || savedState.currentIntent || 'Feature Implementation';
        const optResult = await aiService.suggestOptions(featureText, {
          ...projectContextForAI,
          files: (snapshot?.files || []).slice(0, 20),
          _snapshot: snapshot,
        });
        const options = Array.isArray(optResult.options) ? optResult.options : [];
        const plan = {
          id: `plan_${Date.now()}`,
          task: featureText,
          intentSummary: featureText.slice(0, 80),
          userIntent: featureText,
          featureType: optResult.featureType || 'Feature Implementation',
          availableApproaches: options,
          options,
          filesToEdit: [],
          filesToCreate: ['index.html', 'style.css', 'app.js'],
        };

        sessionStore.saveState({
          currentPlan: plan,
          currentIntent: featureText,
          pendingAction: null,
          pendingFeature: null,
        });

        const replyText = `I analyzed your request: **"${featureText}"**.\n\nPlease select your preferred architecture approach below:`;
        const response = {
          id: `msg_ai_${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: replyText,
          mode: 'action',
          options,
          plan,
          needsOptions: true,
          isBugFix: false,
        };
        return { ok: true, response };
      }
    }

    // 2. Intent Analysis Override: If message has new request alongside confirmation (e.g. "ok akn taholy login feature add korbo")
    newRequestFromConfirm = typeof aiService.extractNewRequestFromConfirmation === 'function'
      ? aiService.extractNewRequestFromConfirmation(message)
      : null;

    if (newRequestFromConfirm) {
      console.log('[Chat IPC] Override confirmation with new feature request:', newRequestFromConfirm);
      message = newRequestFromConfirm;
      savedState.pendingAction = null;
      savedState.pendingBugReport = null;
      sessionStore.saveState({ pendingAction: null, pendingBugReport: null });
    }

    const confirmationRegex = /^((ok|okay|yes|ha|haa|haan|thik\s+ache|sure)\s+)?(yes|ha|haa|haan|ok|okay|sure|y|thik\s+ache|thik\s+ase|alright|fine|please\s+do)$/i;
    const isPureConfirm = !newRequestFromConfirm && !isOptionsCmd && !isPromptCmd && (
      typeof aiService.isConfirmationWord === 'function' ? aiService.isConfirmationWord(message) : confirmationRegex.test(message)
    );
    const isExplicitFix = !newRequestFromConfirm && (
      typeof aiService.isExplicitFixCommand === 'function' ? aiService.isExplicitFixCommand(message) : /^((ok|please|pls)\s+)?fix(\s+(it|this))?$/i.test((message || '').trim())
    );

    const pendingAction = savedState.pendingAction || (savedState.pendingBugReport ? 'bug_fix_prompt' : null);

    // 2a-0. Contextual Confirmation for update_feature or add_feature
    if (!isExplanation && isPureConfirm && (pendingAction === 'update_feature' || pendingAction === 'add_feature')) {
      const isUpdate = pendingAction === 'update_feature';
      console.log(`[Chat IPC] Contextual Confirmation detected for ${pendingAction}:`, savedState.pendingFeature);
      const targetFeature = savedState.pendingFeature || (isUpdate ? 'login' : 'Feature');
      const featureTask = isUpdate
        ? `Refactor and update ${targetFeature} feature`
        : `Add ${targetFeature} feature`;

      const optionsResult = await aiService.suggestOptions(featureTask, {
        _snapshot: snapshot,
        domain: projectContextForAI?.domain || 'Software Project',
        techStack: projectContextForAI?.techStack || [],
        files: snapshot?.files || [],
        missingBlueprints: projectContextForAI?.missingBlueprints || [],
        activeRules: savedState?.activeRules || [],
      });

      const options = Array.isArray(optionsResult.options) ? optionsResult.options : [];
      const plan = {
        id: `plan_${Date.now()}`,
        task: featureTask,
        intentSummary: featureTask.slice(0, 80),
        userIntent: featureTask,
        featureType: optionsResult.featureType || (isUpdate ? 'Feature Update' : 'Feature Implementation'),
        availableApproaches: options,
        options,
        filesToEdit: isUpdate ? ['app.js'] : [],
        filesToCreate: isUpdate ? [] : ['index.html', 'style.css', 'app.js'],
        isRefactor: isUpdate,
      };

      activePlans.set(plan.id, plan);

      sessionStore.saveState({
        currentIntent: featureTask,
        currentPlan: plan,
        pendingAction: 'feature_plan',
        pendingFeature: targetFeature,
      });

      const replyText = isUpdate
        ? `I have prepared 3 architectural options for updating and refactoring the "${targetFeature}" feature. Please choose an approach:`
        : `I have prepared 3 architectural options for adding the "${targetFeature}" feature. Please choose an approach:`;

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'action',
        options,
        plan,
        needsOptions: true,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    // 2a. Confirming Bug Fix Prompt
    const isConfirmingBug = !isExplanation && (
      (aiRes && (aiRes.mode === 'bug_fix_ready' || (aiRes.mode === 'confirmation_yes' && pendingAction === 'bug_fix_prompt'))) ||
      ((pendingAction === 'bug_fix_prompt' || isExplicitFix || Boolean(savedState.pendingBugReport && isExplicitFix)) && (isPureConfirm || isExplicitFix)) ||
      (isExplicitFix && (Boolean(savedState.pendingBugReport) || !aiService.isBugReport(message)))
    );

    if (isConfirmingBug) {
      console.log('[Chat IPC] Bug Fix Confirmation detected for message:', message);
      const bugReportText = aiRes?.bugReport || savedState.pendingBugReport || message;
      let bugFixPrompt = aiRes?.prompt || null;
      let bugFixMetadata = aiRes?.metadata || null;

      if (!bugFixPrompt) {
        const { buildBugFixPrompt } = require('../rules/prompt-builder');
        let projectFilesList = [];
        if (snapshot && Array.isArray(snapshot.files) && snapshot.files.length > 0) {
          projectFilesList = snapshot.files.map(f => f.path || f);
        } else {
          projectFilesList = ['index.html', 'style.css', 'app.js'];
        }

        const bugFixResult = await buildBugFixPrompt({
          currentIntent: bugReportText,
          userBugReport: bugReportText,
          projectFiles: projectFilesList,
          snapshot,
          agent: 'antigravity',
        });
        bugFixPrompt = bugFixResult.prompt;
        bugFixMetadata = bugFixResult.metadata;
      }

      const updatedPromptHistory = [
        ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
        {
          prompt: bugFixPrompt,
          feature: 'Bug Fix: ' + bugReportText.slice(0, 60),
          featureName: 'Bug Fix',
          task: bugReportText,
          timestamp: Date.now(),
          generatedAt: new Date().toISOString(),
          agent: 'antigravity',
          promptPreview: bugFixPrompt.slice(0, 160),
          isBugFix: true,
        },
      ];

      sessionStore.saveState({
        currentIntent: bugReportText,
        lastGeneratedPrompt: bugFixPrompt,
        promptHistory: updatedPromptHistory,
        isBugFix: true,
        pendingAction: null,
        pendingBugReport: null,
      });

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: bugFixPrompt,
          metadata: bugFixMetadata,
          promptHistory: updatedPromptHistory,
          isBugFix: true,
        });
      }

      const replyText = "I have generated the fix prompt. Click below to open it.";
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'bug_fix_ready',
        options: [],
        plan: null,
        isBugFix: true,
        prompt: bugFixPrompt,
        metadata: bugFixMetadata,
        promptHistory: updatedPromptHistory,
      };
      return { ok: true, response };
    }

    // 2a-2. Feature prompt ready directly from aiRes (e.g. from Bengali feature reference)
    if (aiRes && aiRes.prompt && !aiRes.isBugFix) {
      console.log('[Chat IPC] Feature Prompt ready directly from aiRes:', aiRes.plan?.task || savedState.currentIntent);
      const featureTask = aiRes.plan?.task || savedState.currentIntent || 'Feature Implementation';
      const updatedPromptHistory = [
        ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
        {
          prompt: aiRes.prompt,
          feature: featureTask,
          featureName: featureTask,
          task: featureTask,
          timestamp: Date.now(),
          generatedAt: new Date().toISOString(),
          agent: savedState.selectedTargetAI || 'cursor',
          planId: aiRes.plan?.id || `plan_${Date.now()}`,
          promptPreview: aiRes.prompt.slice(0, 160),
          isBugFix: false,
        },
      ];

      sessionStore.saveState({
        currentIntent: featureTask,
        lastGeneratedPrompt: aiRes.prompt,
        currentPlan: aiRes.plan,
        promptHistory: updatedPromptHistory,
        pendingAction: null,
        pendingFeature: null,
      });

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: aiRes.prompt,
          metadata: aiRes.metadata || {},
          promptHistory: updatedPromptHistory,
          isBugFix: false,
        });
      }

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: aiRes.reply || "I have prepared the prompt and architectural options for your feature.",
        mode: 'action',
        options: aiRes.options || [],
        plan: aiRes.plan || null,
        prompt: aiRes.prompt,
        needsOptions: true,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    // 2a-3. Options ready directly from aiRes (e.g. from command request or feature planning)
    const textExplicitlyHasOptions = /(prepared.*options|architectural options|choose an approach|select.*approach|options below|3 options|following options)/i.test(aiRes?.reply || aiRes?.responseText || '');
    const hasActualOptions = Array.isArray(aiRes?.options) && aiRes.options.length > 0;
    const aiImpliesOptions = aiRes && (hasActualOptions || textExplicitlyHasOptions);

    if (aiImpliesOptions && !aiRes.isBugFix && aiRes.mode !== 'bug_fix_ready') {
      const rawFeatureTask = (isValidIntentString(message) && !(typeof aiService.isConversationalQuestion === 'function' && aiService.isConversationalQuestion(message)))
        ? message
        : (aiRes.plan?.task || savedState.pendingFeature || savedState.currentIntent || 'Feature Implementation');
      const featureTask = typeof aiService.cleanFeatureIntent === 'function'
        ? aiService.cleanFeatureIntent(rawFeatureTask)
        : rawFeatureTask;

      let options = (Array.isArray(aiRes.options) && aiRes.options.length > 0)
        ? aiRes.options
        : (aiRes.plan?.options || []);

      if (options.length === 0) {
        const optResult = await aiService.suggestOptions(featureTask, {
          ...projectContextForAI,
          files: (snapshot?.files || []).slice(0, 20),
          _snapshot: snapshot,
        });
        options = Array.isArray(optResult.options) ? optResult.options : [];
      }

      const plan = aiRes.plan || {
        id: `plan_${Date.now()}`,
        task: featureTask,
        intentSummary: featureTask.slice(0, 80),
        userIntent: featureTask,
        featureType: 'Feature Implementation',
        availableApproaches: options,
        options,
        filesToEdit: [],
        filesToCreate: ['index.html', 'style.css', 'app.js'],
      };
      plan.task = featureTask;
      plan.intentSummary = featureTask.slice(0, 80);
      plan.userIntent = featureTask;
      plan.options = options;

      const cleanIntent = featureTask;

      sessionStore.saveState({
        currentPlan: plan,
        currentIntent: cleanIntent,
        pendingAction: 'feature_plan',
        pendingFeature: cleanIntent,
      });

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: aiRes.reply || aiRes.responseText || `I have prepared 3 architectural options for "${featureTask}". Please choose an approach:`,
        mode: 'action',
        options,
        plan,
        needsOptions: true,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    // 2b. Confirming Feature Plan / Feature Prompt
    const isConfirmingFeature = !isExplanation && !isConfirmingBug && isPureConfirm && (
      pendingAction === 'feature_plan' || (aiRes && aiRes.mode === 'confirmation_yes' && pendingAction === 'feature_plan')
    );

    if (isConfirmingFeature) {
      console.log('[Chat IPC] Feature Plan Confirmation detected for message:', message);
      const featureText = savedState.pendingFeature || savedState.currentIntent || 'Feature Implementation';
      
      const optionsResult = await aiService.suggestOptions(featureText, {
        _snapshot: snapshot,
        domain: projectContextForAI?.domain || 'Software Project',
        techStack: projectContextForAI?.techStack || [],
        files: snapshot?.files || [],
        missingBlueprints: projectContextForAI?.missingBlueprints || [],
        activeRules: savedState?.activeRules || [],
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

      activePlans.set(plan.id, plan);

      sessionStore.saveState({
        currentIntent: featureText,
        currentPlan: plan,
        pendingAction: null,
        pendingFeature: null,
      });

      const replyText = `I analyzed your request: **"${featureText}"**.\n\n` +
        `• Detected Domain: **${optionsResult.featureType || 'Feature Implementation'}**\n\n` +
        `Please select your preferred architecture approach below:`;

      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText,
        mode: 'action',
        options,
        plan,
        needsOptions: true,
        isBugFix: false,
      };
      return { ok: true, response };
    }

    // 2c. Pure Confirmation with NO pendingAction -> normal chat input (do NOT trigger any prompt)
    if (!isExplanation && isPureConfirm && !pendingAction && !isExplicitFix && !isBuildCmd) {
      console.log('[Chat IPC] Confirmation without pendingAction treated as normal chat');
      const isBengali = /[\u0980-\u09FF]|ha|haa|haan|thik/i.test(message);
      const text = isBengali
        ? "ঠিক আছে! আপনার প্রোজেক্টে কীভাবে সাহায্য করতে পারি? নতুন ফিচার যোগ করতে বা কোনো সমস্যা জানাতে পারেন।"
        : "Understood! How can I help you with your project? You can request a new feature or report an issue.";
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text,
        options: [],
        plan: null,
        isClarification: true,
      };
      return { ok: true, response };
    }

    // 3. Bug Intent Detection (First Response - Asking for Confirmation)
    const isBug = !isExplanation && ((aiRes && (aiRes.mode === 'bug_fix' || aiRes.mode === 'bug_report')) || (typeof aiService.isBugReport === 'function' && aiService.isBugReport(message)));
    if (isBug) {
      console.log('[Chat IPC] Bug Intent detected for message:', message);
      sessionStore.saveState({
        pendingAction: 'bug_fix_prompt',
        pendingBugReport: message,
        currentIntent: message,
      });

      const bugReply = "I understand your problem. Do you want me to generate a prompt to fix it?";
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: bugReply,
        mode: 'bug_fix',
        options: [],
        plan: null,
        isBugFix: true,
      };
      return { ok: true, response };
    }

    // Clear pending bug report if developer proceeds to other queries (except explanation)
    if (savedState.pendingBugReport && !isExplanation && !confirmationRegex.test(message)) {
      sessionStore.saveState({ pendingAction: null, pendingBugReport: null });
    }

    // 3. If AI replied conversationally (general questions, Bengali, project query, greetings)
    if (aiRes && !aiRes.needsOptions && !aiRes.suggestedFeatureType) {
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: aiRes.responseText || 'I am ready to help with your project.',
        options: [],
        plan: null,
        isClarification: true,
        providerUsed: aiRes.providerUsed || 'fallback',
        isStatic: !!(aiRes.isStatic || aiRes.providerUsed === 'fallback'),
      };
      return { ok: true, response };
    }

    // 3. For feature requests: analyze feature against AST (static baseline)
    const analysis = analyzeFeature(message, snapshot);

    // If input is non-actionable or vague (e.g. "text", "test")
    if (analysis.isClarification && (!aiRes || !aiRes.needsOptions)) {
      const response = {
        id: `msg_ai_${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: aiRes?.responseText || analysis.clarificationMessage,
        options: [],
        plan: null,
        progress: analysis.currentProgress,
        isClarification: true,
      };
      return { ok: true, response };
    }

    const progress = calculateProgress(snapshot, analysis.featureKey);

    const isSingleFile = typeof aiService.isSingleFileConstraint === 'function'
      ? aiService.isSingleFileConstraint(message)
      : /\b(single[\s-]*file|one[\s-]*file|monolith(ic)?|all[\s-]in[\s-]one)\b/i.test(message);

    // ── Get project-type-aware options (replaces hardcoded FEATURE_CATALOG) ──
    let aiOptions = [];
    try {
      const optResult = await aiService.suggestOptions(message, {
        ...projectContextForAI,
        files:     (snapshot?.files || []).slice(0, 20),
        _snapshot: snapshot,
      });
      if (optResult && Array.isArray(optResult.options) && optResult.options.length > 0) {
        aiOptions = optResult.options;
        console.log(`[Chat IPC] suggestOptions → ${aiOptions.length} options, projectType=${optResult._projectType || 'unknown'}`);
      }
    } catch (err) {
      console.warn('[Chat IPC] suggestOptions failed, using static fallback:', err.message);
    }

    // Fall back to static analysis options only if AI options completely unavailable
    let finalOptions = aiOptions.length > 0 ? aiOptions : analysis.availableApproaches;

    if (isSingleFile && typeof aiService.getSingleFileOverrideOptions === 'function') {
      finalOptions = aiService.getSingleFileOverrideOptions();
    }

    const { detectProjectType } = require('../ast/project-type-detector');
    const typeResult = detectProjectType(snapshot, projectContextForAI || {});
    const isFrontendProj = typeResult.projectType === 'frontend' || isSingleFile;

    const { isBackendFilename } = require('../rules/missing-file-analyzer');
    const sanitizedMissing = isFrontendProj
      ? analysis.missingFiles.filter(f => !isBackendFilename(f))
      : analysis.missingFiles;

    let initialFilesToCreate = isFrontendProj
      ? []
      : sanitizedMissing.slice(0, 3);

    let initialFilesToEdit = (snapshot?.files || []).slice(0, 3).map(f => f.path);
    if (isFrontendProj && initialFilesToEdit.length === 0) {
      initialFilesToEdit = ['index.html', 'app.js'];
    }

    const userWantsModules = /\b(modular|modules?)\b/i.test(message);
    if (finalOptions.length > 0 && finalOptions[0]) {
      const topOpt = finalOptions[0];
      if (Array.isArray(topOpt.filesToCreate) && topOpt.filesToCreate.length > 0) {
        initialFilesToCreate = [...topOpt.filesToCreate];
      }
      if (Array.isArray(topOpt.filesToEdit) && topOpt.filesToEdit.length > 0) {
        initialFilesToEdit = [...topOpt.filesToEdit];
      }
    }

    if (isFrontendProj && !userWantsModules) {
      initialFilesToCreate = initialFilesToCreate.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
      initialFilesToEdit = initialFilesToEdit.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
    }

    if (isSingleFile) {
      initialFilesToCreate = ['index.html', 'style.css', 'app.js'];
      initialFilesToEdit = [];
    } else if (isFrontendProj && (!snapshot || !snapshot.files || snapshot.files.length === 0)) {
      initialFilesToCreate = ['index.html', 'style.css', 'app.js'];
      initialFilesToEdit = [];
    }

    let cleanDomain = null;
    const msgLower = message.toLowerCase();
    if (msgLower.includes('game') || msgLower.includes('tic-tac-toe') || msgLower.includes('tictactoe') || msgLower.includes('canvas')) {
      cleanDomain = 'frontend_game';
    } else if (msgLower.includes('dark mode') || msgLower.includes('theme') || msgLower.includes('ui') || msgLower.includes('toggle')) {
      cleanDomain = 'UI_Component';
    } else if (isFrontendProj) {
      cleanDomain = 'frontend';
    } else if (aiRes?.suggestedFeatureType && aiRes.suggestedFeatureType.length <= 40 && aiRes.suggestedFeatureType !== message) {
      cleanDomain = aiRes.suggestedFeatureType;
    } else if (analysis.featureType && analysis.featureType.length <= 40 && analysis.featureType !== message) {
      cleanDomain = analysis.featureType;
    } else {
      cleanDomain = 'general';
    }

    const planId = `plan_${Date.now()}`;
    const cleanIntent = typeof aiService.cleanFeatureIntent === 'function'
      ? aiService.cleanFeatureIntent(message)
      : message;

    let activeReqs = Array.isArray(savedState.activeFeatureRequirements) ? [...savedState.activeFeatureRequirements] : [];
    if (!activeReqs.includes(message)) {
      if (activeReqs.length === 0 || typeof aiService.isDetailOrRelated !== 'function' || aiService.isDetailOrRelated(message, savedState.pendingFeature)) {
        activeReqs.push(message);
      } else {
        activeReqs = [message];
      }
    }

    const plan = {
      id: planId,
      task: cleanIntent,
      intentSummary: cleanIntent,
      userIntent: cleanIntent,
      rawUserPrompt: message,
      domain: cleanDomain,
      featureType: cleanDomain,
      selectedOption: isSingleFile ? finalOptions[0] : (finalOptions.length > 0 ? finalOptions[0] : undefined),
      selectedOptionName: isSingleFile ? 'Production Modular Structure (Recommended)' : (finalOptions.length > 0 ? (finalOptions[0].name || finalOptions[0].label) : undefined),
      isProductionModular: isSingleFile ? true : undefined,
      architectureBadge: isSingleFile ? '✅ Production Architecture Selected' : undefined,
      filesToEdit: initialFilesToEdit,
      filesToCreate: initialFilesToCreate,
      forbiddenFiles: ['.env', 'node_modules/', 'package-lock.json'],
      missingFiles: sanitizedMissing,
      activeFeatureRequirements: activeReqs,
      riskLevel: sanitizedMissing.length > 2 ? 'medium' : 'low',
      riskReasons: [
        `Architectural scope: ${analysis.featureType || 'Feature Implementation'}`,
        'Strict schema validation required',
        'Preserve zero-secret constraints'
      ],
      estimatedChanges: {
        linesAdded: 85,
        linesModified: 30,
        filesAffected: sanitizedMissing.length + 2
      }
    };

    activePlans.set(planId, plan);

    // Save state
    sessionStore.saveState({
      pendingAction: 'feature_plan',
      pendingFeature: cleanIntent,
      currentIntent: cleanIntent,
      lastFeatureAnalyzed: plan.featureType,
      currentProgress: progress,
      currentPlan: plan,
      selectedOption: plan.selectedOption,
      selectedOptionName: plan.selectedOptionName,
      activeFeatureRequirements: activeReqs,
    });

    let responseText = aiRes?.responseText;
    if (isSingleFile && (!responseText || !responseText.toLowerCase().includes('keeping everything in one file is not recommended'))) {
      responseText = `For a production-level application, keeping everything in one file is not recommended. I have prepared a modular structure for you.\n\n` +
        `• Detected Domain: **${cleanDomain}**\n` +
        `• Recommended: **Production Modular Structure (Recommended)**\n` +
        `• Files to Create: <code>index.html</code>, <code>style.css</code>, <code>app.js</code>\n\n` +
        `Please select your preferred architecture approach below:`;
    } else if (!responseText) {
      responseText = `I analyzed your request: **"${message}"**.\n\n` +
        `• Detected Domain: **${analysis.featureType}**\n` +
        `• Overall Project Progress: **${progress.overall}%** (${progress.ready.length} ready files)\n\n` +
        `Please select your preferred architecture approach below:`;
    }

    const response = {
      id: `msg_ai_${Date.now()}`,
      role: 'assistant',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: responseText,
      mode: 'action',
      needsOptions: true,
      options: finalOptions,
      plan,
      progress,
      providerUsed: aiRes?.providerUsed || (aiOptions.length > 0 ? 'ai' : 'fallback'),
      isStatic: (aiRes?.providerUsed === 'fallback' || aiOptions.length === 0),
    };

    return { ok: true, response };
  });

  /**
   * chat:options
   * Developer selects Option A, B, or C.
   */
  ipcMain.handle('chat:options', async (_event, payload) => {
    const optionId = typeof payload === 'object' ? (payload.id || payload.optionId) : payload;
    const planId = payload?.planId;
    const fullOption = typeof payload === 'object' ? payload : { id: optionId };
    console.log('[Chat IPC] chat:options selected:', optionId, 'for plan:', planId);

    const savedState = sessionStore.loadState();
    const plan = activePlans.get(planId) || savedState.currentPlan || { id: planId };
    const optionLabel = fullOption.label || fullOption.name || fullOption.description || `Option ${optionId}`;

    let resolvedFilesToEdit = (Array.isArray(fullOption.filesToEdit) && fullOption.filesToEdit.length > 0)
      ? [...fullOption.filesToEdit]
      : (plan.filesToEdit || []);

    let resolvedFilesToCreate = (Array.isArray(fullOption.filesToCreate) && fullOption.filesToCreate.length > 0)
      ? [...fullOption.filesToCreate]
      : (plan.filesToCreate || []);

    const { detectProjectType } = require('../ast/project-type-detector');
    const { isBackendFilename } = require('../rules/missing-file-analyzer');
    let optSnapshot = null;
    if (astEngineRef?.getSnapshot) optSnapshot = astEngineRef.getSnapshot();
    const typeRes = detectProjectType(optSnapshot, {});
    const isFrontendProj = typeRes.projectType === 'frontend';

    const optLabelLower = (optionLabel || '').toLowerCase();
    const isProdModular = optLabelLower.includes('production modular') || fullOption?.isProductionModular;
    const isSingleFileProto = optLabelLower.includes('single file') || fullOption?.isSingleFilePrototype;

    if (isProdModular) {
      resolvedFilesToCreate = ['index.html', 'style.css', 'app.js'];
      resolvedFilesToEdit = [];
    } else if (isSingleFileProto) {
      resolvedFilesToCreate = ['index.html'];
      resolvedFilesToEdit = [];
    } else if (isFrontendProj) {
      resolvedFilesToEdit = resolvedFilesToEdit.filter(f => !isBackendFilename(f));
      resolvedFilesToCreate = (Array.isArray(fullOption.filesToCreate) && fullOption.filesToCreate.length > 0)
        ? fullOption.filesToCreate.filter(f => !isBackendFilename(f))
        : [];
      if (resolvedFilesToEdit.length === 0 && resolvedFilesToCreate.length === 0) {
        resolvedFilesToEdit = ['index.html', 'app.js'];
      }
    }

    const updatedPlan = {
      ...plan,
      task: plan.task || savedState.currentIntent || undefined,
      userIntent: plan.userIntent || savedState.currentIntent || undefined,
      intentSummary: (plan.intentSummary && plan.intentSummary !== 'Feature Implementation' && plan.intentSummary !== 'Implement approved feature scope')
        ? plan.intentSummary
        : (savedState.currentIntent || plan.intentSummary),
      selectedOption: fullOption,
      selectedOptionName: optionLabel,
      filesToEdit: resolvedFilesToEdit,
      filesToCreate: resolvedFilesToCreate,
      isProductionModular: isProdModular,
      isSingleFilePrototype: isSingleFileProto,
      architectureBadge: isProdModular ? '✅ Production Architecture Selected' : undefined,
    };

    if (planId) {
      activePlans.set(planId, updatedPlan);
    }
    sessionStore.saveState({
      selectedOption: fullOption,
      selectedOptionName: optionLabel,
      currentPlan: updatedPlan,
    });

    return {
      ok: true,
      optionId,
      option: fullOption,
      message: `Option ${optionId} selected: "${optionLabel}". Review the execution plan below and click Approve to proceed with prompt generation.`
    };
  });

  /**
   * chat:approve
   */
  ipcMain.handle('chat:approve', async (_event, payload) => {
    const planId = payload?.planId;
    console.log('[Chat IPC] chat:approve planId:', planId);

    const savedState = sessionStore.loadState();
    sessionStore.saveState({ permissionStatus: 'approved' });

    let promptResult = null;
    let updatedPromptHistory = null;
    try {
      const plan = activePlans.get(planId) || savedState.currentPlan || { id: planId };
      const isQ = (s) => typeof aiService.isConversationalQuestion === 'function' ? aiService.isConversationalQuestion(s) : false;
      const cleanFn = (s) => typeof aiService.cleanFeatureIntent === 'function' ? aiService.cleanFeatureIntent(s) : s;
      const candidateTasks = [
        typeof payload === 'object' ? (payload.currentIntent || payload.task || payload.feature) : null,
        savedState.currentIntent,
        plan.userIntent,
        plan.task,
        plan.intentSummary,
        typeof payload === 'object' ? payload.userIntent : null,
        plan.featureType,
      ].filter(c => isValidIntentString(c) && !isQ(c));
      const rawTask = candidateTasks.find(c => isValidIntentString(c) && !isQ(c))
        || (isValidIntentString(savedState.currentIntent) && !isQ(savedState.currentIntent) ? savedState.currentIntent : 'Feature Implementation');
      const task = cleanFn(rawTask);
      const agent = savedState.selectedTargetAI || 'cursor';
      const activeRules = savedState.activeRules || ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval'];

      let snapshot = null;
      let memory = null;
      try {
        if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
        if (snapshot?.rootPath) {
          const cached = projectMemory.load(snapshot.rootPath);
          if (cached) memory = cached.memory;
        }
      } catch (_) {}


      const selectedOption = (typeof payload === 'object' && payload.selectedOption)
        || plan.selectedOption
        || savedState.selectedOption
        || null;

      const selectedOptionName = (typeof payload === 'object' && payload.selectedOptionName)
        || plan.selectedOptionName
        || savedState.selectedOptionName
        || (typeof selectedOption === 'object' && selectedOption ? (selectedOption.name || selectedOption.label || selectedOption.title || selectedOption.description) : null)
        || (typeof selectedOption === 'string' ? selectedOption : null);

      let filesToEdit = (typeof selectedOption === 'object' && selectedOption && Array.isArray(selectedOption.filesToEdit) && selectedOption.filesToEdit.length > 0)
        ? [...selectedOption.filesToEdit]
        : (Array.isArray(plan.filesToEdit) && plan.filesToEdit.length > 0
          ? [...plan.filesToEdit]
          : (typeof payload === 'object' && Array.isArray(payload.filesToEdit) ? [...payload.filesToEdit] : []));

      let filesToCreate = (typeof selectedOption === 'object' && selectedOption && Array.isArray(selectedOption.filesToCreate) && selectedOption.filesToCreate.length > 0)
        ? [...selectedOption.filesToCreate]
        : (Array.isArray(plan.filesToCreate) && plan.filesToCreate.length > 0
          ? [...plan.filesToCreate]
          : (typeof payload === 'object' && Array.isArray(payload.filesToCreate) ? [...payload.filesToCreate] : []));

      const isProdModular = plan.isProductionModular
        || (typeof selectedOption === 'object' && selectedOption?.isProductionModular)
        || /production\s*modular/i.test(selectedOptionName || '')
        || /production\s*modular/i.test(typeof selectedOption === 'string' ? selectedOption : '');

      const isSingleFileProto = plan.isSingleFilePrototype
        || (typeof selectedOption === 'object' && selectedOption?.isSingleFilePrototype)
        || /single\s*file/i.test(selectedOptionName || '')
        || /single\s*file/i.test(typeof selectedOption === 'string' ? selectedOption : '');

      if (isProdModular) {
        filesToCreate = ['index.html', 'style.css', 'app.js'];
        filesToEdit = [];
      } else if (isSingleFileProto) {
        filesToCreate = ['index.html'];
        filesToEdit = [];
      }

      const planDomain = plan.domain || (typeof plan.featureType === 'string' && plan.featureType.length <= 40 && plan.featureType !== task ? plan.featureType : undefined);
      const planWithTask = {
        ...plan,
        task,
        intentSummary: task,
        userIntent: task,
        domain: planDomain,
        featureType: planDomain,
        selectedOption: selectedOption || selectedOptionName,
        selectedOptionName: selectedOptionName || (typeof selectedOption === 'string' ? selectedOption : null),
        selectedOptionObject: typeof selectedOption === 'object' ? selectedOption : null,
        filesToEdit,
        filesToCreate,
        isProductionModular: isProdModular,
        isSingleFilePrototype: isSingleFileProto,
        architectureBadge: isProdModular ? '✅ Production Architecture Selected' : undefined,
      };

      promptResult = await buildStrictPrompt({
        plan: planWithTask,
        currentIntent: task,
        task,
        feature: task,
        userIntent: task,
        activeFeatureRequirements: savedState.activeFeatureRequirements || [],
        agent,
        activeRules,
        snapshot,
        projectMemory: memory,
      });

      if (promptResult?.prompt) {
        const promptHistory = Array.isArray(savedState.promptHistory) ? savedState.promptHistory : [];
        updatedPromptHistory = [
          ...promptHistory,
          {
            prompt: promptResult.prompt,
            feature: task,
            featureName: task,
            task,
            timestamp: Date.now(),
            generatedAt: new Date().toISOString(),
            validation: promptResult.metadata?.validation,
            agent,
            planId,
            promptPreview: promptResult.prompt.slice(0, 160),
          },
        ];
        const selectedRuleIds = promptResult.metadata?.selectedSecurityRules || [];

        sessionStore.saveState({
          currentIntent: task,
          lastGeneratedPrompt: promptResult.prompt,
          currentPlan: planWithTask,
          selectedOption: selectedOption || selectedOptionName,
          selectedOptionName: selectedOptionName || (typeof selectedOption === 'string' ? selectedOption : null),
          promptHistory: updatedPromptHistory,
          activeRules: selectedRuleIds.length > 0 ? selectedRuleIds : savedState.activeRules,
        });

        if (snapshot?.rootPath) {
          try {
            const domainCandidate = (/log\s*analyzer/i.test(task) || /log\s*analyzer/i.test(savedState.currentIntent || ''))
              ? 'Log Analyzer'
              : (plan.domain && plan.domain !== 'Unknown' && plan.domain !== 'backend_cli' ? plan.domain : undefined);
            const isPy = (promptResult.metadata?.selectedSecurityRules || []).some(r => r === 'safe-paths') ||
              (snapshot.files || []).some(f => /\.py$/i.test(f.path || f)) ||
              (plan.filesToCreate || []).some(f => /\.py$/i.test(f));
            projectMemory.update(snapshot.rootPath, {
              ...(domainCandidate ? { domain: domainCandidate } : {}),
              techStack: isPy ? ['Python'] : undefined,
            });
          } catch (_) {}
        }

        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('prompt:ready', {
            prompt: promptResult.prompt,
            selectedRuleIds,
            rules: promptResult.metadata?.security?.rules || [],
            metadata: promptResult.metadata,
            validation: promptResult.metadata?.validation,
            promptHistory: updatedPromptHistory,
          });
        }
      }
    } catch (err) {
      console.warn('[Chat IPC] chat:approve strict prompt generation warning:', err.message);
    }

    return {
      ok: true,
      approved: true,
      planId,
      message: 'Plan approved! Switched to Prompt tab with your tailored guardrail directive.',
      prompt: promptResult?.prompt || null,
      selectedRuleIds: promptResult?.metadata?.selectedSecurityRules || [],
      rules: promptResult?.metadata?.security?.rules || [],
      metadata: promptResult?.metadata || null,
      validation: promptResult?.metadata?.validation || null,
      promptHistory: updatedPromptHistory || null,
    };
  });

  /**
   * chat:reject
   */
  ipcMain.handle('chat:reject', async (_event, payload) => {
    const planId = payload?.planId;
    console.log('[Chat IPC] chat:reject planId:', planId);

    sessionStore.saveState({ permissionStatus: 'rejected' });

    return {
      ok: true,
      approved: false,
      planId,
      message: 'Plan rejected. Tell me how you would like to revise the approach.'
    };
  });

  /**
   * chat:modify
   */
  ipcMain.handle('chat:modify', async (_event, payload) => {
    const { planId, notes } = payload || {};
    console.log('[Chat IPC] chat:modify planId:', planId);

    sessionStore.saveState({ permissionStatus: 'modified' });

    return {
      ok: true,
      planId,
      notes,
      message: `Modification recorded: "${notes || 'Revised scope'}". Plan updated.`
    };
  });

  /**
   * progress:get
   */
  ipcMain.handle('progress:get', async (_event, featureType) => {
    let snapshot = null;
    try {
      if (astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
        snapshot = astEngineRef.getSnapshot();
      }
    } catch (_) {}

    const progress = calculateProgress(snapshot, featureType);
    return { ok: true, progress };
  });

  /**
   * progress:update
   */
  ipcMain.handle('progress:update', async (_event) => {
    let snapshot = null;
    try {
      if (astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
        snapshot = astEngineRef.getSnapshot();
      }
    } catch (_) {}

    const progress = calculateProgress(snapshot);
    sessionStore.saveState({ currentProgress: progress });

    // Push update to renderer
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('progress:update', progress);
    }

    return { ok: true, progress };
  });

  // ── Backward-compatible Aliases for legacy Intent/Permission calls ──────
  ipcMain.handle('intent:submit', async (_event, payload) => {
    const res = await ipcMain.handle['chat:send'] ? ipcMain.handle['chat:send'](_event, payload) : null;
    if (res?.ok && res.response) {
      return { ok: true, plan: res.response.plan };
    }
    return {
      ok: true,
      plan: {
        id: `plan_${Date.now()}`,
        intentSummary: payload?.message || 'Feature implementation',
        filesToEdit: ['src/index.js'],
        filesToCreate: ['src/services/auth.js'],
        forbiddenFiles: ['.env'],
        missingFiles: [],
        riskLevel: 'low'
      }
    };
  });

  console.log('[Chat IPC] chat:send, chat:options, progress:get, progress:update registered');
}

module.exports = { registerChatIPC, clearChatState };
