/**
 * PromptLock — Full AST Parser (Step 3)
 *
 * Uses @babel/parser + @babel/traverse to extract rich metadata
 * from JS/TS source files.
 *
 * Extracts: imports, exports, functions, classes, decorators.
 * Broken files → skip gracefully, return null.
 * NEVER returns raw source code — only structural metadata.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BABEL_PLUGINS = [
  'jsx',
  'typescript',
  ['decorators', { decoratorsBeforeExport: true }],
  'dynamicImport',
  'classProperties',
  'classPrivateMethods',
  'classPrivateProperties',
  'optionalChaining',
  'nullishCoalescingOperator',
  'exportDefaultFrom',
  'exportNamespaceFrom',
];

/**
 * Regex-based parser helpers for non-JS backend languages
 */
function parsePythonRegex(source) {
  const fns = [];
  const fnNames = [];
  const classes = [];
  const imports = [];
  const exports = [];

  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    // Functions: def func_name(...) or async def func_name(...)
    const fnMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const fnName = fnMatch[1];
      const params = (fnMatch[2] || '').trim();
      const sig = params ? `${fnName}(${params})` : `${fnName}()`;
      fns.push(sig);
      fnNames.push(fnName);
      if (!fnName.startsWith('_')) exports.push(fnName);
      continue;
    }

    // Classes: class ClassName(...) or class ClassName:
    const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/);
    if (classMatch) {
      const clsName = classMatch[1];
      classes.push(clsName);
      if (!clsName.startsWith('_')) exports.push(clsName);
      continue;
    }

    // Imports: from x import y, z
    const fromMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+([^#]+)/);
    if (fromMatch) {
      const pkg = fromMatch[1];
      const specs = fromMatch[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      imports.push({ from: pkg, specifiers: specs });
      continue;
    }

    // Imports: import x, y
    const importMatch = trimmed.match(/^import\s+([^#]+)/);
    if (importMatch) {
      const pkgs = importMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const p of pkgs) {
        imports.push({ from: p, specifiers: [] });
      }
      continue;
    }
  }

  return { fns, fnNames, classes, imports, exports };
}

function parseGoRegex(source) {
  const fns = [];
  const fnNames = [];
  const classes = [];
  const imports = [];
  const exports = [];

  // Match func (r *Receiver) MethodName(params) or func FuncName(params)
  const fnRegex = /(?:^|\n)\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = fnRegex.exec(source)) !== null) {
    const fnName = m[1];
    const params = (m[2] || '').trim();
    const sig = params ? `${fnName}(${params})` : `${fnName}()`;
    fns.push(sig);
    fnNames.push(fnName);
    if (/^[A-Z]/.test(fnName)) exports.push(fnName);
  }

  // Structs and interfaces: type Foo struct / type Bar interface
  const typeRegex = /(?:^|\n)\s*type\s+([a-zA-Z0-9_]+)\s+(?:struct|interface)/g;
  while ((m = typeRegex.exec(source)) !== null) {
    const typeName = m[1];
    classes.push(typeName);
    if (/^[A-Z]/.test(typeName)) exports.push(typeName);
  }

  // Grouped imports: import ( "fmt" \n "net/http" )
  const groupImportRegex = /import\s*\(\s*([\s\S]*?)\s*\)/g;
  while ((m = groupImportRegex.exec(source)) !== null) {
    const block = m[1];
    const lines = block.split('\n');
    for (const l of lines) {
      const im = l.trim().match(/(?:[a-zA-Z0-9_]+\s+)?"([^"]+)"/);
      if (im) imports.push({ from: im[1], specifiers: [] });
    }
  }

  // Single imports: import "fmt" or import p "path"
  const singleImportRegex = /(?:^|\n)\s*import\s+(?:[a-zA-Z0-9_]+\s+)?"([^"]+)"/g;
  while ((m = singleImportRegex.exec(source)) !== null) {
    imports.push({ from: m[1], specifiers: [] });
  }

  return { fns, fnNames, classes, imports, exports };
}

function parseRustRegex(source) {
  const fns = [];
  const fnNames = [];
  const classes = [];
  const imports = [];
  const exports = [];

  // fn name(params) or pub fn name(params) or async fn name(params)
  const fnRegex = /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern(?:\s+"[^"]+")?\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  let m;
  while ((m = fnRegex.exec(source)) !== null) {
    const fnName = m[1];
    const params = (m[2] || '').trim();
    const sig = params ? `${fnName}(${params})` : `${fnName}()`;
    fns.push(sig);
    fnNames.push(fnName);
    if (m[0].includes('pub ')) exports.push(fnName);
  }

  // struct / enum / trait
  const structRegex = /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait)\s+([a-zA-Z0-9_]+)/g;
  while ((m = structRegex.exec(source)) !== null) {
    const name = m[1];
    classes.push(name);
    if (m[0].includes('pub ')) exports.push(name);
  }

  // use statements: use std::io; use crate::foo::bar;
  const useRegex = /(?:^|\n)\s*(?:pub\s+)?use\s+([^;]+);/g;
  while ((m = useRegex.exec(source)) !== null) {
    const rawUse = m[1].trim();
    imports.push({ from: rawUse, specifiers: [] });
  }

  return { fns, fnNames, classes, imports, exports };
}

/**
 * Parse a single JS/TS or multi-language source file and extract AST metadata.
 * @param {string} filePath - Absolute path to the source file
 * @returns {object|null} Metadata or null on failure
 */
