(() => {
/* ═══════════════════════════════════════════════════════════════
   Xprompt — Unified AI Guardrail Co-Pilot Logic v2.0
   Unified Chat & Ready-Made Guardrail Prompt Generator
════════════════════════════════════════════════════════════════ */
const api = window.xprompt || window.promptLock || window.api;

// ── State ─────────────────────────────────────────────────────
let isExpanded = false;
let dragDistance = 0;
let dragging = false, dragX = 0, dragY = 0;

const state = {
  currentDir:   null,
  activeTab:    'prompt',
  selectedAgent:'cursor',
  activeRules:  ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval'],
  messages:     [],
  astSnapshot:  null,
  roadmapGoal:  '',
  roadmapMilestones: [],
  activeMilestoneId: null,
  currentIntent: '',
  currentPlan: null,
  permissionStatus: null,
  lastVerificationReport: null,
  aiProvider: 'openrouter',
  lastGeneratedPrompt: null,
};

window._xpromptSession = window._promptLockSession = state;

/** Cleanup fn returned by api.onAstUpdate — removes the IPC listener */
let astCleanup = null;

// ── Agent Metadata ───────────────────────────────────────────
const AGENTS = {
  cursor: {
    name: 'Cursor AI (Composer / Agent)',
    tag: '🎯 CURSOR COMPOSER PROMPT',
    short: '🎯 Cursor AI',
    desc: 'Optimized for Cursor Composer multi-file diffing & .cursorrules',
    template: formatCursorPrompt
  },
  claude: {
    name: 'Claude 3.5 Sonnet (Anthropic)',
    tag: '⚡ CLAUDE SONNET 3.5 XML PROMPT',
    short: '⚡ Claude 3.5',
    desc: 'Formatted with Claude XML tag guardrails & strict reasoning',
    template: formatClaudePrompt
  },
  chatgpt: {
    name: 'ChatGPT-4o (Canvas / OpenAI)',
    tag: '🧠 CHATGPT-4O CANVAS DIRECTIVE',
    short: '🧠 ChatGPT-4o',
    desc: 'Tailored for OpenAI Canvas workspace & artifact generation',
    template: formatChatGptPrompt
  },
  copilot: {
    name: 'GitHub Copilot (Workspace)',
    tag: '🚀 GITHUB COPILOT WORKSPACE',
    short: '🚀 GitHub Copilot',
    desc: 'Formatted for Copilot Workspace planning & TDD guidelines',
    template: formatCopilotPrompt
  },
  windsurf: {
    name: 'Windsurf (Cascade)',
    tag: '🔮 WINDSURF CASCADE PROMPT',
    short: '🔮 Windsurf',
    desc: 'Structured with Cascade checkpoint verification steps',
    template: formatWindsurfPrompt
  },
  antigravity: {
    name: 'Anti-Gravity AI',
    tag: '🛡️ ANTIGRAVITY AGENTIC DIRECTIVE',
    short: '🛡️ Anti-Gravity AI',
    desc: 'Formatted for DeepMind Advanced Agentic AI pair programming',
    template: formatAntiGravityPrompt
  },
  v0: {
    name: 'v0.dev (Frontend UI)',
    tag: '⚡ V0.DEV REACT COMPONENT PROMPT',
    short: '⚡ v0.dev',
    desc: 'Tailored for Next.js App Router, Tailwind, and React 19',
    template: formatV0Prompt
  },
  deepseek: {
    name: 'DeepSeek Coder',
    tag: '🧪 DEEPSEEK CODER DIRECTIVE',
    short: '🧪 DeepSeek',
    desc: 'Optimized for DeepSeek code reasoning & unit test generation',
    template: formatDeepSeekPrompt
  }
};

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const floatIcon           = $('floatIcon');
const panel               = $('panel');
const wsBadge             = $('workspaceBadge');
const wsName              = $('wsName');
const dirPath             = $('dirPath');
const btnPickDir          = $('btnPickDir');
const btnPickDir2         = $('btnPickDir2');
const targetAgentSelect   = $('targetAgentSelect');
const pillGrid            = $('pillGrid');
const ruleStripCount      = $('ruleStripCount');
const copilotFeed         = $('copilotFeed');
const copilotThinking     = $('copilotThinking');
const copilotThinkingLabel= $('copilotThinkingLabel');
const chatInput           = $('chatInput');
const btnSendChat         = $('btnSendChat');
const btnSendChatText     = $('btnSendChatText');
const dockAgentBadge      = $('dockAgentBadge');
const statusMsg           = $('statusMsg');
const ruleCount           = $('ruleCount');
const toast               = $('toast');
const ftNoProject         = $('ftNoProject');
const ftTreeWrap          = $('ftTreeWrap');
const treeList            = $('treeList');
const dhBars              = $('dhBars');

// ══════════════════════════════════════════════════════════════
//  EXPAND / COLLAPSE & DRAGGING
// ══════════════════════════════════════════════════════════════
function expand() {
  if (isExpanded) return;
  isExpanded = true;
  console.log('[PromptLock UI] Expanding to full dashboard...');
  api.expand();
  panel.classList.remove('hidden','anim-out');
  panel.classList.add('anim-in');
  floatIcon.classList.add('hidden');
  if (chatInput) setTimeout(() => chatInput.focus(), 250);
}

function collapse() {
  if (!isExpanded) return;
  console.log('[PromptLock UI] Collapsing to floating icon...');
  panel.classList.remove('anim-in');
  panel.classList.add('anim-out');
  setTimeout(() => {
    panel.classList.add('hidden');
    panel.classList.remove('anim-out');
    floatIcon.classList.remove('hidden');
    isExpanded = false;
    api.collapse();
  }, 180);
}

let isDragging = false;
let dragMoved = false;
let startX = 0, startY = 0;
let totalDelta = 0;

if (floatIcon) {
  const floatWidgetImg = floatIcon.querySelector('.float-widget-icon');
  if (floatWidgetImg && !floatWidgetImg.getAttribute('src')) {
    floatWidgetImg.src = 'assets/icon.png';
  }

  floatIcon.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragMoved = false;
    totalDelta = 0;
    startX = e.screenX;
    startY = e.screenY;
  });

  floatIcon.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[PromptLock UI] Icon click detected, dragMoved =', dragMoved, 'totalDelta =', totalDelta);
    if (!dragMoved) {
      expand();
    }
  });
}

const panelHeader = $('panelHeader');
if (panelHeader) {
  panelHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('.wc') || e.target.closest('.ws-badge')) return;
    isDragging = true;
    dragMoved = false;
    totalDelta = 0;
    startX = e.screenX;
    startY = e.screenY;
  });
}

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.screenX - startX;
  const dy = e.screenY - startY;
  const step = Math.abs(dx) + Math.abs(dy);
  totalDelta += step;
  startX = e.screenX;
  startY = e.screenY;

  // Only move the window if the user clearly dragged more than 8 pixels
  if (totalDelta > 8) {
    dragMoved = true;
    api.move(dx, dy);
  }
});

document.addEventListener('mouseup', () => {
  isDragging = false;
});

const btnMin = $('btnMin');
if (btnMin) btnMin.addEventListener('click', collapse);

const btnClose = $('btnClose');
if (btnClose) {
  btnClose.addEventListener('click', () => {
    try {
      if (window._chatTab && typeof window._chatTab.flushChatSession === 'function') {
        window._chatTab.flushChatSession();
      }
      persistSession(true);
    } catch (_) {}
    if (isExpanded) {
      collapse();
      setTimeout(() => api.close(), 220);
    } else {
      api.close();
    }
  });
}

api.onToggle(() => { if (isExpanded) collapse(); else expand(); });

// ══════════════════════════════════════════════════════════════
//  ACTIVE RULES ARRAY HELPER
// ══════════════════════════════════════════════════════════════
function getActiveRulesArray(target) {
  const val = target !== undefined ? target : (typeof state !== 'undefined' ? state?.activeRules : []);
  if (Array.isArray(val)) return val;
  if (val instanceof Set) return Array.from(val);
  if (val && typeof val === 'object') return Object.keys(val);
  return [];
}

// ══════════════════════════════════════════════════════════════
//  SESSION PERSISTENCE HELPER
// ══════════════════════════════════════════════════════════════
function persistSession() {
  const forceSync = arguments[0] === true;
  if (!api) return;
  const currentChat = (window._promptLockSession?.chatHistory && window._promptLockSession.chatHistory.length > 0)
    ? window._promptLockSession.chatHistory
    : (window._chatTab?.getMessages?.() || state.messages || []);
  const payload = {
    lastActiveProjectPath: state.currentDir,
    selectedTargetAI: state.selectedAgent,
    activeRules: getActiveRulesArray(state.activeRules),
    activeTab: state.activeTab,
    chatHistory: currentChat,
    roadmapGoal: state.roadmapGoal,
    roadmapMilestones: state.roadmapMilestones,
    activeMilestoneId: state.activeMilestoneId,
    currentIntent: window._promptLockSession?.currentIntent || state.currentIntent || '',
    currentPlan: window._promptLockSession?.currentPlan || null,
    permissionStatus: window._promptLockSession?.permissionStatus || null,
    lastVerificationReport: window._promptLockSession?.lastVerificationReport || null,
    aiProvider: state.aiProvider || 'openrouter',
    lastGeneratedPrompt: state.lastGeneratedPrompt || window._promptLockSession?.lastGeneratedPrompt || null,
  };

  if (forceSync && (api.sessionSaveSync || api.session?.saveSync)) {
    try {
      if (api.sessionSaveSync) {
        api.sessionSaveSync(payload);
      } else {
        api.session.saveSync(payload);
      }
      return;
    } catch (e) {
      console.warn('[PromptLock Store] Sync save error:', e);
    }
  }

  if (api.sessionSave) {
    api.sessionSave(payload).catch(err => console.warn('[PromptLock Store] Save error:', err));
  } else if (api.session?.save) {
    api.session.save(payload).catch(err => console.warn('[PromptLock Store] Save error:', err));
  }
}

