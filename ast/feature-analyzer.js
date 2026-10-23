/**
 * PromptLock — AST Feature Analyzer (Step 2.4.2 Upgrade)
 *
 * Analyzes developer feature requests against workspace AST metadata and project memory.
 * Synthesizes required files, missing files, progress, and available A/B/C approaches.
 */

'use strict';

const { calculateProgress } = require('../scanner/progress-calculator');

/** Standard feature blueprints and multi-approach strategies */
const FEATURE_CATALOG = {
  auth: {
    type: 'Authentication & Authorization',
    requiredFiles: [
      'src/auth/auth.controller.js',
      'src/auth/auth.service.js',
      'src/auth/jwt.strategy.js',
      'src/users/user.model.js'
    ],
    approaches: [
      {
        id: 'A',
        label: 'Option A: JWT Bearer Tokens with Refresh Rotation',
        description: 'Stateless, microservice-friendly JWT stored in secure httpOnly cookies with rotation on reuse.'
      },
      {
        id: 'B',
        label: 'Option B: Session-Based Cookies with Redis Store',
        description: 'Stateful sessions with instant server-side revocation capability and low payload overhead.'
      },
      {
        id: 'C',
        label: 'Option C: OAuth2 / Social SSO (Google + GitHub)',
        description: 'Delegated identity management with PKCE verification and user auto-provisioning.'
      }
    ]
  },
  payment: {
    type: 'Payment & Checkout Gateway',
    requiredFiles: [
      'src/payment/stripe.service.js',
      'src/payment/checkout.controller.js',
      'src/payment/webhook.handler.js',
      'src/models/order.model.js'
    ],
    approaches: [
      {
        id: 'A',
        label: 'Option A: Stripe Hosted Checkout Session',
        description: 'Quickest PCI-compliant integration using Stripe-hosted redirects and webhook event handling.'
      },
      {
        id: 'B',
        label: 'Option B: Stripe Elements Embedded UI',
        description: 'Native custom styling directly within your application with client-side tokenization.'
      },
      {
        id: 'C',
        label: 'Option C: Multi-Provider (Stripe + PayPal / Razorpay)',
        description: 'Abstract payment gateway interface allowing regional payment method switching.'
      }
    ]
  },
  crud: {
    type: 'RESTful Resource CRUD & Database',
    requiredFiles: [
      'src/routes/resource.routes.js',
      'src/controllers/resource.controller.js',
      'src/services/resource.service.js',
      'src/schemas/resource.schema.js'
    ],
    approaches: [
      {
        id: 'A',
        label: 'Option A: Zod Schema Validation + Service Layer',
        description: 'Strict runtime schema validation on all inputs with clean Separation of Concerns.'
      },
      {
        id: 'B',
        label: 'Option B: Fastify/Express Router with Controller Middleware',
        description: 'Minimalist high-performance handler with standard Express/Connect middleware chaining.'
      },
      {
        id: 'C',
        label: 'Option C: Repository Pattern with ORM/Prisma Model',
        description: 'Type-safe query building with transactional guarantees and migration tracking.'
      }
    ]
  }
};

/** Set of vague, greeting, or generic terms that should trigger clarification rather than architecture options */
const VAGUE_TERMS = new Set([
  'text', 'test', 'testing', 'hello', 'hi', 'hey', 'yo', 'sup', 'hola',
  'help', 'help me', 'asdf', 'foo', 'bar', 'baz', 'temp', 'sample', 'example',
  'what can you do', 'what is this', 'demo', 'ok', 'okay', 'yes', 'no',
  'who are you', 'promptlock', 'please', 'thanks', 'thank you', 'stuff', 'thing'
]);

const ACTION_VERBS = [
  'add', 'create', 'build', 'implement', 'setup', 'set up', 'configure',
  'integrate', 'support', 'generate', 'update', 'refactor', 'write', 'fix',
  'make', 'handle', 'design', 'develop', 'connect', 'install', 'enable'
];

