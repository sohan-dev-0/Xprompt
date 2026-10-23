/**
 * PromptLock — Base Security Rules (Step 5)
 *
 * Core security guardrail rules enforced on AI code generation.
 * Categorized by:
 *  - Core backend rules (Zero Secrets, SQL/NoSQL Guard, Input Sanitization, Rate Limiting, OWASP Headers, Error Masking)
 *  - Frontend-specific rules (XSS Guard, No innerHTML, No eval)
 *  - Domain-specific rules (JWT Rotation, Password Hashing, Webhook Signatures, Idempotency)
 */

'use strict';

const BASE_RULES = [
  // ── Core Security Rules (1-6) ──────────────────────────────────────────────
  {
    id: 'zero-secrets',
    name: 'Zero Hardcoded Secrets',
    category: 'core',
    text: 'ZERO SECRETS (STRICT): NEVER read, output, log, or commit API keys, secrets, tokens, or credentials. Reference environment variables via process.env or secret managers only.',
    mandatory: true,
  },
  {
    id: 'sql-guard',
    name: 'SQL/NoSQL Injection Protection',
    category: 'backend',
    text: 'SQL GUARD: SQL/NoSQL Injection Protection. Use parameterized queries or type-safe ORM query builders only. String concatenation or unescaped query assembly is strictly prohibited.',
    mandatory: false,
  },
  {
    id: 'zod-validation',
    name: 'Input Sanitization (Zod/express-validator)',
    category: 'backend',
    text: 'ZOD VALIDATION: Input Sanitization (Zod/express-validator). All incoming request payloads, route parameters, and external API responses MUST be validated with strict Zod or express-validator schemas.',
    mandatory: false,
  },
  {
    id: 'rate-limiting',
    name: 'Rate Limiting',
    category: 'backend',
    text: 'RATE LIMITING: Enforce rate limiting and request throttling (e.g. express-rate-limit) on sensitive and public endpoints to prevent abuse and brute-force attacks.',
    mandatory: false,
  },
  {
    id: 'owasp-headers',
    name: 'OWASP Headers + CORS (helmet)',
    category: 'backend',
    text: 'OWASP HEADERS & CORS: Configure secure HTTP response headers (via Helmet) and restrict CORS origins to trusted domains only.',
    mandatory: false,
  },
  {
    id: 'error-masking',
    name: 'Error Masking',
    category: 'core',
    text: 'ERROR MASKING: Never leak internal stack traces, system paths, or raw database error details to clients. Log errors internally and return sanitized error messages.',
    mandatory: false,
  },

  // ── Frontend-Specific Rules ────────────────────────────────────────────────
  {
    id: 'xss-guard',
    name: 'XSS Guard',
    category: 'frontend',
    text: 'XSS GUARD (STRICT): Prevent Cross-Site Scripting. Sanitize all untrusted inputs, URL parameters, and dynamic text before rendering into the DOM.',
    mandatory: false,
  },
  {
    id: 'no-innerhtml',
    name: 'No innerHTML',
    category: 'frontend',
    text: 'NO INNERHTML: Use textContent, createElement, or safe DOM manipulation methods. Avoid direct innerHTML assignment without strict sanitization.',
    mandatory: false,
  },
  {
    id: 'no-eval',
    name: 'No eval/Function',
    category: 'frontend',
    text: 'NO EVAL: Dynamic code execution via eval(), new Function(), or unsafe script injection is strictly prohibited.',
    mandatory: false,
  },

  // ── Domain-Specific Rules ──────────────────────────────────────────────────
  {
    id: 'jwt-rotation',
    name: 'JWT Rotation & Token Security',
    category: 'auth',
    text: 'JWT ROTATION & SECURE TOKENS: Enforce short-lived access tokens, refresh token rotation, and secure httpOnly cookies with CSRF protection.',
    mandatory: false,
  },
  {
    id: 'bcrypt-hash',
    name: 'Secure Password Hashing',
    category: 'auth',
    text: 'SECURE PASSWORD HASHING: Passwords must be hashed using bcrypt (cost factor >= 12) or argon2id before persistence. Plaintext passwords must never touch storage or logs.',
    mandatory: false,
  },
  {
    id: 'webhook-signature',
    name: 'Webhook Signature Verification',
    category: 'payment',
    text: 'WEBHOOK SIGNATURE VERIFICATION: Verify raw cryptographic signatures (HMAC SHA-256) on incoming webhook payloads before handling payment events.',
    mandatory: false,
  },
  {
    id: 'idempotency',
    name: 'Payment Idempotency',
    category: 'payment',
    text: 'PAYMENT IDEMPOTENCY: Enforce unique idempotency keys and transactional safety for all billing and charge operations to prevent duplicate transactions.',
    mandatory: false,
  },

  // ── Python-Specific Rules ──────────────────────────────────────────────────
  {
    id: 'safe-paths',
    name: 'Safe Path Traversal Protection',
    category: 'python',
    text: 'SAFE PATHS: Use `os.path` safely to prevent path traversal.',
    mandatory: false,
  },
  {
    id: 'no-eval-exec',
    name: 'No eval/exec Execution',
    category: 'python',
    text: 'NO EVAL/EXEC: Do not use `eval()` or `exec()` in Python.',
    mandatory: false,
  },
  {
    id: 'log-sanitization',
    name: 'Log Input Sanitization',
    category: 'python',
    text: 'LOG SANITIZATION: Sanitize log inputs to prevent log injection.',
    mandatory: false,
  },
];

// Aliases mapping for flexible lookups
const RULE_ALIASES = {
  'input-sanitization': 'zod-validation',
  'sql-injection': 'sql-guard',
  'helmet': 'owasp-headers',
  'cors': 'owasp-headers',
  'express-rate-limit': 'rate-limiting',
  'password-hashing': 'bcrypt-hash',
  'jwt': 'jwt-rotation',
  'webhook': 'webhook-signature',
  'idempotent': 'idempotency',
  'safe-path': 'safe-paths',
  'safe-paths': 'safe-paths',
  'os-path': 'safe-paths',
  'no-eval-exec': 'no-eval-exec',
  'eval-exec': 'no-eval-exec',
  'log-sanitization': 'log-sanitization',
  'log-injection': 'log-sanitization',
};

/**
 * Get rule by ID or alias.
 * @param {string} id
 */
function getRule(id) {
  if (!id || typeof id !== 'string') return null;
  const canonicalId = RULE_ALIASES[id.toLowerCase()] || id;
  return BASE_RULES.find(r => r.id === canonicalId) || null;
}

/**
 * Get all available base rules.
 */
function getAllRules() {
  return [...BASE_RULES];
}

/**
 * Get core rules (1-6).
 */
function getCoreRules() {
  return BASE_RULES.filter(r => r.category === 'core' || r.category === 'backend');
}

/**
 * Get frontend-specific rules.
 */
function getFrontendRules() {
  return BASE_RULES.filter(r => r.category === 'frontend' || r.id === 'zero-secrets');
}

/**
 * Get python-specific rules.
 */
function getPythonRules() {
  return BASE_RULES.filter(r => r.category === 'python' || r.id === 'zero-secrets');
}

/**
 * Get domain-specific rules.
 * @param {'auth'|'payment'} [domain]
 */
function getDomainRules(domain) {
  if (domain) {
    return BASE_RULES.filter(r => r.category === domain);
  }
  return BASE_RULES.filter(r => r.category === 'auth' || r.category === 'payment');
}

module.exports = {
  BASE_RULES,
  rules: BASE_RULES,
  getRule,
  getAllRules,
  getCoreRules,
  getFrontendRules,
  getPythonRules,
  getDomainRules,
};