// ══════════════════════════════════════════════════════════════
//  4-TAB NAVIGATION (Scanner, Chat, Prompt, Verify)
// ══════════════════════════════════════════════════════════════
function switchTab(id) {
  let targetTabId = id;
  // Gracefully fallback to 'chat' or 'scanner' if switching to roadmap or progress
  if (targetTabId === 'roadmap' || targetTabId === 'progress') {
    targetTabId = 'chat';
  }
  state.activeTab = targetTabId;

  document.querySelectorAll('.tab').forEach(t => {
    const tid = t.dataset.tab;
    const isMatch = (tid === targetTabId) ||
      (targetTabId === 'prompt' && tid === 'copilot') || (targetTabId === 'copilot' && tid === 'prompt') ||
      (targetTabId === 'scanner' && tid === 'filetree') || (targetTabId === 'filetree' && tid === 'scanner');
    t.classList.toggle('active', isMatch);
  });

  document.querySelectorAll('.tab-content').forEach(tc => {
    const contentId = `tab${targetTabId.charAt(0).toUpperCase()}${targetTabId.slice(1)}`;
    const isMatch = (tc.id === contentId) ||
      (targetTabId === 'workflow' && (tc.id === 'tab-workflow' || tc.id === 'tabWorkflow')) ||
      ((targetTabId === 'prompt' || targetTabId === 'copilot') && (tc.id === 'tabPrompt' || tc.id === 'tabCopilot')) ||
      ((targetTabId === 'scanner' || targetTabId === 'filetree') && (tc.id === 'tabScanner' || tc.id === 'tabFiletree'));
    tc.classList.toggle('active', isMatch);
    tc.classList.toggle('hidden', !isMatch);
  });

  if (targetTabId === 'prompt' || targetTabId === 'copilot') {
    const promptToRender = state.lastGeneratedPrompt || window._promptLockSession?.lastGeneratedPrompt;
    const textArea = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    if (promptToRender && textArea && (!textArea.value || textArea.value !== promptToRender)) {
      document.dispatchEvent(new CustomEvent('prompt:restored', { detail: promptToRender }));
    }
  }

  if (targetTabId === 'chat') {
    if (window._chatTab && typeof window._chatTab.forceScrollToBottom === 'function') {
      window._chatTab.forceScrollToBottom();
    } else if (window._chatTab && typeof window._chatTab.scrollToBottom === 'function') {
      window._chatTab.scrollToBottom();
    }
  }

  persistSession();
}
window.switchTab = switchTab;

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.tab);
  });
});

// ══════════════════════════════════════════════════════════════
//  AGENT SELECTOR
// ══════════════════════════════════════════════════════════════
if (targetAgentSelect) {
  targetAgentSelect.addEventListener('change', () => {
    state.selectedAgent = targetAgentSelect.value;
    const agentInfo = AGENTS[state.selectedAgent] || AGENTS.cursor;
    if (dockAgentBadge) dockAgentBadge.textContent = agentInfo.short;
    showToast(`✓ Target AI set to: ${agentInfo.name}`);
    setStatus(`Target AI: ${agentInfo.name}`, 'working');
    setTimeout(() => setStatus('Ready — ⌘⇧G to toggle',''), 2500);
    persistSession();
  });
}

// ══════════════════════════════════════════════════════════════
//  SECURITY RULE PILLS
// ══════════════════════════════════════════════════════════════
if (pillGrid) {
  pillGrid.addEventListener('click', e => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    const rule = pill.dataset.rule;
    let rules = getActiveRulesArray(state.activeRules);
    if (rules.includes(rule)) {
      rules = rules.filter(r => r !== rule);
      pill.classList.remove('active');
    } else {
      rules.push(rule);
      pill.classList.add('active');
    }
    state.activeRules = rules;
    updateRuleCount();
    showToast(`Security rules: ${rules.length} active`);
    persistSession();
  });
}

function updateRuleCount() {
  const rules = getActiveRulesArray(state.activeRules);
  const n = rules.length;
  if (ruleStripCount) ruleStripCount.textContent = `${n} Active`;
  if (ruleCount) ruleCount.textContent = `${n} rule${n!==1?'s':''} active`;
}

// Rule name lookup for display
const RULE_DISPLAY_NAMES = {
  'zero-secrets': 'Zero Secrets',
  'zod-validation': 'Zod Validation',
  'sql-guard': 'SQL Guard',
  'no-eval': 'No eval()',
  'rate-limiting': 'Rate Limiting',
  'rate-limit': 'Rate Limiting',
  'xss-guard': 'XSS Guard',
  'no-innerhtml': 'No innerHTML',
  'owasp-headers': 'OWASP Headers',
  'error-masking': 'Error Masking',
  'jwt-rotation': 'JWT Rotation',
  'bcrypt-hash': 'Password Hash',
  'webhook-signature': 'Webhook Sig',
  'idempotency': 'Idempotency',
};

/**
 * Synchronize the Enforced Security Rules pill grid with the contextually selected rules.
 * @param {string[]} ruleIds - Array of canonical or alias rule IDs
 */
function syncSecurityRulePills(ruleIds) {
  if (!ruleIds) return;
  const grid = document.getElementById('pillGrid') || pillGrid;
  if (!grid) return;

  const rawArray = getActiveRulesArray(ruleIds);
  const normalizedList = rawArray.map(r => String(r).toLowerCase());

  // Map aliases
  if (normalizedList.includes('rate-limiting') && !normalizedList.includes('rate-limit')) normalizedList.push('rate-limit');
  if (normalizedList.includes('rate-limit') && !normalizedList.includes('rate-limiting')) normalizedList.push('rate-limiting');
  if (normalizedList.includes('input-sanitization') && !normalizedList.includes('zod-validation')) normalizedList.push('zod-validation');
  if (normalizedList.includes('sql-injection') && !normalizedList.includes('sql-guard')) normalizedList.push('sql-guard');

  state.activeRules = rawArray;

  // 1. Update existing static pills
  const existingPills = grid.querySelectorAll('.pill:not(.dynamic-pill)');
  const handledRules = [];

  existingPills.forEach(pill => {
    const rId = (pill.dataset.rule || '').toLowerCase();
    handledRules.push(rId);
    if (rId === 'rate-limit') handledRules.push('rate-limiting');
    if (rId === 'zod-validation') handledRules.push('input-sanitization');

    const isActive = normalizedList.includes(rId);
    pill.classList.toggle('active', isActive);
  });

  // 2. Remove previously added dynamic pills
  grid.querySelectorAll('.pill.dynamic-pill').forEach(el => el.remove());

  // 3. Add dynamic pills for any selected rules not present in the static grid
  rawArray.forEach(id => {
    const canonical = String(id).toLowerCase();
    if (!handledRules.includes(canonical) && canonical !== 'rate-limit') {
      const btn = document.createElement('button');
      btn.className = 'pill active dynamic-pill';
      btn.dataset.rule = canonical;
      const dot = document.createElement('span');
      dot.className = 'pill-dot';
      btn.appendChild(dot);
      const label = RULE_DISPLAY_NAMES[canonical] || id;
      btn.appendChild(document.createTextNode(label));
      grid.appendChild(btn);
    }
  });

  // 4. Update count badges
  const activeCount = rawArray.length;
  const stripEl = typeof ruleStripCount !== 'undefined' ? ruleStripCount : document.getElementById('ruleStripCount');
  const countEl = typeof ruleCount !== 'undefined' ? ruleCount : document.getElementById('ruleCount');
  if (stripEl) stripEl.textContent = `${activeCount} Active`;
  if (countEl) countEl.textContent = `${activeCount} rule${activeCount !== 1 ? 's' : ''} active`;

  if (window._promptLockSession) {
    window._promptLockSession.activeRules = Array.from(rawArray);
  }
}
window.syncSecurityRulePills = syncSecurityRulePills;

// ══════════════════════════════════════════════════════════════
//  DIRECTORY PICKER — triggers real AST scan
// ══════════════════════════════════════════════════════════════
async function pickDirectory() {
  setStatus('Opening folder picker…','working');
  const folderPath = await api.openFolder();
  if (!folderPath) { setStatus('No directory selected.',''); return; }
  await switchProject({ rootPath: folderPath });
}

if (btnPickDir) btnPickDir.addEventListener('click', () => pickDirectory());
if (btnPickDir2) btnPickDir2.addEventListener('click', () => pickDirectory());



async function setDirectory(folderPath, silent = false, skipPersist = false) {
  if (folderPath && typeof folderPath === 'string') {
    const parts = folderPath.replace(/[\/\\]+$/, '').split(/[\/\\]/);
    if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
      folderPath = parts.slice(0, -1).join('/') || '/';
    }
  }
  state.currentDir = folderPath;
  const name = folderPath.split('/').pop() || folderPath.split('\\').pop() || folderPath;

  dirPath.textContent = name;
  dirPath.className   = 'dir-text-mini active';
  dirPath.title       = folderPath;
  wsName.textContent  = name;
  wsBadge.classList.remove('hidden');

  if (!skipPersist) {
    persistSession();
  }

  // ── Show scanning state on File Tree tab ──────────────────
  ftNoProject.classList.add('hidden');
  ftTreeWrap.classList.remove('hidden');
  renderScanningState(name);
  setStatus(`Scanning ${name}…`, 'working');

  // ── Subscribe to live updates BEFORE we trigger the scan ──
  if (astCleanup) { astCleanup(); astCleanup = null; }
  astCleanup = api.onAstUpdate(snapshot => {
    state.astSnapshot = snapshot;
    renderSnapshot(snapshot);
    updateCopilotContext(snapshot);
    setStatus(`AST live — ${snapshot.stats.totalFiles} files`, 'success');
  });

  // ── Trigger full AST scan in the main process ─────────────
  const result = await api.astScan(folderPath);

  if (!result.ok) {
    setStatus(`Scan error: ${result.error}`, 'error');
    if (!silent) showToast('❌ Scan failed — see console');
    return;
  }

  state.astSnapshot = result.snapshot;
  renderSnapshot(result.snapshot);
  updateCopilotContext(result.snapshot);

  const s = result.snapshot.stats;
  if (!silent) {
    showToast(`✓ Scanned: ${s.totalFiles} files, ${s.functions} functions`);
  }
  setStatus(`Ready — ${s.totalFiles} files, ${s.astFiles} AST, ${s.uniqueDeps} deps`, 'success');
  setTimeout(() => setStatus('Ready — ⌘⇧G to toggle',''), 4000);
}

// ── Show a "scanning…" placeholder while AST runs ─────────────
function renderScanningState(name) {
  dhBars.innerHTML = '<div style="color:var(--slate-500);font-size:11px;padding:8px 0;">Scanning project…</div>';
  treeList.innerHTML = `
    <div class="tree-item dir">
      <span class="tree-indent" style="width:0"></span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3a1 1 0 011-1h3l1.5 1.5H10a1 1 0 011 1v5a1 1 0 01-1 1H2a1 1 0 01-1-1V3z" stroke="#818cf8" stroke-width="1.1"/></svg>
      <span>${escapeHtml(name)}/</span>
    </div>
    <div class="tree-scanning-msg">⚡ Parsing AST…</div>
  `;
}

