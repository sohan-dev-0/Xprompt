/**
 * PromptLock — Project Progress Calculator (Step 2 Upgrade)
 *
 * Computes snapshot-based progress metrics per architectural module
 * (Auth, Database, Routes, etc.) and analyzes missing/partial/ready files.
 */

'use strict';

const path = require('path');

/** Expected standard blueprint per module */
const MODULE_BLUEPRINTS = {
  auth: {
    name: 'Auth',
    icon: '🔐',
    expected: [
      'auth.controller.js',
      'auth.service.js',
      'user.model.js',
      'jwt.strategy.js',
      'jwt.guard.js'
    ],
    keywords: ['auth', 'login', 'register', 'jwt', 'user', 'session', 'token', 'password']
  },
  database: {
    name: 'Database',
    icon: '🗄️',
    expected: [
      'db.connection.js',
      'schema.prisma',
      'user.entity.js',
      'migration.sql',
      'repository.js'
    ],
    keywords: ['db', 'database', 'model', 'schema', 'entity', 'prisma', 'mongo', 'sql', 'store']
  },
  routes: {
    name: 'Routes',
    icon: '🛣️',
    expected: [
      'api.router.js',
      'auth.routes.js',
      'user.routes.js',
      'health.routes.js',
      'middleware.js'
    ],
    keywords: ['route', 'router', 'controller', 'endpoint', 'api', 'handler', 'middleware']
  }
};

/** Well-known metadata and icons for project modules */
const MODULE_METADATA = {
  ai: { name: 'AI Engine', icon: '🤖' },
  scanner: { name: 'Scanner', icon: '🔍' },
  ipc: { name: 'IPC Bridge', icon: '🔌' },
  renderer: { name: 'UI Renderer', icon: '🎨' },
  ast: { name: 'AST Engine', icon: '📐' },
  storage: { name: 'Storage', icon: '💾' },
  verification: { name: 'Verification Engine', icon: '✅' },
  security: { name: 'Security Guard', icon: '🛡️' },
  rules: { name: 'Rules Engine', icon: '⚖️' },
  auth: { name: 'Auth', icon: '🔐' },
  database: { name: 'Database', icon: '🗄️' },
  db: { canonical: 'database', name: 'Database', icon: '🗄️' },
  routes: { name: 'Routes', icon: '🛣️' },
  api: { name: 'API Endpoints', icon: '🌐' },
  components: { name: 'Components', icon: '🧩' },
  services: { name: 'Services', icon: '⚙️' },
  models: { name: 'Models', icon: '📊' },
  utils: { name: 'Utilities', icon: '🛠️' },
  test: { name: 'Automated Tests', icon: '🧪' },
  tests: { canonical: 'test', name: 'Automated Tests', icon: '🧪' },
  core: { name: 'Core Application', icon: '📦' },
  game: { name: 'Game Engine', icon: '🎮' }
};

const IGNORED_TOP_LEVEL = new Set([
  'node_modules', '.git', 'userdata', '.test-user-data',
  'dist', 'build', 'out', 'coverage', '.gemini', '.vscode', '.idea'
]);

/**
 * Extract logical module key from a file relative path.
 * @param {string} filePath
 * @returns {string}
 */
function extractModuleKey(filePath) {
  if (!filePath || typeof filePath !== 'string') return 'core';
  const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = norm.split('/').filter(Boolean);

  if (parts.length === 1) {
    const base = parts[0].toLowerCase();
    // Standard core root files
    if (base === 'main.js' || base === 'index.js' || base === 'app.js' || base === 'server.js' ||
        base === 'preload.js' || base === 'package.json' || base === 'package-lock.json') {
      return 'core';
    }
    if (base.endsWith('.html') || base.endsWith('.css')) return 'renderer';
    if (base.includes('auth') || base.includes('login') || base.includes('jwt')) return 'auth';
    if (base.includes('database') || base.includes('prisma') || base.startsWith('db.') || base.startsWith('db-')) return 'database';
    if (base.includes('route') || base.includes('router') || base.includes('endpoint')) return 'routes';
    if (base.startsWith('ai.') || base.startsWith('ai-') || base.includes('llm') || base.includes('prompt')) return 'ai';
    if (base.includes('game') || base.includes('board') || base.includes('play')) return 'game';
    return 'core';
  }

  const top = parts[0].toLowerCase();
  if (top === 'src' || top === 'lib' || top === 'app') {
    if (parts.length > 2) {
      const sub = parts[1].toLowerCase();
      if (sub === 'main' || sub === 'renderer' || sub === 'client' || sub === 'server') {
        if (parts.length > 3) {
          return parts[2].toLowerCase();
        }
        return sub;
      }
      return sub;
    }
    return 'core';
  }

  return top;
}

