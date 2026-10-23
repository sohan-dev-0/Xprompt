/**
 * Xprompt — Snapshot-Based Project Progress Tab Controller (Step 1.2.3 Upgrade)
 *
 * Displays snapshot-grounded project progress:
 *  - Overall completion percentage progress bar (0 - 100%)
 *  - Architectural Module breakdown (Auth, Database, Routes)
 *  - Ready (success), Partial (in-progress), and Missing (warning) file lists
 */

(() => {
  'use strict';

  const api = window.xprompt || window.promptLock || window.api;

  // ── DOM refs ──────────────────────────────────────────────────────────────────
  const progressOverall = document.getElementById('progress-overall');
  const progressModules = document.getElementById('progress-modules');
  const progressMissing = document.getElementById('progress-missing');
  const progressPartial = document.getElementById('progress-partial');
  const progressReady   = document.getElementById('progress-ready');
  const btnRefreshProg  = document.getElementById('btn-refresh-progress');
  const progPctLabel    = document.getElementById('progress-overall-pct');

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function renderList(el, items = [], emptyText = 'None') {
    if (!el) return;
    el.innerHTML = '';
    if (!items || items.length === 0) {
      el.innerHTML = `<li class="prog-empty-item">${emptyText}</li>`;
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'prog-file-item';
      li.textContent = item;
      el.appendChild(li);
    }
  }

  // ── Render Progress Data ──────────────────────────────────────────────────────
  function renderProgress(data) {
    if (!data) return;

    // 1. Overall bar
    const pct = Math.min(100, Math.max(0, data.overall || 0));
    if (progressOverall) {
      progressOverall.style.width = `${pct}%`;
    }
    if (progPctLabel) {
      progPctLabel.textContent = `${pct}%`;
    }

    // 2. Modules breakdown (Dynamic & Project-Aware)
    if (progressModules && data.modules) {
      progressModules.innerHTML = '';
      const renderedKeys = new Set();

      for (const [key, mod] of Object.entries(data.modules)) {
        if (!mod || typeof mod !== 'object') continue;
        const canonKey = mod.key || key;
        if (renderedKeys.has(canonKey)) continue; // Avoid duplicate alias cards
        renderedKeys.add(canonKey);

        const item = document.createElement('div');
        item.className = 'prog-mod-card';

        const icon = mod.icon || '📁';
        const name = mod.name || (key.charAt(0).toUpperCase() + key.slice(1));
        const modPct = Math.min(100, Math.max(0, mod.progress || 0));
        const filesReady = mod.filesReady || 0;
        const filesTotal = mod.filesTotal || (mod.files ? mod.files.length : 0);

        let barColor = 'var(--indigo-400)';
        if (modPct === 100) {
          barColor = '#10b981';
        } else if (modPct === 0) {
          barColor = 'rgba(148, 163, 184, 0.3)';
        } else if (modPct < 50) {
          barColor = '#f59e0b';
        }

        item.innerHTML = `
          <div class="pmc-top">
            <span class="pmc-name"><span class="pmc-icon">${icon}</span> ${escapeHtml(name)}</span>
            <span class="pmc-pct">${modPct}% (${filesReady}/${filesTotal} files)</span>
          </div>
          <div class="pmc-bar-bg">
            <div class="pmc-bar-fill" style="width: ${modPct}%; background: ${barColor};"></div>
          </div>
        `;
        progressModules.appendChild(item);
      }
    }

    // 3. File lists
    renderList(progressMissing, data.missing, 'No missing blueprint files');
    renderList(progressPartial, data.partial, 'No partially implemented files');
    renderList(progressReady,   data.ready,   'No ready source files detected');
  }

  // ── Fetch / Refresh ───────────────────────────────────────────────────────────
  async function loadProgress() {
    try {
      if (api?.progress?.get) {
        const res = await api.progress.get();
        if (res?.ok && res.progress) {
          renderProgress(res.progress);
        }
      }
    } catch (_) {}
  }

  if (btnRefreshProg) {
    btnRefreshProg.addEventListener('click', async () => {
      btnRefreshProg.disabled = true;
      try {
        if (api?.progress?.update) {
          const res = await api.progress.update();
          if (res?.ok && res.progress) {
            renderProgress(res.progress);
          }
        }
      } catch (_) {}
      setTimeout(() => { if (btnRefreshProg) btnRefreshProg.disabled = false; }, 600);
    });
  }

  // Task 23: Force Re-scan button (AST re-scan + progress recalc)
  const btnForceRescan = document.getElementById('btn-force-rescan');
  if (btnForceRescan) {
    btnForceRescan.addEventListener('click', async () => {
      btnForceRescan.disabled = true;
      btnForceRescan.textContent = '... Scanning';
      try {
        const session = window._promptLockSession || {};
        const rootPath = session.currentDir || session.rootPath;
        if (rootPath && api?.astScan) {
          await api.astScan(rootPath);
        }
        if (api?.progress?.update) {
          const res = await api.progress.update();
          if (res?.ok && res.progress) renderProgress(res.progress);
        }
      } catch (_) {}
      setTimeout(() => {
        if (btnForceRescan) {
          btnForceRescan.disabled = false;
          btnForceRescan.textContent = '\u27F3 Re-scan';
        }
      }, 800);
    });
  }

  // Listen to progress updates emitted by chat or AST
  document.addEventListener('progress:updated', e => {
    if (e.detail) renderProgress(e.detail);
  });

  if (api?.progress?.onUpdate) {
    api.progress.onUpdate(prog => {
      renderProgress(prog);
    });
  }

  // ── Step 3 AI DOM refs ───────────────────────────────────────────────────────
  const aiArchPattern    = document.getElementById('ai-arch-pattern');
  const aiDomain         = document.getElementById('ai-domain');
  const aiTechStack      = document.getElementById('ai-tech-stack');
  const aiDomainEntities = document.getElementById('ai-domain-entities');
  const aiAnalyzedTime   = document.getElementById('ai-analyzed-time');
  const aiPoweredBadge   = document.getElementById('ai-powered-badge');
  const btnAnalyzeAi     = document.getElementById('btn-analyze-ai');

  // ── Render AI Insights ────────────────────────────────────────────────────────
  function renderAIInsights(memory) {
    if (!memory) return;

    if (aiArchPattern) {
      aiArchPattern.textContent = memory.architecturePattern || 'Standard Modular';
    }
    if (aiDomain) {
      aiDomain.textContent = memory.domain || 'Software Project';
    }
    if (aiAnalyzedTime && memory.analyzedAt) {
      const timeStr = new Date(memory.analyzedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      aiAnalyzedTime.textContent = `Analyzed ${timeStr}`;
    }
    if (aiPoweredBadge) {
      const provider = (memory.provider || 'AI').toUpperCase();
      aiPoweredBadge.textContent = `✨ Powered by ${provider}`;
    }

    // Tech Stack Chips
    if (aiTechStack) {
      aiTechStack.innerHTML = '';
      const stack = Array.isArray(memory.techStack) && memory.techStack.length > 0
        ? memory.techStack
        : ['JavaScript', 'Node.js'];
      for (const item of stack) {
        const span = document.createElement('span');
        span.className = 'pai-tag';
        span.textContent = item;
        aiTechStack.appendChild(span);
      }
    }

    // Domain Entities Chips
    if (aiDomainEntities) {
      aiDomainEntities.innerHTML = '';
      const entities = Array.isArray(memory.domainEntities) && memory.domainEntities.length > 0
        ? memory.domainEntities
        : (memory.entryPoints || ['Workspace Core']);
      for (const ent of entities) {
        const span = document.createElement('span');
        span.className = 'pai-tag';
        span.textContent = ent;
        aiDomainEntities.appendChild(span);
      }
    }
  }

  // ── Run AI Understanding ──────────────────────────────────────────────────────
  async function runAIUnderstanding() {
    if (btnAnalyzeAi) {
      btnAnalyzeAi.disabled = true;
      btnAnalyzeAi.textContent = 'Analyzing…';
    }
    try {
      if (api?.ai?.understandProject) {
        const res = await api.ai.understandProject();
        if (res && res.ok && res.memory) {
          renderAIInsights(res.memory);
        }
      }
    } catch (err) {
      console.warn('[ProgressTab] AI understand error:', err.message);
    } finally {
      if (btnAnalyzeAi) {
        btnAnalyzeAi.disabled = false;
        btnAnalyzeAi.textContent = '⚡ Deep AI Analysis';
      }
    }
  }

  if (btnAnalyzeAi) {
    btnAnalyzeAi.addEventListener('click', runAIUnderstanding);
  }

  // Listen for AST updates to auto-refresh progress
  if (api?.onAstUpdate) {
    api.onAstUpdate(() => {
      loadProgress();
    });
  }

  // Initial load
  loadProgress();
  setTimeout(runAIUnderstanding, 800);

  window._progressTabInit = true;
})();

