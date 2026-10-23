# Xprompt — Testing & Verification Guide

This guide covers running the automated test suites, performance benchmarks, and manual QA checklists for Xprompt v2.0.

---

## 🚀 Running the Automated Test Suites

### 1. Prerequisites
Ensure Node.js (v18+) and dependencies are installed:
```bash
npm install
```

### 2. Run All Tests
Runs all integration suites, runtime bug checks, and Polish Part 2 verification suites:
```bash
npm test
```
**Current Test Coverage:**
- `test/verify.js` — AST Parser, dependency graph, cycle detection, orphan detection
- `test/step1-step2-test.js` — File tree scanner, metadata hash calculation, ignore filters
- `test/step3-test.js` — AI Layer orchestration, adapters, and prompt templates
- `test/step4-test.js` — Prompt compiler, guardrail rule injection, approach filtering
- `test/chat-validation-test.js` — Chat input clarification vs. actionable request parsing
- `test/project-store-test.js` — Per-project session isolation, atomic writes, schema migration
- `test/storage-integration-test.js` — 10 cross-project isolation and persistence suites (108 assertions)
- `test/runtime-bugs-test.js` — Idempotent IPC registration, provider status, path deduplication, live AI response
- `test/polish-part2-test.js` — Architecture folders, prompt templates presets, fallback chain, chat archiving, export/import/delete

### 3. Run Performance Benchmarks
Measures scan throughput on 100+ files, AST parsing speed, snapshot diff latency, and memory consumption:
```bash
node test/performance-test.js
```

---

## 🖥 Running the Application

### Development Mode
```bash
npm run dev
# or
npm start
```
Starts Electron with dev tools and live window reloading enabled.

---

## 📋 Step-by-Step Manual QA Checklist

### Step 1: Glassmorphism Floating Overlay
- [ ] Launch Xprompt (`npm start`).
- [ ] Verify the floating window appears with glassmorphism styling (`backdrop-filter: blur`).
- [ ] Verify window pinning / dragging / minimize / close buttons function smoothly.
- [ ] Confirm top navigation tabs: **Chat**, **Roadmap**, **Progress**, **Scanner**, **Prompt**.

### Step 2: AST Workspace Scanner & Snapshot Engine
- [ ] Switch to a project folder via Open Folder dialog.
- [ ] Navigate to the **Scanner** tab.
- [ ] Verify file tree renders with LOC, file size, extension, and git status.
- [ ] Verify 8-metric health analysis displays (Files Scanned, AST Parsed, Dependencies, Risky Imports, etc.).
- [ ] Make a file edit in your workspace; observe AST re-scan within 500ms.
- [ ] Verify snapshots are persisted across app restarts in `~/.xprompt/projects/{projectId}/snapshots.json`.

### Step 3: AI Service Layer & Fallback
- [ ] Open Settings modal (⚙ gear icon).
- [ ] Verify active provider indicator (e.g., `Active: Groq (qwen/qwen3.8-27b) (ready)`).
- [ ] Verify provider dropdown shows `✅` (key present) or `⚠️` (key missing) indicators.
- [ ] Click **Test Connection** for the active provider; verify connection success indicator.
- [ ] If rate limited or network is interrupted, verify automatic fallback chain (Groq → Gemini → OpenAI → static fallback).

### Step 4: Guardrail Prompt Compiler & Diff View
- [ ] In the **Chat** tab, enter a feature request (e.g. `"Implement JWT authentication with refresh tokens"`).
- [ ] Observe A/B/C architecture options rendered.
- [ ] Select an option (e.g., Option B) and approve the plan.
- [ ] Switch to the **Prompt** tab:
  - [ ] Verify the strict guardrail prompt is generated with the selected approach name.
  - [ ] Verify missing files list contains only files required for the selected option.
  - [ ] Click **✎ Edit** to toggle the textarea from readonly to editable.
  - [ ] Click **🔄 Regenerate** to recompile prompt with fresh metadata.
  - [ ] Click **⚖ Compare with previous** to view side-by-side added/removed line diff.
  - [ ] Click **📋 Copy**; verify clipboard receives prompt text.

---

## 🔌 Testing AI Providers

Configure credentials in `.env`:
```env
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

1. **Groq**: Uses `qwen/qwen3.8-27b` via OpenAI-compatible endpoints with ultra-fast latency.
2. **Gemini**: Uses `gemini-2.5-flash` via `@google/generative-ai`.
3. **OpenAI**: Uses `gpt-4o-mini` with bearer auth.
4. **Anthropic**: Uses `claude-3-5-sonnet-latest` with `x-api-key` header.
5. **Fallback Simulation**: Temporarily set an invalid key or disconnect network; verify Xprompt logs `[AI Service] Attempting fallback candidate...` and delivers a safe structured response without crashing.

---

## 🔀 Testing Multi-Project Switching

Xprompt isolates all data per project using SHA-256 project IDs (`16-hex` format).

1. Open **Project A** (e.g., `/path/to/project-a`).
2. Add a chat message: `"Implement payments"`.
3. Open **Project B** (e.g., `/path/to/project-b`).
4. Add a chat message: `"Add redis cache"`.
5. Switch back to **Project A**:
   - Verify Project A's chat history restores `"Implement payments"`.
   - Verify Project B's history is not leaked or intermixed.
6. Check `~/.xprompt/projects/`:
   - Verify separate subdirectories exist for each project ID.

---

## 🗑 Resetting App Data

To completely reset Xprompt settings and per-project storage:

### macOS / Linux
```bash
# Remove all persisted per-project sessions, snapshots, and settings:
rm -rf ~/.xprompt
```

### Via Xprompt UI
1. Open the **Settings** modal (⚙ icon).
2. Under **Storage Stats**, view current disk usage and project count.
3. In Recent Projects, click **🗑️ Delete Data** next to any project to purge its records.
4. Or click **Clear All Storage** to wipe all local cache.
