/**
 * PromptLock — Deep File Metadata & AST File Tree Engine (Step 2 Upgrade)
 *
 * Scans workspace and builds detailed file metadata:
 *  - hash (sha256)
 *  - lastModified
 *  - gitStatus
 *  - loc (lines of code)
 *  - classes[]
 *  - isEntryPoint
 *  - 8-metric dependency health analysis:
 *    [Files Scanned, AST Parsed, Dependencies, Risky Imports, .env Exposure,
 *     Missing Imports, Dependency Cycles, Orphan Files]
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');
const {
  buildIgnoreFilter,
  shouldIgnore,
  AST_EXT,
  MAX_FILE_BYTES,
} = require('./ignore-rules');
const {
  parsePythonRegex,
  parseGoRegex,
  parseRustRegex,
} = require('../ast/parser');

const ENTRY_POINTS = new Set([
  'index.js', 'index.ts', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts',
  'app.js', 'app.ts', 'app.jsx', 'app.tsx',
  'server.js', 'server.ts',
  'main.py', 'app.py', 'server.py',
  'main.go', 'main.rs', 'lib.rs',
]);

const RISKY_PKGS = new Set([
  'eval', 'vm', 'child_process', 'exec', 'shelljs', 'node-serialize'
]);

/**
 * Check if a relative path represents a typical entry point.
 */
function checkEntryPoint(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (ENTRY_POINTS.has(base)) return true;
  if (/^(src\/)?(index|main|app|server)\.[a-z]+$/i.test(relPath)) return true;
  return false;
}

/**
 * Cache for git status output per repository root.
 */
const gitStatusCache = new Map();

function getRepoGitMap(rootPath) {
  const cached = gitStatusCache.get(rootPath);
  if (cached && (Date.now() - cached.timestamp < 3000)) {
    return cached.map;
  }
  const statusMap = new Map();
  try {
    const gitDir = path.join(rootPath, '.git');
    if (!fs.existsSync(gitDir)) {
      gitStatusCache.set(rootPath, { timestamp: Date.now(), map: null });
      return null;
    }
    const { execSync } = require('child_process');
    const out = execSync('git status --porcelain -uall', {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    });
    for (const line of out.split('\n')) {
      if (!line || line.length < 3) continue;
      const code = line.slice(0, 2).trim();
      let file = line.slice(3).trim();
      if (file.startsWith('"') && file.endsWith('"')) {
        file = file.slice(1, -1);
      }
      let st = 'clean';
      if (code === '??') st = 'untracked';
      else if (code === '!!') st = 'ignored';
      else if (code.includes('M') || code.includes('A') || code.includes('R') || code.includes('C')) st = 'modified';
      else if (code.includes('D')) st = 'deleted';
      statusMap.set(file.replace(/\\/g, '/'), st);
    }
    gitStatusCache.set(rootPath, { timestamp: Date.now(), map: statusMap });
  } catch (_) {
    gitStatusCache.set(rootPath, { timestamp: Date.now(), map: null });
  }
  return statusMap;
}

/**
 * Get accurate git status for a file if in git repo.
 * Maps to: 'committed' | 'modified' | 'untracked' | 'ignored' | 'clean'
 */
function getGitStatus(absPath, rootPath) {
  try {
    const rel = path.relative(rootPath, absPath).replace(/\\/g, '/');
    const gitDir = path.join(rootPath, '.git');
    if (!fs.existsSync(gitDir)) return 'clean';
    const statusMap = getRepoGitMap(rootPath);
    if (!statusMap) return 'clean';
    if (statusMap.has(rel)) return statusMap.get(rel);
    return 'committed';
  } catch (_) {
    return 'clean';
  }
}

/**
 * Parse a single file and generate deep metadata.
 */
