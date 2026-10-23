/**
 * PromptLock — Missing File Analyzer (Step 4)
 *
 * Cross-references execution plans with workspace AST metadata
 * to detect missing blueprint files and generate actionable warnings.
 */

'use strict';

const path = require('path');
const { detectRequiredFiles } = require('../ast/feature-analyzer');

const BACKEND_KEYWORDS = ['route', 'controller', 'service', 'schema'];

function isBackendFilename(file) {
  if (!file) return false;
  const lower = String(file).toLowerCase();
  return BACKEND_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Analyze missing blueprint files for a given execution plan.
 * @param {object} params - { plan, projectMemory, astSummary, snapshot, projectType }
 * @returns {Promise<{ required: string[], existing: string[], missing: string[], warning: string }>}
 */
async function analyzeMissingFiles(params = {}) {
  const { plan = {}, projectMemory = {}, astSummary = null, snapshot = null } = params;

  // Determine project type
  const { detectProjectType } = require('../ast/project-type-detector');
  const typeResult = detectProjectType(snapshot, projectMemory || {});
  let projectType = params.projectType || plan.projectType || typeResult.projectType;

  const fullFeatureText = `${plan.task || ''} ${plan.intentSummary || ''} ${plan.featureType || ''} ${plan.userIntent || ''} ${params.feature || ''} ${plan.rawUserPrompt || ''}`.toLowerCase();
  const techStackList = Array.isArray(projectMemory?.techStack)
    ? projectMemory.techStack.map(s => String(s).toLowerCase())
    : (typeof projectMemory?.techStack === 'string' ? [projectMemory.techStack.toLowerCase()] : []);
  const isPython = /\b(python|py)\b/i.test(`${fullFeatureText} ${params.requestedLanguage || ''} ${plan.requestedLanguage || ''} ${techStackList.join(' ')}`);
  const isNonJsBackend = isPython || /\b(golang|go|rust|cpp|c\+\+|c|java|ruby|c#|csharp)\b/i.test(`${fullFeatureText} ${techStackList.join(' ')}`);
  const isEmptyFolder = !snapshot || !Array.isArray(snapshot.files) || snapshot.files.length === 0;

  if (isNonJsBackend) {
    projectType = 'backend';
  } else if (isEmptyFolder || projectType === 'unknown' || !projectType) {
    if (isEmptyFolder || fullFeatureText.includes('dark mode') || fullFeatureText.includes('toggle') || fullFeatureText.includes('css') || fullFeatureText.includes('html') || fullFeatureText.includes('theme') || fullFeatureText.includes('ui') || fullFeatureText.includes('vanilla') || fullFeatureText.includes('audio') || fullFeatureText.includes('music') || fullFeatureText.includes('frontend') || fullFeatureText.includes('typing') || fullFeatureText.includes('speed') || fullFeatureText.includes('game') || fullFeatureText.includes('web') || fullFeatureText.includes('test')) {
      projectType = 'frontend';
    }
  }

  const isFrontend = projectType === 'frontend';
  const userRequestedModules = /\b(modular|modules?)\b/i.test(fullFeatureText);

  // 1. Determine selected option id
  const selectedOpt = plan.selectedOption;
  const selectedOptionId = (typeof selectedOpt === 'object' && selectedOpt !== null)
    ? (selectedOpt.id || selectedOpt.name)
    : (selectedOpt || params.selectedOptionId || null);

  // 2. Determine required blueprint files
  let required = [];

  // If an option is specifically chosen and defines filesRequired / filesToCreate / filesToEdit
  if (selectedOptionId && Array.isArray(plan.options || plan.availableApproaches)) {
    const matchingOption = (plan.options || plan.availableApproaches).find(
      opt => opt.id === selectedOptionId || opt.name === selectedOptionId || opt.label === selectedOptionId
    );
    if (matchingOption) {
      if (Array.isArray(matchingOption.filesRequired) && matchingOption.filesRequired.length > 0) {
        required = [...matchingOption.filesRequired];
      } else if (Array.isArray(matchingOption.filesToCreate) || Array.isArray(matchingOption.filesToEdit)) {
        required = [...(matchingOption.filesToCreate || []), ...(matchingOption.filesToEdit || [])];
      }
    }
  }

  // Also if selectedOpt itself is an object with filesRequired / filesToCreate / filesToEdit
  if (required.length === 0 && typeof selectedOpt === 'object' && selectedOpt !== null) {
    if (Array.isArray(selectedOpt.filesRequired) && selectedOpt.filesRequired.length > 0) {
      required = [...selectedOpt.filesRequired];
    } else if (Array.isArray(selectedOpt.filesToCreate) || Array.isArray(selectedOpt.filesToEdit)) {
      required = [...(selectedOpt.filesToCreate || []), ...(selectedOpt.filesToEdit || [])];
    }
  }

  // Also check plan.options or plan.availableApproaches if option not yet selected
  if (required.length === 0 && Array.isArray(plan.options || plan.availableApproaches) && (plan.options || plan.availableApproaches).length > 0) {
    const firstOpt = (plan.options || plan.availableApproaches)[0];
    if (Array.isArray(firstOpt.filesRequired) && firstOpt.filesRequired.length > 0) {
      required = [...firstOpt.filesRequired];
    } else if (Array.isArray(firstOpt.filesToCreate) || Array.isArray(firstOpt.filesToEdit)) {
      required = [...(firstOpt.filesToCreate || []), ...(firstOpt.filesToEdit || [])];
    }
  }

  // If option did not specify files, check plan-level required files
  if (required.length === 0) {
    if (Array.isArray(plan.requiredFiles) && plan.requiredFiles.length > 0) {
      required = [...plan.requiredFiles];
    } else if (Array.isArray(plan.filesToCreate) || Array.isArray(plan.filesToEdit)) {
      const combined = [...(plan.filesToCreate || []), ...(plan.filesToEdit || [])];
      if (combined.length > 0) required = [...new Set(combined)];
    }
  }

  // Explicitly filter out any backend filenames if project is frontend
  if (isFrontend) {
    required = required.filter(f => !isBackendFilename(f));
  } else if (isPython) {
    required = required.filter(f => !/\.(html|css|js|jsx|ts|tsx)$/i.test(f));
  }

  // Modular utilities detection (e.g. Shannon Entropy utility in frontend)
  if (isFrontend && /entropy|shannon/i.test(fullFeatureText)) {
    if (!required.some(r => r.endsWith('entropy.js'))) {
      required.unshift('utils/entropy.js');
    }
  }

  // FIX 2: Include UI Files for UI-related / user-facing features (like displaying entropy, UI controls, etc.)
  const isUIFeature = isFrontend || (!isPython && /entropy|shannon|ui|display|meter|strength|visual|theme|toggle|dark\s*mode|button|modal|input|view|render|html|css|style|password/i.test(fullFeatureText));
  if (isUIFeature && snapshot && Array.isArray(snapshot.files)) {
    const existingInSnapshot = snapshot.files.map(f => normalizePath(f.path));
    const uiCandidates = ['app.js', 'index.html', 'style.css'];
    for (const cand of uiCandidates) {
      const match = existingInSnapshot.find(ef => ef === cand || ef.endsWith('/' + cand) || ef.endsWith('\\' + cand));
      if (match && !required.some(r => normalizePath(r) === match)) {
        required.push(cand);
      }
    }
  }

  // Check if external libraries are needed for Python
  const externalLibsRegex = /\b(watchdog|requests|aiohttp|aiofiles|fastapi|flask|django|uvicorn|pandas|numpy|pytest|click|rich|psutil|pip|requirements)\b/i;
  const needsRequirements = isPython && externalLibsRegex.test(`${fullFeatureText} ${JSON.stringify(plan)} ${JSON.stringify(selectedOpt)}`);

  // Fallback to feature catalog ONLY for backend/unknown non-frontend projects
  if (required.length === 0) {
    if (isFrontend) {
      // NEVER fall back to backend CRUD templates for frontend projects!
      // Default strictly to index.html, style.css, and app.js for frontend projects
      const existingInSnapshot = snapshot && Array.isArray(snapshot.files)
        ? snapshot.files.map(f => normalizePath(f.path))
        : [];
      const standardCandidates = ['index.html', 'style.css', 'app.js'];
      const presentStandard = standardCandidates.filter(sf =>
        existingInSnapshot.some(ef => ef === sf || ef.endsWith('/' + sf) || ef.endsWith('\\' + sf))
      );
      if (presentStandard.length > 0) {
        required = presentStandard;
      } else if (/dark\s*mode/i.test(fullFeatureText)) {
        required = ['index.html', 'app.js'];
      } else {
        required = ['index.html', 'style.css', 'app.js'];
      }
    } else if (isPython) {
      if (needsRequirements) {
        required = ['requirements.txt', 'main.py', 'analyzer.py'];
      } else {
        required = ['main.py', 'analyzer.py'];
      }
    } else {
      const featureText = plan.featureType || plan.intentSummary || '';
      required = detectRequiredFiles(featureText);
    }
  }

  // Python standard files normalization
  if (isPython) {
    if (needsRequirements && !required.some(r => r.endsWith('requirements.txt'))) {
      required.push('requirements.txt');
    }
    if (fullFeatureText.includes('log') || fullFeatureText.includes('analyzer')) {
      if (!required.some(r => r.endsWith('main.py'))) {
        required.unshift('main.py');
      }
      if (!required.some(r => r.endsWith('analyzer.py'))) {
        // If log_analyzer.py is present, swap or add analyzer.py
        const logIdx = required.findIndex(r => r.endsWith('log_analyzer.py'));
        if (logIdx >= 0) {
          required[logIdx] = 'analyzer.py';
        } else {
          required.push('analyzer.py');
        }
      }
    }
  }

  // Deduplicate, normalize, and ensure no backend files or hallucinated modules for frontend
  required = [...new Set(required)];
  if (isFrontend) {
    required = required.filter(f => !isBackendFilename(f));
    // Remove hallucinated modules/ or feature-logic unless user explicitly asked for modular or modules
    if (!userRequestedModules) {
      required = required.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
    }
  } else if (isPython) {
    required = required.filter(f => !/\.(html|css|js|jsx|ts|tsx)$/i.test(f));
  }

  // 2. Collect existing files in workspace
  const existingFilesList = new Set();

  if (snapshot && Array.isArray(snapshot.files)) {
    for (const f of snapshot.files) {
      existingFilesList.add(normalizePath(f.path));
    }
  } else if (astSummary && Array.isArray(astSummary.topFiles)) {
    for (const f of astSummary.topFiles) {
      existingFilesList.add(normalizePath(f.path));
    }
  }

  // 3. Compare required against existing
  const existing = [];
  let missing  = [];

  for (const req of required) {
    const normReq = normalizePath(req);
    const baseReq = path.basename(normReq).toLowerCase().split('.')[0];

    // Check exact or partial match
    let found = false;
    for (const ex of existingFilesList) {
      if (ex === normReq || ex.endsWith(normReq) || path.basename(ex).toLowerCase().split('.')[0] === baseReq) {
        found = true;
        break;
      }
    }

    if (found) {
      existing.push(req);
    } else {
      missing.push(req);
    }
  }

  if (isFrontend) {
    missing = missing.filter(f => !isBackendFilename(f));
    if (!userRequestedModules) {
      missing = missing.filter(f => !String(f).toLowerCase().replace(/\\/g, '/').startsWith('modules/') && !String(f).toLowerCase().includes('feature-logic'));
    }
  } else if (isPython) {
    missing = missing.filter(f => !/\.(html|css|js|jsx|ts|tsx)$/i.test(f));
  }

  // 4. Synthesize developer warning
  let warning = '';
  const total = required.length;
  const foundCount = existing.length;

  if (missing.length > 0) {
    const missingNames = missing.map(m => String(m).replace(/\\/g, '/').replace(/^\.\//, '')).join(', ');
    warning = `Feature requires ${total} files. ${foundCount} found. Please create ${missingNames} before running AI.`;
  } else if (total > 0) {
    warning = `All ${total} required blueprint files are present in the workspace.`;
  } else {
    warning = 'No missing blueprint dependencies detected. (No new files required)';
  }

  return {
    required,
    existing,
    missing,
    warning,
  };
}

/**
 * Normalize path slashes and lowercasing for consistent comparison.
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').toLowerCase().trim();
}

module.exports = {
  analyzeMissingFiles,
  normalizePath,
  isBackendFilename,
};