const DOMAIN_KEYWORDS = [
  'auth', 'authentication', 'login', 'logout', 'signup', 'sign up', 'signin', 'sign in',
  'jwt', 'token', 'oauth', 'session', 'user', 'users', 'password', 'role', 'permission',
  'pay', 'payment', 'payments', 'stripe', 'checkout', 'billing', 'invoice', 'card', 'subscription',
  'crud', 'api', 'endpoint', 'endpoints', 'route', 'routes', 'controller', 'service',
  'database', 'db', 'model', 'schema', 'table', 'sql', 'orm', 'prisma', 'mongoose',
  'rest', 'graphql', 'webhook', 'webhooks', 'socket', 'websocket',
  'upload', 'storage', 's3', 'cache', 'redis', 'email', 'mailer', 'notification',
  // Frontend / UI domain keywords
  'keyboard', 'shortcut', 'shortcuts', 'keybind', 'keybinds', 'hotkey', 'hotkeys',
  'sound', 'sounds', 'audio', 'music', 'sfx',
  'timer', 'countdown', 'clock', 'stopwatch',
  'dark', 'darkmode', 'dark-mode', 'theme', 'themes', 'theming', 'toggle',
  'mode', 'light', 'palette',
  'animation', 'animations', 'transition', 'transitions', 'motion',
  'spinner', 'loader', 'loading', 'progress',
  'drag', 'drop', 'draggable', 'droppable',
  'score', 'scores', 'scoreboard', 'leaderboard', 'game', 'gameplay',
  'modal', 'dialog', 'popup', 'popover', 'drawer', 'tooltip',
  'button', 'form', 'input', 'checkbox', 'radio', 'slider', 'select', 'dropdown',
  'tab', 'tabs', 'menu', 'navbar', 'nav', 'navigation', 'sidebar', 'footer', 'header',
  'canvas', 'svg', 'chart', 'charts', 'graph',
  'localstorage', 'sessionstorage', 'cookie', 'cookies', 'preference', 'preferences',
  'state', 'store', 'view', 'layout', 'responsive', 'mobile',
  'filter', 'search', 'pagination', 'sort', 'sorting'
];

const VAGUE_OBJECTS = new Set([
  'it', 'this', 'that', 'these', 'those', 'something', 'anything', 'everything',
  'thing', 'things', 'stuff', 'item', 'items', 'one', 'more', 'now', 'here',
  'there', 'me', 'us', 'them', 'text', 'test', 'sample', 'example'
]);

/**
 * Determine whether a user message describes an actionable feature
 * or is too vague/generic and requires clarification.
 * @param {string} text
 * @returns {boolean}
 */
function isActionableFeature(text = '') {
  const trimmed = String(text || '').trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed || trimmed.length < 3) return false;
  if (VAGUE_TERMS.has(lower)) return false;

  const words = lower.split(/[\s,._-]+/).filter(Boolean);

  // Single word inputs: only actionable if it specifically matches a domain keyword
  if (words.length === 1) {
    return DOMAIN_KEYWORDS.some(k => k === words[0] || (words[0].length >= 4 && k.startsWith(words[0])));
  }

  // Check for domain keywords
  const hasDomain = DOMAIN_KEYWORDS.some(k => lower.includes(k));
  // Check for action verbs
  const hasAction = ACTION_VERBS.some(v => lower.includes(v));

  // If input has 2-3 words, require either a domain keyword or an action verb with a substantive object
  if (words.length <= 3) {
    if (hasDomain) return true;
    if (hasAction) {
      const hasSubstantiveWord = words.some(
        w => !ACTION_VERBS.includes(w) && !VAGUE_OBJECTS.has(w) && !VAGUE_TERMS.has(w) && w.length >= 3
      );
      return hasSubstantiveWord;
    }
    return false;
  }

  // If > 3 words, either domain keyword or action verb
  return hasDomain || hasAction;
}

/**
 * Analyze a feature request string against snapshot metadata.
 * @param {string} featureText - User prompt / request
 * @param {object} snapshot - Current AST project snapshot
 * @param {object} [projectMemory] - Previous session knowledge
 * @returns {object} Feature analysis result
 */
function analyzeFeature(featureText = '', snapshot = null, projectMemory = {}) {
  const query = String(featureText).toLowerCase();

  // If input is not actionable (e.g. "text", "hi", "test"), return clarification
  if (!isActionableFeature(query)) {
    return {
      isActionable: false,
      isClarification: true,
      featureType: null,
      featureKey: null,
      clarificationMessage: `I received your message: **"${featureText.slice(0, 100)}"**.\n\n` +
        `This is too brief or ambiguous to generate an architecture plan. PromptLock needs a specific feature to analyze against your project's AST.\n\n` +
        `**Examples of actionable feature requests:**\n` +
        `• *"Implement JWT user authentication with refresh tokens"*\n` +
        `• *"Add Stripe payment checkout session and webhook handler"*\n` +
        `• *"Create RESTful API endpoints for user profiles with Zod validation"*`,
      requiredFiles: [],
      missingFiles: [],
      matchedFiles: [],
      currentProgress: calculateProgress(snapshot, 'crud'),
      availableApproaches: []
    };
  }

  // Detect feature type
  let featureKey = 'crud';
  if (query.includes('auth') || query.includes('login') || query.includes('jwt') || query.includes('user') || query.includes('sign')) {
    featureKey = 'auth';
  } else if (query.includes('pay') || query.includes('stripe') || query.includes('billing') || query.includes('checkout') || query.includes('card')) {
    featureKey = 'payment';
  }

  const catalog = FEATURE_CATALOG[featureKey] || FEATURE_CATALOG.crud;
  const existingFiles = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files.map(f => f.path.toLowerCase()) : [];

  const requiredFiles = detectRequiredFiles(query);
  const { matched, missing: missingFiles } = compareWithAST(requiredFiles, snapshot);

  // Calculate snapshot progress
  const currentProgress = calculateProgress(snapshot, featureKey);

  return {
    isActionable: true,
    isClarification: false,
    featureType: catalog.type,
    featureKey,
    requiredFiles,
    missingFiles,
    matchedFiles: matched,
    currentProgress,
    availableApproaches: catalog.approaches
  };
}