function parseFile(filePath) {
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source || source.length > 500_000) return null; // skip huge files

    const ext = path.extname(filePath).toLowerCase();
    const loc = source.split('\n').length;
    const size = Buffer.byteLength(source, 'utf8');
    const unique = arr => [...new Set(arr)];

    // ── Multi-Language Fallback: Python, Go, Rust ─────────────────
    if (ext === '.py') {
      const py = parsePythonRegex(source);
      return {
        path:    filePath,
        imports: unique(py.imports.map(i => i.from ? i : { from: String(i), specifiers: [] })),
        exports: unique(py.exports),
        fns:     unique(py.fnNames?.length ? py.fnNames : py.fns),
        classes: unique(py.classes),
        loc,
        size,
        ext,
        isAST:   true,
      };
    }

    if (ext === '.go') {
      const go = parseGoRegex(source);
      return {
        path:    filePath,
        imports: unique(go.imports.map(i => i.from ? i : { from: String(i), specifiers: [] })),
        exports: unique(go.exports),
        fns:     unique(go.fnNames?.length ? go.fnNames : go.fns),
        classes: unique(go.classes),
        loc,
        size,
        ext,
        isAST:   true,
      };
    }

    if (ext === '.rs') {
      const rs = parseRustRegex(source);
      return {
        path:    filePath,
        imports: unique(rs.imports.map(i => i.from ? i : { from: String(i), specifiers: [] })),
        exports: unique(rs.exports),
        fns:     unique(rs.fnNames?.length ? rs.fnNames : rs.fns),
        classes: unique(rs.classes),
        loc,
        size,
        ext,
        isAST:   true,
      };
    }

    const parser = require('@babel/parser');
    const traverse = require('@babel/traverse').default || require('@babel/traverse');

    const ast = parser.parse(source, {
      sourceType: 'unambiguous',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction:  true,
      errorRecovery:               true,
      plugins:                     BABEL_PLUGINS,
    });

    const imports   = [];
    const exports   = [];
    const functions = [];
    const classes   = [];

    traverse(ast, {
      // ── Imports ──────────────────────────────────────────────
      ImportDeclaration({ node }) {
        const specifiers = node.specifiers.map(s => s.local?.name || s.imported?.name || '*');
        imports.push({ from: node.source.value, specifiers });
      },

      // ── Require calls ─────────────────────────────────────────
      CallExpression({ node }) {
        if (
          node.callee?.name === 'require' &&
          node.arguments?.[0]?.type === 'StringLiteral'
        ) {
          imports.push({ from: node.arguments[0].value, specifiers: [] });
        }
      },

      // ── Named exports ─────────────────────────────────────────
      ExportNamedDeclaration({ node }) {
        if (node.declaration) {
          const decl = node.declaration;
          if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
            exports.push(decl.id.name);
            functions.push(decl.id.name);
          } else if (decl.type === 'ClassDeclaration' && decl.id?.name) {
            exports.push(decl.id.name);
            classes.push(decl.id.name);
          } else if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) {
              const name = d.id?.name;
              if (name) {
                exports.push(name);
                if (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression') {
                  functions.push(name);
                }
              }
            }
          }
        }
        // export { a, b }
        if (node.specifiers) {
          for (const s of node.specifiers) {
            if (s.exported?.name) exports.push(s.exported.name);
          }
        }
      },

      // ── Default export ────────────────────────────────────────
      ExportDefaultDeclaration({ node }) {
        const decl = node.declaration;
        if (decl?.id?.name) exports.push(decl.id.name);
        else exports.push('default');
        if (decl?.type === 'ClassDeclaration' && decl?.id?.name) classes.push(decl.id.name);
      },

      // ── module.exports ────────────────────────────────────────
      AssignmentExpression({ node }) {
        const left = node.left;
        if (
          left?.object?.name === 'module' &&
          left?.property?.name === 'exports'
        ) {
          const right = node.right;
          if (right?.type === 'ObjectExpression') {
            for (const prop of right.properties || []) {
              if (prop.key?.name) exports.push(prop.key.name);
            }
          }
        }
      },

      // ── Function declarations ─────────────────────────────────
      FunctionDeclaration({ node }) {
        if (node.id?.name && !functions.includes(node.id.name)) {
          functions.push(node.id.name);
        }
      },

      // ── Class declarations ────────────────────────────────────
      ClassDeclaration({ node }) {
        if (node.id?.name && !classes.includes(node.id.name)) {
          classes.push(node.id.name);
        }
      },

      // ── Arrow / variable functions ────────────────────────────
      VariableDeclarator({ node }) {
        if (
          node.id?.name &&
          (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression') &&
          !functions.includes(node.id.name)
        ) {
          functions.push(node.id.name);
        }
      },
    });

    const relPath = filePath; // caller should normalize

    return {
      path:    relPath,
      imports: unique(imports.map(i => i.from ? i : { from: String(i), specifiers: [] })),
      exports: unique(exports),
      fns:     unique(functions.map(fn => String(fn).replace(/\(\)$/, ''))),
      classes: unique(classes),
      loc,
      size:    Buffer.byteLength(source, 'utf8'),
      ext:     path.extname(filePath).toLowerCase(),
      isAST:   true,
    };
  } catch (err) {
    // Graceful failure — log warning but never crash
    console.warn(`[Parser] Skipped ${path.basename(filePath)}: ${err.message?.slice(0, 80)}`);
    return null;
  }
}

/**
 * Parse multiple files and return metadata array.
 * @param {string[]} filePaths
 * @returns {object[]} Array of parsed metadata (nulls filtered)
 */
function parseFiles(filePaths) {
  const results = [];
  for (const fp of filePaths) {
    const meta = parseFile(fp);
    if (meta) results.push(meta);
  }
  return results;
}

module.exports = {
  parseFile,
  parseFiles,
  parsePythonRegex,
  parseGoRegex,
  parseRustRegex,
};