// ── Render a full ProjectSnapshot into the File Tree tab ─────────
function renderSnapshot(snapshot) {
  if (!snapshot) return;
  ftNoProject.classList.add('hidden');
  ftTreeWrap.classList.remove('hidden');

  // ── Dep health bars ─────────────────────────────────────────
  dhBars.innerHTML = snapshot.depHealth.map(d => `
    <div class="dh-row">
      <span class="dh-name" title="${escapeHtml(d.label)}">${escapeHtml(d.name)}</span>
      <div class="dh-bar-bg">
        <div class="dh-bar-fill ${d.cls}" style="width:0%" data-w="${Math.min(100,d.pct)}%"></div>
      </div>
      <span class="dh-pct dh-label-tip" title="${escapeHtml(d.label)}">${escapeHtml(d.label)}</span>
    </div>`).join('');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    dhBars.querySelectorAll('.dh-bar-fill').forEach(b => { b.style.width = b.dataset.w; });
  }));

  // ── Stats banner ─────────────────────────────────────────────
  const s = snapshot.stats;
  const statsHtml = `
    <div class="ft-stats-row">
      <span class="ft-stat"><span class="ft-stat-val">${s.totalFiles}</span> Files</span>
      <span class="ft-stat"><span class="ft-stat-val ast">${s.astFiles}</span> AST-Parsed</span>
      <span class="ft-stat"><span class="ft-stat-val fn">${s.functions}</span> Functions</span>
      <span class="ft-stat"><span class="ft-stat-val dep">${s.uniqueDeps}</span> Dependencies</span>
    </div>
  `;

  // ── File tree items ──────────────────────────────────────────
  // Group: dirs first, then files, sorted by path
  const root = snapshot.rootPath.split('/').pop() || snapshot.rootPath.split('\\').pop() || 'project';
  const files = snapshot.files || [];

  // Build dir structure from paths
  const dirsSeen = new Set();
  const rows = [];

  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/');
    // Track directory entries we haven't shown yet
    for (let i = 0; i < parts.length - 1; i++) {
      const dirKey = parts.slice(0, i + 1).join('/');
      if (!dirsSeen.has(dirKey)) {
        dirsSeen.add(dirKey);
        rows.push({ type: 'dir', depth: i, name: parts[i], key: dirKey });
      }
    }
    const ext = file.path.split('.').pop().toLowerCase();
    rows.push({
      type: 'file', depth: parts.length - 1,
      name: parts[parts.length - 1],
      ext,
      isAST: file.isAST,
      fns: file.fns || [],
      exports: file.exports || [],
    });
  }

  const EXT_COLOR = {
    ts:'#818cf8', tsx:'#818cf8', js:'#fbbf24', jsx:'#fbbf24',
    json:'#34d399', md:'#94a3b8', env:'#fb7185',
    css:'#38bdf8', html:'#f97316', mjs:'#fbbf24',
  };

  const treeHtml = [
    // Root node
    `<div class="tree-item dir" style="">
      <span class="tree-indent" style="width:0"></span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3a1 1 0 011-1h3l1.5 1.5H10a1 1 0 011 1v5a1 1 0 01-1 1H2a1 1 0 01-1-1V3z" stroke="#818cf8" stroke-width="1.1"/></svg>
      <span>${escapeHtml(root)}/</span>
    </div>`,
    ...rows.map(row => {
      const indent = (row.depth + 1) * 12;
      if (row.type === 'dir') {
        return `<div class="tree-item dir">
          <span class="tree-indent" style="width:${indent}px"></span>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M1 3a1 1 0 011-1h3l1.5 1.5H10a1 1 0 011 1v5a1 1 0 01-1 1H2a1 1 0 01-1-1V3z" stroke="#818cf8" stroke-width="1.1"/></svg>
          <span>${escapeHtml(row.name)}/</span>
        </div>`;
      }
      const color = EXT_COLOR[row.ext] || '#64748b';
      const fnsHtml = row.fns.length
        ? `<span class="tree-fn-badge" title="${escapeHtml(row.fns.join(', '))}">${row.fns.length} fn${row.fns.length>1?'s':''}</span>`
        : '';
      return `<div class="tree-item ${row.isAST ? 'ast-parsed' : ''}">
        <span class="tree-indent" style="width:${indent}px"></span>
        <svg width="11" height="11" viewBox="0 0 11 13" fill="none">
          <rect x=".5" y=".5" width="7" height="11" rx="1" stroke="${color}" stroke-width="1"/>
          <path d="M5.5.5v3h3" stroke="${color}" stroke-width="1"/>
        </svg>
        <span class="tree-filename">${escapeHtml(row.name)}</span>
        ${fnsHtml}
      </div>`;
    })
  ].join('');

  treeList.innerHTML = statsHtml + treeHtml;
}

// ── Update Co-Pilot context badge with real AST data ─────────────
function updateCopilotContext(snapshot) {
  // Update the dock context badge
  const dockCtx = $('dockContextBadge');
  if (dockCtx && snapshot) {
    const s = snapshot.stats;
    const name = snapshot.rootPath.split('/').pop() || 'project';
    dockCtx.textContent = `${name} • ${s.totalFiles} files • ${s.functions} fns`;
  }
}

// ══════════════════════════════════════════════════════════════
//  PROMPT TEMPLATE FORMATTERS (Tailored per Target AI)
// ══════════════════════════════════════════════════════════════
function getActiveRuleDescriptions(rules) {
  const map = {
    'zero-secrets': '• ZERO SECRETS: Never output or commit API keys, tokens, credentials, or secrets.',
    'zod-validation': '• ZOD VALIDATION: All input payloads must be strictly validated with Zod schemas.',
    'sql-guard': '• SQL GUARD: Use parameterized queries/prepared statements exclusively. No raw concatenation.',
    'no-eval': '• NO EVAL: Prohibit eval(), dynamic Function(), or unsafe script injection.',
    'rate-limit': '• RATE LIMITING: Add rate limiting protection on all exposed API routes.',
    'xss-guard': '• XSS GUARD: Sanitize all user-controlled text before rendering or storing.'
  };
  const list = getActiveRulesArray(rules);
  return list.map(r => map[r]).filter(Boolean);
}

function formatAstContextSnippet(snapshot) {
  if (!snapshot || !snapshot.files || !snapshot.files.length) return '';
  const astFiles = snapshot.files.filter(f => f.isAST && f.fns && f.fns.length > 0).slice(0, 6);
  if (!astFiles.length) return '';

  const lines = ['[WORKSPACE AST & EXPORT CONTRACTS]'];
  for (const f of astFiles) {
    const fnList = f.fns.slice(0, 3).join(', ');
    lines.push(`• ${f.path}: [${fnList}${f.fns.length > 3 ? '…' : ''}]`);
  }
  return '\n' + lines.join('\n') + '\n';
}

// ══════════════════════════════════════════════════════════════
//  ROADMAP & GOAL TRACKER ENGINE (Step 2.6)
// ══════════════════════════════════════════════════════════════
const ROADMAP_PRESETS = {
  game: {
    goal: 'Interactive Frontend Game & UI Engine',
    milestones: [
      {
        id: 'm_game_1',
        title: 'Phase 1: Basic UI Layout & Grid',
        desc: 'Build modular responsive HTML/CSS board layout and canvas/DOM grid',
        tokens: ['ui', 'layout', 'grid', 'board', 'cell', 'html', 'css', 'render'],
        manualDone: false,
      },
      {
        id: 'm_game_2',
        title: 'Phase 2: Game Logic & Click Handling',
        desc: 'Interactive move selection, player turn switching, and click event listeners',
        tokens: ['click', 'move', 'turn', 'player', 'play', 'event', 'handler', 'logic'],
        manualDone: false,
      },
      {
        id: 'm_game_3',
        title: 'Phase 3: State Management & Win Detection',
        desc: 'Game state tracking, win/draw condition evaluation, and score state',
        tokens: ['state', 'store', 'win', 'winner', 'check', 'detect', 'status', 'score'],
        manualDone: false,
      },
      {
        id: 'm_game_4',
        title: 'Phase 4: Audio Effects & Styling Polish',
        desc: 'Synthesize audio cues, animations, and restart/reset flow',
        tokens: ['audio', 'sound', 'sfx', 'animation', 'style', 'reset', 'restart'],
        manualDone: false,
      },
    ]
  },
  frontend: {
    goal: 'Interactive Client-Side Web Application',
    milestones: [
      {
        id: 'm_fe_1',
        title: 'UI Components & Layout Structure',
        desc: 'Build modular responsive HTML/CSS UI components and layout templates',
        tokens: ['ui', 'component', 'layout', 'css', 'style', 'html', 'view'],
        manualDone: false,
      },
      {
        id: 'm_fe_2',
        title: 'State Management & DOM Event Binding',
        desc: 'Reactive state tracking, event delegation, and interactive DOM updates',
        tokens: ['state', 'store', 'event', 'render', 'dispatch', 'listener', 'handler'],
        manualDone: false,
      },
      {
        id: 'm_fe_3',
        title: 'Audio Feedback & Sound Controller',
        desc: 'Synthesize audio cues, sound triggers, and Web Audio API effects',
        tokens: ['audio', 'sound', 'webaudio', 'synth', 'frequency', 'gain', 'sfx'],
        manualDone: false,
      },
      {
        id: 'm_fe_4',
        title: 'Accessibility (a11y) & Keyboard Navigation',
        desc: 'ARIA attributes, focus traps, keyboard shortcuts, and screen reader labels',
        tokens: ['a11y', 'aria', 'accessibility', 'keyboard', 'focus', 'contrast', 'shortcut'],
        manualDone: false,
      },
    ]
  },
  auth: {
    goal: 'Production Authentication & RBAC Engine',
    milestones: [
      {
        id: 'm_auth_1',
        title: 'User Registration & Password Hashing',
        desc: 'Secure signup with bcrypt/argon2 hashing and input validation',
        tokens: ['register', 'hash', 'bcrypt', 'signup', 'password'],
        manualDone: false,
      },
      {
        id: 'm_auth_2',
        title: 'JWT Authentication & Refresh Token Rotation',
        desc: 'Issue signed JWTs, access token expiry, and refresh token handling',
        tokens: ['login', 'jwt', 'token', 'sign', 'verify', 'refresh'],
        manualDone: false,
      },
      {
        id: 'm_auth_3',
        title: 'Role-Based Access Control (RBAC) & Route Guard',
        desc: 'Middleware protecting restricted routes based on user role',
        tokens: ['authorize', 'role', 'guard', 'requireauth', 'permission'],
        manualDone: false,
      },
      {
        id: 'm_auth_4',
        title: 'Password Reset & Secure Email Verification',
        desc: 'Time-limited token generation and email dispatch for account recovery',
        tokens: ['resetpassword', 'sendemail', 'verifyemail', 'mailer'],
        manualDone: false,
      },
    ]
  },
  payment: {
    goal: 'Stripe Payment & Subscription Infrastructure',
    milestones: [
      {
        id: 'm_pay_1',
        title: 'Stripe Checkout Session & Customer Creation',
        desc: 'Initialize checkout session and link payment to registered customer',
        tokens: ['createcheckout', 'stripe', 'checkout', 'session', 'customer'],
        manualDone: false,
      },
      {
        id: 'm_pay_2',
        title: 'Stripe Webhook Ingestion & Signature Verification',
        desc: 'Verify constructEvent signatures and handle async events securely',
        tokens: ['webhook', 'constructevent', 'rawbody', 'signature'],
        manualDone: false,
      },
      {
        id: 'm_pay_3',
        title: 'Subscription Lifecycle & Customer Billing Portal',
        desc: 'Manage recurring billing tiers, portal links, and cancellations',
        tokens: ['subscription', 'billingportal', 'cancel', 'tier', 'plan'],
        manualDone: false,
      },
      {
        id: 'm_pay_4',
        title: 'Invoice Generation & Payment Failure Recovery',
        desc: 'Handle payment failures, send dunning emails, and record invoices',
        tokens: ['invoice', 'paymentfailed', 'refund', 'receipt'],
        manualDone: false,
      },
    ]
  },
  crud: {
    goal: 'High-Performance REST/tRPC API Data Layer',
    milestones: [
      {
        id: 'm_crud_1',
        title: 'Database Schema Modeling & Migration Pipeline',
        desc: 'Define relational/document schemas and run migration scripts',
        tokens: ['schema', 'migrate', 'db', 'prisma', 'drizzle', 'entity'],
        manualDone: false,
      },
      {
        id: 'm_crud_2',
        title: 'Data Access Layer (Repository Pattern)',
        desc: 'Clean CRUD methods (create, findById, update, softDelete)',
        tokens: ['create', 'findbyid', 'findall', 'update', 'delete', 'repository'],
        manualDone: false,
      },
      {
        id: 'm_crud_3',
        title: 'API Controllers with Zod Request Validation',
        desc: 'Validated request bodies, pagination, and standardized JSON responses',
        tokens: ['controller', 'router', 'validate', 'pagination', 'handler'],
        manualDone: false,
      },
      {
        id: 'm_crud_4',
        title: 'Automated Unit & Integration Test Suite',
        desc: 'Comprehensive Jest/Vitest assertions with mock database fixtures',
        tokens: ['test', 'describe', 'it', 'expect', 'mock', 'assert'],
        manualDone: false,
      },
    ]
  }
};

