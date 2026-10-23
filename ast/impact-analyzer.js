/**
 * PromptLock — Impact Analyzer (Step 3)
 *
 * Analyzes what files would be impacted when a given file changes.
 * Uses reverse dependency graph to compute blast radius.
 */

'use strict';

const { buildGraph } = require('./dependency-graph');

/**
 * Build an impact analyzer from an AST snapshot.
 * @param {object} snapshot - AST project snapshot with .files array
 * @returns {object} Analyzer with impact analysis methods
 */
function buildImpactAnalyzer(snapshot) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  const graph = buildGraph(files);

  return {
    getDirectImpact:   (filePath) => getDirectImpact(filePath, graph),
    getIndirectImpact: (filePath) => getIndirectImpact(filePath, graph),
    getRiskLevel:      (filePaths) => getRiskLevel(filePaths, graph, files),
    getFeatureImpact:  (keywords) => getFeatureImpact(keywords, graph, files),
    cycles:            graph.detectCycles(),
    orphans:           graph.findOrphans(),
  };
}

/**
 * Get files that directly import the given file.
 * @param {string} filePath
 * @param {object} graph
 * @returns {string[]}
 */
function getDirectImpact(filePath, graph) {
  const rdeps = graph.reverseGraph.get(filePath);
  return rdeps ? [...rdeps] : [];
}

/**
 * Get all files transitively affected if the given file changes.
 * BFS on the reverse graph.
 * @param {string} filePath
 * @param {object} graph
 * @returns {string[]}
 */
function getIndirectImpact(filePath, graph) {
  const visited = new Set();
  const queue   = [filePath];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const rdeps = graph.reverseGraph.get(current) || new Set();
    for (const dep of rdeps) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  visited.delete(filePath); // don't include the file itself
  return [...visited];
}

/**
 * Compute risk level for a set of file changes.
 * @param {string[]} filePaths - Files being modified
 * @param {object} graph
 * @param {object[]} allFiles
 * @returns {{ level: 'low'|'medium'|'high', affectedCount: number, reasons: string[] }}
 */
function getRiskLevel(filePaths, graph, allFiles) {
  const totalFiles   = allFiles.length || 1;
  const allImpacted  = new Set();
  const reasons      = [];

  for (const fp of filePaths) {
    const indirect = getIndirectImpact(fp, graph);
    indirect.forEach(f => allImpacted.add(f));
  }

  const affectedCount  = allImpacted.size;
  const affectedRatio  = affectedCount / totalFiles;
  const cycles         = graph.detectCycles();

  if (cycles.length > 0) reasons.push(`${cycles.length} circular dependency cycle(s) detected`);
  if (affectedRatio > 0.4) reasons.push(`>${Math.round(affectedRatio * 100)}% of project files impacted`);
  if (filePaths.some(f => f.includes('auth') || f.includes('security'))) reasons.push('Auth/security module affected');

  const level =
    affectedRatio > 0.4 || cycles.length > 2 ? 'high' :
    affectedRatio > 0.15 || cycles.length > 0 ? 'medium' :
    'low';

  return { level, affectedCount, reasons };
}

/**
 * Find all files related to a feature by keyword matching.
 * @param {string[]} keywords
 * @param {object} graph
 * @param {object[]} allFiles
 * @returns {{ relevantFiles: string[], impactedFiles: string[], riskLevel: string }}
 */
function getFeatureImpact(keywords, graph, allFiles) {
  const kws = keywords.map(k => k.toLowerCase());

  const relevantFiles = allFiles
    .map(f => f.path)
    .filter(p => kws.some(k => p.toLowerCase().includes(k)));

  const allImpacted = new Set();
  for (const rf of relevantFiles) {
    getIndirectImpact(rf, graph).forEach(f => allImpacted.add(f));
  }

  const { level } = getRiskLevel(relevantFiles, graph, allFiles);

  return {
    relevantFiles,
    impactedFiles: [...allImpacted],
    riskLevel: level,
  };
}

module.exports = { buildImpactAnalyzer };
