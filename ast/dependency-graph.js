/**
 * PromptLock — Dependency Graph (Step 3)
 *
 * Builds adjacency lists from AST import/require metadata.
 * Provides: cycle detection, orphan detection, depth calculation.
 */

'use strict';

/**
 * Build a dependency graph from an array of file metadata objects.
 * @param {object[]} files - Array from parseFiles() or AST snapshot
 * @returns {object} Graph with adjacencyList, reverseGraph, and analysis methods
 */
function buildGraph(files = []) {
  /** @type {Map<string, Set<string>>} path → Set<dependency paths> */
  const adjacencyList = new Map();
  /** @type {Map<string, Set<string>>} path → Set<files that depend on it> */
  const reverseGraph  = new Map();

  // Build path lookup (normalize relative imports)
  const pathSet = new Set(files.map(f => f.path));

  for (const file of files) {
    const src = file.path;
    if (!adjacencyList.has(src)) adjacencyList.set(src, new Set());
    if (!reverseGraph.has(src))  reverseGraph.set(src,  new Set());

    for (const imp of file.imports || []) {
      const from = imp.from || imp;
      // Only track internal dependencies (relative paths)
      if (typeof from === 'string' && from.startsWith('.')) {
        // Attempt to resolve to known file
        const resolved = resolveImport(src, from, pathSet);
        if (resolved) {
          adjacencyList.get(src).add(resolved);
          if (!reverseGraph.has(resolved)) reverseGraph.set(resolved, new Set());
          reverseGraph.get(resolved).add(src);
        }
      }
    }
  }

  return {
    adjacencyList,
    reverseGraph,
    detectCycles:   () => detectCycles(adjacencyList),
    findOrphans:    () => findOrphans(adjacencyList, reverseGraph, files),
    getDepth:       (file) => getDepth(file, adjacencyList),
    toJSON:         () => graphToJSON(adjacencyList, reverseGraph),
  };
}

/**
 * Attempt to resolve a relative import to a known file path.
 * @param {string} fromFile - Source file path
 * @param {string} importStr - Relative import string (e.g. './utils')
 * @param {Set<string>} pathSet
 * @returns {string|null}
 */
function resolveImport(fromFile, importStr, pathSet) {
  const dir = fromFile.replace(/[^/\\]+$/, ''); // dirname
  const base = dir + importStr.replace(/^\.\//, '');
  const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
  for (const ext of extensions) {
    const candidate = (base + ext).replace(/\/\//g, '/');
    if (pathSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Detect circular dependencies using DFS.
 * @param {Map<string, Set<string>>} adj
 * @returns {string[][]} Array of cycles (each cycle is an array of file paths)
 */
function detectCycles(adj) {
  const visited   = new Set();
  const inStack   = new Set();
  const cycles    = [];

  function dfs(node, stack) {
    if (inStack.has(node)) {
      // Found cycle — extract it
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) cycles.push([...stack.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    for (const neighbor of adj.get(node) || []) {
      dfs(neighbor, stack);
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node, []);
  }

  return cycles;
}

/**
 * Find orphan files (no imports and no reverse dependencies).
 * @param {Map<string, Set<string>>} adj
 * @param {Map<string, Set<string>>} rev
 * @param {object[]} files
 * @returns {string[]} Orphan file paths
 */
function findOrphans(adj, rev, files) {
  return files
    .map(f => f.path)
    .filter(p => {
      const deps = adj.get(p) || new Set();
      const rdeps = rev.get(p) || new Set();
      return deps.size === 0 && rdeps.size === 0;
    });
}

/**
 * Calculate the dependency depth (longest path) of a file.
 * @param {string} file
 * @param {Map<string, Set<string>>} adj
 * @returns {number}
 */
function getDepth(file, adj, visited = new Set()) {
  if (visited.has(file)) return 0;
  visited.add(file);
  const deps = adj.get(file) || new Set();
  if (deps.size === 0) return 0;
  return 1 + Math.max(...[...deps].map(d => getDepth(d, adj, new Set(visited))));
}

/**
 * Serialize graph to a plain JSON-safe object.
 */
function graphToJSON(adj, rev) {
  const result = { edges: [], reverseEdges: [] };
  for (const [src, dsts] of adj) {
    for (const dst of dsts) result.edges.push([src, dst]);
  }
  for (const [src, dsts] of rev) {
    for (const dst of dsts) result.reverseEdges.push([src, dst]);
  }
  return result;
}

module.exports = { buildGraph };