function getAstTokensSet(snapshot) {
  const set = new Set();
  if (!snapshot || !Array.isArray(snapshot.files)) return set;
  for (const file of snapshot.files) {
    if (Array.isArray(file.fns)) {
      for (const fn of file.fns) set.add(String(fn).toLowerCase());
    }
    if (Array.isArray(file.exports)) {
      for (const exp of file.exports) set.add(String(exp).toLowerCase());
    }
    const cleanPath = (file.path || '').toLowerCase();
    const parts = cleanPath.split(/[^a-z0-9]+/);
    for (const p of parts) {
      if (p.length >= 3) set.add(p);
    }
  }
  return set;
}

function evaluateMilestoneStatus(milestone, astTokens) {
  if (milestone.manualDone) {
    return {
      status: 'completed',
      percentage: 100,
      matchedTokens: milestone.tokens || [],
      missingTokens: [],
      isManual: true,
    };
  }

  const tokens = milestone.tokens || [];
  if (!tokens.length) {
    return {
      status: 'pending',
      percentage: 0,
      matchedTokens: [],
      missingTokens: [],
      isManual: false,
    };
  }

  const matchedTokens = [];
  const missingTokens = [];

  for (const t of tokens) {
    const lowerT = String(t).toLowerCase();
    let found = false;
    for (const item of astTokens) {
      if (item.includes(lowerT) || lowerT.includes(item)) {
        found = true;
        break;
      }
    }
    if (found) matchedTokens.push(t);
    else missingTokens.push(t);
  }

  const percentage = Math.round((matchedTokens.length / tokens.length) * 100);
  let status = 'pending';
  if (percentage >= 100) {
    status = 'completed';
  } else if (percentage > 0) {
    status = 'in_progress';
  }

  return {
    status,
    percentage,
    matchedTokens,
    missingTokens,
    isManual: false,
  };
}

function calculateOverallRoadmapProgress() {
  const milestones = state.roadmapMilestones || [];
  if (!milestones.length) return 0;
  const astTokens = getAstTokensSet(state.astSnapshot);
  let totalPct = 0;
  for (const m of milestones) {
    const evalRes = evaluateMilestoneStatus(m, astTokens);
    totalPct += evalRes.percentage;
  }
  return Math.round(totalPct / milestones.length);
}

function formatRoadmapContextSnippet() {
  if (!state.roadmapMilestones || !state.roadmapMilestones.length) {
    if (state.roadmapGoal && state.roadmapGoal.trim()) {
      return `\n[MILESTONE & ROADMAP CONSTRAINTS]\n• ACTIVE PROJECT GOAL: ${state.roadmapGoal.trim()}\n`;
    }
    return '';
  }

  const astTokens = getAstTokensSet(state.astSnapshot);
  const overallPct = calculateOverallRoadmapProgress();

  let activeM = state.roadmapMilestones.find(m => m.id === state.activeMilestoneId);
  if (!activeM) {
    activeM = state.roadmapMilestones.find(m => {
      const evalRes = evaluateMilestoneStatus(m, astTokens);
      return evalRes.status !== 'completed';
    }) || state.roadmapMilestones[0];
  }

  const evalRes = activeM ? evaluateMilestoneStatus(activeM, astTokens) : null;
  const statusText = evalRes ? `${evalRes.status.toUpperCase()} (${evalRes.percentage}% AST Grounded)` : 'PENDING';
  const matched = evalRes && evalRes.matchedTokens.length ? `[${evalRes.matchedTokens.join(', ')}]` : '[None yet]';
  const missing = evalRes && evalRes.missingTokens.length ? `[${evalRes.missingTokens.join(', ')}]` : '[All implemented]';

  const lines = [
    '[MILESTONE & ROADMAP CONSTRAINTS]',
    `• ACTIVE PROJECT GOAL: ${state.roadmapGoal || 'Production Application'}`,
    `• ROADMAP COMPLETION: ${overallPct}% overall`,
    `• TARGET MILESTONE: "${activeM ? activeM.title : 'General Feature'}" (Status: ${statusText})`,
  ];
  if (activeM && activeM.desc) {
    lines.push(`• MILESTONE SCOPE: ${activeM.desc}`);
  }
  lines.push(`• DETECTED AST TOKENS: ${matched}`);
  lines.push(`• REQUIRED NEW IMPLEMENTATIONS: ${missing}`);
  lines.push('• DIRECTIVE: All proposed code MUST strictly advance this milestone without regressing existing AST contracts.');

  return '\n' + lines.join('\n') + '\n';
}

function formatCursorPrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `// .cursorrules & Composer Guardrail Directives
// PROJECT: ${proj}
// TARGET: Cursor AI (Composer & Agent)

You are implementing: "${task}" in the "${proj}" repository.
${astBlock}
[SCOPE CONSTRAINTS]
1. Restrict modifications strictly to the files required for this feature.
2. Preserve existing variable naming conventions and public API contracts.
3. Do not modify or delete unrelated functions or config files.

[ACTIVE SECURITY GUARDRAILS]
${ruleLines.join('\n')}

[IMPLEMENTATION REQUIREMENTS]
- Provide clean, surgical diffs that can be directly applied by Cursor Composer.
- Include TypeScript types and automated unit tests for every new handler.
- If any requirement is ambiguous, state your plan and ask before overwriting code.`;
}

function formatClaudePrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `<system>
You are an expert full-stack software engineer writing code for ${proj}.
Task: "${task}"
${astBlock ? `<ast_context>\n${astBlock.trim()}\n</ast_context>` : ''}
</system>

<security_guardrails>
${ruleLines.join('\n')}
</security_guardrails>

<implementation_scope>
- Only modify files directly related to: "${task}"
- Maintain backward compatibility and adhere to established architectural patterns.
- Ensure strict TypeScript typing and error propagation.
</implementation_scope>

<output_format>
1. Concise architecture summary (2 sentences).
2. Complete, non-truncated production code.
3. Unit tests verifying happy path & security boundary conditions.
</output_format>`;
}

function formatChatGptPrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `### OPENAI CANVAS IMPLEMENTATION DIRECTIVE
**Project:** ${proj}  
**Task:** ${task}  
${astBlock ? `\n${astBlock}\n` : ''}
#### Mandatory Security Guardrails:
${ruleLines.join('\n')}

#### Engineering Constraints:
- Implement the requested feature cleanly within a self-contained code artifact.
- Write defensive code with thorough error handling and descriptive error responses.
- Supply accompanying Jest/Vitest unit test cases for all exported functions.
- Avoid introducing any unnecessary third-party dependencies.`;
}

function formatCopilotPrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `// GitHub Copilot Workspace Plan & Guardrails
// Feature: ${task}
// Repository: ${proj}
${astBlock ? `//\n// AST Signature Context:\n// ${astBlock.trim().replace(/\n/g, '\n// ')}\n` : ''}/*
 * ACTIVE GUARDRAILS:
 * ${ruleLines.join('\n * ')}
 *
 * WORKSPACE GUIDELINES:
 * 1. Plan: Outline affected files and architectural dependencies.
 * 2. Implementation: Write clean, type-safe code adhering strictly to the guardrails above.
 * 3. Testing: Provide automated tests with mock handlers.
 */`;
}

function formatWindsurfPrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `[WINDSURF CASCADE DIRECTIVE]
TASK: ${task}
WORKSPACE: ${proj}
${astBlock ? `\n${astBlock}\n` : ''}
SECURITY CHECKS:
${ruleLines.join('\n')}