/**
 * Detect required files for a given feature key or query string.
 * @param {string} featureKeyOrText
 * @returns {string[]} List of required file paths
 */
function detectRequiredFiles(featureKeyOrText = 'crud') {
  const query = String(featureKeyOrText).toLowerCase();
  let featureKey = 'crud';
  if (query.includes('auth') || query.includes('login') || query.includes('jwt') || query.includes('user') || query.includes('sign')) {
    featureKey = 'auth';
  } else if (query.includes('pay') || query.includes('stripe') || query.includes('billing') || query.includes('checkout') || query.includes('card')) {
    featureKey = 'payment';
  }
  const catalog = FEATURE_CATALOG[featureKey] || FEATURE_CATALOG.crud;
  return [...catalog.requiredFiles];
}

/**
 * Compare required blueprint files with active AST snapshot.
 * @param {string[]} requiredFiles
 * @param {object} snapshot
 * @returns {{ matched: string[], missing: string[] }}
 */
function compareWithAST(requiredFiles = [], snapshot = null) {
  const existingFiles = (snapshot && Array.isArray(snapshot.files))
    ? snapshot.files.map(f => f.path.toLowerCase())
    : [];

  const matched = [];
  const missing = [];

  for (const req of requiredFiles) {
    const baseName = req.split('/').pop().toLowerCase().split('.')[0];
    const exists = existingFiles.some(p => p.includes(baseName));
    if (exists) {
      matched.push(req);
    } else {
      missing.push(req);
    }
  }

  return { matched, missing };
}

/**
 * Analyze a feature request with AI enhancement if available,
 * falling back gracefully to static AST analysis.
 * @param {object|string} opts - { featureDescription, snapshot, projectMemory } or featureText
 * @param {object} [snapshotParam]
 * @param {object} [memoryParam]
 * @returns {Promise<object>} Combined feature analysis result
 */
async function analyzeFeatureWithAI(opts, snapshotParam, memoryParam) {
  let featureText = '';
  let snapshot = null;
  let projectMemory = null;

  if (typeof opts === 'string') {
    featureText = opts;
    snapshot = snapshotParam || null;
    projectMemory = memoryParam || null;
  } else if (opts && typeof opts === 'object') {
    featureText = opts.featureDescription || opts.featureText || opts.message || '';
    snapshot = opts.snapshot || snapshotParam || null;
    projectMemory = opts.projectMemory || memoryParam || null;
  }

  // 1. Always compute static baseline
  const staticResult = analyzeFeature(featureText, snapshot, projectMemory);
  if (staticResult.isClarification) {
    return {
      ...staticResult,
      aiEnhanced: false,
    };
  }

  // 2. Try AI enhancement
  try {
    const aiService = require('../ai/ai-service');
    const projectContext = {
      domain: projectMemory?.domain || 'Software Project',
      techStack: projectMemory?.techStack || [],
      files: (snapshot?.files || []).slice(0, 20),
      missingBlueprints: staticResult.missingFiles || [],
      activeRules: projectMemory?.activeRules || [],
    };

    const aiOptions = await aiService.suggestOptions(featureText, projectContext);
    if (aiOptions && Array.isArray(aiOptions.options) && aiOptions.options.length > 0 && !aiOptions._fallback) {
      return {
        ...staticResult,
        availableApproaches: aiOptions.options,
        recommendedOption: aiOptions.recommendedOption || 'A',
        reasonForRecommendation: aiOptions.reasonForRecommendation || '',
        aiEnhanced: true,
      };
    }
  } catch (err) {
    // Graceful fallback to static
  }

  return {
    ...staticResult,
    aiEnhanced: false,
  };
}

module.exports = {
  analyzeFeature,
  analyzeFeatureWithAI,
  detectRequiredFiles,
  compareWithAST,
  FEATURE_CATALOG,
  isActionableFeature
};

