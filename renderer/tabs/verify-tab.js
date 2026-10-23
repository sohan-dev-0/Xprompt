/**
 * Xprompt — Verify Tab Controller (Step 6 Simplified UI & Deterministic Engine)
 *
 * Displays focused post-execution verification report:
 * 📊 Visual Risk Score Gauge + Progress Bar
 * ✅ Done (Green)
 * ❌ Missed (Red)
 * 🚨 Violations (Red alert)
 * ⚠️ Expandable Issues Accordion (Broken Imports & Regressions — collapsed by default)
 * 🎯 Interactive Next Actions Checklist
 */

(() => {
  'use strict';

  const api = window.xprompt || window.promptLock || window.api;

  // ── DOM refs ──────────────────────────────────────────────────────────────────
  const btnRescan           = document.getElementById('btn-rescan-project');
  const verifyStatus        = document.getElementById('verify-status');
  const verifyEmpty         = document.getElementById('verify-empty');
  const verifyBetaBadge     = document.getElementById('verify-beta-badge');
  const verifyReport        = document.getElementById('verify-report');

  // Core Focused Report sections
  const verifyDone          = document.getElementById('verify-done');
  const verifyMissed        = document.getElementById('verify-missed');
  const verifyViolations    = document.getElementById('verify-violations');
  const verifyPartial       = document.getElementById('verify-partial');

  // Integration Contracts Card (Step 6 Cross-File Validation)
  const cardContracts       = document.getElementById('vr-contracts-card');
  const verifyContractsBadge= document.getElementById('verify-contracts-badge');
  const verifyContractsList = document.getElementById('verify-contracts-list');

  // Expandable Issues Accordion
  const issuesAccordion     = document.getElementById('vr-issues-accordion');
  const issuesCount         = document.getElementById('vr-issues-count');
  const verifyBrokenImports = document.getElementById('verify-broken-imports');
  const cardBrokenImports   = document.getElementById('vr-broken-imports-card');
  const verifyRegressions   = document.getElementById('verify-regressions');
  const cardRegressions     = document.getElementById('vr-regressions-card');

  // Risk Score & Badge
  const verifyRiskScore     = document.getElementById('verify-risk-score');
  const verifyRiskLabel     = document.getElementById('verify-risk-label');
  const verifyRiskBar       = document.getElementById('verify-risk-bar');
  const verifyAiBadge       = document.getElementById('verify-ai-badge');
  const verifyCachedBadge   = document.getElementById('verify-cached-badge');
  const verifyArchBadge     = document.getElementById('verify-arch-badge');
  const verifyRateLimitBadge= document.getElementById('verify-rate-limit-badge');
  const verifyFallbackBadge = document.getElementById('verify-fallback-badge');

  // Production Readiness Circular Ring & Hero
  const verifyScoreRing         = document.getElementById('verify-score-ring');
  const verifyReadinessScore    = document.getElementById('verify-readiness-score');
  const verifyReadinessStatusBadge = document.getElementById('verify-readiness-status-badge');
  const verifyReadinessTitle    = document.getElementById('verify-readiness-title');
  const verifyReadinessSubtitle = document.getElementById('verify-readiness-subtitle');

  // Category Breakdown Cards
  const vrCatArchScore          = document.getElementById('vr-cat-arch-score');
  const vrCatArchBar            = document.getElementById('vr-cat-arch-bar');
  const vrCatArchList           = document.getElementById('vr-cat-arch-list');

  const vrCatQualityScore       = document.getElementById('vr-cat-quality-score');
  const vrCatQualityBar         = document.getElementById('vr-cat-quality-bar');
  const vrCatQualityList        = document.getElementById('vr-cat-quality-list');

  const vrCatSecurityScore      = document.getElementById('vr-cat-security-score');
  const vrCatSecurityBar        = document.getElementById('vr-cat-security-bar');
  const vrCatSecurityList       = document.getElementById('vr-cat-security-list');

  const vrCatErrorScore         = document.getElementById('vr-cat-error-score');
  const vrCatErrorBar           = document.getElementById('vr-cat-error-bar');
  const vrCatErrorList          = document.getElementById('vr-cat-error-list');

  // Big Verdict Banner & Hero Fix elements
  const verifyVerdictBanner = document.getElementById('verify-verdict-banner');
  const verifyVerdictTitle  = document.getElementById('verify-verdict-title');
  const verifyVerdictBadge  = document.getElementById('verify-verdict-badge');
  const verifyVerdictSubtitle = document.getElementById('verify-verdict-subtitle');
  const verifyFixHero       = document.getElementById('verify-fix-hero');
  const btnGenerateFixPrompt = document.getElementById('btn-generate-fix-prompt');
  const technicalAccordion  = document.getElementById('vr-technical-accordion');

  // Meta & Actions
  const verifyNextActions   = document.getElementById('verify-next-actions');
  const verifyTimestamp     = document.getElementById('verify-timestamp');
  const verifySnapshotId    = document.getElementById('verify-snapshot-id');

  let currentReport         = null;

  // Track if user manually expanded accordion
  if (technicalAccordion) {
    technicalAccordion.addEventListener('toggle', () => {
      if (technicalAccordion.open) {
        technicalAccordion.setAttribute('data-user-opened', 'true');
      } else {
        technicalAccordion.removeAttribute('data-user-opened');
      }
    });
  }

  if (issuesAccordion) {
    issuesAccordion.addEventListener('toggle', () => {
      if (issuesAccordion.open) {
        issuesAccordion.setAttribute('data-user-opened', 'true');
      } else {
        issuesAccordion.removeAttribute('data-user-opened');
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function displayToast(msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
      return;
    }
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = msg;
      t.classList.remove('hidden');
      void t.offsetWidth;
      t.classList.add('show');
      setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.classList.add('hidden'), 300);
      }, 2200);
    }
  }

  function setVerifyStatus(msg, type = '') {
    if (!verifyStatus) return;
    verifyStatus.textContent = msg;
    verifyStatus.className = 'verify-status' + (type ? ` ${type}` : '');
  }

  function renderList(el, items, emptyText = 'None') {
    if (!el) return;
    if (!items || items.length === 0) {
      el.innerHTML = `<li class="vr-empty">${emptyText}</li>`;
      return;
    }
    el.innerHTML = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'vr-item';
      li.textContent = item;
      el.appendChild(li);
    }
  }

  function renderChecklist(el, items, emptyText = 'No actions suggested') {
    if (!el) return;
    if (!items || items.length === 0) {
      el.innerHTML = `<li class="vr-empty">${emptyText}</li>`;
      return;
    }
    el.innerHTML = '';
    items.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'vr-checklist-item';

      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '8px';
      label.style.width = '100%';
      label.style.cursor = 'pointer';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = `action-chk-${idx}`;
      chk.addEventListener('change', () => {
        if (chk.checked) {
          li.classList.add('checked');
        } else {
          li.classList.remove('checked');
        }
      });

      const span = document.createElement('span');
      span.textContent = item;

      label.appendChild(chk);
      label.appendChild(span);
      li.appendChild(label);
      el.appendChild(li);
    });
  }

  // ── Verdict Calculation ───────────────────────────────────────────────────────
  function calculateVerdict(report) {
    if (!report) {
      return {
        status: 'green',
        title: '✅ Implementation Looks Good',
        badge: 'Ready for Review',
        subtitle: 'All files created, cross-file contracts passed, and no violations detected.',
        needsFix: false,
      };
    }

    const hasRealItems = (arr) => Array.isArray(arr) && arr.some(item => {
      if (!item || typeof item !== 'string') return false;
      const low = item.toLowerCase().trim();
      return !low.startsWith('no ') &&
             !low.includes('none detected') &&
             !low.includes('not detected') &&
             !low.includes('0 detected');
    });

    const hasMissed = hasRealItems(report.missed);
    const hasViolations = hasRealItems(report.violations);
    const hasBrokenImports = hasRealItems(report.brokenImports);
    const hasRegressions = hasRealItems(report.regressions);
    const contractsFailed = report.contracts ? !report.contracts.passed : false;
    const score = typeof report.riskScore === 'number' ? report.riskScore : 0;
    const prodScore = typeof report.productionScore === 'number'
      ? report.productionScore
      : (typeof report.readinessScore === 'number' ? report.readinessScore : null);

    // 1. RED: Action Required (missing files, broken logic, contract failure, guardrail violations, or prodScore < 50)
    if (hasMissed || hasViolations || hasBrokenImports || hasRegressions || contractsFailed || score >= 50 || (prodScore !== null && prodScore < 50)) {
      let sub = 'Action required — ';
      if (prodScore !== null && prodScore < 50) {
        sub += `Production readiness score is ${prodScore}%. Critical architecture, test, or security items missing.`;
      } else if (hasMissed) {
        sub += `${report.missed.length} expected requirement(s) or file(s) missing.`;
      } else if (contractsFailed) {
        sub += 'Cross-file HTML & JS contracts or script links failed.';
      } else if (hasViolations) {
        sub += `${report.violations.length} guardrail violation(s) detected.`;
      } else {
        sub += 'Critical logic issues or functional regressions detected.';
      }

      return {
        status: 'red',
        title: '⚠️ Implementation Incomplete',
        badge: 'FIX REQUIRED',
        subtitle: sub,
        needsFix: true,
      };
    }

    // 2. YELLOW: Quality Check (minor issues like missing tests, JSDoc, contract warnings, or 50 <= prodScore < 85)
    const hasPartial = hasRealItems(report.partial);
    const hasContractWarnings = report.contracts && Array.isArray(report.contracts.warnings) && report.contracts.warnings.length > 0;
    if (hasPartial || hasContractWarnings || score > 15 || (prodScore !== null && prodScore < 85)) {
      const sub = (prodScore !== null && prodScore < 85)
        ? `Production readiness score is ${prodScore}%. Review the missing quality and test items below.`
        : (hasContractWarnings ? 'Files exist but minor cross-file contract warnings detected.' : 'Code runs but requires polish, tests, or documentation cleanup.');
      return {
        status: 'yellow',
        title: '🟡 Code Quality Needs Improvement',
        badge: 'Quality: Needs Polish',
        subtitle: sub,
        needsFix: true,
      };
    }

    // 3. GREEN: Looks Good (clean code, contracts passed, 0 violations, 0 missed, prodScore >= 85)
    return {
      status: 'green',
      title: '✅ Implementation Looks Good',
      badge: 'Ready for Review',
      subtitle: prodScore !== null
        ? `High production readiness score (${prodScore}%). Architecture, code quality, security, and error handling verified.`
        : 'All files created, cross-file contracts passed, and no violations detected.',
      needsFix: false,
    };
  }

  // ── Render Report ─────────────────────────────────────────────────────────────
  function renderReport(report) {
    if (!report) return;
    currentReport = report;

    if (verifyEmpty)  verifyEmpty.classList.add('hidden');
    if (verifyReport) verifyReport.classList.remove('hidden');

    // 1. Big Verdict Banner at the Top
    const verdict = calculateVerdict(report);

    if (verifyVerdictBanner) {
      verifyVerdictBanner.className = `vr-verdict-banner verdict-${verdict.status}`;
    }
    if (verifyVerdictTitle) {
      verifyVerdictTitle.textContent = verdict.title;
    }
    if (verifyVerdictBadge) {
      verifyVerdictBadge.textContent = verdict.badge;
    }
    if (verifyVerdictSubtitle) {
      verifyVerdictSubtitle.textContent = verdict.subtitle;
    }

    // 2. Hero Fix Button: Massive, glowing, placed right below verdict
    if (btnGenerateFixPrompt) {
      btnGenerateFixPrompt.textContent = '🛠️ Generate Fix Prompt to Complete Task';
    }
    if (verifyFixHero) {
      if (verdict.needsFix) {
        verifyFixHero.classList.remove('hidden');
      } else {
        verifyFixHero.classList.add('hidden');
      }
    }
    if (btnGenerateFixPrompt) {
      if (verdict.needsFix) {
        btnGenerateFixPrompt.classList.remove('hidden');
      } else {
        btnGenerateFixPrompt.classList.add('hidden');
      }
    }

    // 2b. Production Readiness Hero & Circular Ring
    const prodScore = typeof report.productionScore === 'number'
      ? Math.max(0, Math.min(100, Math.round(report.productionScore)))
      : (typeof report.readinessScore === 'number'
        ? Math.max(0, Math.min(100, Math.round(report.readinessScore)))
        : (report.riskScore !== undefined ? Math.max(0, 100 - Math.round(report.riskScore)) : 0));

    if (verifyScoreRing) {
      // Circumference for r=40 is 2 * PI * 40 = 251.327
      const circumference = 251.327;
      const offset = circumference - (prodScore / 100) * circumference;
      verifyScoreRing.style.strokeDashoffset = String(offset);

      verifyScoreRing.classList.remove('ring-green', 'ring-yellow', 'ring-red');
      if (prodScore >= 85) {
        verifyScoreRing.classList.add('ring-green');
      } else if (prodScore >= 50) {
        verifyScoreRing.classList.add('ring-yellow');
      } else {
        verifyScoreRing.classList.add('ring-red');
      }
    }

    if (verifyReadinessScore) {
      verifyReadinessScore.textContent = `${prodScore}%`;
    }

    if (verifyReadinessStatusBadge) {
      verifyReadinessStatusBadge.className = 'vr-readiness-status-badge ' + (
        prodScore >= 85 ? 'badge-green' : (prodScore >= 50 ? 'badge-yellow' : 'badge-red')
      );
      verifyReadinessStatusBadge.textContent = prodScore >= 85
        ? 'PRODUCTION READY'
        : (prodScore >= 50 ? 'NEEDS POLISH' : 'NOT READY');
    }

    // 2c. Category Breakdown Cards (Architecture, Code Quality, Security, Error Handling)
    function renderCategoryCard(scoreEl, barEl, listEl, catData, defaultMax) {
      if (!catData) return;
      const score = typeof catData.score === 'number' ? catData.score : 0;
      const max = catData.maxScore || defaultMax || 30;
      const pct = Math.min(100, Math.max(0, Math.round((score / max) * 100)));

      if (scoreEl) {
        scoreEl.textContent = `${score} / ${max} pts`;
        scoreEl.className = 'vr-cat-score-badge ' + (score === max ? 'cat-pass' : (score > 0 ? 'cat-partial' : 'cat-fail'));
      }
      if (barEl) {
        barEl.style.width = `${pct}%`;
        barEl.className = 'vr-cat-progress-bar ' + (score === max ? 'bar-green' : (score > 0 ? 'bar-yellow' : 'bar-red'));
      }
      if (listEl) {
        listEl.innerHTML = '';
        if (Array.isArray(catData.checks) && catData.checks.length > 0) {
          catData.checks.forEach(chk => {
            const li = document.createElement('li');
            li.className = 'vr-cat-check-item ' + (chk.passed ? 'check-pass' : 'check-fail');
            const icon = document.createElement('span');
            icon.className = 'check-icon';
            icon.textContent = chk.passed ? '✅' : '❌';
            const textWrap = document.createElement('div');
            textWrap.className = 'check-text-wrap';
            const title = document.createElement('span');
            title.className = 'check-name';
            title.textContent = chk.name + (chk.points !== undefined ? ` (${chk.passed ? chk.points : 0}/${chk.points} pts)` : '');
            textWrap.appendChild(title);
            if (chk.detail) {
              const detail = document.createElement('span');
              detail.className = 'check-detail';
              detail.textContent = chk.detail;
              textWrap.appendChild(detail);
            }
            li.appendChild(icon);
            li.appendChild(textWrap);
            listEl.appendChild(li);
          });
        }
      }
    }

    if (report.categories) {
      renderCategoryCard(vrCatArchScore, vrCatArchBar, vrCatArchList, report.categories.architecture, 30);
      renderCategoryCard(vrCatQualityScore, vrCatQualityBar, vrCatQualityList, report.categories.codeQuality, 30);
      renderCategoryCard(vrCatSecurityScore, vrCatSecurityBar, vrCatSecurityList, report.categories.security, 20);
      renderCategoryCard(vrCatErrorScore, vrCatErrorBar, vrCatErrorList, report.categories.errorHandling, 20);
    }

    if (verifyArchBadge) {
      const sessionPlan = window._promptLockSession?.currentPlan || report?.plan || null;
      const isProdModular = !!(
        report?.isProductionModular ||
        sessionPlan?.isProductionModular ||
        /production\s*modular/i.test(sessionPlan?.selectedOptionName || '') ||
        /production\s*modular/i.test(typeof sessionPlan?.selectedOption === 'string' ? sessionPlan.selectedOption : (sessionPlan?.selectedOption?.name || ''))
      );
      if (isProdModular) {
        verifyArchBadge.classList.remove('hidden');
      } else {
        verifyArchBadge.classList.add('hidden');
      }
    }

    // 3. Core Focused Cards (Done, Missed, Violations)
    renderList(verifyDone,        report.done,       'Nothing verified yet');
    renderList(verifyMissed,      report.missed,     'No missed items');
    renderList(verifyViolations,  report.violations, 'No violations detected');

    // 4. Hide Technical Jargon in Collapsed Accordion by Default
    if (technicalAccordion && !technicalAccordion.hasAttribute('data-user-opened')) {
      technicalAccordion.open = false;
    }

    // 4b. Integration Contracts Card (Inside Advanced Technical Details)
    if (cardContracts && verifyContractsList) {
      const contracts = report.contracts || null;
      if (contracts) {
        cardContracts.classList.remove('hidden');
        const passed = Boolean(contracts.passed);
        if (verifyContractsBadge) {
          verifyContractsBadge.textContent = passed ? 'Passed' : 'Failed';
          verifyContractsBadge.className = 'vr-contract-badge ' + (passed ? 'badge-passed' : 'badge-failed');
        }

        const items = [];
        if (Array.isArray(contracts.violations) && contracts.violations.length > 0) {
          contracts.violations.forEach(v => items.push(`❌ ${v}`));
        }
        if (Array.isArray(contracts.warnings) && contracts.warnings.length > 0) {
          contracts.warnings.forEach(w => items.push(`⚠️ ${w}`));
        }
        if (items.length === 0) {
          items.push('✅ Script tags linked, DOM selectors grounded, and event listeners active');
        }

        renderList(verifyContractsList, items);
      } else {
        // Fallback: check violations for contract messages
        const contractViolations = (report.violations || []).filter(v =>
          typeof v === 'string' && (
            v.includes('JS file is not linked in HTML') ||
            v.includes('JS expects ID') ||
            v.includes('Buttons exist but no event listeners found')
          )
        );
        if (contractViolations.length > 0) {
          cardContracts.classList.remove('hidden');
          if (verifyContractsBadge) {
            verifyContractsBadge.textContent = 'Failed';
            verifyContractsBadge.className = 'vr-contract-badge badge-failed';
          }
          renderList(verifyContractsList, contractViolations.map(v => `❌ ${v}`));
        } else {
          cardContracts.classList.remove('hidden');
          if (verifyContractsBadge) {
            verifyContractsBadge.textContent = 'Passed';
            verifyContractsBadge.className = 'vr-contract-badge badge-passed';
          }
          renderList(verifyContractsList, ['✅ All cross-file HTML & JS contracts intact']);
        }
      }
    }

    // Backward-compatibility render for partial
    if (verifyPartial) {
      renderList(verifyPartial, report.partial, 'No partial completions');
    }

    // 5. Expandable Issues in Technical Details
    const brokenCount = Array.isArray(report.brokenImports) ? report.brokenImports.length : 0;
    const regrCount = Array.isArray(report.regressions) ? report.regressions.length : 0;
    const totalIssues = brokenCount + regrCount;

    if (issuesAccordion) {
      if (totalIssues > 0) {
        if (issuesCount) issuesCount.textContent = String(totalIssues);
        renderList(verifyBrokenImports, report.brokenImports, 'No broken imports');
        renderList(verifyRegressions, report.regressions, 'No functional regressions');
        issuesAccordion.classList.remove('hidden');
        if (!issuesAccordion.hasAttribute('data-user-opened')) {
          issuesAccordion.open = false; // Collapsed by default
        }
      } else {
        issuesAccordion.classList.add('hidden');
        issuesAccordion.open = false;
      }
    } else {
      // Fallback if accordion container not present
      if (verifyBrokenImports && cardBrokenImports) {
        if (brokenCount > 0) {
          renderList(verifyBrokenImports, report.brokenImports);
          cardBrokenImports.classList.remove('hidden');
        } else {
          cardBrokenImports.classList.add('hidden');
        }
      }
      if (verifyRegressions && cardRegressions) {
        if (regrCount > 0) {
          renderList(verifyRegressions, report.regressions);
          cardRegressions.classList.remove('hidden');
        } else {
          cardRegressions.classList.add('hidden');
        }
      }
    }

    // 6. Interactive Next Actions Checklist (Road to 100% Production Readiness)
    const actions = Array.isArray(report.nextActions) && report.nextActions.length > 0
      ? report.nextActions
      : (Array.isArray(report.failedChecks) && report.failedChecks.length > 0
        ? report.failedChecks.map(f => typeof f === 'string' ? f : `Resolve: ${f.name} - ${f.detail}`)
        : (report.missed && report.missed.length > 0 ? report.missed.map(m => `Implement: ${m}`) : ['All production readiness checks passed! Ready for deployment.']));

    renderChecklist(verifyNextActions, actions, 'No actions suggested');

    // 7. Remove Intimidating Scores — Human-Readable Technical Details
    const score = typeof report.riskScore === 'number'
      ? Math.max(0, Math.min(100, Math.round(report.riskScore)))
      : 0;

    if (verifyRiskLabel) {
      if (verdict.status === 'red') {
        verifyRiskLabel.textContent = 'FIX REQUIRED';
        verifyRiskLabel.className = 'vr-risk-label risk-high';
      } else if (verdict.status === 'yellow') {
        verifyRiskLabel.textContent = 'Quality: Needs Polish';
        verifyRiskLabel.className = 'vr-risk-label risk-medium';
      } else {
        verifyRiskLabel.textContent = 'Looks Good';
        verifyRiskLabel.className = 'vr-risk-label risk-low';
      }
    }

    if (verifyRiskScore) {
      if (verdict.status === 'red') {
        verifyRiskScore.textContent = '!';
        verifyRiskScore.className = 'vr-risk-number risk-high';
      } else if (verdict.status === 'yellow') {
        verifyRiskScore.textContent = `${score}`;
        verifyRiskScore.className = 'vr-risk-number risk-medium';
      } else {
        verifyRiskScore.textContent = `${score}`;
        verifyRiskScore.className = 'vr-risk-number risk-low';
      }
    }

    if (verifyRiskBar) {
      verifyRiskBar.style.width = `${Math.max(5, score)}%`;
      verifyRiskBar.className = `vr-progress-bar risk-${verdict.status === 'red' ? 'high' : (verdict.status === 'yellow' ? 'medium' : 'low')}`;
    }

    // AI Verified & Cached Badges
    if (verifyAiBadge) {
      if (report.isAiVerified) {
        verifyAiBadge.classList.remove('hidden');
      } else {
        verifyAiBadge.classList.add('hidden');
      }
    }
    if (verifyCachedBadge) {
      if (report.isCached || report.cached) {
        verifyCachedBadge.classList.remove('hidden');
      } else {
        verifyCachedBadge.classList.add('hidden');
      }
    }

    // UX Improvement: Red Rate-Limited Badge / Offline Mode
    const isRateLimited = !!(report.providerUsed === 'fallback' || report.isStatic || report._fallback || report.aiError === 'API_LIMIT_REACHED');
    if (verifyRateLimitBadge) {
      if (isRateLimited && !report.isAiVerified) {
        verifyRateLimitBadge.classList.remove('hidden');
        verifyRateLimitBadge.textContent = '🚫 API Limit Exceeded (Rule-Based Audit)';
        verifyRateLimitBadge.title = 'AI limit reached. Verification is running via local rule-based audit.';
        verifyRateLimitBadge.style.cssText = 'font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.35); margin-left: 8px;';
      } else {
        verifyRateLimitBadge.classList.add('hidden');
      }
    }
    if (verifyFallbackBadge) {
      if (isRateLimited && !report.isAiVerified) {
        verifyFallbackBadge.classList.remove('hidden');
        verifyFallbackBadge.textContent = '🚫 API Limit Exceeded (Rule-Based Audit)';
        verifyFallbackBadge.title = 'AI limit reached. Verification is running via local rule-based audit.';
        verifyFallbackBadge.style.cssText = 'font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 600; background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.35);';
      } else {
        verifyFallbackBadge.classList.add('hidden');
      }
    }

    if (verifyTimestamp && report.timestamp) {
      verifyTimestamp.textContent = new Date(report.timestamp).toLocaleString();
    }
    if (verifySnapshotId && report.snapshotId) {
      verifySnapshotId.textContent = report.snapshotId;
    }
  }

  // Expose for external calls from app.js
  window.renderVerificationReport = renderReport;

  // ── Re-scan Button ────────────────────────────────────────────────────────────
  async function runVerification() {
    if (!api || !api.verify || typeof api.verify.run !== 'function') {
      setVerifyStatus('Verify API not available.', 'error');
      return;
    }

    setVerifyStatus('Scanning project for changes…', 'working');
    if (btnRescan) {
      btnRescan.disabled = true;
      btnRescan.classList.add('loading');
    }

    try {
      const result = await api.verify.run();
      if (!result.ok) throw new Error(result.error || 'Verification failed');

      renderReport(result.report);

      const isUnchanged = Boolean(result.report.isCached || result.report.cached || result.report.unchanged);
      if (isUnchanged) {
        displayToast('📦 Cached Result (No changes detected)');
        setVerifyStatus('Cached Result - No changes detected', 'success');
      } else {
        const v = calculateVerdict(result.report);
        const badgeText = result.report.isAiVerified ? ' (AI Verified)' : ' (Rule-Based Fallback)';
        displayToast(`${v.title} — ${v.badge}`);
        setVerifyStatus(`${v.title} — ${v.badge}${badgeText}`, v.status === 'red' ? 'error' : 'success');
      }

      // Persist report to session
      if (window._promptLockSession) {
        window._promptLockSession.lastVerificationReport = result.report;
      }
    } catch (err) {
      setVerifyStatus(`Verification error: ${err.message}`, 'error');
      displayToast(`❌ Verification error: ${err.message}`);
    } finally {
      if (btnRescan) {
        btnRescan.disabled = false;
        btnRescan.classList.remove('loading');
      }
    }
  }

  if (btnRescan) btnRescan.addEventListener('click', runVerification);

  // ── Auto-Fix Prompt Generation ──────────────────────────────────────────────
  async function generateFixPrompt() {
    if (!currentReport) return;
    const fn = api?.verify?.generateFixPrompt || api?.verification?.generateFixPrompt;
    if (!fn) {
      displayToast('❌ Fix Prompt API not available.');
      return;
    }

    if (btnGenerateFixPrompt) {
      btnGenerateFixPrompt.disabled = true;
      btnGenerateFixPrompt.textContent = '⏳ Generating Fix Prompt…';
    }

    try {
      const res = await fn({
        report: currentReport,
        originalPrompt: window._promptLockSession?.lastGeneratedPrompt || '',
        plan: window._promptLockSession?.currentPlan || null,
      });

      if (!res?.ok) throw new Error(res?.error || 'Failed to generate fix prompt');

      const fixPrompt = res.prompt;

      // Update prompt tab preview if available
      if (window._promptTab && typeof window._promptTab.renderStrictPrompt === 'function') {
        window._promptTab.renderStrictPrompt(fixPrompt, {
          isFixPrompt: true,
          riskScore: currentReport.riskScore,
          riskLabel: currentReport.riskLabel,
        });
      } else {
        document.dispatchEvent(new CustomEvent('prompt:restored', {
          detail: {
            prompt: fixPrompt,
            metadata: { isFixPrompt: true },
          }
        }));
      }

      // Sync session state
      if (window._promptLockSession) {
        window._promptLockSession.lastGeneratedPrompt = fixPrompt;
        if (Array.isArray(res.promptHistory)) {
          window._promptLockSession.promptHistory = res.promptHistory;
        }
      }

      displayToast('🛠️ Auto-Fix Prompt generated!');
      setVerifyStatus('Auto-Fix Prompt generated and loaded into Prompt Tab', 'success');

      // Automatically switch to Prompt Tab
      const promptTab = document.querySelector('.tab[data-tab="prompt"]') ||
                        document.querySelector('.tab[data-tab="copilot"]');
      if (promptTab) {
        promptTab.click();
      }
    } catch (err) {
      displayToast(`❌ Fix prompt failed: ${err.message}`);
      setVerifyStatus(`Fix prompt generation error: ${err.message}`, 'error');
    } finally {
      if (btnGenerateFixPrompt) {
        btnGenerateFixPrompt.disabled = false;
        btnGenerateFixPrompt.textContent = '🛠️ Generate Fix Prompt to Complete Task';
      }
    }
  }

  if (btnGenerateFixPrompt) btnGenerateFixPrompt.addEventListener('click', generateFixPrompt);

  // ── Listen for pushed report from main ───────────────────────────────────────
  if (api && api.onVerificationReport) {
    api.onVerificationReport(report => {
      renderReport(report);
      setVerifyStatus(`Report received — Risk: ${report.riskLabel || 'Low'}`, 'success');
    });
  }

  // Expose for orchestration
  window._verifyTabInit = true;
})();