EXECUTION STEPS:
1. Verify existing codebase AST and imports before introducing new exports.
2. Implement "${task}" cleanly without modifying unrelated files.
3. Verify test coverage and absence of security vulnerabilities.`;
}

function formatAntiGravityPrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `<!-- ANTIGRAVITY AGENTIC SPEC -->
<agent_instructions>
Target Repository: ${proj}
User Goal: ${task}
${astBlock ? `<ast_signatures>\n${astBlock.trim()}\n</ast_signatures>` : ''}

<security_rules>
${ruleLines.join('\n')}
</security_rules>

<rules_of_engagement>
- Maintain documentation integrity and preserve all existing comments.
- Create tests for every new public function or endpoint.
- Ensure zero secrets or unvalidated inputs enter the codebase.
</rules_of_engagement>
</agent_instructions>`;
}

function formatV0Prompt(task, proj, rules, _ast) {
  return `// v0.dev Next.js & React 19 Component Prompt
// Goal: ${task}
Use Next.js 15 App Router, React Server Components where appropriate, and Tailwind CSS.
Ensure all interactive form inputs are validated with Zod.
Design with accessible semantic HTML, responsive modern glassmorphism, and Lucide icons.
Task Description: ${task}`;
}

function formatDeepSeekPrompt(task, proj, rules, ast) {
  const ruleLines = getActiveRuleDescriptions(rules);
  const astBlock = formatAstContextSnippet(ast);
  return `[DEEPSEEK CODER DIRECTIVE]
Task: ${task}
Project: ${proj}
${astBlock ? `\n${astBlock}\n` : ''}
Security & Architecture Constraints:
${ruleLines.join('\n')}

Please think step by step:
1. Analyze the required data flow and boundary conditions.
2. Write production-ready, type-safe code.
3. Add unit tests for edge cases and input validation.`;
}

// ══════════════════════════════════════════════════════════════
//  CHAT & PROMPT FEED ENGINE
// ══════════════════════════════════════════════════════════════
function initFeed() {
  if (!copilotFeed) return;
  const proj = state.currentDir ? (state.currentDir.split('/').pop() || 'Xprompt') : 'your project';
  copilotFeed.innerHTML = `
    <div class="copilot-welcome-card">
      <div class="cwc-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7v1a2 2 0 01-2 2h-1v1a3 3 0 01-3 3H9a3 3 0 01-3-3v-1H5a2 2 0 01-2-2v-1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2z" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="9" cy="12" r="1.5" fill="currentColor"/>
          <circle cx="15" cy="12" r="1.5" fill="currentColor"/>
          <path d="M9 16c1 .8 2 1 3 1s2-.2 3-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="cwc-body">
        <div class="cwc-title">Xprompt AI Guardrail Co-Pilot</div>
        <div>Tell me what feature or code change you want to build in <strong>${escapeHtml(proj)}</strong>. I will automatically enforce your security guardrails and generate a <strong>Ready-Made Prompt Box</strong> formatted for your chosen Target AI!</div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendUserBubble(msg) {
  if (!copilotFeed) return;
  const userMsgEl = document.createElement('div');
  userMsgEl.className = 'chat-msg user';
  userMsgEl.innerHTML = `
    <div class="chat-bubble-user">${escapeHtml(msg.text)}</div>
    <span class="chat-time">${escapeHtml(msg.time || formatTime())}</span>
  `;
  copilotFeed.appendChild(userMsgEl);
  copilotFeed.scrollTop = copilotFeed.scrollHeight;
}

function appendReadyPromptBox(msg) {
  if (!copilotFeed) return;
  const agentKey = msg.agent || state.selectedAgent || 'cursor';
  const agentInfo = AGENTS[agentKey] || AGENTS.cursor;
  const promptBoxEl = document.createElement('div');
  promptBoxEl.className = 'chat-msg assistant';

  const boxId = msg.id || ('rpb_' + Date.now() + Math.random().toString(36).slice(2, 6));
  const readyPrompt = msg.readyPrompt || '';
  const rulesCount = typeof msg.rulesCount === 'number' ? msg.rulesCount : getActiveRulesArray(state.activeRules).length;

  promptBoxEl.innerHTML = `
    <div class="ready-prompt-box">
      <div class="rpb-header">
        <div class="rpb-agent-tag">
          <span class="badge-pill">${escapeHtml(msg.tag || agentInfo.tag)}</span>
          <span class="rpb-rules-tag">✓ ${rulesCount} Guardrails Applied</span>
        </div>
        <button class="btn-copy-prompt" id="${boxId}_btn">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-7A1.5 1.5 0 001 3.5v9A1.5 1.5 0 002.5 14H5" stroke="currentColor" stroke-width="1.4"/>
          </svg>
          <span class="lbl">Copy Prompt</span>
        </button>
      </div>

      <div class="rpb-code-container">
        <pre class="rpb-code"><code>${escapeHtml(readyPrompt)}</code></pre>
      </div>

      <div class="rpb-footer">
        <span>${readyPrompt.length} chars • ~${Math.round(readyPrompt.length / 4)} tokens • Ready to paste</span>
        <div class="rpb-footer-actions">
          <button class="btn-rpb-mini" id="${boxId}_re">🔄 Re-generate</button>
        </div>
      </div>
    </div>
    <span class="chat-time">${escapeHtml(msg.time || formatTime())}</span>
  `;

  copilotFeed.appendChild(promptBoxEl);
  copilotFeed.scrollTop = copilotFeed.scrollHeight;

  // Wire Copy Button
  const copyBtn = $(`${boxId}_btn`);
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      await api.copyToClipboard(readyPrompt);
      copyBtn.classList.add('copied');
      copyBtn.querySelector('.lbl').textContent = '✓ Copied!';
      showToast(`✓ Ready prompt copied for ${agentInfo.short}!`);
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.querySelector('.lbl').textContent = 'Copy Prompt';
      }, 2200);
    });
  }

  // Wire Re-generate
  const reBtn = $(`${boxId}_re`);
  if (reBtn && msg.text) {
    reBtn.addEventListener('click', () => handleGeneratePrompt(msg.text));
  }
}

async function handleGeneratePrompt(promptText) {
  const text = (promptText || (chatInput ? chatInput.value : '')).trim();
  if (!text) {
    const dockBox = $('dockInputBox');
    if (dockBox) shakeElement(dockBox);
    setStatus('Please describe what you want to build first.', 'error');
    setTimeout(() => setStatus('Ready — ⌘⇧G to toggle',''), 2500);
    return;
  }

  if (chatInput) {
    chatInput.value = '';
    chatInput.style.height = '52px';
  }

  // 1. Append user chat bubble
  const userMsgObj = {
    id: 'u_' + Date.now(),
    type: 'user',
    text,
    time: formatTime(),
  };
  state.messages.push(userMsgObj);
  appendUserBubble(userMsgObj);

  // 2. Show thinking indicator
  const agentInfo = AGENTS[state.selectedAgent] || AGENTS.cursor;
  if (copilotThinkingLabel) copilotThinkingLabel.textContent = `Xprompt AI analyzing your request…`;
  if (copilotThinking) copilotThinking.classList.remove('hidden');
  if (btnSendChat) btnSendChat.disabled = true;
  if (btnSendChatText) btnSendChatText.textContent = 'Analyzing…';
  if (copilotFeed) copilotFeed.scrollTop = copilotFeed.scrollHeight;

  // 3. Call backend AI via IPC (chat:send)
  let aiResponse = null;
  try {
    if (api && api.chat && typeof api.chat.send === 'function') {
      const result = await api.chat.send({ message: text });
      if (result && result.ok && result.response) {
        aiResponse = result.response;
      }
    }
  } catch (err) {
    console.warn('[Chat] api.chat.send failed:', err.message);
  }

  if (copilotThinking) copilotThinking.classList.add('hidden');
  if (btnSendChat) btnSendChat.disabled = false;
  if (btnSendChatText) btnSendChatText.textContent = 'Generate Prompt';

  const projName = state.currentDir ? (state.currentDir.split('/').pop() || 'project') : 'project';

  if (aiResponse) {
    // ── AI responded — render the AI message with options/plan ─────────────
    appendAiChatBubble(aiResponse, text);
    persistSession();
    showToast('⚡ Xprompt AI responded!');
  } else {
    // ── AI unavailable — fall back to local guardrail prompt generation ────
    copilotThinkingLabel.textContent = `Formatting guardrail prompt for ${agentInfo.name}…`;
    copilotThinking.classList.remove('hidden');
    await delay(400);
    copilotThinking.classList.add('hidden');

    const readyPrompt = agentInfo.template(text, projName, state.activeRules, state.astSnapshot);
    const assistantMsgObj = {
      id: 'rpb_' + Date.now(),
      type: 'assistant',
      text,
      agent: state.selectedAgent,
      tag: agentInfo.tag,
      rulesCount: getActiveRulesArray(state.activeRules).length,
      readyPrompt,
      time: formatTime(),
    };
    state.messages.push(assistantMsgObj);
    appendReadyPromptBox(assistantMsgObj);
    persistSession();
    showToast(`⚡ Guardrail prompt ready for ${agentInfo.short}!`);
  }
}

/**
 * Render an AI chat bubble with optional options cards and plan panel.
 * Called when chat:send returns a real AI response.
 */