function parseFileDeep(abs, root) {
  const rel = path.relative(root, abs);
  const ext = (path.extname(abs) || ('.' + abs.split('.').pop())).toLowerCase();
  const rawExt = ext.replace(/^\./, '');

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (_) {
    return null;
  }

  const size = stat.size || 0;
  const lastModified = stat.mtime.toISOString();
  const isEntryPoint = checkEntryPoint(rel);
  const gitStatus = getGitStatus(abs, root);

  const isMultiLang = ['py', 'go', 'rs'].includes(rawExt);

  if (!AST_EXT.has(rawExt) && !isMultiLang) {
    // Non-JS/TS and non-multi-lang file
    let hash = null;
    let loc = 0;
    try {
      if (stat.size <= MAX_FILE_BYTES) {
        const raw = fs.readFileSync(abs);
        hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
        loc = raw.toString('utf8').split('\n').length;
      }
    } catch (_) {}

    return {
      path: rel,
      fns: [],
      exports: [],
      imports: [],
      classes: [],
      isAST: false,
      hash,
      loc,
      size,
      ext,
      lastModified,
      isEntryPoint,
      gitStatus,
    };
  }

  // Size guard
  if (stat.size > MAX_FILE_BYTES) {
    return {
      path: rel,
      fns: [],
      exports: [],
      imports: [],
      classes: [],
      isAST: false,
      hash: null,
      loc: Math.round(stat.size / 30),
      size,
      ext,
      lastModified,
      isEntryPoint,
      gitStatus,
      note: `skipped (${Math.round(stat.size / 1024)}KB > limit)`,
    };
  }

  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch (_) {
    return null;
  }

  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const loc  = source.split('\n').length;

  if (isMultiLang) {
    let meta = { fns: [], exports: [], imports: [], classes: [] };
    if (rawExt === 'py') meta = parsePythonRegex(source);
    else if (rawExt === 'go') meta = parseGoRegex(source);
    else if (rawExt === 'rs') meta = parseRustRegex(source);

    return {
      path: rel,
      fns: meta.fns || [],
      exports: meta.exports || [],
      imports: meta.imports || [],
      classes: meta.classes || [],
      isAST: true,
      hash,
      loc,
      size,
      ext,
      lastModified,
      isEntryPoint,
      gitStatus,
    };
  }

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: [
        'typescript', 'jsx', 'decorators-legacy',
        'classProperties', 'optionalChaining',
        'nullishCoalescingOperator', 'dynamicImport', 'importMeta',
      ],
    });
  } catch (err) {
    return {
      path: rel,
      fns: [],
      exports: [],
      imports: [],
      classes: [],
      isAST: false,
      hash,
      loc,
      size,
      ext,
      lastModified,
      isEntryPoint,
      gitStatus,
      note: `parse error: ${err.message.slice(0, 80)}`,
    };
  }

  const fns = [];
  const exports = [];
  const imports = [];
  const classes = [];

  walkAST(ast.program.body, fns, exports, imports, classes);

  if (fns.length === 0 && source) {
    const fnRegex = /(?:function\s+([a-zA-Z0-9_$]+)|(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:function|\([^)]*\)\s*=>))/g;
    let m;
    while ((m = fnRegex.exec(source)) !== null) {
      const name = (m[1] || m[2] || '').replace(/\(\)$/, '').trim();
      if (name && !fns.some(f => f.startsWith(name))) {
        fns.push(name);
      }
    }
  }

  return {
    path: rel,
    fns,
    exports,
    imports,
    classes,
    isAST: true,
    hash,
    loc,
    size,
    ext,
    lastModified,
    isEntryPoint,
    gitStatus,
  };
}

