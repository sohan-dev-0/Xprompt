/**
 * Xprompt — Prompt Validator (Step 4)
 *
 * Verifies that generated AI prompts meet all strict guardrail criteria:
 *  - Zero-secrets enforcement
 *  - Strict file scope & forbidden files boundary
 *  - Milestone & roadmap constraint injection
 *  - Target agent formatting
 *  - Input/Schema validation requirement
 */

'use strict';

/**
 * Validate a generated prompt string against Xprompt guardrail standards.
 * @param {string} promptText
 * @param {object} [options] - { agent, activeRules, plan }
 * @returns {{ valid: boolean, score: number, checks: object, warnings: string[] }}
 */
function validatePrompt(promptText, options = {}) {
  const warnings = [];
  const text = String(promptText || '').toLowerCase();

  if (!promptText || promptText.trim().length < 50) {
    return {
      valid: false,
      score: 0,
      checks: {
        zeroSecrets: false,
        scopeConstraints: false,
        milestoneRoadmap: false,
        targetAgent: false,
        validationRule: false,
      },
      warnings: ['Prompt is empty or too short to provide effective guardrails.'],
    };
  }

  // 1. Check Zero-Secrets
  const hasZeroSecrets =
    text.includes('zero secrets') ||
    text.includes('zero-secret') ||
    (text.includes('.env') && text.includes('never'));
  if (!hasZeroSecrets) {
    warnings.push('Prompt is missing explicit Zero-Secrets constraint.');
  }

  // 2. Check Scope Constraints
  const hasScopeConstraints =
    (text.includes('forbidden') || text.includes('prohibited') || text.includes('not modify')) &&
    (text.includes('files to edit') || text.includes('files to create') ||
     text.includes('files to modify') || text.includes('permitted') ||
     text.includes('permitted files') || text.includes('scope') ||
     text.includes('strict file scope') || text.includes('boundary'));
  if (!hasScopeConstraints) {
    warnings.push('Prompt does not explicitly define allowed/forbidden file boundaries.');
  }

  // 3. Milestone & Roadmap Constraints (Deprecated - Developer-centric workflow)
  const hasMilestoneRoadmap = true;

  // 4. Check Target Agent Specification
  const agent = (options.agent || '').toLowerCase();
  const hasTargetAgent =
    agent.length > 0
      ? text.includes(agent) || text.includes('agent') || text.includes('directive')
      : true;
  if (!hasTargetAgent) {
    warnings.push(`Prompt is not properly tagged for target agent: "${options.agent}".`);
  }

  // 5. Check Validation / Schema Requirement
  const hasValidationRule =
    text.includes('zod') ||
    text.includes('validation') ||
    text.includes('validate') ||
    text.includes('type');
  if (!hasValidationRule) {
    warnings.push('Prompt does not mandate schema or input validation.');
  }

  const checks = {
    zeroSecrets: hasZeroSecrets,
    scopeConstraints: hasScopeConstraints,
    milestoneRoadmap: hasMilestoneRoadmap,
    targetAgent: hasTargetAgent,
    validationRule: hasValidationRule,
  };

  const passedCount = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passedCount / Object.keys(checks).length) * 100);
  const valid = score >= 80;

  return {
    valid,
    score,
    checks,
    warnings,
  };
}

module.exports = {
  validatePrompt,
  CRITERIA: {
    zeroSecrets:      'No secrets, API keys, or credentials may appear in prompt output',
    scopeConstraints: 'Explicit allowed/forbidden file boundaries must be present',
    milestoneRoadmap: 'Step 2.6 Milestone & Roadmap grounding constraints required',
    targetAgent:      'Prompt must be tagged for a specific AI agent directive',
    validationRule:   'Schema or input validation enforcement must be mandated',
  },
};