/**
 * Canonicalize module key (e.g. db -> database).
 * @param {string} key
 * @returns {string}
 */
function canonicalizeKey(key) {
  const k = (key || '').toLowerCase();
  if (k === 'db') return 'database';
  if (k === 'tests') return 'test';
  if (k === 'ui' || k === 'views') return 'renderer';
  return k;
}

/**
 * Calculates project progress from an active project snapshot.
 * Dynamically detects modules from folder hierarchy or project structure.
 *
 * @param {object} snapshot - ProjectSnapshot from ast-engine
 * @param {string} [featureType] - Optional specific feature (e.g. 'auth', 'payment', 'database')
 * @returns {object} Progress breakdown
 */
function calculateProgress(snapshot, featureType) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  const filesCount = files.length;

  if (filesCount === 0) {
    return {
      overall: 0,
      modules: {
        auth: { key: 'auth', name: 'Auth', icon: '🔐', progress: 0, filesReady: 0, filesTotal: 5 },
        database: { key: 'database', name: 'Database', icon: '🗄️', progress: 0, filesReady: 0, filesTotal: 5 },
        routes: { key: 'routes', name: 'Routes', icon: '🛣️', progress: 0, filesReady: 0, filesTotal: 5 }
      },
      missing: ['config/firebase.js', 'services/otpService.js', 'src/auth/auth.service.js'],
      partial: [],
      ready: []
    };
  }

  const ready = [];
  const partial = [];
  const missing = [];

  // 1. Categorize existing files into ready vs partial
  for (const f of files) {
    const fnsCount = (f.fns || []).length;
    const expCount = (f.exports || []).length;
    const loc = f.loc || 0;

    if (f.isAST && (fnsCount > 0 || expCount > 0 || loc > 25)) {
      ready.push(f.path);
    } else if (f.isAST || loc > 5) {
      partial.push(f.path);
    }
  }

  // 2. Dynamically group files into architectural modules
  const detectedGroups = new Map(); // canonKey -> array of files

  for (const f of files) {
    const p = (f.path || f.name || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;
    const parts = p.split('/').filter(Boolean);
    if (parts.length > 1 && IGNORED_TOP_LEVEL.has(parts[0].toLowerCase())) {
      continue;
    }
    const rawKey = extractModuleKey(p);
    const canonKey = canonicalizeKey(rawKey);

    if (!detectedGroups.has(canonKey)) {
      detectedGroups.set(canonKey, []);
    }
    detectedGroups.get(canonKey).push(f);
  }

  // Check if project has CRUD modules
  const isCrudProject = Boolean(
    detectedGroups.has('auth') ||
    detectedGroups.has('database') ||
    detectedGroups.has('routes') ||
    featureType === 'crud' ||
    featureType === 'auth' ||
    featureType === 'database' ||
    featureType === 'routes'
  );

  if (isCrudProject) {
    // Ensure all 3 CRUD modules exist for standard CRUD expectations
    if (!detectedGroups.has('auth')) detectedGroups.set('auth', []);
    if (!detectedGroups.has('database')) detectedGroups.set('database', []);
    if (!detectedGroups.has('routes')) detectedGroups.set('routes', []);
  }

  // 3. Compute metrics per detected module
  const modules = {};

  for (const [modKey, modFiles] of detectedGroups.entries()) {
    const meta = MODULE_METADATA[modKey] || {
      name: modKey.charAt(0).toUpperCase() + modKey.slice(1),
      icon: '📁'
    };

    const isBlueprintMod = Boolean(MODULE_BLUEPRINTS[modKey]);
    const blueprint = MODULE_BLUEPRINTS[modKey];

    let filesReady = 0;
    let filesPartial = 0;

    for (const f of modFiles) {
      if (ready.includes(f.path)) {
        filesReady++;
      } else if (partial.includes(f.path)) {
        filesPartial++;
      }
    }

    const filesTotal = isBlueprintMod
      ? Math.max(blueprint.expected.length, modFiles.length)
      : modFiles.length;

    let modPct = 0;
    if (filesTotal > 0) {
      if (isBlueprintMod) {
        modPct = Math.round((filesReady / filesTotal) * 100);
        if (modFiles.length > 0 && modPct === 0) modPct = 25;
      } else {
        modPct = Math.round(((filesReady + (filesPartial * 0.5)) / filesTotal) * 100);
        if (modFiles.length > 0 && modPct === 0) modPct = 25;
      }
    }
    modPct = Math.min(100, Math.max(0, modPct));

    modules[modKey] = {
      key: modKey,
      name: meta.name,
      icon: meta.icon,
      progress: modPct,
      filesReady,
      filesTotal,
      files: modFiles.map(f => f.path)
    };

    if (isBlueprintMod) {
      for (const exp of blueprint.expected) {
        const hasMatch = files.some(f => (f.path || '').toLowerCase().includes(exp.toLowerCase().split('.')[0]));
        if (!hasMatch && !missing.includes(exp)) {
          missing.push(exp);
        }
      }
    }
  }

  // Backward-compatible aliases
  if (modules.database) {
    modules.db = modules.database;
  }
  if (modules.test) {
    modules.tests = modules.test;
  }

  // 4. Compute overall progress based on actual project files
  let overall = 0;
  if (files.length > 0) {
    if (isCrudProject) {
      const crudKeys = ['auth', 'database', 'routes'];
      let sum = 0;
      let count = 0;
      for (const k of crudKeys) {
        if (modules[k]) {
          sum += modules[k].progress;
          count++;
        }
      }
      overall = count > 0 ? Math.round(sum / count) : 0;
    } else {
      // Calculate overall based on files that actually exist in the project
      const readyCount = ready.length;
      const partialCount = partial.length;
      overall = Math.round(((readyCount + (partialCount * 0.5)) / files.length) * 100);
    }
    overall = Math.min(100, Math.max(0, overall));
  }

  if (featureType && modules[featureType.toLowerCase()]) {
    overall = modules[featureType.toLowerCase()].progress;
  }

  return {
    overall,
    modules,
    missing: missing.slice(0, 5),
    partial: partial.slice(0, 6),
    ready: ready.slice(0, 10)
  };
}