function appendAiChatBubble(aiResponse, originalText) {
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg assistant';

  const isClarification = aiResponse.isClarification;
  const options = aiResponse.options || [];
  const plan = aiResponse.plan || null;
  const planId = plan?.id || ('plan_' + Date.now());

  // ── Option cards HTML ──────────────────────────────────────────────────
  let optionsHtml = '';
  if (options.length > 0) {
    optionsHtml = `
      <div class="ai-options-grid">
        ${options.map(opt => `
          <button class="ai-option-card" data-option-id="${escapeHtml(opt.id)}" data-plan-id="${escapeHtml(planId)}">
            <span class="opt-label">${escapeHtml(opt.id)}</span>
            <span class="opt-title">${escapeHtml(opt.label || opt.title || opt.id)}</span>
            <span class="opt-desc">${escapeHtml((opt.description || opt.desc || '').slice(0, 100))}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  // ── Plan panel HTML ────────────────────────────────────────────────────
  let planHtml = '';
  if (plan && !isClarification) {
    const files2Edit   = (plan.filesToEdit   || []).slice(0, 5);
    const files2Create = (plan.filesToCreate || []).slice(0, 5);
    const forbidden    = (plan.forbiddenFiles || []).slice(0, 5);
    const isProductionArch = !!(
      plan.isProductionModular ||
      (plan.selectedOptionName && /production\s*modular/i.test(plan.selectedOptionName)) ||
      (typeof plan.selectedOption === 'string' && /production\s*modular/i.test(plan.selectedOption)) ||
      (typeof plan.selectedOption === 'object' && (plan.selectedOption?.isProductionModular || /production\s*modular/i.test(plan.selectedOption?.name || plan.selectedOption?.label || '')))
    );
    planHtml = `
      <div class="ai-plan-panel" id="plan_${escapeHtml(planId)}">
        <div class="plan-header" style="display: flex; justify-content: space-between; align-items: center;">
          <span>📋 Execution Plan</span>
          ${isProductionArch ? '<span class="badge-production-arch" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600;">✅ Production Architecture Selected</span>' : ''}
        </div>
        ${isProductionArch ? '<div class="plan-note" style="color: #10b981; font-size: 11px; margin: 4px 0 8px 0;">✅ Production Architecture Selected: Modular HTML, CSS, and JS files</div>' : ''}
        ${files2Edit.length   ? `<div class="plan-section"><span class="plan-label edit">Edit</span>${files2Edit.map(f=>`<code>${escapeHtml(f)}</code>`).join(' ')}</div>` : ''}
        ${files2Create.length ? `<div class="plan-section"><span class="plan-label create">Create</span>${files2Create.map(f=>`<code>${escapeHtml(f)}</code>`).join(' ')}</div>` : ''}
        ${forbidden.length    ? `<div class="plan-section"><span class="plan-label forbidden">🔒 Forbidden</span>${forbidden.map(f=>`<code>${escapeHtml(f)}</code>`).join(' ')}</div>` : ''}
        <div class="plan-actions">
          <button class="btn-plan-approve" data-plan-id="${escapeHtml(planId)}">✅ Approve &amp; Generate Prompt</button>
          <button class="btn-plan-reject"  data-plan-id="${escapeHtml(planId)}">✗ Reject</button>
        </div>
      </div>
    `;
  }

  // ── Bug Fix Panel HTML ────────────────────────────────────────────────
  const isBugFix = !!((aiResponse.isBugFix || aiResponse.mode === 'bug_fix_ready') && aiResponse.prompt);
  let bugFixHtml = '';
  if (isBugFix) {
    bugFixHtml = `
      <div class="ai-bug-fix-panel" style="margin-top: 12px; padding: 12px 14px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="font-weight: 600; font-size: 13px; color: #f87171; display: inline-flex; align-items: center; gap: 6px;">
            🛠️ Strict Bug-Fix Directive Ready
          </span>
          <span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(239, 68, 68, 0.2); color: #fca5a5; font-weight: 500;">Anti-Gravity</span>
        </div>
        <p style="margin: 0 0 10px 0; font-size: 12px; color: #94a3b8; line-height: 1.4;">
          Generated a strict Bug-Fix Prompt for Anti-Gravity that restricts changes to existing files and enforces security guardrails.
        </p>
        <button class="btn-view-bug-prompt" style="display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; background: linear-gradient(135deg, #6366f1, #4f46e5); color: #ffffff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.15s ease; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);">
          🎯 Open Bug-Fix Prompt
        </button>
      </div>
    `;
  }

  // ── Format text with basic markdown ────────────────────────────────────
  const isError = Boolean(aiResponse.isError || aiResponse.error === 'API_LIMIT_REACHED' || (aiResponse.text && (aiResponse.text.includes('API Limit Exceeded') || aiResponse.text.includes('API লিমিট শেষ'))));
  const bubbleStyle = isError ? 'style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.5); color: #fca5a5;"' : '';
  const textStyle = isError ? 'style="color: #fca5a5;"' : '';

  const formattedText = (aiResponse.text || '').trim()
    .replace(/\*\*(.+?)\*\*/g, isError ? '<strong style="color: #ef4444;">$1</strong>' : '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  msgEl.innerHTML = `
    <div class="chat-bubble-ai ${isError ? 'chat-error' : ''}" ${bubbleStyle}>
      <div class="ai-bubble-text" ${textStyle}>${formattedText}</div>
      ${isError ? '' : bugFixHtml}
      ${isError ? '' : optionsHtml}
      ${isError ? '' : planHtml}
    </div>
    <span class="chat-time">${escapeHtml(aiResponse.timestamp || formatTime())}</span>
  `;

  if (copilotFeed) {
    copilotFeed.appendChild(msgEl);
    copilotFeed.scrollTop = copilotFeed.scrollHeight;
  }

  // ── Wire Bug Fix button ────────────────────────────────────────────────
  msgEl.querySelectorAll('.btn-view-bug-prompt').forEach(btn => {
    btn.addEventListener('click', () => {
      const promptTab = document.querySelector('.tab[data-tab="prompt"]') ||
                        document.querySelector('.tab[data-tab="copilot"]');
      if (promptTab) promptTab.click();
      if (aiResponse.prompt) {
        document.dispatchEvent(new CustomEvent('prompt:restored', {
          detail: { prompt: aiResponse.prompt, metadata: { isBugFix: true, mode: 'bug_fix_ready' } }
        }));
      }
      showToast('⚡ Switched to Bug-Fix Prompt for Anti-Gravity!');
    });
  });

  // ── Wire option card clicks ────────────────────────────────────────────
  msgEl.querySelectorAll('.ai-option-card').forEach(card => {
    card.addEventListener('click', async () => {
      msgEl.querySelectorAll('.ai-option-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const optId   = card.dataset.optionId;
      const pId     = card.dataset.planId;
      try {
        if (api?.chat?.selectOption) await api.chat.selectOption(optId, pId);
      } catch (_) {}
      showToast(`Option ${optId} selected — review the plan and Approve`);
    });
  });

  // ── Wire Approve button ────────────────────────────────────────────────
  msgEl.querySelectorAll('.btn-plan-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳ Generating…';
      try {
        const res = await api.chat.approve(planId);
        if (res?.ok) {
          showToast('✅ Plan approved! Prompt generated.');
          // Switch to prompt tab
          const promptTab = document.querySelector('.tab[data-tab="prompt"]') ||
                            document.querySelector('.tab[data-tab="copilot"]');
          if (promptTab) promptTab.click();
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '✅ Approve & Generate Prompt';
        showToast('❌ Approve failed: ' + err.message);
      }
    });
  });

  // ── Wire Reject button ─────────────────────────────────────────────────
  msgEl.querySelectorAll('.btn-plan-reject').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        if (api?.chat?.reject) await api.chat.reject(planId);
      } catch (_) {}
      showToast('Plan rejected. Tell me how to revise.');
      btn.closest('.ai-plan-panel')?.remove();
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  INPUT LISTENERS & CHIPS
// ══════════════════════════════════════════════════════════════
if (btnSendChat) btnSendChat.addEventListener('click', () => handleGeneratePrompt());

if (chatInput) {
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGeneratePrompt();
    }
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });
}

// Quick prompt chips
document.querySelectorAll('.dock-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const p = chip.getAttribute('data-prompt');
    if (p) handleGeneratePrompt(p);
  });
});

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function setStatus(msg, type='') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-text' + (type ? ` ${type}` : '');
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2200);
}
window.showToast = showToast;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function shakeElement(el) {
  if (!el) return;
  el.style.borderColor = 'rgba(244,63,94,0.60)';
  el.style.boxShadow   = '0 0 0 3px rgba(244,63,94,0.15)';
  setTimeout(() => { el.style.borderColor=''; el.style.boxShadow=''; }, 900);
}

// ══════════════════════════════════════════════════════════════
//  SESSION RESTORATION ON STARTUP
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  ROADMAP STUB (Roadmap Tab Safely Deprecated)
// ══════════════════════════════════════════════════════════════
function renderRoadmap() {}
window._renderRoadmap = renderRoadmap;

// ══════════════════════════════════════════════════════════════
//  SESSION RESTORATION ON STARTUP
// ══════════════════════════════════════════════════════════════
async function initSession() {
  if (!api || (!api.sessionLoad && !api.session?.load)) return;
  try {
    const saved = api.sessionLoad ? await api.sessionLoad() : await api.session.load();
    if (!saved) return;

    console.log('[PromptLock UI] Restoring saved session:', saved);

    // 1. Restore Target AI
    if (saved.selectedTargetAI && AGENTS[saved.selectedTargetAI]) {
      state.selectedAgent = saved.selectedTargetAI;
      targetAgentSelect.value = state.selectedAgent;
      const agentInfo = AGENTS[state.selectedAgent];
      if (dockAgentBadge) dockAgentBadge.textContent = agentInfo.short;
    }

    // 2. Restore Active Security Rules
    if (Array.isArray(saved.activeRules) && saved.activeRules.length > 0) {
      syncSecurityRulePills(saved.activeRules);
    }

    // 3. Restore Chat History
    const chatList = Array.isArray(saved.chatHistory) ? saved.chatHistory : [];
    state.messages = chatList;
    if (window._chatTab && typeof window._chatTab.restoreChatHistory === 'function') {
      window._chatTab.restoreChatHistory(chatList);
    }
    if (copilotFeed) {
      copilotFeed.innerHTML = '';
      if (chatList.length > 0) {
        initFeed(); // Welcome header
        for (const msg of state.messages) {
          if (msg.type === 'user' || msg.role === 'user') {
            appendUserBubble(msg);
          } else if (msg.type === 'assistant' || msg.role === 'assistant') {
            appendReadyPromptBox(msg);
          }
        }
      }
    }

    // 4. Restore Workspace & File Tree
    if (saved.lastActiveProjectPath) {
      // Check if main process has cached AST ready
      const cached = await api.astGetSnapshot();
      if (
        cached &&
        cached.rootPath === saved.lastActiveProjectPath &&
        cached.files &&
        cached.files.length > 0
      ) {
        state.currentDir = saved.lastActiveProjectPath;
        state.astSnapshot = cached;
        const name = saved.lastActiveProjectPath.split('/').pop() || saved.lastActiveProjectPath;
        dirPath.textContent = name;
        dirPath.className   = 'dir-text-mini active';
        dirPath.title       = saved.lastActiveProjectPath;
        wsName.textContent  = name;
        wsBadge.classList.remove('hidden');
        renderSnapshot(cached);
        updateCopilotContext(cached);
        setStatus(`Workspace restored: ${name}`, 'success');
      } else {
        await setDirectory(saved.lastActiveProjectPath, true, true);
      }
    }

    // 5. Restore Roadmap & Goal State (Quietly preserve without crashing)
    if (saved.roadmapGoal) {
      state.roadmapGoal = saved.roadmapGoal;
    }
    if (Array.isArray(saved.roadmapMilestones)) {
      state.roadmapMilestones = saved.roadmapMilestones;
    }
    if (saved.activeMilestoneId) {
      state.activeMilestoneId = saved.activeMilestoneId;
    }

    // 6. Restore AI Provider & Intent / Plan
    if (saved.aiProvider) {
      state.aiProvider = saved.aiProvider;
      const aiSel = $('ai-provider');
      if (aiSel) aiSel.value = saved.aiProvider;
    }
    if (saved.currentIntent) {
      state.currentIntent = saved.currentIntent;
      const intentIn = $('intent-input');
      if (intentIn) intentIn.value = saved.currentIntent;
    }
    if (saved.currentPlan) {
      state.currentPlan = saved.currentPlan;
      document.dispatchEvent(new CustomEvent('intent:plan-ready', { detail: saved.currentPlan }));
    }
    if (saved.lastVerificationReport && typeof window.renderVerificationReport === 'function') {
      window.renderVerificationReport(saved.lastVerificationReport);
    }

    // 7. Restore Prompt Preview & Prompt History
    if (saved.lastGeneratedPrompt) {
      state.lastGeneratedPrompt = saved.lastGeneratedPrompt;
      document.dispatchEvent(new CustomEvent('prompt:restored', { detail: saved.lastGeneratedPrompt }));
    } else {
      state.lastGeneratedPrompt = null;
      if (window._promptTab && typeof window._promptTab.clearPrompt === 'function') {
        window._promptTab.clearPrompt();
      } else {
        const promptPreviewText = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
        if (promptPreviewText) {
          if ('value' in promptPreviewText) promptPreviewText.value = '';
          promptPreviewText.textContent = '';
        }
        const promptGenStatus = document.getElementById('prompt-gen-status');
        if (promptGenStatus) {
          promptGenStatus.textContent = '';
          promptGenStatus.className = 'prompt-gen-status';
        }
        const strictPanel = document.getElementById('strict-prompt-panel');
        if (strictPanel) strictPanel.classList.add('hidden');
        const emptyState = document.getElementById('prompt-empty-state');
        if (emptyState) emptyState.classList.remove('hidden');
      }
      document.dispatchEvent(new CustomEvent('prompt:cleared'));
    }

    const pHistory = Array.isArray(saved.promptHistory) ? saved.promptHistory : [];
    if (window._promptTab && typeof window._promptTab.refreshPromptHistory === 'function') {
      window._promptTab.refreshPromptHistory(pHistory);
    }

    // 8. Restore Active Tab (graceful fallback if roadmap or progress was active)
    let tabToRestore = saved.activeTab || 'scanner';
    if (tabToRestore === 'roadmap' || tabToRestore === 'progress') {
      tabToRestore = 'chat';
    }
    switchTab(tabToRestore);

  } catch (err) {
    console.warn('[PromptLock UI] Session restore error:', err);
  }
}

async function restoreSession() {
  await initSession();
}
window.restoreSession = restoreSession;

// ══════════════════════════════════════════════════════════════
//  AI SETTINGS MODAL HANDLERS (Tasks 14, 15, 26)
// ══════════════════════════════════════════════════════════════
const btnSettings = $('btnSettings');
const btnCloseSettings = $('btnCloseSettings');
const settingsModal = $('settingsModal');
const btnSaveAi = $('save-ai-settings');
const btnTestConnection = $('btnTestConnection');
const aiProviderSelect = $('ai-provider');
const apiKeyInput = $('api-key');
const aiStatus = $('aiSettingsStatus');

// Task 11 & 14: Load real provider status badge & dropdown indicators
async function loadProviderStatus() {
  const dot = $('sd-provider-dot');
  const lbl = $('sd-provider-label');
  if (!dot || !lbl) return;
  try {
    if (api?.ai?.getConfig) {
      const cfg = await api.ai.getConfig();
      const provider = cfg?.activeProvider || cfg?.provider;
      if (cfg && provider) {
        const providerNames = {
          groq: 'Groq (qwen/qwen3.8-27b)', gemini: 'Gemini (gemini-2.5-flash)',
          openai: 'OpenAI (gpt-4o-mini)', anthropic: 'Anthropic (claude-3-5-sonnet)',
          openrouter: 'OpenRouter', ollama: 'Ollama (local)', fallback: 'Fallback (offline)',
        };
        const hasKeyMap = cfg.hasKey || {};
        const hasActiveKey = typeof hasKeyMap === 'object' ? !!hasKeyMap[provider] : cfg.hasKey !== false;
        dot.style.cssText = `background:${hasActiveKey ? '#22c55e' : '#f59e0b'};box-shadow:0 0 6px ${hasActiveKey ? '#22c55e88' : '#f59e0b88'};`;
        lbl.textContent = `Active: ${providerNames[provider] || provider}${hasActiveKey ? ' (ready)' : ' (no key)'}`;

        if (aiProviderSelect) {
          aiProviderSelect.value = provider;
          Array.from(aiProviderSelect.options).forEach(opt => {
            const pVal = opt.value;
            const keyPresent = hasKeyMap[pVal] ?? false;
            const cleanText = opt.textContent.replace(/^[✅⚠️]\s*/, '');
            opt.textContent = `${keyPresent ? '✅' : '⚠️'} ${cleanText}`;
          });
        }
      } else {
        dot.style.background = '#ef4444';
        lbl.textContent = 'No provider configured';
      }
    }
  } catch (_) {
    if (dot) dot.style.background = '#6b7280';
    if (lbl) lbl.textContent = 'Provider status unavailable';
  }
}

// Task 15: Load storage stats
async function loadStorageStats() {
  try {
    if (api?.storage?.getStats) {
      const res = await api.storage.getStats();
      if (res?.success && res.data) {
        const d = res.data;
        const pc = $('sds-project-count');
        const du = $('sds-disk-usage');
        const sc = $('sds-snapshot-count');
        if (pc) pc.textContent = d.projectCount != null ? d.projectCount : '--';
        if (du) {
          const bytes = d.totalBytes || 0;
          du.textContent = bytes > 1048576
            ? `${(bytes/1048576).toFixed(1)} MB`
            : bytes > 1024 ? `${(bytes/1024).toFixed(1)} KB` : `${bytes} B`;
        }
        if (sc) sc.textContent = d.snapshotCount != null ? d.snapshotCount : '--';
      }
    }
  } catch (_) {}
}

if (btnSettings && settingsModal) {
  btnSettings.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    if (aiProviderSelect && state.aiProvider) aiProviderSelect.value = state.aiProvider;
    loadProviderStatus();
    loadStorageStats();
  });
}
if (btnCloseSettings && settingsModal) {
  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });
}
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.add('hidden');
  });
  const settingsDialog = settingsModal.querySelector('.settings-dialog');
  if (settingsDialog) {
    settingsDialog.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (settingsModal && !settingsModal.classList.contains('hidden')) {
      settingsModal.classList.add('hidden');
    }
  }
});

if (btnTestConnection && aiProviderSelect) {
  btnTestConnection.addEventListener('click', async () => {
    const provider = aiProviderSelect.value;
    const key = apiKeyInput?.value?.trim();
    btnTestConnection.disabled = true;
    if (aiStatus) aiStatus.textContent = 'Testing connection\u2026';
    try {
      if (key && api?.ai?.setKey) await api.ai.setKey(provider, key);
      if (api?.ai?.testConnection) {
        const res = await api.ai.testConnection(provider);
        if (res && res.ok) {
          if (aiStatus) aiStatus.textContent = `\u2705 Connected (${res.provider}${res.keyPreview ? ' \u2022 ' + res.keyPreview : ''})`;
          loadProviderStatus();
        } else {
          if (aiStatus) aiStatus.textContent = `\u274c Failed: ${res?.error || 'Unknown error'}`;
        }
      }
    } catch (err) {
      if (aiStatus) aiStatus.textContent = `\u274c ${err.message}`;
    } finally {
      btnTestConnection.disabled = false;
    }
  });
}

if (btnSaveAi && aiProviderSelect && apiKeyInput) {
  btnSaveAi.addEventListener('click', async () => {
    const provider = aiProviderSelect.value;
    const key = apiKeyInput.value.trim();
    if (aiStatus) aiStatus.textContent = 'Saving\u2026';
    try {
      if (api?.ai?.setProvider) await api.ai.setProvider(provider);
      if (api?.ai?.setKey && key) await api.ai.setKey(provider, key);
      state.aiProvider = provider;
      persistSession();
      if (aiStatus) aiStatus.textContent = '\u2713 Saved (Zero-leakage local store)';
      loadProviderStatus();
      setTimeout(() => {
        if (aiStatus) aiStatus.textContent = '';
        settingsModal?.classList.add('hidden');
      }, 1200);
    } catch (err) {
      if (aiStatus) aiStatus.textContent = 'Error: ' + err.message;
    }
  });
}

// Task 15: Refresh stats button
const btnRefreshStats = $('btn-refresh-stats');
if (btnRefreshStats) {
  btnRefreshStats.addEventListener('click', async () => {
    btnRefreshStats.disabled = true;
    await loadStorageStats();
    setTimeout(() => { if (btnRefreshStats) btnRefreshStats.disabled = false; }, 500);
  });
}

// Task 26: Export project backup
const btnExportProject = $('btn-export-project');
if (btnExportProject && api?.project?.exportData) {
  btnExportProject.addEventListener('click', async () => {
    const st = $('sd-storage-status');
    btnExportProject.disabled = true;
    if (st) st.textContent = 'Exporting...';
    try {
      const res = await api.project.exportData({});
      if (res?.success) { if (st) st.textContent = '\u2705 Export complete!'; }
      else if (res?.canceled) { if (st) st.textContent = 'Export canceled.'; }
      else { if (st) st.textContent = '\u274c Export failed: ' + (res?.error || 'Unknown'); }
    } catch (err) { if (st) st.textContent = '\u274c ' + err.message; }
    finally { btnExportProject.disabled = false; setTimeout(() => { if (st) st.textContent = ''; }, 3000); }
  });
}

// Task 26: Import project backup
const btnImportProject = $('btn-import-project');
if (btnImportProject && api?.project?.importData) {
  btnImportProject.addEventListener('click', async () => {
    const st = $('sd-storage-status');
    btnImportProject.disabled = true;
    if (st) st.textContent = 'Importing...';
    try {
      const res = await api.project.importData({});
      if (res?.success) {
        if (st) st.textContent = '\u2705 Import complete!';
        loadStorageStats(); loadRecentProjects();
      } else if (res?.canceled) { if (st) st.textContent = 'Import canceled.'; }
      else { if (st) st.textContent = '\u274c Import failed: ' + (res?.error || 'Unknown'); }
    } catch (err) { if (st) st.textContent = '\u274c ' + err.message; }
    finally { btnImportProject.disabled = false; setTimeout(() => { if (st) st.textContent = ''; }, 4000); }
  });
}

// Task 26: Clear active project data
const btnClearProject = $('btn-clear-project');
if (btnClearProject) {
  btnClearProject.addEventListener('click', async () => {
    const st = $('sd-storage-status');
    const activeId = window._promptLockSession?.projectId;
    if (!activeId) {
      if (st) st.textContent = '\u26a0 No active project to clear.';
      setTimeout(() => { if (st) st.textContent = ''; }, 3000);
      return;
    }
    if (!confirm('Delete ALL data for the active project? This cannot be undone.')) return;
    btnClearProject.disabled = true;
    if (st) st.textContent = 'Clearing...';
    try {
      const res = await api.project.deleteData(activeId);
      if (res?.success) {
        if (st) st.textContent = '\u2705 Project data cleared.';
        loadStorageStats(); loadRecentProjects();
      } else { if (st) st.textContent = '\u274c Clear failed: ' + (res?.error || 'Unknown'); }
    } catch (err) { if (st) st.textContent = '\u274c ' + err.message; }
    finally { btnClearProject.disabled = false; setTimeout(() => { if (st) st.textContent = ''; }, 3000); }
  });
}

// ══════════════════════════════════════════════════════════════
//  RECENT PROJECTS & WORKSPACE SWITCHING
// ══════════════════════════════════════════════════════════════

const recentDropdown  = $('recent-projects-dropdown');
const btnRecentToggle = $('btnRecentToggle');
const recentList      = $('recent-list');
const btnOpenFolder   = $('btn-open-folder');

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function loadRecentProjects() {
  if (!api || !api.project || typeof api.project.getRecent !== 'function') return;
  try {
    const res = await api.project.getRecent();
    const projects = res?.data || (Array.isArray(res) ? res : []);
    renderRecentProjects(projects);
  } catch (err) {
    console.warn('[RecentProjects] Error loading recent projects:', err);
  }
}

function renderRecentProjects(projects = []) {
  if (!recentList) return;
  recentList.innerHTML = '';

  if (!projects || projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'recent-empty';
    empty.textContent = 'No recent projects yet';
    recentList.appendChild(empty);
    return;
  }

  projects.forEach((proj) => {
    const li = document.createElement('li');
    li.className = 'recent-item';
    if (state.currentDir && proj.rootPath && state.currentDir.toLowerCase() === proj.rootPath.toLowerCase()) {
      li.classList.add('active');
    }

    const info = document.createElement('div');
    info.className = 'recent-info';

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = proj.name || 'Project';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'recent-path';
    pathSpan.textContent = proj.rootPath;
    pathSpan.title = proj.rootPath;

    const metaRow = document.createElement('div');
    metaRow.className = 'recent-meta-row';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'recent-time';
    timeSpan.textContent = formatTimeAgo(proj.lastOpened);
    metaRow.appendChild(timeSpan);

    info.appendChild(name);
    info.appendChild(pathSpan);
    info.appendChild(metaRow);
    li.appendChild(info);

    const btnRemove = document.createElement('button');
    btnRemove.className = 'btn-remove-recent';
    btnRemove.innerHTML = '&times;';
    btnRemove.title = 'Remove from recent';
    btnRemove.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (api.project.removeRecent) {
          const res = await api.project.removeRecent(proj.projectId);
          const updated = res?.data || (Array.isArray(res) ? res : []);
          renderRecentProjects(updated);
        }
      } catch (_) {}
    });
    li.appendChild(btnRemove);

    li.addEventListener('click', () => {
      recentDropdown?.classList.add('hidden');
      switchProject(proj);
    });

    recentList.appendChild(li);
  });
}

async function switchProject(project) {
  if (!project || !project.rootPath) return;
  if (typeof project.rootPath === 'string') {
    const parts = project.rootPath.replace(/[\/\\]+$/, '').split(/[\/\\]/);
    if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
      project.rootPath = parts.slice(0, -1).join('/') || '/';
    }
  }
  try {
    setStatus(`Switching to ${project.name || 'project'}…`, 'working');

    // 1. Save current session & chat before switching
    persistSession();
    if (window._chatTab && typeof window._chatTab.flushChatSession === 'function') {
      window._chatTab.flushChatSession();
    }

    // 2. Switch project on backend
    if (api && api.project && typeof api.project.switch === 'function') {
      await api.project.switch({ rootPath: project.rootPath, name: project.name });
    }

    // 3. CLEAR all UI containers immediately to prevent data bleed
    // Clear Chat messages container
    const chatContainer = document.getElementById('chat-messages') || document.querySelector('.chat-feed-area');
    if (chatContainer) chatContainer.innerHTML = '';
    if (window._chatTab && typeof window._chatTab.clearChat === 'function') {
      window._chatTab.clearChat();
    }
    if (copilotFeed) copilotFeed.innerHTML = '';

    // Clear Prompt preview
    const promptPreviewText = document.getElementById('prompt-preview-text') || document.getElementById('prompt-text');
    if (promptPreviewText) {
      if ('value' in promptPreviewText) promptPreviewText.value = '';
      promptPreviewText.textContent = '';
    }
    const promptGenStatus = document.getElementById('prompt-gen-status');
    if (promptGenStatus) {
      promptGenStatus.textContent = '';
      promptGenStatus.className = 'prompt-gen-status';
    }
    const strictPanel = document.getElementById('strict-prompt-panel');
    if (strictPanel) strictPanel.classList.add('hidden');
    const emptyState = document.getElementById('prompt-empty-state');
    if (emptyState) emptyState.classList.remove('hidden');
    if (window._promptTab && typeof window._promptTab.clearPrompt === 'function') {
      window._promptTab.clearPrompt();
    }

    // Hide options panel and execution plan card
    if (window._chatTab && typeof window._chatTab.clearInteractivePanels === 'function') {
      window._chatTab.clearInteractivePanels();
    }
    const chatOptions = document.getElementById('chat-options');
    if (chatOptions) {
      chatOptions.innerHTML = '';
      chatOptions.classList.add('hidden');
    }
    const permCard = document.getElementById('permission-card');
    if (permCard) {
      permCard.innerHTML = '';
      permCard.classList.add('hidden');
    }
    const interactiveCard = document.getElementById('interactive-plan-card');
    if (interactiveCard) interactiveCard.remove();

    // Clear in-memory state of previous project
    state.messages = [];
    state.lastGeneratedPrompt = null;
    state.currentIntent = '';
    state.currentPlan = null;
    state.roadmapMilestones = [];
    state.roadmapGoal = '';
    state.activeMilestoneId = null;
    const rmGoalInput = document.getElementById('roadmap-goal-input');
    if (rmGoalInput) rmGoalInput.value = '';
    if (window._roadmapTab && typeof window._roadmapTab.clearRoadmap === 'function') {
      window._roadmapTab.clearRoadmap();
    } else {
      renderRoadmap();
    }
    if (window._promptLockSession) {
      window._promptLockSession.chatHistory = [];
      window._promptLockSession.lastGeneratedPrompt = null;
      window._promptLockSession.currentPlan = null;
      window._promptLockSession.currentIntent = '';
      window._promptLockSession.selectedOption = null;
      window._promptLockSession.selectedOptionName = null;
      window._promptLockSession.roadmapMilestones = [];
      window._promptLockSession.roadmapGoal = '';
    }

    // 4. Update directory with skipPersist = true
    await setDirectory(project.rootPath, false, true);

    // 5. Restore new project's session from backend
    await restoreSession();

    // Force active tab to Scanner on project switch
    switchTab('scanner');

    // If new project has no chat messages, guarantee chat window is completely empty
    if (!state.messages || state.messages.length === 0) {
      if (window._chatTab && typeof window._chatTab.clearChat === 'function') {
        window._chatTab.clearChat();
      }
      const chatContainer = document.getElementById('chat-messages') || document.querySelector('.chat-feed-area');
      if (chatContainer) chatContainer.innerHTML = '';
    }

    // 6. Reload recent projects list
    loadRecentProjects();

    setStatus(`✅ Switched to ${project.name || 'workspace'}`, 'success');
  } catch (err) {
    console.error('[RecentProjects] Error switching project:', err);
    setStatus(`Failed to switch project: ${err.message}`, 'error');
  }
}

if (btnRecentToggle) {
  btnRecentToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!recentDropdown) return;
    const isHidden = recentDropdown.classList.contains('hidden');
    if (isHidden) {
      loadRecentProjects();
      recentDropdown.classList.remove('hidden');
    } else {
      recentDropdown.classList.add('hidden');
    }
  });
}

if (btnOpenFolder) {
  btnOpenFolder.addEventListener('click', async () => {
    recentDropdown?.classList.add('hidden');
    const btnOpen = $('btnOpen');
    if (btnOpen) btnOpen.click();
  });
}

document.addEventListener('click', (e) => {
  if (recentDropdown && !recentDropdown.classList.contains('hidden')) {
    if (!recentDropdown.contains(e.target) && e.target !== btnRecentToggle && !btnRecentToggle?.contains(e.target)) {
      recentDropdown.classList.add('hidden');
    }
  }
});

// Expose renderSnapshot for other modules/window if needed
window.renderSnapshot = renderSnapshot;

// Flush chat history and app session on app close / unload
window.addEventListener('beforeunload', () => {
  try {
    if (window._chatTab && typeof window._chatTab.flushChatSession === 'function') {
      window._chatTab.flushChatSession();
    }
    persistSession(true);
  } catch (_) {}
});

// Initialize
initFeed();
updateRuleCount();
initSession();
loadRecentProjects();
})();
