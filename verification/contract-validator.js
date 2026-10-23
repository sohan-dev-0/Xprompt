/**
 * PromptLock — Cross-File Contract Validator (Step 6 Upgrade)
 *
 * Statically analyzes cross-file contracts between HTML and JavaScript:
 * 1. Script Tag Check: Is the JS file referenced in index.html via <script src="...">?
 * 2. DOM ID / Class Match: Do getElementById / querySelector calls in JS match IDs/classes in HTML?
 * 3. Event Listener Check: If HTML has buttons, does JS register event listeners?
 */

'use strict';

const fs = require('fs');
const path = require('path');

let parser = null;
try {
  parser = require('@babel/parser');
} catch (_) {}

/**
 * Extract script src attributes from HTML content.
 * @param {string} htmlContent
 * @returns {string[]}
 */
function extractScriptSources(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') return [];
  const sources = [];
  const scriptRegex = /<script\b[^>]*\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*>/gi;
  let match;
  while ((match = scriptRegex.exec(htmlContent)) !== null) {
    const src = (match[1] || match[2] || '').trim();
    if (src) sources.push(src);
  }
  return sources;
}

/**
 * Extract all declared IDs and class names from HTML content.
 * @param {string} htmlContent
 * @returns {{ ids: Set<string>, classes: Set<string>, buttonCount: number }}
 */