/**
 * Filter files relevant to given feature keywords.
 * @param {object} snapshot
 * @param {string[]} featureKeywords
 * @returns {{ relevant: string[], missing: string[], ready: string[] }}
 */
function getRelevantFiles(snapshot, featureKeywords = []) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  const kwList = (Array.isArray(featureKeywords) && featureKeywords.length > 0)
    ? featureKeywords.map(k => String(k).toLowerCase())
    : ['auth', 'user', 'service', 'route'];

  const relevant = [];
  const ready = [];
  const missing = [];

  for (const f of files) {
    const p = f.path.toLowerCase();
    const isRel = kwList.some(k => p.includes(k));
    if (isRel) {
      relevant.push(f.path);
      if (f.isAST && (f.fns?.length > 0 || f.exports?.length > 0)) {
        ready.push(f.path);
      }
    }
  }

  for (const kw of kwList) {
    const found = files.some(f => f.path.toLowerCase().includes(kw));
    if (!found) {
      missing.push(`${kw}.service.js`);
    }
  }

  return {
    relevant,
    missing,
    ready
  };
}

/**
 * Categorize files into ready and partial categories.
 * @param {Array} files
 * @returns {{ ready: string[], partial: string[] }}
 */
function categorizeFiles(files = []) {
  const ready = [];
  const partial = [];

  for (const f of files) {
    const fnsCount = (f.fns || []).length;
    const expCount = (f.exports || []).length;
    const loc = f.loc || 0;

    if (f.isAST && (fnsCount > 0 || expCount > 0 || loc > 25)) {
      ready.push(f.path);
    } else if (f.isAST || loc > 5) {
      partial.push(f.path);
    }
  }

  return { ready, partial };
}

/**
 * Generate standard blueprint files for a module or all modules.
 * @param {string} [moduleKey]
 * @returns {string[]}
 */
function generateBlueprint(moduleKey) {
  if (moduleKey && MODULE_BLUEPRINTS[moduleKey]) {
    return [...MODULE_BLUEPRINTS[moduleKey].expected];
  }
  const all = [];
  for (const bp of Object.values(MODULE_BLUEPRINTS)) {
    all.push(...bp.expected);
  }
  return all;
}

/**
 * Calculate progress for a specific module.
 * @param {object} snapshot
 * @param {string} moduleKey
 * @returns {{ progress: number, filesReady: number, filesTotal: number }}
 */
function calculateModuleProgress(snapshot, moduleKey) {
  const prog = calculateProgress(snapshot, moduleKey);
  if (moduleKey && prog.modules && prog.modules[moduleKey]) {
    return prog.modules[moduleKey];
  }
  return { progress: prog.overall, filesReady: prog.ready.length, filesTotal: prog.ready.length + prog.missing.length };
}

module.exports = {
  calculateProgress,
  calculateModuleProgress,
  categorizeFiles,
  generateBlueprint,
  getRelevantFiles,
  MODULE_BLUEPRINTS
};
