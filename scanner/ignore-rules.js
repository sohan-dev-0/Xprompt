/**
 * PromptLock — Ignore Rules Engine (Step 2 Upgrade)
 *
 * Enforces automated ignore rules: skips binary, vendor, and temporary files.
 * Reads project .gitignore if available.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const ignore = require('ignore');

const ALWAYS_IGNORE = [
  'node_modules', '.git', '.git/**', 'dist', 'build', 'out', 'coverage',
  '.cache', '.turbo', '.next', '__pycache__', '__pycache__/**',
  '.env', '.env.*',
  // Step 2 Additions:
  '*.log', '.DS_Store', 'Thumbs.db', '*.tmp',
  // Watcher Stability & Determinism (Step 6):
  'userData', 'userData/**', '*.json',
  // Python Virtual Environments & Bytecode:
  '.venv', '.venv/**', '.venv/',
  'venv', 'venv/**', 'venv/',
  'env', 'env/**', 'env/',
  '__pycache__/',
  '.git/',
  '*.pyc', '*.pyo', '*.pyd',
];

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','svg','ico','webp','bmp',
  'mp4','mp3','wav','ogg','webm','mov','avi',
  'zip','tar','gz','7z','rar','dmg','pkg','exe',
  'pdf','woff','woff2','ttf','otf','eot',
  'lock','map',
]);

const AST_EXT = new Set(['js','jsx','ts','tsx','mjs','cjs']);
const MAX_FILE_BYTES = 512 * 1024; // 512 KB

const IGNORED_DIR_NAMES = new Set([
  '.venv', 'venv', 'env', '__pycache__', '.git',
  'node_modules', 'userData', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.next'
]);

function buildIgnoreFilter(root) {
  const inst = ignore();
  inst.add(ALWAYS_IGNORE);

  if (root) {
    const gitignorePath = path.join(root, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const raw = fs.readFileSync(gitignorePath, 'utf8');
        inst.add(raw);
      } catch (_) {}
    }
  }

  return inst;
}

function shouldIgnore(rel, igFilter) {
  if (!rel) return true;
  const basename = path.basename(rel);
  if (basename === '.DS_Store' || basename === 'Thumbs.db') return true;
  if (basename.endsWith('.log') || basename.endsWith('.tmp')) return true;
  if (basename.endsWith('.json')) return true;
  if (basename.endsWith('.pyc') || basename.endsWith('.pyo') || basename.endsWith('.pyd')) return true;

  const parts = rel.split(/[\\/]/);
  if (parts.some(p => IGNORED_DIR_NAMES.has(p) || p.startsWith('userData') || p === '.env' || p.startsWith('.env.'))) return true;

  const ext = basename.split('.').pop().toLowerCase();
  if (BINARY_EXT.has(ext)) return true;

  if (igFilter) {
    try {
      const normalizedRel = rel.replace(/\\/g, '/');
      return igFilter.ignores(normalizedRel);
    } catch (_) {
      return false;
    }
  }
  return false;
}

module.exports = {
  ALWAYS_IGNORE,
  BINARY_EXT,
  AST_EXT,
  MAX_FILE_BYTES,
  buildIgnoreFilter,
  shouldIgnore,
};