function walkAST(body, fns, exports, imports, classes) {
  for (const node of body) {
    if (!node) continue;

    // Import declarations
    if (node.type === 'ImportDeclaration' && node.source?.value) {
      const specifiers = (node.specifiers || []).map(s => s.local?.name).filter(Boolean);
      imports.push({ from: node.source.value, specifiers: dedup(specifiers) });
      continue;
    }

    // Export default
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      const name = decl?.id?.name || decl?.name || 'default';
      exports.push(name);
      if (decl?.type === 'ClassDeclaration') {
        classes.push(decl.id?.name || 'AnonymousClass');
        fns.push(`class ${decl.id?.name || 'AnonymousClass'}`);
      } else if (isFunctionLike(decl)) {
        fns.push(sigFromDecl(decl) || name);
      }
      continue;
    }

    // Export named
    if (node.type === 'ExportNamedDeclaration') {
      const decl = node.declaration;
      if (decl?.type === 'VariableDeclaration') {
        for (const declarator of decl.declarations || []) {
          const name = idName(declarator.id);
          if (name) {
            exports.push(name);
            if (declarator.init && isFunctionLike(declarator.init)) {
              fns.push(`${name}(${paramList(declarator.init)})`);
            }
          }
        }
      }
      if (decl?.id?.name) {
        exports.push(decl.id.name);
        if (decl.type === 'ClassDeclaration') {
          classes.push(decl.id.name);
          fns.push(`class ${decl.id.name}`);
        } else if (isFunctionLike(decl)) {
          fns.push(sigFromDecl(decl));
        }
      }
      for (const spec of node.specifiers || []) {
        if (spec.exported?.name) exports.push(spec.exported.name);
      }
      continue;
    }

    // Top-level function declaration
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      fns.push(`${node.id.name}(${paramList(node)})`);
      continue;
    }

    // Top-level class declaration
    if (node.type === 'ClassDeclaration' && node.id?.name) {
      classes.push(node.id.name);
      fns.push(`class ${node.id.name}`);
      continue;
    }

    // Top-level variable declaration
    if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations || []) {
        if (
          declarator.init?.type === 'CallExpression' &&
          declarator.init.callee?.name === 'require' &&
          declarator.init.arguments?.[0]?.value
        ) {
          const pkg = declarator.init.arguments[0].value;
          const specifiers = [];
          if (declarator.id?.type === 'ObjectPattern') {
            for (const prop of declarator.id.properties || []) {
              const n = idName(prop.value || prop.key);
              if (n) specifiers.push(n);
            }
          } else {
            const n = idName(declarator.id);
            if (n) specifiers.push(n);
          }
          imports.push({ from: pkg, specifiers: dedup(specifiers) });
        }

        const name = idName(declarator.id);
        if (name && declarator.init && isFunctionLike(declarator.init)) {
          fns.push(`${name}(${paramList(declarator.init)})`);
        }
      }
    }

    // CommonJS module.exports
    if (
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'AssignmentExpression'
    ) {
      const { left, right } = node.expression;
      if (
        left?.type === 'MemberExpression' &&
        left.object?.name === 'module' &&
        left.property?.name === 'exports'
      ) {
        if (right?.type === 'ObjectExpression') {
          for (const prop of right.properties || []) {
            const name = idName(prop.key);
            if (name) exports.push(name);
          }
        } else {
          exports.push('default');
        }
      }
      if (
        left?.type === 'MemberExpression' &&
        left.object?.name === 'exports' &&
        left.property?.name
      ) {
        exports.push(left.property.name);
      }
    }

    // Traverse IIFEs, CallExpressions, and Event Listener callbacks
    if (node.type === 'ExpressionStatement' && node.expression) {
      const expr = node.expression;
      if (expr.type === 'CallExpression') {
        const callee = expr.callee;
        if (callee?.body?.body && Array.isArray(callee.body.body)) {
          walkAST(callee.body.body, fns, exports, imports, classes);
        } else if (callee?.body?.type === 'BlockStatement' && Array.isArray(callee.body.body)) {
          walkAST(callee.body.body, fns, exports, imports, classes);
        }
        for (const arg of expr.arguments || []) {
          if (arg?.body?.body && Array.isArray(arg.body.body)) {
            walkAST(arg.body.body, fns, exports, imports, classes);
          }
        }
      }
    }

    // Traverse BlockStatement
    if (node.type === 'BlockStatement' && Array.isArray(node.body)) {
      walkAST(node.body, fns, exports, imports, classes);
    }
  }
}

