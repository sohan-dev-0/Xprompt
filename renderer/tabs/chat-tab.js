/**
 * Xprompt — Interactive Chat & Orchestrator Tab Controller (Step 1.2 & Polish Update)
 *
 * Developer interacts directly with the Xprompt Brain:
 *  - Chat feed with User & Assistant message bubbles
 *  - Interactive inline A / B / C architecture option buttons
 *  - Inline Plan review card with Approve / Reject / Modify buttons
 *  - Real-time typing animation and chat clear button
 *  - Export Chat as Markdown (Task 15)
 *  - Command dispatch & execution (Task 16)
 *  - Prompt Templates preset filler (Task 20)
 */

(() => {
  'use strict';

  const api = window.xprompt || window.promptLock || window.api;

  // ── DOM Elements ─────────────────────────────────────────────────────────────
  const chatMessages       = document.getElementById('chat-messages');
  const chatInput          = document.getElementById('chat-input');
  const chatSend           = document.getElementById('chat-send');
  const chatOptions        = document.getElementById('chat-options');
  const chatApproval       = document.getElementById('chat-approval');
  const chatTyping         = document.getElementById('chat-typing');
  const chatClear          = document.getElementById('chat-clear');

  // ── State ────────────────────────────────────────────────────────────────────
  let messages = [];
  let isSending = false;
  let currentActivePlan = null;
  let currentMode = 'chat'; // 'chat' | 'add' | 'update' | 'fix'

  function setChatMode(mode) {
    if (!['chat', 'add', 'update', 'fix'].includes(mode)) mode = 'chat';
    currentMode = mode;
    if (!window._promptLockSession) {
      window._promptLockSession = {};
    }
    window._promptLockSession.currentMode = mode;
    const btns = document.querySelectorAll('#chat-mode-selector button, .chat-mode-btn');
    btns.forEach(btn => {
      const btnMode = btn.getAttribute('data-mode') || btn.dataset.mode;
      btn.classList.toggle('active', btnMode === mode);
    });

    if (chatInput) {
      if (mode === 'add') {
        chatInput.placeholder = "Describe new feature to add (e.g. 'login feature', 'JWT Authentication')...";
      } else if (mode === 'update') {
        chatInput.placeholder = "Describe existing feature to update/refactor (e.g. 'login', 'timer speed')...";
      } else if (mode === 'fix') {
        chatInput.placeholder = "Describe bug or paste error (e.g. 'The button is broken', 'TypeError')...";
      } else {
        chatInput.placeholder = "Type your message (e.g. 'How many files?', 'Explain app.js')...";
      }
    }
  }

  // Expose globally so external scripts/buttons can access setChatMode
  window.setChatMode = setChatMode;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  const chatFeedArea = document.querySelector('.chat-feed-area') || (chatMessages ? chatMessages.parentElement : null);

  function forceScrollToBottom() {
    const container = document.querySelector('.chat-feed-area') || document.querySelector('#chat-messages');
    if (container) {
      // Force immediate scroll
      container.scrollTop = container.scrollHeight;
      // Trigger again after a tiny delay for fonts/images
      setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
      setTimeout(() => { container.scrollTop = container.scrollHeight; }, 200);
      setTimeout(() => { container.scrollTop = container.scrollHeight; }, 500);
    }
    const tabChat = document.querySelector('#tabChat');
    if (tabChat && tabChat.scrollHeight > tabChat.clientHeight) {
      tabChat.scrollTop = tabChat.scrollHeight;
    }
  }

  function scrollToBottom(smooth = true) {
    const performScroll = () => {
      const container = document.querySelector('.chat-feed-area') || (chatMessages ? chatMessages.parentElement : null) || chatMessages;
      if (container) {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: smooth ? 'smooth' : 'auto'
        });
      }
    };
    performScroll();
    setTimeout(performScroll, 60);
    forceScrollToBottom();
  }

  function renderChatMessages(history) {
    restoreChatHistory(history);
    forceScrollToBottom();
  }

  function clearInteractivePanels() {
    if (chatOptions) {
      chatOptions.innerHTML = '';
      chatOptions.classList.add('hidden');
    }
    if (chatApproval) {
      chatApproval.innerHTML = '';
      chatApproval.classList.add('hidden');
    }
    const permCard = document.getElementById('permission-card');
    if (permCard) {
      permCard.innerHTML = '';
      permCard.classList.add('hidden');
    }
  }

  function setTyping(isTyping, customText = 'Xprompt is analyzing AST & intent…') {
    if (!chatTyping) return;
    if (isTyping) {
      chatTyping.classList.remove('hidden');
      const label = chatTyping.querySelector('.ct-label');
      if (label) label.textContent = customText;
    } else {
      chatTyping.classList.add('hidden');
    }
    scrollToBottom(true);
  }

  // ── Session Persistence (Debounced 500ms, Immediate on Flush / Window Close) ──
  let chatSaveTimeout = null;

  function saveChatSession(immediate = false) {
    if (chatSaveTimeout) {
      clearTimeout(chatSaveTimeout);
      chatSaveTimeout = null;
    }

    const doSave = (forceSync = false) => {
      if (messages.length > 500) {
        messages = messages.slice(-500);
      }
      if (window._promptLockSession) {
        window._promptLockSession.chatHistory = messages;
      }
      try {
        // If forceSync or immediate, write synchronously to bypass debounce and race conditions
        if (forceSync && (api?.sessionSaveSync || api?.session?.saveSync)) {
          if (api?.sessionSaveSync) {
            api.sessionSaveSync({ chatHistory: messages });
          } else {
            api.session.saveSync({ chatHistory: messages });
          }
          return;
        }

        if (api?.sessionSaveSync && immediate) {
          api.sessionSaveSync({ chatHistory: messages });
          return;
        } else if (api?.session?.saveSync && immediate) {
          api.session.saveSync({ chatHistory: messages });
          return;
        }

        if (api?.sessionSave) {
          api.sessionSave({ chatHistory: messages });
        } else if (api?.session?.save) {
          api.session.save({ chatHistory: messages });
        } else if (api?.sessionSaveSync) {
          api.sessionSaveSync({ chatHistory: messages });
        } else if (api?.session?.saveSync) {
          api.session.saveSync({ chatHistory: messages });
        }
      } catch (err) {
        console.warn('[ChatTab] Error saving chat session:', err);
      }
    };

    if (immediate) {
      doSave(true);
    } else {
      chatSaveTimeout = setTimeout(() => doSave(false), 500);
    }
  }

  // Force immediate synchronous flush on window close / beforeunload
  window.addEventListener('beforeunload', () => {
    saveChatSession(true);
  });

  function appendDefaultWelcomeBubble() {
    if (chatMessages && chatMessages.children.length === 0) {
      appendMessageBubble('assistant',
        'Hello! I am your **PromptLock Orchestrator**.\n\n' +
        'Describe the feature you want to build (e.g. *"Implement JWT auth with refresh tokens"*, *"Add Stripe webhook"*).\n' +
        'I will analyze your active workspace AST and propose architecture options.',
        {},
        false
      );
    }
  }

  function clearChat() {
    if (chatMessages) chatMessages.innerHTML = '';
    clearInteractivePanels();
    messages = [];
    currentActivePlan = null;
    if (window._promptLockSession) {
      window._promptLockSession.chatHistory = [];
    }
  }

  function restoreChatHistory(history) {
    clearChat();
    if (!chatMessages) return;

    if (Array.isArray(history) && history.length > 0) {
      const toRestore = history.slice(-500);
      for (const msg of toRestore) {
        if (!msg) continue;
        const role = msg.role || (msg.type === 'user' ? 'user' : 'assistant');
        const text = msg.text || msg.message || msg.content || '';
        appendMessageBubble(role, text, msg.meta || { time: msg.time }, false);
      }
    }
    if (window._promptLockSession) {
      window._promptLockSession.chatHistory = messages;
    }
    forceScrollToBottom();
  }

  async function initChatSession() {
    try {
      const session = api?.sessionLoad ? await api.sessionLoad() : (api?.session?.load ? await api.session.load() : null);
      if (session && session.currentMode) {
        setChatMode(session.currentMode);
      }
      if (session && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
        restoreChatHistory(session.chatHistory);
        forceScrollToBottom();
        return;
      }
    } catch (e) {
      console.warn('[ChatTab] Failed to load chat history on startup:', e);
    }
    appendDefaultWelcomeBubble();
    forceScrollToBottom();
  }

  // ── Render Message Bubble ────────────────────────────────────────────────────
  function appendMessageBubble(role, text, meta = {}, persist = true) {
    if (!chatMessages) return null;

    const isErrorBubble = Boolean(meta && (meta.isError || meta.error === 'API_LIMIT_REACHED')) ||
      (typeof text === 'string' && (text.includes('API Limit Exceeded') || text.includes('API লিমিট শেষ')));

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-${role}${isErrorBubble ? ' chat-error' : ''}`;
    if (isErrorBubble) {
      bubble.style.cssText = 'background: rgba(239, 68, 68, 0.12) !important; border: 1px solid rgba(239, 68, 68, 0.5) !important; color: #fca5a5 !important; box-shadow: 0 4px 16px rgba(239, 68, 68, 0.18) !important;';
    }

    const header = document.createElement('div');
    header.className = 'cb-header';
    if (isErrorBubble) {
      header.style.color = '#f87171';
    }

    const sender = document.createElement('span');
    sender.className = 'cb-sender';
    sender.textContent = role === 'user' ? 'Developer' : 'PromptLock Brain';
    if (isErrorBubble) {
      sender.style.color = '#ef4444';
      sender.style.fontWeight = '800';
    }

    header.appendChild(sender);

    const time = document.createElement('span');
    time.className = 'cb-time';
    time.textContent = meta.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    header.appendChild(time);
    bubble.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cb-body';

    const formatted = escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, isErrorBubble ? '<strong style="color: #ef4444;">$1</strong>' : '<strong>$1</strong>')
      .replace(/\n\n/g, '<br/><br/>')
      .replace(/\n• /g, '<br/>• ');
    body.innerHTML = formatted;

    if (meta && (meta.mode === 'bug_fix_ready' || meta.isBugFixReady || meta.mode === 'feature_prompt_ready' || meta.isFeaturePromptReady)) {
      const isFeature = meta.mode === 'feature_prompt_ready' || meta.isFeaturePromptReady;
      const btnContainer = document.createElement('div');
      btnContainer.className = 'bugfix-prompt-action';
      btnContainer.style.cssText = 'margin-top: 12px; display: flex;';

      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-primary';
      openBtn.id = isFeature ? 'btn-open-feature-prompt' : 'btn-open-bugfix-prompt';
      openBtn.innerHTML = isFeature ? '🎯 Open Feature Prompt' : '🎯 Open Bug-Fix Prompt';
      openBtn.style.cssText = 'background: linear-gradient(135deg, #6366f1, #4f46e5); color: #ffffff; font-weight: 700; font-size: 12px; padding: 9px 16px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4); transition: all 0.15s ease;';

      openBtn.addEventListener('mouseenter', () => {
        openBtn.style.transform = 'translateY(-1px)';
        openBtn.style.boxShadow = '0 6px 18px rgba(99, 102, 241, 0.55)';
      });
      openBtn.addEventListener('mouseleave', () => {
        openBtn.style.transform = 'translateY(0)';
        openBtn.style.boxShadow = '0 4px 14px rgba(99, 102, 241, 0.4)';
      });

      openBtn.addEventListener('click', () => {
        const promptText = meta.prompt || window._promptLockSession?.lastGeneratedPrompt;
        if (promptText) {
          const isBug = !isFeature && (meta.metadata?.isBugFix !== false);
          if (window._promptTab && typeof window._promptTab.renderStrictPrompt === 'function') {
            window._promptTab.renderStrictPrompt(promptText, meta.metadata || { isBugFix: isBug }, null, { force: true });
          } else {
            document.dispatchEvent(new CustomEvent('prompt:restored', {
              detail: { prompt: promptText, metadata: meta.metadata || { isBugFix: isBug } }
            }));
          }
        }
        setChatMode('chat');
        const promptTab = document.querySelector('.tab[data-tab="prompt"]') ||
                          document.querySelector('.tab[data-tab="copilot"]') ||
                          document.querySelector('[data-tab="prompt"]');
        if (promptTab) {
          promptTab.click();
        }
      });

      btnContainer.appendChild(openBtn);
      body.appendChild(btnContainer);
    }

    bubble.appendChild(body);

    chatMessages.appendChild(bubble);
    scrollToBottom();

    messages.push({ role, text, time: time.textContent, meta });
    if (messages.length > 500) {
      messages = messages.slice(-500);
    }
    if (window._promptLockSession) {
      window._promptLockSession.chatHistory = messages;
    }

    if (persist) {
      try {
        if (window.api?.session?.save) {
          window.api.session.save({ chatHistory: messages });
        } else if (api?.sessionSave) {
          api.sessionSave({ chatHistory: messages });
        }
      } catch (_) {}
      saveChatSession(false);
    }

    return bubble;
  }

  // ── Render Inline A/B/C Options ──────────────────────────────────────────────
  function renderOptions(options = [], planId = null) {
    if (!chatOptions) return;
    chatOptions.innerHTML = '';

    if (!options || options.length === 0) {
      chatOptions.classList.add('hidden');
      return;
    }

    chatOptions.classList.remove('hidden');

    const title = document.createElement('div');
    title.className = 'options-prompt-title';
    title.textContent = 'Select Architecture Approach:';
    chatOptions.appendChild(title);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'options-btn-group';

    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'btn-chat-opt';
      btn.innerHTML = `<span class="opt-badge">${opt.id}</span> <span class="opt-text">${escapeHtml(opt.label || opt.description)}</span>`;
      btn.title = opt.description || opt.label;

      btn.addEventListener('click', async () => {
        btnGroup.querySelectorAll('.btn-chat-opt').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');

        const optName = opt.name || opt.label || opt.description || `Option ${opt.id}`;
        appendMessageBubble('user', `Selected ${opt.label || `Option ${opt.id}`}`);

        // Update currentActivePlan with the selected option and files
        if (!currentActivePlan) {
          const userInt = window._promptLockSession?.currentIntent || null;
          currentActivePlan = {
            id: planId || `plan_${Date.now()}`,
            task: userInt,
            intentSummary: userInt,
            userIntent: userInt,
          };
        }
        const isModular = opt.isProductionModular || /production\s*modular/i.test(optName);
        const isSingleProto = opt.isSingleFilePrototype || /single\s*file/i.test(optName);
        currentActivePlan.selectedOption = opt;
        currentActivePlan.selectedOptionName = optName.replace(/^Option\s+[A-Z]:\s*/i, '').trim();
        if (isModular) {
          currentActivePlan.isProductionModular = true;
          currentActivePlan.filesToCreate = ['index.html', 'style.css', 'app.js'];
          currentActivePlan.filesToEdit = [];
        } else if (isSingleProto) {
          currentActivePlan.isSingleFilePrototype = true;
          currentActivePlan.isProductionModular = false;
          currentActivePlan.filesToCreate = ['index.html'];
          currentActivePlan.filesToEdit = [];
        } else {
          if (Array.isArray(opt.filesToEdit)) {
            currentActivePlan.filesToEdit = [...opt.filesToEdit];
          }
          if (Array.isArray(opt.filesToCreate)) {
            currentActivePlan.filesToCreate = [...opt.filesToCreate];
          }
        }

        // Hide and clear options once an option is selected so it doesn't linger
        if (chatOptions) {
          chatOptions.innerHTML = '';
          chatOptions.classList.add('hidden');
        }

        setTyping(true, 'Configuring execution plan…');
        try {
          if (api?.chat?.selectOption) {
            const selectPayload = {
              optionId: opt.id,
              id: opt.id,
              planId: planId || currentActivePlan.id,
              name: opt.name || opt.label,
              label: opt.label,
              description: opt.description,
              filesToEdit: opt.filesToEdit || [],
              filesToCreate: opt.filesToCreate || [],
              selectedOption: opt,
              task: currentActivePlan.task || window._promptLockSession?.currentIntent,
              userIntent: currentActivePlan.userIntent || window._promptLockSession?.currentIntent,
            };
            const res = await api.chat.selectOption(selectPayload, planId);
            appendMessageBubble('assistant', res.message || `Option ${opt.id} selected. Review the plan below:`);
          }
        } catch (_) {}
        setTyping(false);

        renderApprovalCard(currentActivePlan);
      });

      btnGroup.appendChild(btn);
    }

    chatOptions.appendChild(btnGroup);
    scrollToBottom();
  }

  // ── Render Inline Approval Buttons (Approve / Reject / Modify) ────────────────
  function renderApprovalCard(plan) {
    if (!chatApproval) return;
    chatApproval.innerHTML = '';

    if (!plan) {
      chatApproval.classList.add('hidden');
      return;
    }

    chatApproval.classList.remove('hidden');

    const isProductionArch = !!(
      plan.isProductionModular ||
      (plan.selectedOptionName && /production\s*modular/i.test(plan.selectedOptionName)) ||
      (typeof plan.selectedOption === 'string' && /production\s*modular/i.test(plan.selectedOption)) ||
      (typeof plan.selectedOption === 'object' && (plan.selectedOption?.isProductionModular || /production\s*modular/i.test(plan.selectedOption?.name || plan.selectedOption?.label || '')))
    );

    const card = document.createElement('div');
    card.className = 'inline-plan-card';

    const pHeader = document.createElement('div');
    pHeader.className = 'ipc-header';
    pHeader.innerHTML = `
      <span class="ipc-title">Execution Plan • ${escapeHtml(plan.featureType || 'Feature')}</span>
      ${isProductionArch ? '<span class="badge-production-arch" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; margin-left: auto; margin-right: 8px;">✅ Production Architecture Selected</span>' : ''}
      <span class="ipc-risk-badge risk-${(plan.riskLevel || 'low').toLowerCase()}">${(plan.riskLevel || 'low').toUpperCase()}</span>
    `;
    card.appendChild(pHeader);

    const pDetails = document.createElement('div');
    pDetails.className = 'ipc-details';
    pDetails.innerHTML = `
      ${isProductionArch ? '<div class="ipc-row ipc-prod-note" style="color: #10b981; font-size: 12px; margin-bottom: 6px;"><strong>Architecture:</strong> ✅ Production Modular Structure (Separate HTML, CSS, JS)</div>' : ''}
      <div class="ipc-row"><strong>Files to Edit:</strong> ${(plan.filesToEdit || []).slice(0, 5).join(', ') || 'None'}</div>
      <div class="ipc-row"><strong>Files to Create:</strong> ${(plan.filesToCreate || []).slice(0, 5).join(', ') || 'None'}</div>
      <div class="ipc-row ipc-forbidden"><strong>Forbidden (Guarded):</strong> ${(plan.forbiddenFiles || []).join(', ')}</div>
    `;
    card.appendChild(pDetails);

    const btnRow = document.createElement('div');
    btnRow.className = 'ipc-btn-row';

    const btnReject = document.createElement('button');
    btnReject.className = 'btn-ipc btn-ipc-reject';
    btnReject.textContent = '✕ Reject';
    btnReject.addEventListener('click', async () => {
      btnReject.disabled = true;
      try {
        if (api?.chat?.reject) await api.chat.reject(plan.id);
        appendMessageBubble('assistant', 'Plan rejected. Tell me what needs to be changed.');
        clearInteractivePanels();
        currentActivePlan = null;
      } catch (_) {}
    });

    const btnModify = document.createElement('button');
    btnModify.className = 'btn-ipc btn-ipc-modify';
    btnModify.textContent = '✎ Modify Scope';
    btnModify.addEventListener('click', async () => {
      let notes = null;
      try {
        if (typeof window.prompt === 'function') notes = window.prompt('Specify modification for plan:');
      } catch (_) {}
      if (!notes) {
        if (chatInput) {
          chatInput.value = 'Please modify the plan: ';
          chatInput.focus();
        }
        appendMessageBubble('assistant', 'Please type your requested modifications in the chat input below.');
        return;
      }
      try {
        if (api?.chat?.modify) await api.chat.modify(plan.id, notes);
        appendMessageBubble('assistant', `Scope revised: "${notes}". Plan updated.`);
      } catch (_) {}
    });

    const btnApprove = document.createElement('button');
    btnApprove.className = 'btn-ipc btn-ipc-approve';
    btnApprove.textContent = '✔ Approve Plan';
    btnApprove.addEventListener('click', async () => {
      btnApprove.disabled = true;
      btnApprove.textContent = '⏳ Approving…';
      try {
        function isValidIntent(s) {
          if (typeof s !== 'string') return false;
          const str = s.trim();
          if (!str) return false;
          const lower = str.toLowerCase();
          if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'undefined') return false;
          if (lower === 'feature implementation' || lower === 'implement approved feature scope') return false;
          return true;
        }

        const candidateTasks = [
          plan.task,
          plan.intentSummary,
          plan.userIntent,
          window._promptLockSession?.currentIntent,
          plan.featureType,
        ];
        const taskIntent = candidateTasks.find(isValidIntent)
          || (isValidIntent(window._promptLockSession?.currentIntent) ? window._promptLockSession.currentIntent : 'Feature Implementation');

        const approvePayload = {
          planId: plan.id,
          plan: plan,
          task: taskIntent,
          feature: taskIntent,
          userIntent: taskIntent,
          selectedOption: plan.selectedOption,
          selectedOptionName: plan.selectedOptionName || (typeof plan.selectedOption === 'object' ? (plan.selectedOption.name || plan.selectedOption.label) : null),
          filesToEdit: plan.filesToEdit || [],
          filesToCreate: plan.filesToCreate || [],
        };

        let approveRes = null;
        if (api?.chat?.approve) {
          approveRes = await api.chat.approve(approvePayload);
        } else if (api?.plan?.approve) {
          approveRes = await api.plan.approve(approvePayload);
        }
        appendMessageBubble('assistant', '🎉 Plan approved! Switching to Prompt tab with your tailored guardrail directive.');

        const approvedPlanDetail = {
          ...plan,
          task: taskIntent,
          intentSummary: taskIntent,
          userIntent: taskIntent,
          selectedOption: plan.selectedOption,
          selectedOptionName: approvePayload.selectedOptionName,
          ...(approveRes?.prompt ? { generatedPrompt: approveRes.prompt } : {}),
          ...(approveRes?.selectedRuleIds ? { selectedRuleIds: approveRes.selectedRuleIds } : {}),
          ...(approveRes?.metadata ? { metadata: approveRes.metadata } : {}),
        };

        if (window._promptLockSession) {
          window._promptLockSession.currentPlan = approvedPlanDetail;
          window._promptLockSession.currentIntent = taskIntent;
          window._promptLockSession.selectedOption = plan.selectedOption;
          window._promptLockSession.selectedOptionName = approvedPlanDetail.selectedOptionName;
          if (approveRes?.promptHistory) {
            window._promptLockSession.promptHistory = approveRes.promptHistory;
          }
          if (Array.isArray(approveRes?.selectedRuleIds) && approveRes.selectedRuleIds.length > 0) {
            window._promptLockSession.activeRules = approveRes.selectedRuleIds;
            if (typeof window.syncSecurityRulePills === 'function') {
              window.syncSecurityRulePills(approveRes.selectedRuleIds);
            }
          }
        }

        document.dispatchEvent(new CustomEvent('plan:approved', { detail: approvedPlanDetail }));
        clearInteractivePanels();
        setChatMode('chat');

        setTimeout(() => {
          const promptTab = document.querySelector('.tab[data-tab="prompt"]') ||
                            document.querySelector('.tab[data-tab="copilot"]') ||
                            document.querySelector('[data-tab="prompt"]');
          if (promptTab) promptTab.click();
        }, 300);
      } catch (err) {
        console.error('[ChatTab] Error approving plan:', err);
        btnApprove.disabled = false;
        btnApprove.textContent = '✔ Approve Plan';
        appendMessageBubble('assistant', `⚠️ Could not approve plan: ${err?.message || 'Unknown error'}`);
      }
    });

    btnRow.appendChild(btnReject);
    btnRow.appendChild(btnModify);
    btnRow.appendChild(btnApprove);
    card.appendChild(btnRow);

    chatApproval.appendChild(card);
    scrollToBottom();
  }

  // ── Task 15: Export Chat as Markdown ─────────────────────────────────────────
  function exportChatAsMarkdown() {
    const chatList = messages.length > 0 ? messages : (window._promptLockSession?.chatHistory || []);
    if (!chatList || chatList.length === 0) {
      alert('No chat messages to export.');
      return;
    }

    const projectId = window._promptLockSession?.projectId || 'current';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `chat-${projectId}-${timestamp}.md`;

    const mdLines = [`# PromptLock Chat Transcript — Project ${projectId}`, `*Exported on ${new Date().toLocaleString()}*`, ''];

    for (let i = 0; i < chatList.length; i++) {
      const msg = chatList[i];
      if (msg.role === 'user') {
        mdLines.push(`## 👤 Developer\n${msg.text}\n`);
      } else {
        mdLines.push(`## 🤖 AI\n${msg.text}\n`);
      }
    }

    const blob = new Blob([mdLines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Task 16: Dispatch UI Chat Command ────────────────────────────────────────
  async function executeChatCommand(action, payload) {
    if (!action) return;

    if (action === 'rescan') {
      const scannerTab = document.querySelector('.tab[data-tab="scanner"]') || document.querySelector('.tab[data-tab="filetree"]');
      if (scannerTab) scannerTab.click();
      const currentDir = window._promptLockSession?.currentDir || window._promptLockSession?.rootPath;
      if (currentDir && api?.astScan) {
        await api.astScan(currentDir);
      }
    } else if (action === 'show_snapshots') {
      const progressTab = document.querySelector('.tab[data-tab="progress"]');
      if (progressTab) progressTab.click();
    } else if (action === 'clear_chat') {
      if (chatMessages) chatMessages.innerHTML = '';
      clearInteractivePanels();
      messages = [];
      currentActivePlan = null;
      if (window._promptLockSession) window._promptLockSession.chatHistory = [];
    } else if (action === 'switch_project' && payload) {
      if (api?.project?.switch) {
        await api.project.switch({ rootPath: payload });
        window.location.reload();
      }
    }
  }

  // ── Send Message Handler ─────────────────────────────────────────────────────
  async function sendMessage() {
    if (isSending || !chatInput) return;
    const text = chatInput.value.trim();
    if (text.length < 2) return;

    // Task 16: Client-side slash command handling
    if (text.startsWith('/')) {
      chatInput.value = '';
      const cmd = text.split(/\s+/)[0].toLowerCase();
      if (cmd === '/help') {
        appendMessageBubble('assistant',
          '**PromptLock Slash Commands:**\n\n' +
          '\u2022 `/help` \u2014 Show this help\n' +
          '\u2022 `/status` \u2014 Active project & AI provider info\n' +
          '\u2022 `/clear` \u2014 Clear the chat\n' +
          '\u2022 `/scan` \u2014 Force re-scan AST\n' +
          '\u2022 `/templates` \u2014 List prompt templates'
        );
        return;
      }
      if (cmd === '/clear') {
        if (chatMessages) chatMessages.innerHTML = '';
        clearInteractivePanels();
        messages = []; currentActivePlan = null;
        if (window._promptLockSession) window._promptLockSession.chatHistory = [];
        saveChatSession(true);
        appendMessageBubble('assistant', 'Chat cleared. How can I help you build with guardrails today?');
        return;
      }
      if (cmd === '/status') {
        const s = window._promptLockSession || {};
        const proj = s.projectName || (s.currentDir ? s.currentDir.split('/').pop() : 'None');
        appendMessageBubble('assistant',
          '**Status:**\n\u2022 Project: ' + proj + '\n\u2022 Provider: ' + (s.aiProvider || 'unknown') +
          '\n\u2022 Rules: ' + (Array.isArray(s.activeRules) ? s.activeRules.length : (s.activeRules?.size ?? (s.activeRules ? Object.keys(s.activeRules).length : 4))) +
          '\n\u2022 AST: ' + (s.astSnapshot ? (s.astSnapshot.files ? s.astSnapshot.files.length : 0) + ' files' : 'not loaded')
        );
        return;
      }
      if (cmd === '/scan') {
        appendMessageBubble('user', text);
        const rp = window._promptLockSession && window._promptLockSession.currentDir;
        if (rp && api && api.astScan) {
          appendMessageBubble('assistant', 'Re-scanning AST...');
          try { await api.astScan(rp); appendMessageBubble('assistant', '\u2705 Re-scan complete.'); }
          catch (e) { appendMessageBubble('assistant', '\u274c Scan failed: ' + e.message); }
        } else { appendMessageBubble('assistant', '\u26a0 No project loaded.'); }
        return;
      }
      if (cmd === '/templates') {
        appendMessageBubble('assistant', '**Templates:** auth, payment, crud, upload, chat\nUse the dropdown below to pre-fill.');
        return;
      }
      appendMessageBubble('assistant', 'Unknown command: `' + cmd + '`. Type `/help` to see commands.');
      return;
    }

    chatInput.value = '';
    chatInput.style.height = 'auto';
    isSending = true;
    if (chatSend) chatSend.disabled = true;

    // Clear previous interactive options and approval cards immediately on new message
    clearInteractivePanels();
    currentActivePlan = null;

    // 1. Append user message
    appendMessageBubble('user', text);
    if (window._promptLockSession) {
      const isQuestionOrCmd = text.includes('?') ||
        /^(kon\b|konta\b|kivabe\b|why\b|how\b|amr\b|amar\b|option\b|options\b)/i.test(text.trim()) ||
        /(option\s*(gula|gulo)?\s*(daw|dao|ase\s*nai|nai|dekhina|koi))/i.test(text.trim());
      if (!isQuestionOrCmd && text.trim().length > 3) {
        window._promptLockSession.currentIntent = text.trim();
      }
    }

    // 2. Start thinking animation
    setTyping(true, 'PromptLock Brain is analyzing AST & intent…');

    const activeBtn = document.querySelector('#chat-mode-selector button.active, .chat-mode-btn.active');
    const domMode = activeBtn ? (activeBtn.getAttribute('data-mode') || activeBtn.dataset.mode) : null;
    const sendingMode = currentMode || (window._promptLockSession && window._promptLockSession.currentMode) || domMode || 'chat';
    currentMode = sendingMode;
    if (!window._promptLockSession) {
      window._promptLockSession = {};
    }
    window._promptLockSession.currentMode = currentMode;
    console.log('[IPC Send] Mode:', currentMode);

    try {
      const historyPayload = messages.slice(-6).map(m => ({
        role: m.role || 'user',
        text: m.text || '',
      }));
      const res = await api.chat.send({ message: text, mode: currentMode, conversationHistory: historyPayload });

        if (res && res.ok && res.response) {
          const aiMsg = res.response;

          // Clear previous options panel & execution plan card before rendering new response
          clearInteractivePanels();
          currentActivePlan = null;

          if (aiMsg.error === 'API_LIMIT_REACHED' || aiMsg.isError) {
            appendMessageBubble('assistant', aiMsg.text, {
              isError: true,
              error: 'API_LIMIT_REACHED',
            });
            return;
          }

          const aiHandled = Boolean(aiMsg.providerUsed && aiMsg.providerUsed !== 'fallback' && !aiMsg.isStatic && !aiMsg._fallback);
          const isFallback = !aiHandled;
          appendMessageBubble('assistant', aiMsg.text, {
            providerUsed: aiMsg.providerUsed || (isFallback ? 'fallback' : 'ai'),
            isStatic: isFallback,
            _fallback: isFallback,
            mode: aiMsg.mode,
            prompt: aiMsg.prompt,
            metadata: aiMsg.metadata,
            isBugFixReady: aiMsg.mode === 'bug_fix_ready',
          });

          if ((aiMsg.mode === 'bug_fix_ready' || aiMsg.mode === 'feature_prompt_ready') && aiMsg.prompt) {
            if (window._promptLockSession) {
              window._promptLockSession.lastGeneratedPrompt = aiMsg.prompt;
            }
            if (window._promptTab && typeof window._promptTab.renderStrictPrompt === 'function') {
              window._promptTab.renderStrictPrompt(aiMsg.prompt, aiMsg.metadata || { isBugFix: aiMsg.mode === 'bug_fix_ready' }, null, { force: true });
            }
            setChatMode('chat');
          }

          const r = aiMsg;
          // If response.mode === 'informational' | 'chitchat' | 'command' | 'clarification_needed'
          const isNonAction = ['informational', 'chitchat', 'command', 'clarification_needed'].includes(r.mode) || ['bug_fix', 'bug_fix_ready'].includes(r.mode) || ['bug_explanation', 'bug_report'].includes(r.mode) || ['feature_prompt_ready'].includes(r.mode);
          const isAction = (r.mode === 'action' || (!r.mode && (r.needsOptions || (r.options && r.options.length > 0))));

          const optionsToRender = (Array.isArray(r.options) && r.options.length > 0)
            ? r.options
            : (Array.isArray(r.plan?.options) && r.plan.options.length > 0 ? r.plan.options : []);

          const textImpliesOptions = /(prepared.*options|architectural options|choose an approach|select.*approach|options below|3 options|following options)/i.test(r.text || '');
          const isEvaluativeInfo = r.mode === 'informational' && r.needsOptions === false;
          const isBugFlow = ['bug_fix', 'bug_fix_ready', 'bug_explanation', 'bug_report'].includes(r.mode);

          const shouldRenderOptions = (!isNonAction && isAction && r.needsOptions) ||
            (!isBugFlow && !isEvaluativeInfo && optionsToRender.length > 0 && (r.mode === 'action' || r.needsOptions === true || textImpliesOptions));

          if (shouldRenderOptions && optionsToRender.length > 0) {
            currentActivePlan = r.plan || { id: `plan_${Date.now()}`, task: text, options: optionsToRender };
            if (!currentActivePlan.options || currentActivePlan.options.length === 0) {
              currentActivePlan.options = optionsToRender;
            }
            renderOptions(optionsToRender, currentActivePlan?.id);
            setChatMode('chat');
          } else if (!isNonAction && isAction && r.plan && !r.needsOptions) {
            currentActivePlan = r.plan;
            renderApprovalCard(r.plan);
          } else {
            clearInteractivePanels();
            currentActivePlan = null;
          }

          if (aiMsg.progress) {
            document.dispatchEvent(new CustomEvent('progress:updated', { detail: aiMsg.progress }));
          }
        } else {
          clearInteractivePanels();
          currentActivePlan = null;
          appendMessageBubble('assistant', 'I could not process that request. Please try again.');
        }
    } catch (err) {
      console.error('[Chat Tab] Error in sendMessage:', err);
      appendMessageBubble('assistant', 'An internal error occurred. Please check the console.', { isError: true });
    } finally {
      setTyping(false);
      isSending = false;
      if (chatSend) chatSend.disabled = false;
      if (chatInput) chatInput.focus();
    }
  }

  // ── Bind Events ──────────────────────────────────────────────────────────────
  if (chatSend) chatSend.addEventListener('click', sendMessage);

  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
    });
  }

  if (chatClear) {
    chatClear.addEventListener('click', () => {
      if (chatMessages) chatMessages.innerHTML = '';
      clearInteractivePanels();
      messages = [];
      currentActivePlan = null;
      if (window._promptLockSession) {
        window._promptLockSession.chatHistory = [];
      }
      saveChatSession(true);
      appendMessageBubble('assistant', 'Chat cleared. How can I help you build with guardrails today?');
      if (chatInput) {
        chatInput.value = '';
        chatInput.style.height = 'auto';
        chatInput.focus();
      }
      scrollToBottom(false);
    });
  }

  // ── Explicit Mode Selector Event Listeners ─────────────────────────────────
  function attachModeSelectorListeners() {
    const modeButtons = document.querySelectorAll('#chat-mode-selector button, .chat-mode-btn');
    modeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const mode = btn.getAttribute('data-mode') || btn.dataset.mode;
        console.log('[Mode Selector] Clicked:', mode);
        window.setChatMode(mode);
      });
    });
  }

  // ── Listen for prompt ready / restored events to automatically reset mode to 'chat' ──
  document.addEventListener('prompt:ready', () => {
    console.log('[Chat Tab] prompt:ready event received — auto-resetting chat mode to "chat"');
    setChatMode('chat');
  });

  document.addEventListener('prompt:restored', () => {
    setChatMode('chat');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachModeSelectorListeners);
  } else {
    attachModeSelectorListeners();
  }

  // Initialize chat session on startup
  setTimeout(initChatSession, 50);

  // ── Tab Switch Listener (Auto-scroll when switching back to Chat tab) ────────
  function attachTabSwitchListener() {
    const tabChatEl = document.getElementById('tabChat');
    if (tabChatEl) {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            if (tabChatEl.classList.contains('active') && !tabChatEl.classList.contains('hidden')) {
              forceScrollToBottom();
            }
          }
        }
      });
      observer.observe(tabChatEl, { attributes: true });
    }

    document.querySelectorAll('.tab[data-tab="chat"]').forEach(btn => {
      btn.addEventListener('click', () => {
        forceScrollToBottom();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachTabSwitchListener);
  } else {
    attachTabSwitchListener();
  }

  // Expose tab controller
  window._chatTab = {
    appendMessageBubble,
    restoreChatHistory,
    renderChatMessages,
    forceScrollToBottom,
    clearChat,
    clearInteractivePanels,
    initChatSession,
    setChatMode,
    scrollToBottom,
    getCurrentMode: () => currentMode,
    getMessages: () => messages,
    flushChatSession: () => saveChatSession(true),
    exportChatAsMarkdown,
    executeChatCommand,
  };
})();
