/**
 * PromptLock — Strict Prompt Tab Controller (Step 4 & Polish Update)
 *
 * Grounded strict guardrail prompt generator & viewer.
 * Features:
 *  - Auto-compiles strict prompt on plan approval
 *  - Displays target AI instructions, file boundaries, missing files & AST rules
 *  - Displays token count estimate and 0-100 quality score badge
 *  - Regenerate prompt button (Task 13)
 *  - Editable textarea before copy with Edit toggle (Task 14)
 *  - One-click copy using edited textarea value
 *  - Prompt history diff view (Task 19)
 *  - Markdown export (.md download)
 *  - Persistence and restore across sessions
 */

(() => {
  'use strict';

  const api = window.promptLock || window.api;

  // ── DOM Elements ─────────────────────────────────────────────────────────────
  const promptPreview       = document.getElementById('prompt-preview');
  const promptPreviewText   = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
  const promptDiffContainer = document.getElementById('prompt-diff-container');
  const btnCopyPrompt       = document.getElementById('btn-copy-prompt');
  const btnDownloadPrompt   = document.getElementById('btn-download-prompt');
  const btnRegeneratePrompt = document.getElementById('btn-regenerate-prompt');
  const btnEditPrompt       = document.getElementById('btn-edit-prompt');
  const btnDiffPrompt       = document.getElementById('btn-diff-prompt');
  const promptGenStatus     = document.getElementById('prompt-gen-status');
  const strictPromptPanel   = document.getElementById('strict-prompt-panel');
  const promptEmptyState    = document.getElementById('prompt-empty-state');

  const btnPromptHistory      = document.getElementById('btn-prompt-history');
  const btnPromptHistorySpp   = document.getElementById('btn-prompt-history-spp');
  const promptHistoryDropdown = document.getElementById('prompt-history-dropdown');
  const promptHistoryList     = document.getElementById('prompt-history-list');
  const promptHistoryBadge    = document.getElementById('prompt-history-badge');
  const btnClosePromptHistory = document.getElementById('btn-close-prompt-history');

  // ── State ─────────────────────────────────────────────────────────────────────
  let lastStrictPrompt  = null;
  let lastMetadata      = null;
  let lastPlan          = null;
  let isGenerating      = false;
  let isEditing         = false;
  let isDiffViewing     = false;
  let promptHistory     = [];
  let fullPromptHistory = [];

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // ── Empty State & Panel Toggle ────────────────────────────────────────────────
  function updateEmptyState(hasPrompt) {
    const emptyState = document.getElementById('prompt-empty-state') || promptEmptyState;
    const panel = document.getElementById('strict-prompt-panel') || strictPromptPanel;
    if (emptyState) {
      if (hasPrompt) {
        emptyState.classList.add('hidden');
      } else {
        emptyState.classList.remove('hidden');
      }
    }
    if (panel) {
      if (hasPrompt) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    }
  }

  // ── Status Helper ─────────────────────────────────────────────────────────────
  function setPromptStatus(msg, type = '') {
    if (!promptGenStatus) return;
    promptGenStatus.textContent = msg;
    promptGenStatus.className = 'prompt-gen-status' + (type ? ` ${type}` : '');
  }

  // ── Prompt History UI (Badge & Dropdown) ──────────────────────────────────────
  function formatPromptTime(dateInput) {
    if (!dateInput) return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    try {
      const d = new Date(dateInput);
      if (isNaN(d.getTime())) return String(dateInput);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return 'Recent';
    }
  }

  function refreshPromptHistory(historyList) {
    if (Array.isArray(historyList)) {
      fullPromptHistory = historyList;
    } else if (Array.isArray(window._promptLockSession?.promptHistory) && window._promptLockSession.promptHistory.length > 0) {
      fullPromptHistory = window._promptLockSession.promptHistory;
    } else if (!Array.isArray(fullPromptHistory)) {
      fullPromptHistory = [];
    }

    if (window._promptLockSession) {
      window._promptLockSession.promptHistory = fullPromptHistory;
    }

    // Sync promptHistory string list for diff viewing
    promptHistory = fullPromptHistory
      .map(h => (typeof h === 'string' ? h : (h?.prompt || h?.promptPreview || '')))
      .filter(Boolean);

    if (btnDiffPrompt) {
      if (promptHistory.length > 0) {
        btnDiffPrompt.classList.remove('hidden');
      } else {
        btnDiffPrompt.classList.add('hidden');
      }
    }

    // Update badge count 📜 History (X)
    const count = fullPromptHistory.length;
    const badgeText = `📜 History (${count})`;
    const bph = document.getElementById('btn-prompt-history') || btnPromptHistory;
    const bphs = document.getElementById('btn-prompt-history-spp') || btnPromptHistorySpp;
    const phb = document.getElementById('prompt-history-badge') || promptHistoryBadge;
    if (bph) bph.textContent = badgeText;
    if (bphs) bphs.textContent = badgeText;
    if (phb) phb.textContent = String(count);

    // Render list in reverse chronological order (newest first)
    const listEl = document.getElementById('prompt-history-list') || promptHistoryList;
    if (!listEl) return;
    listEl.innerHTML = '';

    if (fullPromptHistory.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'ph-empty-msg';
      emptyEl.textContent = 'No prompts generated yet for this project.';
      listEl.appendChild(emptyEl);
      return;
    }

    const reversed = [...fullPromptHistory].reverse();
    reversed.forEach((entry, idx) => {
      const item = document.createElement('div');
      item.className = 'ph-item';
      item.setAttribute('data-history-index', String(idx));

      const timeStr = formatPromptTime(entry?.generatedAt || entry?.timestamp);
      const featureName = (typeof entry === 'object' && entry)
        ? (entry.feature || entry.featureName || entry.task || entry.agent || 'Feature Implementation')
        : 'Feature Implementation';
      const agentStr = (typeof entry === 'object' && entry?.agent)
        ? entry.agent.toUpperCase()
        : 'AI';
      const promptText = typeof entry === 'string'
        ? entry
        : (entry?.prompt || entry?.promptPreview || '');
      const previewSnippet = (entry?.promptPreview || promptText).slice(0, 140);

      const headerEl = document.createElement('div');
      headerEl.className = 'ph-item-header';

      const timeEl = document.createElement('span');
      timeEl.className = 'ph-item-time';
      timeEl.textContent = `[${timeStr}]`;

      const sepEl = document.createElement('span');
      sepEl.className = 'ph-item-sep';
      sepEl.textContent = '-';

      const nameEl = document.createElement('span');
      nameEl.className = 'ph-item-name';
      nameEl.textContent = `[${featureName}]`;
      nameEl.title = featureName;

      const agentEl = document.createElement('span');
      agentEl.className = 'ph-item-agent';
      agentEl.textContent = agentStr;

      headerEl.appendChild(timeEl);
      headerEl.appendChild(sepEl);
      headerEl.appendChild(nameEl);
      headerEl.appendChild(agentEl);

      const previewEl = document.createElement('div');
      previewEl.className = 'ph-item-preview';
      previewEl.textContent = previewSnippet;

      item.appendChild(headerEl);
      item.appendChild(previewEl);

      // Clicking an item loads that prompt into the main preview textarea
      item.addEventListener('click', () => {
        renderStrictPrompt(promptText, {
          agent: agentStr.toLowerCase(),
          task: featureName,
        });
        setPromptStatus(`✓ Loaded historical prompt: ${featureName} (${timeStr})`, 'success');
        if (promptHistoryDropdown) {
          promptHistoryDropdown.classList.add('hidden');
        }
      });

      promptHistoryList.appendChild(item);
    });
  }

  // ── Render Strict Prompt in UI ────────────────────────────────────────────────
  function renderStrictPrompt(promptText, metadata = null, incomingRuleIds = null, options = {}) {
    if (!promptText || typeof promptText !== 'string' || !promptText.trim()) {
      updateEmptyState(false);
      const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
      if (textArea) {
        if ('value' in textArea) textArea.value = '';
        textArea.textContent = '';
      }
      setPromptStatus('');
      lastStrictPrompt = null;
      return;
    }

    const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    const isAlreadyRendered = textArea && (textArea.value === promptText || textArea.textContent === promptText);

    // Sync Enforced Security Rules chips in the UI (Step 5 UI Sync)
    const activeRuleIds = incomingRuleIds ||
                          metadata?.selectedSecurityRules ||
                          metadata?.selectedRuleIds ||
                          metadata?.security?.selectedRuleIds ||
                          window._promptLockSession?.activeRules;

    // Deduplicate rapid consecutive renders with identical prompt content
    if (lastStrictPrompt === promptText && !options?.force) {
      if (activeRuleIds && (Array.isArray(activeRuleIds) || typeof activeRuleIds === 'object')) {
        if (typeof window.syncSecurityRulePills === 'function') {
          window.syncSecurityRulePills(activeRuleIds);
        } else {
          syncPillGridFallback(activeRuleIds);
        }
      }
      return;
    }

    // Track prompt history for diff viewing
    if (lastStrictPrompt && lastStrictPrompt !== promptText) {
      if (!promptHistory.includes(lastStrictPrompt)) {
        promptHistory.push(lastStrictPrompt);
      }
    }
    lastStrictPrompt = promptText;
    lastMetadata = metadata;

    if (window._promptLockSession) {
      window._promptLockSession.lastGeneratedPrompt = promptText;
    }

    // Add to fullPromptHistory or sync from metadata
    if (Array.isArray(metadata?.promptHistory) && metadata.promptHistory.length > 0) {
      fullPromptHistory = metadata.promptHistory;
    } else {
      const existing = fullPromptHistory.find(h => (typeof h === 'string' ? h : h.prompt) === promptText);
      if (!existing) {
        const featureName = metadata?.task || metadata?.featureName || window._promptLockSession?.currentIntent || 'Feature Implementation';
        const agent = metadata?.agent || window._promptLockSession?.selectedAgent || 'Target AI';
        fullPromptHistory.push({
          agent,
          planId: metadata?.planId || `plan_${Date.now()}`,
          generatedAt: new Date().toISOString(),
          promptPreview: promptText.slice(0, 160),
          prompt: promptText,
          featureName,
        });
      }
    }
    refreshPromptHistory(fullPromptHistory);

    updateEmptyState(true);

    if (textArea) {
      if ('value' in textArea) {
        textArea.value = promptText;
      }
      textArea.textContent = promptText;
      try {
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
        textArea.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
      console.log(`[Prompt Tab] Rendered prompt length: ${(textArea.value || textArea.textContent || '').length}`);
    }

    // Toggle diff button visibility if history has >= 1 previous prompt
    if (btnDiffPrompt) {
      if (promptHistory.length > 0) {
        btnDiffPrompt.classList.remove('hidden');
      } else {
        btnDiffPrompt.classList.add('hidden');
      }
    }

    const tokens = metadata?.tokenEstimate || Math.ceil(promptText.length / 4);
    const score  = metadata?.validation?.score ?? metadata?.qualityScore ?? 100;
    const agent  = metadata?.agent || window._promptLockSession?.selectedAgent || 'Target AI';

    if (activeRuleIds && (Array.isArray(activeRuleIds) || typeof activeRuleIds === 'object')) {
      if (typeof window.syncSecurityRulePills === 'function') {
        window.syncSecurityRulePills(activeRuleIds);
      } else {
        syncPillGridFallback(activeRuleIds);
      }
    }

    setPromptStatus(`✓ Strict Guardrail Ready for ${agent.toUpperCase()} (~${tokens} tokens, Score: ${score}/100)`, 'success');
  }

  function syncPillGridFallback(ruleIds) {
    const pillGrid = document.getElementById('pillGrid');
    if (!pillGrid) return;
    const ruleArray = Array.isArray(ruleIds) ? ruleIds : (ruleIds ? Object.keys(ruleIds) : []);
    const ruleSet = new Set(ruleArray.map(r => String(r).toLowerCase()));
    if (ruleSet.has('rate-limiting')) ruleSet.add('rate-limit');
    if (ruleSet.has('rate-limit')) ruleSet.add('rate-limiting');
    if (ruleSet.has('input-sanitization')) ruleSet.add('zod-validation');
    if (ruleSet.has('sql-injection')) ruleSet.add('sql-guard');

    pillGrid.querySelectorAll('.pill').forEach(pill => {
      const rId = (pill.dataset.rule || '').toLowerCase();
      pill.classList.toggle('active', ruleSet.has(rId));
    });

    const ruleStripCount = document.getElementById('ruleStripCount');
    if (ruleStripCount) ruleStripCount.textContent = `${ruleArray.length} Active`;
  }

  // ── Toggle Editable Textarea (Task 14) ────────────────────────────────────────
  function toggleEditable() {
    const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    if (!textArea) return;

    isEditing = !isEditing;
    if (isEditing) {
      textArea.removeAttribute('readonly');
      textArea.classList.add('editing-active');
      textArea.focus();
      if (btnEditPrompt) {
        btnEditPrompt.textContent = '🔒 Lock';
        btnEditPrompt.classList.add('active');
      }
      setPromptStatus('✎ Prompt is now editable. Edit instructions directly before copying.', 'working');
    } else {
      textArea.setAttribute('readonly', 'readonly');
      textArea.classList.remove('editing-active');
      lastStrictPrompt = textArea.value;
      if (btnEditPrompt) {
        btnEditPrompt.textContent = '✎ Edit';
        btnEditPrompt.classList.remove('active');
      }
      setPromptStatus('✓ Edits locked into current prompt preview.', 'success');
    }
  }

  // ── Line-by-Line Diff View (Task 19) ─────────────────────────────────────────
  function toggleDiffView(forceState = null) {
    const diffContainer = document.getElementById('prompt-diff-container');
    const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    if (!diffContainer || !textArea) return;

    isDiffViewing = forceState !== null ? forceState : !isDiffViewing;

    if (isDiffViewing && promptHistory.length > 0) {
      const prevPrompt = promptHistory[promptHistory.length - 1];
      const currentPrompt = textArea.value || lastStrictPrompt || '';

      const oldLines = prevPrompt.split('\n');
      const newLines = currentPrompt.split('\n');
      const max = Math.max(oldLines.length, newLines.length);

      const html = [];
      html.push(`<div class="diff-header-bar"><span>Previous vs. Current Prompt Diff</span><button id="btn-close-diff" class="btn-diff-close">✕ Back to Editor</button></div>`);
      html.push('<div class="diff-content-scroll">');

      for (let i = 0; i < max; i++) {
        const o = oldLines[i];
        const n = newLines[i];
        if (o === undefined) {
          html.push(`<div class="diff-row diff-add"><span class="diff-sign">+</span><span class="diff-text">${escapeHtml(n)}</span></div>`);
        } else if (n === undefined) {
          html.push(`<div class="diff-row diff-del"><span class="diff-sign">-</span><span class="diff-text">${escapeHtml(o)}</span></div>`);
        } else if (o !== n) {
          html.push(`<div class="diff-row diff-del"><span class="diff-sign">-</span><span class="diff-text">${escapeHtml(o)}</span></div>`);
          html.push(`<div class="diff-row diff-add"><span class="diff-sign">+</span><span class="diff-text">${escapeHtml(n)}</span></div>`);
        } else {
          html.push(`<div class="diff-row diff-same"><span class="diff-sign"> </span><span class="diff-text">${escapeHtml(n)}</span></div>`);
        }
      }
      html.push('</div>');

      diffContainer.innerHTML = html.join('');
      diffContainer.classList.remove('hidden');
      textArea.classList.add('hidden');
      if (btnDiffPrompt) btnDiffPrompt.textContent = '📄 View Normal';

      document.getElementById('btn-close-diff')?.addEventListener('click', () => toggleDiffView(false));
    } else {
      diffContainer.classList.add('hidden');
      textArea.classList.remove('hidden');
      if (btnDiffPrompt) btnDiffPrompt.textContent = '⚖ Compare with previous';
      isDiffViewing = false;
    }
  }

  // ── Copy to Clipboard (Uses Textarea value — Task 14) ────────────────────────
  async function copyPromptToClipboard() {
    const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    const textToCopy = (textArea && 'value' in textArea ? textArea.value : lastStrictPrompt) || lastStrictPrompt;

    if (!textToCopy) {
      setPromptStatus('No prompt to copy. Generate or approve a plan first.', 'error');
      return;
    }
    try {
      if (api && typeof api.copyToClipboard === 'function') {
        await api.copyToClipboard(textToCopy);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(textToCopy);
      }
      setPromptStatus('✓ Copied to clipboard! Paste into your AI editor (Cursor / Claude / Anti-Gravity).', 'success');
      if (btnCopyPrompt) {
        const orig = btnCopyPrompt.textContent;
        btnCopyPrompt.textContent = '✓ Copied!';
        setTimeout(() => { btnCopyPrompt.textContent = orig; }, 2200);
      }
    } catch (err) {
      setPromptStatus(`Copy failed: ${err.message}`, 'error');
    }
  }

  // ── Download as .md ───────────────────────────────────────────────────────────
  function downloadPromptAsMd() {
    const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    const textToDownload = (textArea && 'value' in textArea ? textArea.value : lastStrictPrompt) || lastStrictPrompt;

    if (!textToDownload) {
      setPromptStatus('No prompt to download. Generate or approve a plan first.', 'error');
      return;
    }
    try {
      const agent = lastMetadata?.agent || window._promptLockSession?.selectedAgent || 'guardrail';
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `promptlock-${agent}-${dateStr}.md`;

      const blob = new Blob([textToDownload], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setPromptStatus(`✓ Downloaded as ${filename}`, 'success');
    } catch (err) {
      setPromptStatus(`Download failed: ${err.message}`, 'error');
    }
  }

  // ── Generate Strict Prompt (Task 13 Regenerate Support) ───────────────────────
  function isValidIntent(s) {
    if (typeof s !== 'string') return false;
    const str = s.trim();
    if (!str) return false;
    const lower = str.toLowerCase();
    if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'undefined') return false;
    if (lower === 'feature implementation' || lower === 'implement approved feature scope') return false;
    return true;
  }

  // ── Generate Strict Prompt (Task 13 Regenerate Support) ───────────────────────
  async function generateStrictPrompt(planOverride = null) {
    if (isGenerating) return;

    if (!api || !api.prompt || typeof api.prompt.generate !== 'function') {
      setPromptStatus('Prompt API not available.', 'error');
      return;
    }

    // Refresh from live session state if available
    let session = window._promptLockSession || {};
    try {
      if (api?.session?.load) {
        const liveSession = await api.session.load();
        if (liveSession && typeof liveSession === 'object') {
          session = { ...session, ...liveSession };
          if (window._promptLockSession) {
            Object.assign(window._promptLockSession, liveSession);
          }
        }
      }
    } catch (_) {}

    const plan = planOverride || lastPlan || session.currentPlan || null;
    const agent = session.selectedAgent ||
                  document.getElementById('targetAgentSelect')?.value ||
                  'cursor';

    const candidateTasks = [
      plan?.task,
      plan?.intentSummary,
      plan?.userIntent,
      session.currentIntent,
      plan?.featureType,
      plan?.title,
    ];
    const task = candidateTasks.find(isValidIntent)
      || (isValidIntent(session.currentIntent) ? session.currentIntent : 'Feature Implementation');

    const activeRules = Array.isArray(session.activeRules) && session.activeRules.length > 0
      ? Array.from(session.activeRules)
      : null;

    setPromptStatus(`Compiling strict guardrail prompt for ${agent}…`, 'working');
    if (btnRegeneratePrompt) {
      btnRegeneratePrompt.disabled = true;
      btnRegeneratePrompt.textContent = '⏳ Regenerating…';
    }
    isGenerating = true;

    try {
      const selectedOption = plan?.selectedOption || session.selectedOption;
      const selectedOptionName = plan?.selectedOptionName || session.selectedOptionName || (typeof selectedOption === 'object' ? (selectedOption.name || selectedOption.label) : null);
      const filesToEdit = plan?.filesToEdit || (typeof selectedOption === 'object' ? selectedOption.filesToEdit : null);
      const filesToCreate = plan?.filesToCreate || (typeof selectedOption === 'object' ? selectedOption.filesToCreate : null);

      const generatePayload = {
        plan: plan || session.currentPlan || undefined,
        planId: plan?.id || session.currentPlan?.id,
        task,
        feature: task,
        userIntent: task,
        agent,
        activeRules,
        selectedOption,
        selectedOptionName,
        filesToEdit,
        filesToCreate,
      };

      const result = await api.prompt.generate(generatePayload);

      if (!result.ok) {
        throw new Error(result.error || 'Generation failed');
      }

      if (Array.isArray(result.promptHistory)) {
        fullPromptHistory = result.promptHistory;
        if (window._promptLockSession) {
          window._promptLockSession.promptHistory = result.promptHistory;
        }
      }

      if (isDiffViewing) {
        toggleDiffView(false);
      }

      renderStrictPrompt(result.prompt, result.metadata, result.selectedRuleIds, { force: true });
      refreshPromptHistory(fullPromptHistory);
      setPromptStatus('✓ Fresh prompt generated and synced.', 'success');

    } catch (err) {
      console.error('[Prompt Tab] Generation error:', err);
      setPromptStatus(`Generation failed: ${err.message}`, 'error');
    } finally {
      isGenerating = false;
      if (btnRegeneratePrompt) {
        btnRegeneratePrompt.disabled = false;
        btnRegeneratePrompt.textContent = '🔄 Regenerate';
      }
    }
  }

  // ── Wire DOM Listeners ────────────────────────────────────────────────────────
  if (btnCopyPrompt)       btnCopyPrompt.addEventListener('click', copyPromptToClipboard);
  if (btnDownloadPrompt)   btnDownloadPrompt.addEventListener('click', downloadPromptAsMd);
  if (btnRegeneratePrompt) {
    btnRegeneratePrompt.addEventListener('click', (e) => {
      if (e) e.preventDefault();
      generateStrictPrompt();
    });
  }
  if (btnEditPrompt)       btnEditPrompt.addEventListener('click', toggleEditable);
  if (btnDiffPrompt)       btnDiffPrompt.addEventListener('click', () => toggleDiffView());

  function togglePromptHistoryDropdown(e) {
    if (e) e.stopPropagation();
    if (!promptHistoryDropdown) return;
    promptHistoryDropdown.classList.toggle('hidden');
  }

  if (btnPromptHistory)    btnPromptHistory.addEventListener('click', togglePromptHistoryDropdown);
  if (btnPromptHistorySpp) btnPromptHistorySpp.addEventListener('click', togglePromptHistoryDropdown);
  if (btnClosePromptHistory) {
    btnClosePromptHistory.addEventListener('click', (e) => {
      e.stopPropagation();
      promptHistoryDropdown?.classList.add('hidden');
    });
  }

  document.addEventListener('click', (e) => {
    if (promptHistoryDropdown && !promptHistoryDropdown.classList.contains('hidden')) {
      if (
        !promptHistoryDropdown.contains(e.target) &&
        e.target !== btnPromptHistory && !btnPromptHistory?.contains(e.target) &&
        e.target !== btnPromptHistorySpp && !btnPromptHistorySpp?.contains(e.target)
      ) {
        promptHistoryDropdown.classList.add('hidden');
      }
    }
  });

  // ── Auto-generate on Plan Approval ───────────────────────────────────────────
  document.addEventListener('plan:approved', async (e) => {
    console.log('[Prompt Tab] Plan approved event received:', e.detail);
    lastPlan = e.detail;
    if (window._promptLockSession) {
      window._promptLockSession.currentPlan = e.detail;
      if (e.detail?.task && isValidIntent(e.detail.task)) {
        window._promptLockSession.currentIntent = e.detail.task;
      }
      if (e.detail?.selectedOption) {
        window._promptLockSession.selectedOption = e.detail.selectedOption;
      }
      if (e.detail?.selectedOptionName) {
        window._promptLockSession.selectedOptionName = e.detail.selectedOptionName;
      }
    }
    if (e.detail?.generatedPrompt) {
      renderStrictPrompt(e.detail.generatedPrompt, e.detail.metadata, e.detail.selectedRuleIds);
    } else {
      await generateStrictPrompt(e.detail);
    }
  });

  // ── Listen for IPC prompt:ready Broadcast ─────────────────────────────────────
  if (api?.prompt?.onReady && !window._promptReadyRegistered) {
    window._promptReadyRegistered = true;
    api.prompt.onReady(({ prompt, metadata, promptHistory: pHistory, selectedRuleIds }) => {
      console.log('[Prompt Tab] prompt:ready IPC received');
      if (Array.isArray(pHistory) && pHistory.length > 0) {
        fullPromptHistory = pHistory;
        if (window._promptLockSession) {
          window._promptLockSession.promptHistory = pHistory;
        }
      }
      renderStrictPrompt(prompt, metadata, selectedRuleIds);
      document.dispatchEvent(new CustomEvent('prompt:ready', { detail: { prompt, metadata, selectedRuleIds } }));
    });
  }

  // ── Listen for Restored Prompt ───────────────────────────────────────────────
  document.addEventListener('prompt:restored', (e) => {
    const data = e.detail;
    if (typeof data === 'string') {
      renderStrictPrompt(data);
    } else if (data?.prompt) {
      renderStrictPrompt(data.prompt, data.metadata, data.selectedRuleIds);
    }
  });

  document.addEventListener('prompt:cleared', () => {
    renderStrictPrompt(null);
    refreshPromptHistory([]);
  });

  // ── Initial Restore on Startup ───────────────────────────────────────────────
  setTimeout(async () => {
    try {
      if (api?.sessionLoad || api?.session?.load) {
        const session = api?.sessionLoad ? await api.sessionLoad() : await api.session.load();
        if (session) {
          if (Array.isArray(session.promptHistory)) {
            refreshPromptHistory(session.promptHistory);
          }
          if (session.lastGeneratedPrompt) {
            renderStrictPrompt(session.lastGeneratedPrompt);
            return;
          }
        }
      }
      if (api?.prompt?.getLast) {
        const last = await api.prompt.getLast();
        if (last?.ok && last?.prompt) {
          if (Array.isArray(last.promptHistory)) {
            refreshPromptHistory(last.promptHistory);
          }
          renderStrictPrompt(last.prompt);
          return;
        }
      }
      if (window._promptLockSession?.lastGeneratedPrompt) {
        renderStrictPrompt(window._promptLockSession.lastGeneratedPrompt);
        return;
      }
    } catch (_) {}

    // No restored prompt found on startup — show empty state
    if (!lastStrictPrompt) {
      updateEmptyState(false);
      refreshPromptHistory([]);
    }
  }, 150);

  // Expose controller
  window._promptTab = {
    renderStrictPrompt,
    generateStrictPrompt,
    toggleEditable,
    toggleDiffView,
    refreshPromptHistory,
    getPromptHistory: () => fullPromptHistory,
    clearPrompt: () => renderStrictPrompt(null),
  };
})();