function isFunctionLike(node) {
  if (!node) return false;
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
}

function paramList(node) {
  if (!node?.params) return '';
  return node.params.map(p => {
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'AssignmentPattern') return idName(p.left) || '…';
    if (p.type === 'RestElement') return `...${idName(p.argument) || ''}`;
    if (p.type === 'ObjectPattern') return '{…}';
    if (p.type === 'ArrayPattern') return '[…]';
    if (p.type === 'TSParameterProperty') return idName(p.parameter) || '…';
    return '…';
  }).join(', ');
}

function sigFromDecl(decl) {
  if (!decl) return '';
  if (decl.type === 'ClassDeclaration') return `class ${decl.id?.name || ''}`;
  const name = decl.id?.name || 'anonymous';
  const params = isFunctionLike(decl) ? paramList(decl) : '';
  return `${name}(${params})`;
}

function idName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral' || node.type === 'Literal') return node.value;
  return '';
}

function dedup(arr) { return [...new Set(arr)]; }

/**
 * Calculate 8 dependency health metrics from the file list and rootPath.
 */
function calculateHealth(files, rootPath) {
  const astFiles = files.filter(f => f.isAST);
  const allImports = astFiles.flatMap(f => f.imports.map(i => i.from));
  const external = allImports.filter(m => !m.startsWith('.') && !m.startsWith('/'));
  const unique = [...new Set(external)];

  const riskyCount = unique.filter(p => RISKY_PKGS.has(p.split('/')[0])).length;

  const dotenvFiles = astFiles.filter(f =>
    f.imports.some(i => i.from === 'dotenv' || i.from.includes('.env')) &&
    !f.path.includes('config') &&
    !f.path.includes('env')
  );

  // Missing local relative imports
  const existingFilesSet = new Set(files.map(f => f.path));
  let missingImportsCount = 0;
  for (const f of astFiles) {
    const dir = path.dirname(f.path);
    for (const imp of f.imports) {
      if (imp.from.startsWith('.')) {
        const resolved = path.normalize(path.join(dir, imp.from));
        // Check with possible extensions
        const candidates = [
          resolved,
          `${resolved}.js`, `${resolved}.ts`, `${resolved}.jsx`, `${resolved}.tsx`,
          path.join(resolved, 'index.js'), path.join(resolved, 'index.ts'),
        ];
        const found = candidates.some(c => existingFilesSet.has(c));
        if (!found) missingImportsCount++;
      }
    }
  }

  // Dependency cycles in local relative imports
  const localGraph = new Map();
  for (const f of files) localGraph.set(f.path, []);
  for (const f of astFiles) {
    const dir = path.dirname(f.path);
    const targets = [];
    for (const imp of f.imports) {
      if (imp.from.startsWith('.')) {
        const resolved = path.normalize(path.join(dir, imp.from));
        for (const ext of ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts']) {
          const c = (ext.startsWith('/') ? path.join(resolved, ext.slice(1)) : resolved + ext);
          if (existingFilesSet.has(c)) {
            targets.push(c);
            break;
          }
        }
      }
    }
    localGraph.set(f.path, targets);
  }

  let cycleCount = 0;
  const visited = new Set();
  const recStack = new Set();
  function detectCycle(node) {
    visited.add(node);
    recStack.add(node);
    for (const neighbor of (localGraph.get(node) || [])) {
      if (!visited.has(neighbor)) {
        if (detectCycle(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }
  for (const node of localGraph.keys()) {
    if (!visited.has(node)) {
      if (detectCycle(node)) cycleCount++;
    }
  }

  // Orphan files: files that are never imported locally and are not entry points
  const importedSet = new Set();
  for (const targets of localGraph.values()) {
    for (const t of targets) importedSet.add(t);
  }
  const orphanCount = files.filter(f => !f.isEntryPoint && !importedSet.has(f.path)).length;

  return [
    {
      name: 'Files Scanned',
      pct: Math.min(100, files.length),
      raw: files.length,
      label: `${files.length} total`,
      cls: 'good',
    },
    {
      name: 'AST Parsed',
      pct: files.length ? Math.round((astFiles.length / files.length) * 100) : 0,
      raw: astFiles.length,
      label: `${astFiles.length} / ${files.length}`,
      cls: 'good',
    },
    {
      name: 'Dependencies',
      pct: Math.min(100, unique.length),
      raw: unique.length,
      label: `${unique.length} unique packages`,
      cls: unique.length > 80 ? 'warn' : 'good',
    },
    {
      name: 'Risky Imports',
      pct: riskyCount > 0 ? Math.min(100, riskyCount * 20) : 0,
      raw: riskyCount,
      label: riskyCount > 0 ? `${riskyCount} flagged` : 'None detected',
      cls: riskyCount > 0 ? 'danger' : 'good',
    },
    {
      name: '.env Exposure',
      pct: dotenvFiles.length > 0 ? Math.min(100, dotenvFiles.length * 25) : 0,
      raw: dotenvFiles.length,
      label: dotenvFiles.length > 0 ? `${dotenvFiles.length} risky file(s)` : 'Clean',
      cls: dotenvFiles.length > 0 ? 'warn' : 'good',
    },
    {
      name: 'Missing Imports',
      pct: missingImportsCount > 0 ? Math.min(100, missingImportsCount * 20) : 0,
      raw: missingImportsCount,
      label: missingImportsCount > 0 ? `${missingImportsCount} broken` : 'Clean',
      cls: missingImportsCount > 0 ? 'warn' : 'good',
    },
    {
      name: 'Dependency Cycles',
      pct: cycleCount > 0 ? Math.min(100, cycleCount * 25) : 0,
      raw: cycleCount,
      label: cycleCount > 0 ? `${cycleCount} circular` : 'None',
      cls: cycleCount > 0 ? 'danger' : 'good',
    },
    {
      name: 'Orphan Files',
      pct: files.length ? Math.round((orphanCount / files.length) * 100) : 0,
      raw: orphanCount,
      label: orphanCount > 0 ? `${orphanCount} unreferenced` : 'None',
      cls: orphanCount > 5 ? 'warn' : 'good',
    },
  ];
}

/**
 * Breakdown files into architectural modules (Auth, Database, Routes, Services, Models, Other).
 * @param {Array<object>} files
 * @returns {object}
 */
function calculateModuleBreakdown(files = []) {
  const breakdown = {
    auth: { count: 0, files: [] },
    database: { count: 0, files: [] },
    routes: { count: 0, files: [] },
    services: { count: 0, files: [] },
    models: { count: 0, files: [] },
    other: { count: 0, files: [] }
  };

  for (const f of files) {
    const p = f.path.toLowerCase();
    if (p.includes('auth') || p.includes('jwt') || p.includes('login') || p.includes('session')) {
      breakdown.auth.count++;
      breakdown.auth.files.push(f.path);
    } else if (p.includes('db') || p.includes('database') || p.includes('prisma') || p.includes('sql') || p.includes('schema')) {
      breakdown.database.count++;
      breakdown.database.files.push(f.path);
    } else if (p.includes('route') || p.includes('router') || p.includes('controller') || p.includes('api')) {
      breakdown.routes.count++;
      breakdown.routes.files.push(f.path);
    } else if (p.includes('service')) {
      breakdown.services.count++;
      breakdown.services.files.push(f.path);
    } else if (p.includes('model') || p.includes('entity')) {
      breakdown.models.count++;
      breakdown.models.files.push(f.path);
    } else {
      breakdown.other.count++;
      breakdown.other.files.push(f.path);
    }
  }

  return breakdown;
}

module.exports = {
  parseFileDeep,
  calculateHealth,
  calculateModuleBreakdown,
  checkEntryPoint,
};
