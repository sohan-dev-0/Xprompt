# Xprompt v2.0

An AI Orchestrator and Guardrail Manager for Developers.

Xprompt is a floating desktop overlay designed to sit alongside your IDE (Cursor, Claude Code, VS Code, or Anti-Gravity). Instead of blindly copy-pasting code to AI, Xprompt analyzes your workspace's AST structure in real-time. It helps you plan architectural approaches, enforces security rules, and generates strict guardrail prompts to prevent AI models from breaking your codebase.

---

## Core Features

- Floating Glassmorphism UI: An elegant, unobtrusive floating overlay with backdrop blur and draggable controls.
- Real-Time AST Engine: Scans imports, exports, functions, classes, dependencies, and circular references using @babel/parser.
- Intelligent Multi-Provider Support: Works with Groq, Google Gemini, OpenAI, Anthropic, OpenRouter, and Ollama. Includes an automatic fallback chain if a provider hits rate limits.
- Architecture Options (A/B/C): Proposes tailored implementation strategies with risk levels, affected files, and dependency implications.
- Strict Security Injection: Automatically injects security rules (zero hardcoded secrets, Zod validation, SQL injection guards, anti-eval) into the final prompt.
- Interactive Prompt Studio:
  - Live editable prompt textarea with a toggle switch.
  - One-click regeneration for fresh compilation.
  - Visual side-by-side diff comparison to track changes.
  - Direct clipboard copy and Markdown download options.
- Multi-Project Isolation: 
  - SHA-256 hashed storage per project to ensure zero cross-project data leakage.
  - Chat history limit (500 messages) with automatic archiving.
  - Full project data export/import as .zip archives.
- Slash Commands: Quickly access features using /help, /status, /clear, /scan, and /templates.

---

## Quick Start

### 1. Clone & Install

    git clone https://github.com/sohan-dev-0/Xprompt.git
    cd Xprompt
    npm install

### 2. Configure Environment Variables
Copy the example environment file and add your API keys:

    cp .env.example .env

Open the .env file and configure your preferred provider:

    AI_PROVIDER=groq
    GROQ_API_KEY=your_groq_api_key_here
    GROQ_MODEL=qwen/qwen3.8-27b

    GEMINI_API_KEY=your_gemini_api_key_here
    GEMINI_MODEL=gemini-2.5-flash

    OPENAI_API_KEY=your_openai_key_here
    OPENAI_MODEL=gpt-4o-mini

    ANTHROPIC_API_KEY=your_anthropic_api_key_here
    ANTHROPIC_MODEL=claude-3-5-sonnet-latest

    OPENROUTER_API_KEY=
    OLLAMA_HOST=http://localhost:11434
    NODE_ENV=development

### 3. Launch the Application
The easiest way to start the entire application (both the backend and the Electron UI) is to run the provided shell script:

    chmod +x run.sh
    ./run.sh

(Alternatively, you can use npm start or npm run dev for development).

---

## How the AI Fallback System Works

Xprompt ensures your workflow is never interrupted:
1. Primary Provider: Defaults to the AI_PROVIDER specified in your .env.
2. Fallback Order: groq -> gemini -> openai -> Offline fallback.
3. Adaptive Retry: If a provider hits a rate limit (429), is unavailable (503), or times out (30s), Xprompt automatically routes the request to the next available provider.
4. Zero Key Leaks: API keys are read securely from process.env or local storage. They are never logged or exposed to the renderer process.

---

## Keyboard Shortcuts & Commands

| Command / Action | Description |
| :--- | :--- |
| Enter | Send message or generate prompt |
| Shift + Enter | Insert a new line in the chat input |
| /help | Display the command help menu |
| /status | Show active project, provider, rules, and AST file count |
| /clear | Clear current chat session |
| /scan | Trigger an immediate AST workspace re-scan |
| /templates | Display available feature presets |

---

## System Architecture

    graph TD
        subgraph Electron Main Process
            Main[main.js] --> AI[ai-service.js & Fallback Chain]
            Main --> AST[ast-engine.js & file-tree.js]
            Main --> Store[storage/project-store.js]
            Main --> Rules[rules/prompt-builder.js]
            AI --> Adapters[Groq / Gemini / OpenAI / Anthropic Adapters]
            Store --> Disk[(~/.xprompt/projects/{id}/)]
        end

        subgraph Preload & IPC Bridge
            Preload[preload.js: window.api]
            IPCAI[ipc/ai-ipc.js]
            IPCProj[ipc/project-ipc.js]
            IPCPrompt[ipc/prompt-ipc.js]
        end

        subgraph Floating Renderer UI
            App[renderer/app.js]
            ChatTab[tabs/chat-tab.js]
            ProgressTab[tabs/progress-tab.js]
            ScannerTab[tabs/scanner-tab.js]
            PromptTab[tabs/prompt-tab.js]
        end

        App --> Preload
        Preload --> IPCAI & IPCProj & IPCPrompt
        IPCAI & IPCProj & IPCPrompt --> Main

- Secure Decoupling: The UI runs in strict isolation (contextIsolation: true, nodeIntegration: false).
- Atomic Storage: All per-project storage writes use atomic temporary files and rename guarantees to prevent data corruption.
- AST Graphing: Cycles and orphan files are accurately mapped using Babel parsing tools.

---

## Testing

Xprompt includes automated test suites covering the core pipeline:

    npm test
    node test/performance-test.js

For manual QA checklists and recovery procedures, see TESTING.md.

---

## Storage Location

All project data, roadmaps, snapshots, and session archives are stored in your local user data directory:

- macOS / Linux: ~/.xprompt/
  - projects/{projectId}/session.json — Active state and chat history
  - projects/{projectId}/roadmap.json — Project milestones and goals
  - projects/{projectId}/snapshots.json — Immutable AST snapshots (max 10)
  - projects/{projectId}/chatArchive.json — Archived chat logs
  - projects/{projectId}/meta.json — Project metadata and path mapping
  - recent-projects.json — List of recent workspaces
  - settings.json — Global configurations

---

## License

MIT © Xprompt