function extractHtmlIdsAndClasses(htmlContent) {
  const ids = new Set();
  const classes = new Set();

  if (!htmlContent || typeof htmlContent !== 'string') {
    return { ids, classes, buttonCount: 0 };
  }

  // 1. Extract IDs (id="foo" or id='foo')
  const idRegex = /\bid\s*=\s*["']([^"']+)["']/gi;
  let idMatch;
  while ((idMatch = idRegex.exec(htmlContent)) !== null) {
    const idVal = (idMatch[1] || '').trim();
    if (idVal) ids.add(idVal);
  }

  // 2. Extract Classes (class="foo bar" or class='foo bar')
  const classRegex = /\bclass\s*=\s*["']([^"']+)["']/gi;
  let classMatch;
  while ((classMatch = classRegex.exec(htmlContent)) !== null) {
    const classVal = (classMatch[1] || '').trim();
    if (classVal) {
      classVal.split(/\s+/).forEach(c => {
        if (c) classes.add(c);
      });
    }
  }

  // 3. Count button elements (<button or <input type="button|submit">)
  const buttonMatches = htmlContent.match(/<button\b|<input\b[^>]*\btype\s*=\s*["'](?:button|submit)["']/gi);
  const buttonCount = buttonMatches ? buttonMatches.length : 0;

  return { ids, classes, buttonCount };
}

/**
 * Extract queried DOM IDs, classes, and event listener registrations from JavaScript content.
 * @param {string} jsContent
 * @returns {{ queriedIds: Set<string>, queriedClasses: Set<string>, addEventListenerCount: number }}
 */
function extractJsDomQueries(jsContent) {
  const queriedIds = new Set();
  const queriedClasses = new Set();
  let addEventListenerCount = 0;

  if (!jsContent || typeof jsContent !== 'string') {
    return { queriedIds, queriedClasses, addEventListenerCount: 0 };
  }

  // 1. Try AST parsing with @babel/parser if available
  if (parser) {
    try {
      const ast = parser.parse(jsContent, {
        sourceType: 'unambiguous',
        plugins: ['jsx', 'typescript'],
        errorRecovery: true,
      });

      let traverse = null;
      try {
        traverse = require('@babel/traverse').default || require('@babel/traverse');
      } catch (_) {}

      if (traverse) {
        traverse(ast, {
          CallExpression(astPath) {
            const callee = astPath.node.callee;
            let methodName = '';
            if (callee.type === 'MemberExpression' && callee.property) {
              methodName = callee.property.name || callee.property.value || '';
            } else if (callee.type === 'Identifier') {
              methodName = callee.name || '';
            }

            const args = astPath.node.arguments;

            if (methodName === 'getElementById' && args.length > 0) {
              if (args[0].type === 'StringLiteral') {
                queriedIds.add(args[0].value.trim());
              } else if (args[0].type === 'TemplateLiteral' && args[0].quasis.length === 1) {
                queriedIds.add(args[0].quasis[0].value.raw.trim());
              }
            }

            if ((methodName === 'querySelector' || methodName === 'querySelectorAll') && args.length > 0) {
              let sel = '';
              if (args[0].type === 'StringLiteral') {
                sel = args[0].value.trim();
              } else if (args[0].type === 'TemplateLiteral' && args[0].quasis.length === 1) {
                sel = args[0].quasis[0].value.raw.trim();
              }
              if (sel) {
                const idMatches = sel.match(/#([a-zA-Z0-9_\-]+)/g);
                if (idMatches) {
                  idMatches.forEach(m => queriedIds.add(m.slice(1)));
                }
                const classMatches = sel.match(/\.([a-zA-Z0-9_\-]+)/g);
                if (classMatches) {
                  classMatches.forEach(m => queriedClasses.add(m.slice(1)));
                }
              }
            }

            if (methodName === 'addEventListener') {
              addEventListenerCount++;
            }
          },
          AssignmentExpression(astPath) {
            const left = astPath.node.left;
            if (left && left.type === 'MemberExpression' && left.property) {
              const propName = left.property.name || left.property.value || '';
              if (/^on[a-z]+$/i.test(propName)) {
                addEventListenerCount++;
              }
            }
          }
        });
      }
    } catch (_) {
      // Fallback to regex below
    }
  }

  // 2. Regex extraction (as fallback and supplement)
  const getElRegex = /\bgetElementById\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = getElRegex.exec(jsContent)) !== null) {
    const idVal = (match[1] || '').trim();
    if (idVal) queriedIds.add(idVal);
  }

  const querySelRegex = /\bquerySelector(?:All)?\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((match = querySelRegex.exec(jsContent)) !== null) {
    const sel = (match[1] || '').trim();
    const idMatches = sel.match(/#([a-zA-Z0-9_\-]+)/g);
    if (idMatches) {
      idMatches.forEach(m => queriedIds.add(m.slice(1)));
    }
    const classMatches = sel.match(/\.([a-zA-Z0-9_\-]+)/g);
    if (classMatches) {
      classMatches.forEach(m => queriedClasses.add(m.slice(1)));
    }
  }

  const listenerRegex = /\baddEventListener\s*\(/g;
  const listenerMatches = jsContent.match(listenerRegex);
  if (listenerMatches && listenerMatches.length > addEventListenerCount) {
    addEventListenerCount = listenerMatches.length;
  }

  const onclickRegex = /(?:\.|\b)on[a-z]+\s*=/gi;
  const onclickMatches = jsContent.match(onclickRegex);
  if (onclickMatches && onclickMatches.length > 0 && addEventListenerCount === 0) {
    addEventListenerCount += onclickMatches.length;
  } else if (onclickMatches && !parser) {
    addEventListenerCount += onclickMatches.length;
  }

  return { queriedIds, queriedClasses, addEventListenerCount };
}

/**
 * Locate relevant HTML and JS files in projectPath or snapshot.
 * @param {string|null} projectPath
 * @param {object|null} snapshot
 * @param {object|null} plan
 * @returns {{ htmlFiles: { path: string, content: string }[], jsFiles: { path: string, content: string }[] }}
 */
function locateFiles(projectPath, snapshot, plan) {
  const htmlFiles = [];
  const jsFiles = [];

  const readSafe = (p) => {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (_) {}
    return null;
  };

  // 1. Check direct files in projectPath
  if (projectPath && fs.existsSync(projectPath)) {
    const candidateHtmls = ['index.html', 'public/index.html', 'src/index.html'];
    for (const rel of candidateHtmls) {
      const full = path.join(projectPath, rel);
      const content = readSafe(full);
      if (content !== null) {
        htmlFiles.push({ path: rel, content });
        break;
      }
    }

    const candidateJs = ['app.js', 'main.js', 'index.js', 'script.js', 'js/app.js', 'js/main.js', 'src/app.js', 'src/index.js'];
    for (const rel of candidateJs) {
      const full = path.join(projectPath, rel);
      const content = readSafe(full);
      if (content !== null) {
        jsFiles.push({ path: rel, content });
      }
    }

    // If still no JS found, search project files mentioned in plan
    if (jsFiles.length === 0 && plan) {
      const planned = [...(plan.filesToCreate || []), ...(plan.filesToEdit || [])];
      for (const f of planned) {
        if (typeof f === 'string' && f.endsWith('.js') && !f.includes('node_modules')) {
          const full = path.isAbsolute(f) ? f : path.join(projectPath, f);
          const content = readSafe(full);
          if (content !== null) {
            jsFiles.push({ path: f, content });
          }
        }
      }
    }
  }

  // 2. Fallback to snapshot files if available
  if (snapshot && Array.isArray(snapshot.files)) {
    if (htmlFiles.length === 0) {
      for (const sf of snapshot.files) {
        if (typeof sf.path === 'string' && sf.path.endsWith('.html')) {
          const full = projectPath ? (path.isAbsolute(sf.path) ? sf.path : path.join(projectPath, sf.path)) : sf.path;
          const content = readSafe(full);
          if (content !== null) {
            htmlFiles.push({ path: sf.path, content });
          }
        }
      }
    }

    if (jsFiles.length === 0) {
      for (const sf of snapshot.files) {
        if (typeof sf.path === 'string' && sf.path.endsWith('.js') && !sf.path.includes('node_modules') && !sf.path.includes('.test.')) {
          const full = projectPath ? (path.isAbsolute(sf.path) ? sf.path : path.join(projectPath, sf.path)) : sf.path;
          const content = readSafe(full);
          if (content !== null) {
            jsFiles.push({ path: sf.path, content });
          }
        }
      }
    }
  }

  return { htmlFiles, jsFiles };
}

const PYTHON_STDLIB = new Set([
  'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore',
  'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'binhex', 'bisect',
  'builtins', 'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd',
  'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
  'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'cProfile', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses',
  'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils', 'doctest',
  'email', 'encodings', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp',
  'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt',
  'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq',
  'hmac', 'html', 'http', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect',
  'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math',
  'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt', 'multiprocessing',
  'netrc', 'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev',
  'parser', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil',
  'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile',
  'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri',
  'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy',
  'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
  'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver',
  'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
  'struct', 'subprocess', 'sunau', 'symbol', 'symtable', 'sys', 'sysconfig',
  'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios',
  'test', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token',
  'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty',
  'turtle', 'turtledemo', 'types', 'typing', 'typing_extensions', 'unicodedata',
  'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
  'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc',
  'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo'
]);

const NODE_STDLIB = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'stream/promises', 'stream/web', 'string_decoder', 'timers', 'timers/promises',
  'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib', 'electron'
]);

/**
 * Check if external dependencies imported in JS or Python exist in package managers.
 * @param {object} params
 * @returns {string[]} Violations found
 */
function checkPackageDependencies(params = {}) {
  const violations = [];
  const {
    projectPath = null,
    snapshot = null,
    diff = null,
    pyContent = null,
    pyPath = null,
    jsContent = null,
    jsPath = null,
    requirementsContent = null,
    packageJsonContent = null,
  } = params;

  const readSafe = (p) => {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (_) {}
    return null;
  };

  // 1. Python dependency check against requirements.txt
  let reqs = null;
  if (typeof requirementsContent === 'string') {
    reqs = requirementsContent;
  } else if (projectPath) {
    reqs = readSafe(path.join(projectPath, 'requirements.txt'));
  }

  const reqPackages = new Set();
  if (reqs) {
    for (const line of reqs.split('\n')) {
      const clean = line.trim().replace(/#.*$/, '').trim();
      if (!clean) continue;
      const pkg = clean.split(/[=><~!#\[\s]/)[0].toLowerCase().replace(/[-_]/g, '');
      if (pkg) reqPackages.add(pkg);
    }
  }

  // Gather python files & contents
  const pyFiles = [];
  if (typeof pyContent === 'string') {
    pyFiles.push({ path: pyPath || 'main.py', content: pyContent });
  }

  const diffPy = [...(diff?.added || []), ...(diff?.modified || [])].filter(f => typeof f === 'string' && f.endsWith('.py'));
  for (const f of diffPy) {
    if (pyFiles.some(pf => pf.path === f)) continue;
    const full = projectPath ? (path.isAbsolute(f) ? f : path.join(projectPath, f)) : f;
    const content = readSafe(full);
    if (content !== null) pyFiles.push({ path: f, content });
  }

  if (projectPath && fs.existsSync(projectPath)) {
    try {
      const entries = fs.readdirSync(projectPath);
      for (const entry of entries) {
        if (entry.endsWith('.py')) {
          if (!pyFiles.some(pf => pf.path === entry)) {
            const content = readSafe(path.join(projectPath, entry));
            if (content !== null) pyFiles.push({ path: entry, content });
          }
        }
      }
    } catch (_) {}
  }

  if (snapshot && Array.isArray(snapshot.files)) {
    for (const sf of snapshot.files) {
      if (sf?.path?.endsWith('.py') && !pyFiles.some(pf => pf.path === sf.path)) {
        const full = projectPath ? (path.isAbsolute(sf.path) ? sf.path : path.join(projectPath, sf.path)) : sf.path;
        const content = readSafe(full);
        if (content !== null) pyFiles.push({ path: sf.path, content });
      }
    }
  }

  for (const file of pyFiles) {
    if (!file || typeof file.content !== 'string') continue;
    const lines = file.content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const candidates = [];
      const fromMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import/);
      if (fromMatch) {
        candidates.push(fromMatch[1].split('.')[0]);
      } else {
        const importMatch = trimmed.match(/^import\s+([^#]+)/);
        if (importMatch) {
          importMatch[1].split(',').forEach(item => {
            const mod = item.trim().split(/\s+as\s+/)[0].split('.')[0].trim();
            if (mod) candidates.push(mod);
          });
        }
      }

      for (const rawPkg of candidates) {
        if (!rawPkg || rawPkg.startsWith('.')) continue;
        const norm = rawPkg.toLowerCase();
        if (PYTHON_STDLIB.has(norm)) continue;

        // Third-party package: verify in requirements.txt
        const normClean = norm.replace(/[-_]/g, '');
        if (!reqs || !reqPackages.has(normClean)) {
          const v = `Missing dependency in package manager file: missing requirements.txt dependency for '${rawPkg}' in ${file.path}.`;
          if (!violations.includes(v)) {
            violations.push(v);
          }
        }
      }
    }
  }

  // 2. JavaScript dependency check against package.json
  let pkgJson = null;
  if (typeof packageJsonContent === 'string') {
    try { pkgJson = JSON.parse(packageJsonContent); } catch (_) {}
  } else if (projectPath) {
    const rawPkg = readSafe(path.join(projectPath, 'package.json'));
    if (rawPkg) {
      try { pkgJson = JSON.parse(rawPkg); } catch (_) {}
    }
  }

  const declaredJsPkgs = new Set();
  if (pkgJson) {
    const allDeps = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.devDependencies || {}),
      ...(pkgJson.peerDependencies || {}),
      ...(pkgJson.optionalDependencies || {}),
    };
    Object.keys(allDeps).forEach(p => declaredJsPkgs.add(p.toLowerCase()));
  }

  const jsFiles = [];
  if (typeof jsContent === 'string') {
    jsFiles.push({ path: jsPath || 'app.js', content: jsContent });
  }

  const diffJs = [...(diff?.added || []), ...(diff?.modified || [])].filter(f => typeof f === 'string' && /\.[cm]?[jt]sx?$/.test(f) && !f.includes('node_modules'));
  for (const f of diffJs) {
    if (jsFiles.some(jf => jf.path === f)) continue;
    const full = projectPath ? (path.isAbsolute(f) ? f : path.join(projectPath, f)) : f;
    const content = readSafe(full);
    if (content !== null) jsFiles.push({ path: f, content });
  }

  if (projectPath && fs.existsSync(projectPath)) {
    try {
      const entries = fs.readdirSync(projectPath);
      for (const entry of entries) {
        if (/\.[cm]?[jt]sx?$/.test(entry) && !entry.includes('node_modules')) {
          if (!jsFiles.some(jf => jf.path === entry)) {
            const content = readSafe(path.join(projectPath, entry));
            if (content !== null) jsFiles.push({ path: entry, content });
          }
        }
      }
    } catch (_) {}
  }

  for (const file of jsFiles) {
    const jsImportRegex = /(?:import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let m;
    while ((m = jsImportRegex.exec(file.content)) !== null) {
      const imp = m[1] || m[2];
      if (!imp || imp.startsWith('.') || imp.startsWith('/') || imp.startsWith('~') || imp.startsWith('@/')) {
        continue;
      }
      let cleanImp = imp.startsWith('node:') ? imp.slice(5) : imp;
      if (NODE_STDLIB.has(cleanImp) || NODE_STDLIB.has(cleanImp.split('/')[0])) {
        continue;
      }

      // External npm package
      let pkgName = imp;
      if (imp.startsWith('@')) {
        const parts = imp.split('/');
        pkgName = parts.slice(0, 2).join('/');
      } else {
        pkgName = imp.split('/')[0];
      }

      if (!pkgJson || !declaredJsPkgs.has(pkgName.toLowerCase())) {
        const v = `Missing dependency in package manager file: '${pkgName}' imported in ${file.path} is missing from package.json.`;
        if (!violations.includes(v)) {
          violations.push(v);
        }
      }
    }
  }

  return violations;
}

/**
 * Statically validate cross-file contracts between HTML and JS, and package dependencies.
 *
 * @param {object} params
 * @param {string} [params.projectPath] - Absolute path to project root
 * @param {string} [params.htmlContent] - Direct HTML string override (for tests)
 * @param {string} [params.jsContent] - Direct JS string override (for tests)
 * @param {string} [params.htmlPath] - Optional path of HTML file
 * @param {string} [params.jsPath] - Optional path of JS file
 * @param {object} [params.snapshot] - AST snapshot
 * @param {object} [params.plan] - Execution plan
 * @returns {{
 *   passed: boolean,
 *   violations: string[],
 *   warnings: string[],
 *   details: object,
 *   riskIncrease: number
 * }}
 */
function validateContracts(params = {}) {
  const violations = [];
  const warnings = [];

  const {
    projectPath = null,
    htmlContent: rawHtml = null,
    jsContent: rawJs = null,
    htmlPath = 'index.html',
    jsPath = 'app.js',
    snapshot = null,
    plan = null,
  } = params;

  // 0. Verify package dependencies for JS and Python files
  const depViolations = checkPackageDependencies(params);
  for (const v of depViolations) {
    if (!violations.includes(v)) {
      violations.push(v);
    }
  }

  let htmlEntries = [];
  let jsEntries = [];

  if (typeof rawHtml === 'string') {
    htmlEntries.push({ path: htmlPath, content: rawHtml });
  }

  if (typeof rawJs === 'string') {
    jsEntries.push({ path: jsPath, content: rawJs });
  }

  // If contents not explicitly provided, search project directory / snapshot
  if (htmlEntries.length === 0 || jsEntries.length === 0) {
    const located = locateFiles(projectPath, snapshot, plan);
    if (htmlEntries.length === 0) htmlEntries = located.htmlFiles;
    if (jsEntries.length === 0) jsEntries = located.jsFiles;
  }

  // If no HTML file is present in project, skip frontend contract check
  if (htmlEntries.length === 0) {
    const passed = violations.length === 0;
    return {
      passed,
      skipped: passed,
      violations,
      warnings,
      details: {
        reason: passed ? 'No HTML file found in project scope' : 'Dependency violations found in project',
        depViolations,
      },
      riskIncrease: violations.length > 0 ? 30 : 0,
    };
  }

  // If HTML exists but no JS file exists
  if (jsEntries.length === 0) {
    // Check if HTML has script tags referencing missing JS files
    for (const h of htmlEntries) {
      const scriptSources = extractScriptSources(h.content);
      for (const src of scriptSources) {
        if (!src.startsWith('http') && !src.startsWith('//')) {
          violations.push(`JS file is not linked in HTML (referenced script "${src}" is missing on disk)`);
        }
      }
    }
    return {
      passed: violations.length === 0,
      violations,
      warnings,
      details: { htmlFiles: htmlEntries.map(h => h.path), jsFiles: [] },
      riskIncrease: violations.length > 0 ? 30 : 0,
    };
  }

  // We have both HTML and JS files — perform cross-file contract checks
  const primaryHtml = htmlEntries[0];
  const primaryJs = jsEntries[0];

  const htmlData = extractHtmlIdsAndClasses(primaryHtml.content);
  const scriptSources = extractScriptSources(primaryHtml.content);

  // 1. Script Tag Check
  // Does index.html link to the JS file?
  for (const jsFile of jsEntries) {
    const jsName = path.basename(jsFile.path);
    const isLinked = scriptSources.some(src => {
      const srcBase = path.basename(src);
      return srcBase === jsName || src === jsFile.path || src === `./${jsName}` || src.endsWith('/' + jsName);
    });

    if (!isLinked) {
      violations.push('JS file is not linked in HTML');
    }
  }

  // 2. DOM ID / Class Match Check
  for (const jsFile of jsEntries) {
    const jsData = extractJsDomQueries(jsFile.content);

    // Cross-reference IDs
    for (const queriedId of jsData.queriedIds) {
      if (!htmlData.ids.has(queriedId)) {
        violations.push(`JS expects ID '#${queriedId}' but it's missing in HTML`);
      }
    }

    // 3. Event Listener Check
    // If HTML has buttons, but JS has zero event listeners
    if (htmlData.buttonCount > 0 && jsData.addEventListenerCount === 0) {
      warnings.push('Buttons exist but no event listeners found');
    }
  }

  const passed = violations.length === 0;
  const riskIncrease = violations.length > 0 ? 30 : (warnings.length > 0 ? 10 : 0);

  return {
    passed,
    violations,
    warnings,
    details: {
      htmlFile: primaryHtml.path,
      jsFile: primaryJs.path,
      scriptSources,
      htmlIds: Array.from(htmlData.ids),
      buttonCount: htmlData.buttonCount,
      violationsCount: violations.length,
      warningsCount: warnings.length,
    },
    riskIncrease,
  };
}

module.exports = {
  validateContracts,
  checkPackageDependencies,
  extractScriptSources,
  extractHtmlIdsAndClasses,
  extractJsDomQueries,
};
