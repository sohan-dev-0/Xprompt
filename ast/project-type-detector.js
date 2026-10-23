/**
 * PromptLock — Project Type Detector
 *
 * Classifies a workspace as 'frontend', 'backend', 'fullstack', or 'unknown'
 * by inspecting AST snapshot file paths, tech stack signals, and dependency names.
 *
 * Used by ai-service.js to inject project type into the option suggestion prompt
 * so the AI never suggests backend patterns for a frontend-only project.
 */

'use strict';

// ── Signal Registries ─────────────────────────────────────────────────────────

/** File path / name patterns that indicate frontend-only code */
const FRONTEND_FILE_SIGNALS = [
  /\.html$/i,
  /\.css$/i,
  /\.scss$/i,
  /\.sass$/i,
  /\.less$/i,
  /\.svelte$/i,
  /\.vue$/i,
  /\.jsx$/i,
  /\.tsx$/i,
  /\bcomponents?\b/i,
  /\bpages?\b/i,
  /\bviews?\b/i,
  /\bstyles?\b/i,
  /\bassets?\b/i,
  /\bpublic\b/i,
  /\bstatic\b/i,
  /\bindex\.html\b/i,
  /\bapp\.js\b/i,
  /\bmain\.js\b/i,
];

/** File path / name patterns that indicate backend code */
const BACKEND_FILE_SIGNALS = [
  /\bserver\.js\b/i,
  /\bserver\.ts\b/i,
  /\bserve\.js\b/i,
  /\bbackend\b/i,
  /\bapi\b/i,
  /\broutes?\b/i,
  /\bcontrollers?\b/i,
  /\bservices?\b/i,
  /\bmodels?\b/i,
  /\bmiddleware\b/i,
  /\bprisma\b/i,
  /\bschemas?\b/i,
  /\brepository\b/i,
  /\brepositories\b/i,
  /\bdatabase\b/i,
  /\bmigrations?\b/i,
  /\bseeds?\b/i,
  /\.py$/i,
  /\brequirements\.txt\b/i,
  /\bpyproject\.toml\b/i,
  /\bPipfile\b/i,
  /\.go$/i,
  /\bgo\.mod\b/i,
  /\.rs$/i,
  /\bCargo\.toml\b/i,
  /\.(cpp|cc|cxx|h|hpp)$/i,
];

/** Tech-stack / dependency strings that signal frontend */
const FRONTEND_TECH_SIGNALS = new Set([
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nextjs', 'nuxt',
  'vite', 'webpack', 'parcel', 'rollup', 'esbuild',
  'tailwindcss', 'tailwind', 'bootstrap', 'bulma', 'material-ui', 'mui', 'antd',
  'html5', 'css3', 'sass', 'scss', 'less',
  'web audio api', 'web audio', 'canvas', 'webgl', 'three.js', 'threejs',
  'vanilla javascript', 'vanilla js', 'client-side', 'browser',
  'electron-renderer', 'spa', 'pwa',
]);

/** Tech-stack / dependency strings that signal backend */
const BACKEND_TECH_SIGNALS = new Set([
  'node.js', 'nodejs', 'express', 'fastify', 'koa', 'hapi', 'nestjs', 'nest.js',
  'prisma', 'mongoose', 'sequelize', 'typeorm', 'knex',
  'postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis',
  'jwt', 'passport', 'bcrypt', 'bcryptjs',
  'stripe', 'paypal',
  'aws', 's3', 'lambda', 'docker', 'kubernetes',
  'graphql', 'apollo', 'rest api', 'restapi',
  'zod', 'joi', 'yup',
  'server', 'serverless', 'microservice', 'microservices',
  'python', 'py', 'golang', 'go', 'rust', 'cpp', 'c++', 'c#', 'csharp', 'java', 'ruby', 'php', 'cli',
]);

/** Patterns in package.json scripts / deps that are backend-only indicators */
const BACKEND_DEP_SIGNALS = new Set([
  'express', 'fastify', 'koa', 'hapi', '@nestjs/core',
  'prisma', '@prisma/client', 'mongoose', 'sequelize', 'typeorm',
  'jsonwebtoken', 'passport', 'bcrypt', 'bcryptjs',
  'pg', 'mysql2', 'better-sqlite3', 'redis', 'ioredis',
]);

/** Patterns that are frontend-only dependency indicators */
const FRONTEND_DEP_SIGNALS = new Set([
  'react', 'react-dom', 'vue', '@angular/core', 'svelte',
  'next', 'nuxt', 'vite', 'webpack', 'parcel',
  '@mui/material', 'antd', 'bootstrap', 'tailwindcss',
]);

// ── Detection Logic ───────────────────────────────────────────────────────────

/**
 * Detect the project type from an AST snapshot and/or project context.
 *
 * @param {object} snapshot      - AST project snapshot ({ files: [...] })
 * @param {object} projectContext - { techStack: string[], domain: string, architecturePattern: string }
 * @returns {{ projectType: 'frontend'|'backend'|'fullstack'|'unknown', confidence: number, signals: string[] }}
 */
function detectProjectType(snapshot = null, projectContext = {}) {
  let frontendScore = 0;
  let backendScore  = 0;
  const signals     = [];

  // ── 1. Tech stack strings ──────────────────────────────────────────────────
  const rawTech = projectContext.techStack;
  const techStackList = Array.isArray(rawTech)
    ? rawTech
    : (typeof rawTech === 'string' && rawTech.trim().toLowerCase() !== 'unknown' ? [rawTech] : []);
  const techStack = techStackList.map(s => String(s).toLowerCase().trim());
  for (const tech of techStack) {
    if (FRONTEND_TECH_SIGNALS.has(tech)) {
      frontendScore += 3;
      signals.push(`tech:${tech}→frontend`);
    } else {
      // Check partial match
      for (const sig of FRONTEND_TECH_SIGNALS) {
        if (tech.includes(sig) || sig.includes(tech)) {
          frontendScore += 2;
          signals.push(`tech:${tech}~${sig}→frontend`);
          break;
        }
      }
    }

    if (BACKEND_TECH_SIGNALS.has(tech)) {
      backendScore += 3;
      signals.push(`tech:${tech}→backend`);
    } else {
      for (const sig of BACKEND_TECH_SIGNALS) {
        if (tech.includes(sig) || sig.includes(tech)) {
          backendScore += 2;
          signals.push(`tech:${tech}~${sig}→backend`);
          break;
        }
      }
    }
  }

  // ── 2. Architecture pattern hint ───────────────────────────────────────────
  const arch = String(projectContext.architecturePattern || '').toLowerCase();
  if (/client.side|spa|browser|frontend|monolith.*client/i.test(arch)) {
    frontendScore += 4;
    signals.push(`arch:${arch}→frontend`);
  }
  if (/server|backend|microservice|api|rest|database/i.test(arch)) {
    backendScore += 4;
    signals.push(`arch:${arch}→backend`);
  }

  // ── 3. File-path signals from AST snapshot ─────────────────────────────────
  if (snapshot && Array.isArray(snapshot.files)) {
    const paths = snapshot.files.map(f => (f.path || '').toLowerCase());
    for (const p of paths) {
      if (FRONTEND_FILE_SIGNALS.some(re => re.test(p))) {
        frontendScore += 1;
      }
      if (BACKEND_FILE_SIGNALS.some(re => re.test(p))) {
        backendScore += 1;
      }
    }

    // Presence of HTML files → strong frontend signal
    const htmlCount = paths.filter(p => p.endsWith('.html')).length;
    if (htmlCount > 0) {
      frontendScore += htmlCount * 2;
      signals.push(`files:${htmlCount}x.html→frontend`);
    }

    // Presence of CSS files → frontend signal
    const cssCount = paths.filter(p => /\.(css|scss|sass|less)$/.test(p)).length;
    if (cssCount > 0) {
      frontendScore += cssCount;
      signals.push(`files:${cssCount}x.css→frontend`);
    }

    // Check for index.html + (style.css or app.js) -> Vanilla JS web app (NEVER unknown)
    const hasIndexHtml = paths.some(p => /(?:^|\/)index\.html$/i.test(p));
    const hasStyleCss = paths.some(p => /(?:^|\/)style\.css$/i.test(p));
    const hasAppJs = paths.some(p => /(?:^|\/)app\.js$/i.test(p));
    if (hasIndexHtml && (hasStyleCss || hasAppJs)) {
      frontendScore += 10;
      signals.push('files:vanilla-web-app→frontend');
    }

    // server.js at root or api/ directory → backend signal
    const hasServer = paths.some(p => /^(server|serve|backend)\.[jt]s$|\/server\.[jt]s$/i.test(p));
    if (hasServer) {
      backendScore += 5;
      signals.push('files:server.js→backend');
    }

    const hasApiDir = paths.some(p => /\/(api|routes?|controllers?|services?)\//i.test(p));
    if (hasApiDir) {
      backendScore += 4;
      signals.push('files:api-dir→backend');
    }

    // Presence of Python files → strong backend signal
    const pyCount = paths.filter(p => p.endsWith('.py') || p.endsWith('/requirements.txt') || p === 'requirements.txt').length;
    if (pyCount > 0) {
      backendScore += pyCount * 3 + 6;
      signals.push(`files:${pyCount}x.py→backend`);
    }
  }

  // ── 4. Determine type ─────────────────────────────────────────────────────
  const total = frontendScore + backendScore || 1;
  const confidence = Math.round(Math.max(frontendScore, backendScore) / total * 100);

  let projectType;
  if (frontendScore === 0 && backendScore === 0) {
    projectType = 'unknown';
  } else if (frontendScore > 0 && backendScore > 0) {
    // Both have signals → fullstack, unless one dominates strongly
    const ratio = Math.max(frontendScore, backendScore) / Math.min(frontendScore, backendScore);
    if (ratio >= 4) {
      // One side dominates by 4:1 → treat as that type
      projectType = frontendScore > backendScore ? 'frontend' : 'backend';
    } else {
      projectType = 'fullstack';
    }
  } else {
    projectType = frontendScore > backendScore ? 'frontend' : 'backend';
  }

  return { projectType, confidence, signals };
}

// ── Forbidden Patterns Per Type ───────────────────────────────────────────────

/**
 * Returns a list of terms/patterns that must NOT appear in option suggestions
 * for the given project type.
 *
 * @param {'frontend'|'backend'|'fullstack'|'unknown'} projectType
 * @returns {string[]}
 */
function getForbiddenPatterns(projectType) {
  if (projectType === 'frontend') {
    return [
      'zod', 'express', 'fastify', 'koa', 'nestjs', 'nest.js',
      'prisma', 'mongoose', 'sequelize', 'typeorm', 'orm',
      'repository pattern', 'repository',
      'rest api', 'restful api', 'api endpoint', 'api route',
      'route', 'router', 'controller middleware', 'controller',
      'middleware',
      'database', ' db ', 'sql', 'migration',
      'server-side', 'server side',
      'service layer',
      'jwt', 'passport', 'session store',
    ];
  }
  // Backend and fullstack can receive any suggestion
  return [];
}

/**
 * Validate that AI-generated options are appropriate for the project type.
 * Filters out any option whose label or description contains forbidden terms.
 *
 * @param {object[]} options       - Array of { id, label, description, ... }
 * @param {string}   projectType
 * @returns {{ valid: object[], removed: object[] }}
 */
function validateOptions(options = [], projectType = 'unknown', requestedLanguage = null) {
  let forbidden = [...getForbiddenPatterns(projectType)];
  const isPython = (requestedLanguage && requestedLanguage.toLowerCase() === 'python') || String(projectType).toLowerCase() === 'python';
  if (isPython) {
    forbidden.push(
      'dom manipulation', 'web component', 'web components', 'custom element',
      'html5', 'html', 'css', 'canvas', 'vanilla js', 'vanilla javascript',
      'index.html', 'style.css', 'app.js', 'requestanimationframe'
    );
  }
  if (forbidden.length === 0) return { valid: options, removed: [] };

  const valid   = [];
  const removed = [];

  for (const opt of options) {
    // Check label, name, title, description, and file lists for forbidden patterns
    const haystack = [
      opt.label || '',
      opt.name  || '',
      opt.title || '',
      opt.description || '',
      ...(Array.isArray(opt.filesToCreate) ? opt.filesToCreate : []),
      ...(Array.isArray(opt.filesToEdit) ? opt.filesToEdit : []),
    ].join(' ').toLowerCase();
    const hit = forbidden.find(f => haystack.includes(f.toLowerCase()));
    if (hit) {
      removed.push({ ...opt, _removedReason: `Forbidden pattern "${hit}" for ${projectType} project` });
    } else {
      valid.push(opt);
    }
  }

  return { valid, removed };
}

// ── Frontend Fallback Options ─────────────────────────────────────────────────

/**
 * Static fallback option sets, keyed by project type and rough feature category.
 * Used when AI is unavailable OR when all AI options fail validation.
 */
const STATIC_FALLBACKS = {
  frontend: {
    entropy: [
      {
        id: 'A',
        label: 'Option A: Modular Shannon Entropy Utility (utils/entropy.js)',
        name: 'Modular Shannon Entropy Utility (utils/entropy.js)',
        title: 'Modular Shannon Entropy Utility (utils/entropy.js)',
        description: 'Extract Shannon entropy calculation into dedicated utils/entropy.js module with formula H = -sum(p * log2(p)), and integrate with UI meter in index.html and style.css.',
        filesToCreate: ['utils/entropy.js'],
        filesToEdit: ['app.js', 'index.html', 'style.css'],
        filesRequired: ['utils/entropy.js', 'app.js', 'index.html', 'style.css'],
        estimatedComplexity: 'low',
        tradeoffs: 'Clean separation of mathematical calculations from DOM handling; highly testable.',
      },
      {
        id: 'B',
        label: 'Option B: Inline Entropy Enhancement in app.js',
        name: 'Inline Entropy Enhancement in app.js',
        title: 'Inline Entropy Enhancement in app.js',
        description: 'Refactor and enhance existing entropy and crack-time logic directly in app.js with UI updates in index.html and style.css.',
        filesToCreate: [],
        filesToEdit: ['app.js', 'index.html', 'style.css'],
        filesRequired: ['app.js', 'index.html', 'style.css'],
        estimatedComplexity: 'low',
        tradeoffs: 'Keeps all password evaluation in a single file; fastest to implement.',
      },
      {
        id: 'C',
        label: 'Option C: Web Worker Background Entropy Calculator',
        name: 'Web Worker Background Entropy Calculator',
        title: 'Web Worker Background Entropy Calculator',
        description: 'Offload complex entropy calculation and dictionary checks to a background worker to ensure zero main-thread UI jank.',
        filesToCreate: ['workers/entropy-worker.js'],
        filesToEdit: ['app.js', 'index.html', 'style.css'],
        filesRequired: ['workers/entropy-worker.js', 'app.js', 'index.html', 'style.css'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Non-blocking for heavy dictionary lookups; introduces async message passing.',
      },
    ],
    auth: [
      {
        id: 'A',
        label: 'Option A: Inline Auth in app.js',
        name: 'Inline Auth in app.js',
        title: 'Inline Auth in app.js',
        description: 'Lightweight client-side authentication modal and state management integrated directly into app.js.',
        filesToCreate: [],
        filesToEdit: ['index.html', 'app.js', 'style.css'],
        estimatedComplexity: 'low',
        tradeoffs: 'Quickest to implement; keeps single/few-file architecture intact.',
      },
      {
        id: 'B',
        label: 'Option B: Dedicated auth.js Module',
        name: 'Dedicated auth.js Module',
        title: 'Dedicated auth.js Module',
        description: 'Modular authentication handler in auth.js managing login dialogs, credentials, and session state.',
        filesToCreate: ['auth.js'],
        filesToEdit: ['index.html', 'app.js'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Clean separation of concerns; easy to test and extend.',
      },
      {
        id: 'C',
        label: 'Option C: OAuth / Token-Based Session Provider',
        name: 'OAuth / Token-Based Session Provider',
        title: 'OAuth / Token-Based Session Provider',
        description: 'Token storage and session manager with support for external OAuth providers or mock auth token sessions.',
        filesToCreate: ['auth-service.js', 'auth.css'],
        filesToEdit: ['index.html', 'app.js'],
        estimatedComplexity: 'high',
        tradeoffs: 'Robust authentication flow ready for production backend integration.',
      },
    ],
    ui: [
      {
        id: 'A',
        label: 'Option A: Vanilla JS Module with DOM Manipulation',
        description: 'Self-contained ES module using native browser APIs (getElementById, addEventListener, classList) — zero dependencies.',
        filesToCreate: ['js/feature.js'],
        filesToEdit: ['index.html', 'css/style.css'],
        estimatedComplexity: 'low',
        tradeoffs: 'Simple and fast to ship; no build step required.',
      },
      {
        id: 'B',
        label: 'Option B: Web Component (Custom Element)',
        description: 'Encapsulated, reusable custom HTML element using the native Web Components API with shadow DOM.',
        filesToCreate: ['components/feature-component.js'],
        filesToEdit: ['index.html'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Fully encapsulated and reusable; requires understanding of shadow DOM lifecycle.',
      },
      {
        id: 'C',
        label: 'Option C: CSS + JS Animated UI with State Machine',
        description: 'State-driven UI with CSS transitions/animations managed by a lightweight JS state machine pattern.',
        filesToCreate: ['js/state-machine.js', 'css/animations.css'],
        filesToEdit: ['index.html', 'js/main.js'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Polished UX; slightly more complex state logic to manage.',
      },
    ],
    game: [
      {
        id: 'A',
        label: 'Option A: Canvas 2D Game Loop',
        description: 'requestAnimationFrame-based game loop rendering onto an HTML5 <canvas> element with sprite management.',
        filesToCreate: ['js/game.js', 'js/game-loop.js'],
        filesToEdit: ['index.html'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Full render control; steeper learning curve for canvas transforms.',
      },
      {
        id: 'B',
        label: 'Option B: DOM-Based Game (no canvas)',
        description: 'Pure HTML/CSS/JS game using positioned DOM elements and CSS transitions for game state.',
        filesToCreate: ['js/game.js'],
        filesToEdit: ['index.html', 'css/style.css'],
        estimatedComplexity: 'low',
        tradeoffs: 'Simpler implementation; less performance for complex animations.',
      },
      {
        id: 'C',
        label: 'Option C: Web Audio + Canvas Hybrid',
        description: 'Game with canvas rendering plus Web Audio API for sound effects and background music.',
        filesToCreate: ['js/game.js', 'js/audio-manager.js'],
        filesToEdit: ['index.html'],
        estimatedComplexity: 'high',
        tradeoffs: 'Rich multimedia experience; requires audio asset management.',
      },
    ],
    audio: [
      {
        id: 'A',
        label: 'Option A: Web Audio API Node Graph',
        name: 'Web Audio API Node Graph',
        description: 'AudioContext with AudioBufferSourceNode, GainNode volume controls, and sound synthesis loop.',
        filesToCreate: ['audio-player.js'],
        filesToEdit: ['index.html', 'app.js'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Low-latency playback and programmatic audio graph control.',
      },
      {
        id: 'B',
        label: 'Option B: HTML5 Audio Element Player',
        name: 'HTML5 Audio Element Player',
        description: 'Lightweight player wrapping native HTML5 <audio> element with play/pause, volume slider, and playlist.',
        filesToCreate: ['player.js'],
        filesToEdit: ['index.html', 'style.css'],
        estimatedComplexity: 'low',
        tradeoffs: 'Fastest implementation; standard streaming audio support.',
      },
      {
        id: 'C',
        label: 'Option C: Web Audio + Canvas Visualizer',
        name: 'Web Audio + Canvas Visualizer',
        description: 'AnalyserNode frequency data rendered onto a responsive HTML5 canvas element with sound playback.',
        filesToCreate: ['visualizer.js', 'audio.js'],
        filesToEdit: ['index.html'],
        estimatedComplexity: 'high',
        tradeoffs: 'Stunning animated visual feedback; requires canvas animation loop.',
      },
    ],
    default: [
      {
        id: 'A',
        label: 'Option A: Vanilla JS Module',
        description: 'Native browser JavaScript with no build step — simplest integration into existing HTML/CSS project.',
        filesToCreate: ['js/feature.js'],
        filesToEdit: ['index.html'],
        estimatedComplexity: 'low',
        tradeoffs: 'Zero overhead; limited to browser-native APIs.',
      },
      {
        id: 'B',
        label: 'Option B: Event-Driven Architecture',
        description: 'Custom event emitter pattern for decoupled component communication using dispatchEvent / CustomEvent.',
        filesToCreate: ['js/event-bus.js', 'js/feature.js'],
        filesToEdit: ['js/main.js'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Scalable and decoupled; slight indirection makes debugging harder.',
      },
      {
        id: 'C',
        label: 'Option C: CSS-First Approach with Minimal JS',
        description: 'Maximize CSS (animations, :has, :focus-within, details/summary) with JS only for data orchestration.',
        filesToCreate: ['css/feature.css'],
        filesToEdit: ['index.html', 'js/main.js'],
        estimatedComplexity: 'low',
        tradeoffs: 'Performant and accessible; limited to what CSS can express.',
      },
    ],
  },

  backend: {
    default: [
      {
        id: 'A',
        label: 'Option A: Service Layer + Zod Validation',
        description: 'Clean separation of concerns with runtime Zod schema validation on all incoming data.',
        filesToCreate: ['src/services/feature.service.js', 'src/schemas/feature.schema.js'],
        filesToEdit: ['src/routes/index.js'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Type-safe, testable, and maintainable at scale.',
      },
      {
        id: 'B',
        label: 'Option B: Express Router with Middleware',
        description: 'Direct route handlers using Express middleware chain for request parsing and response shaping.',
        filesToCreate: ['src/routes/feature.routes.js', 'src/controllers/feature.controller.js'],
        filesToEdit: ['src/app.js'],
        estimatedComplexity: 'low',
        tradeoffs: 'Minimal boilerplate; can become tangled without clear layers.',
      },
      {
        id: 'C',
        label: 'Option C: Repository Pattern with Prisma ORM',
        description: 'Database abstraction layer with type-safe Prisma queries and migration tracking.',
        filesToCreate: ['src/repositories/feature.repository.js', 'prisma/migrations/'],
        filesToEdit: ['prisma/schema.prisma'],
        estimatedComplexity: 'high',
        tradeoffs: 'Highly testable and swappable; significant upfront setup cost.',
      },
    ],
  },

  python: {
    log: [
      {
        id: 'A',
        label: 'Option A: Event-Driven File Monitoring (watchdog)',
        name: 'Event-Driven File Monitoring (watchdog)',
        title: 'Event-Driven File Monitoring (watchdog)',
        description: 'Use the Python watchdog library to monitor log file modifications in real-time via OS-level file system events (FileSystemEventHandler).',
        filesToCreate: ['requirements.txt', 'main.py', 'analyzer.py'],
        filesToEdit: [],
        filesRequired: ['requirements.txt', 'main.py', 'analyzer.py'],
        estimatedComplexity: 'medium',
        tradeoffs: 'High performance with zero CPU polling waste; event-driven and efficient.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'B',
        label: 'Option B: Asynchronous Non-Blocking Polling (asyncio & aiofiles)',
        name: 'Asynchronous Non-Blocking Polling (asyncio & aiofiles)',
        title: 'Asynchronous Non-Blocking Polling (asyncio & aiofiles)',
        description: 'Implement an asynchronous event loop using asyncio and non-blocking coroutines to read and stream log lines concurrently.',
        filesToCreate: ['requirements.txt', 'main.py', 'analyzer.py'],
        filesToEdit: [],
        filesRequired: ['requirements.txt', 'main.py', 'analyzer.py'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Handles high-volume concurrent streams smoothly; requires understanding async generators.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'C',
        label: 'Option C: Native File Polling Generator (os.stat & standard library)',
        name: 'Native File Polling Generator (os.stat & standard library)',
        title: 'Native File Polling Generator (os.stat & standard library)',
        description: 'Pure Python standard library implementation mimicking tail -f using os.stat inode tracking and file seek/tell pointers.',
        filesToCreate: ['main.py', 'analyzer.py'],
        filesToEdit: [],
        filesRequired: ['main.py', 'analyzer.py'],
        estimatedComplexity: 'low',
        tradeoffs: 'Zero third-party dependencies; slightly higher CPU utilization due to sleep interval polling.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
    ],
    default: [
      {
        id: 'A',
        label: 'Option A: Modular Architecture with Python Service Layer',
        name: 'Modular Architecture with Python Service Layer',
        description: 'Clean separation of concerns with dedicated service classes, dataclasses, and standard Python modular structure.',
        filesToCreate: ['main.py', 'service.py', 'requirements.txt'],
        filesToEdit: [],
        filesRequired: ['main.py', 'service.py', 'requirements.txt'],
        estimatedComplexity: 'low',
        tradeoffs: 'Standard Python conventions with clean separation of logic.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'B',
        label: 'Option B: Async Event-Driven Architecture (asyncio)',
        name: 'Async Event-Driven Architecture (asyncio)',
        description: 'Asynchronous architecture utilizing Python asyncio event loop and concurrent task processing.',
        filesToCreate: ['main.py', 'async_worker.py', 'requirements.txt'],
        filesToEdit: [],
        filesRequired: ['main.py', 'async_worker.py', 'requirements.txt'],
        estimatedComplexity: 'medium',
        tradeoffs: 'High concurrent throughput for I/O bound tasks; requires async knowledge.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'C',
        label: 'Option C: CLI Application Architecture (argparse / click)',
        name: 'CLI Application Architecture (argparse / click)',
        description: 'Command-line tool architecture with structured argument parsing and clean terminal feedback.',
        filesToCreate: ['main.py', 'cli.py', 'requirements.txt'],
        filesToEdit: [],
        filesRequired: ['main.py', 'cli.py', 'requirements.txt'],
        estimatedComplexity: 'low',
        tradeoffs: 'Fast terminal setup and interactive CLI execution.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
    ],
    sqlite: [
      {
        id: 'A',
        label: 'Option A: SQLite Database Module (sqlite3 standard library)',
        name: 'SQLite Database Module (sqlite3 standard library)',
        title: 'SQLite Database Module (sqlite3 standard library)',
        description: 'Standard library sqlite3 module with dedicated database manager, parameterized SQL queries, and context manager connection handling.',
        filesToCreate: ['database.py'],
        filesToEdit: ['main.py'],
        filesRequired: ['database.py', 'main.py'],
        estimatedComplexity: 'low',
        tradeoffs: 'Zero extra dependencies, built into Python standard library, atomic ACID transactions.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'B',
        label: 'Option B: SQLAlchemy ORM Model & Session Layer',
        name: 'SQLAlchemy ORM Model & Session Layer',
        title: 'SQLAlchemy ORM Model & Session Layer',
        description: 'Declarative ORM models with SQLAlchemy session management and schema migrations.',
        filesToCreate: ['database.py', 'models.py'],
        filesToEdit: ['main.py', 'requirements.txt'],
        filesRequired: ['database.py', 'models.py', 'main.py', 'requirements.txt'],
        estimatedComplexity: 'medium',
        tradeoffs: 'High abstraction and swappable backend; requires third-party dependency.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'C',
        label: 'Option C: Asynchronous SQLite Layer (aiosqlite)',
        name: 'Asynchronous SQLite Layer (aiosqlite)',
        title: 'Asynchronous SQLite Layer (aiosqlite)',
        description: 'Non-blocking async SQLite queries integrated directly into asyncio event loop for concurrent high-throughput log persistence.',
        filesToCreate: ['database.py'],
        filesToEdit: ['main.py', 'requirements.txt'],
        filesRequired: ['database.py', 'main.py', 'requirements.txt'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Prevents blocking the event loop on disk I/O; requires async/await syntax.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
    ],
    slack: [
      {
        id: 'A',
        label: 'Option A: Synchronous HTTP Webhook (requests library)',
        name: 'Synchronous HTTP Webhook (requests library)',
        title: 'Synchronous HTTP Webhook (requests library)',
        description: 'Send Slack webhook alerts for CRITICAL logs using the Python requests library with connection pooling and timeouts.',
        filesToCreate: [],
        filesToEdit: ['analyzer.py', 'requirements.txt'],
        filesRequired: ['analyzer.py', 'requirements.txt'],
        estimatedComplexity: 'low',
        tradeoffs: 'Simple, battle-tested, and reliable HTTP requests; requires requests in requirements.txt.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'B',
        label: 'Option B: Zero-Dependency Standard Library Webhook (urllib.request)',
        name: 'Zero-Dependency Standard Library Webhook (urllib.request)',
        title: 'Zero-Dependency Standard Library Webhook (urllib.request)',
        description: 'Implement Slack alert dispatching using Python standard library urllib.request and json modules with zero third-party packages.',
        filesToCreate: [],
        filesToEdit: ['analyzer.py', 'requirements.txt'],
        filesRequired: ['analyzer.py', 'requirements.txt'],
        estimatedComplexity: 'low',
        tradeoffs: 'Zero external dependencies; slightly more verbose payload formatting than requests.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'C',
        label: 'Option C: Asynchronous Non-Blocking Webhook (aiohttp)',
        name: 'Asynchronous Non-Blocking Webhook (aiohttp)',
        title: 'Asynchronous Non-Blocking Webhook (aiohttp)',
        description: 'Dispatch Slack webhook notifications asynchronously via aiohttp ClientSession so alerting never blocks real-time log ingestion.',
        filesToCreate: [],
        filesToEdit: ['analyzer.py', 'requirements.txt'],
        filesRequired: ['analyzer.py', 'requirements.txt'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Zero latency impact on log monitoring stream; requires aiohttp in requirements.txt.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
    ],
    file_cleaner: [
      {
        id: 'A',
        label: 'Option A: Python Standard Library Timer Cleaner (os + time)',
        name: 'Python Standard Library Timer Cleaner (os + time)',
        title: 'Python Standard Library Timer Cleaner (os + time)',
        description: 'Command-line script using Python built-in os and time modules to accept file path and delay duration, then safely delete target file upon timer expiry.',
        filesToCreate: ['file_cleaner.py'],
        filesToEdit: [],
        filesRequired: ['file_cleaner.py'],
        estimatedComplexity: 'low',
        tradeoffs: 'Zero dependencies; synchronous execution with safe path validation.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'B',
        label: 'Option B: Non-Blocking Background Thread / Async Delay Cleaner',
        name: 'Non-Blocking Background Thread / Async Delay Cleaner',
        title: 'Non-Blocking Background Thread / Async Delay Cleaner',
        description: 'Threaded or asyncio-based file cleaner executing countdown in the background with graceful cancellation support.',
        filesToCreate: ['file_cleaner.py'],
        filesToEdit: [],
        filesRequired: ['file_cleaner.py'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Non-blocking countdown; allows terminal interaction during delay.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
      {
        id: 'C',
        label: 'Option C: Interactive CLI Tool with Progress Bar (click / rich)',
        name: 'Interactive CLI Tool with Progress Bar (click / rich)',
        title: 'Interactive CLI Tool with Progress Bar (click / rich)',
        description: 'Rich CLI tool featuring countdown timer progress bar, prompt confirmation, and safe file unlinking.',
        filesToCreate: ['file_cleaner.py', 'requirements.txt'],
        filesToEdit: [],
        filesRequired: ['file_cleaner.py', 'requirements.txt'],
        estimatedComplexity: 'medium',
        tradeoffs: 'Polished terminal UI and confirmation prompt; requires external packages in requirements.txt.',
        domain: 'backend_cli',
        featureType: 'backend_cli',
      },
    ],
  },
};

/**
 * Get static fallback options for a given project type and feature category.
 *
 * @param {'frontend'|'backend'|'fullstack'|'unknown'} projectType
 * @param {string} featureRequest - Used to pick sub-category (game, ui, etc.)
 * @returns {object[]} Array of option objects
 */
function getStaticFallbackOptions(projectType, featureRequest = '') {
  const req  = (featureRequest || '').toLowerCase();
  let isPython = projectType === 'python' || /\bpython\b/i.test(req) || /(?:script|cli).*?(?:file|path|delete|minute|duration)/i.test(req);
  if (!isPython) {
    try {
      const sessionStore = require('../session-store');
      const state = sessionStore.loadState();
      const tech = state?.techStack || state?.projectMemory?.techStack || [];
      if (Array.isArray(tech) ? tech.some(t => /python/i.test(t)) : /python/i.test(tech)) {
        isPython = true;
      }
    } catch (_) {}
  }
  if (!isPython) {
    try {
      const { getSnapshot } = require('../scanner/snapshot-manager');
      const snap = getSnapshot();
      if (snap?.files && snap.files.some(f => /\.py$/i.test(f.path || f))) {
        isPython = true;
      }
    } catch (_) {}
  }
  if (isPython) {
    const pyBank = STATIC_FALLBACKS.python;
    if (/slack|webhook|alert|notification/i.test(req)) return pyBank.slack || pyBank.default;
    if (/sqlite|database|db\b|sql\b/i.test(req)) return pyBank.sqlite || pyBank.default;
    if (/delete|clean|remove|timer|delay/i.test(req)) return pyBank.file_cleaner || pyBank.default;
    if (/log|analyz|monitor|tail/i.test(req)) return pyBank.log;
    return pyBank.default;
  }

  const type = projectType === 'unknown' ? 'frontend' : projectType;
  const bank = STATIC_FALLBACKS[type] || STATIC_FALLBACKS.frontend;

  // Pick sub-category based on feature keywords
  if (type === 'frontend') {
    if (/entropy|shannon|complexity|algorithm|math|crypto/i.test(req)) return bank.entropy || bank.default;
    if (/\b(login|auth|signin|signup|oauth|password|credentials?|sessions?)\b/i.test(req) || (/user/i.test(req) && /auth|login|account|profile/i.test(req))) return bank.auth || bank.default;
    if (/audio|music|sound|\bplayer\b|\bplayers\b|\btrack\b|\btracks\b|song|volume|voice|synth|webaudio/i.test(req)) return bank.audio || bank.default;
    if (/game|play|guess|puzzle|quiz|score/i.test(req)) return bank.game;
    if (/button|modal|dropdown|menu|card|form|input|toggle|ui|interface|component/i.test(req)) return bank.ui;
    return bank.default;
  }

  return (bank.default || STATIC_FALLBACKS.frontend.default);
}

module.exports = {
  detectProjectType,
  validateOptions,
  getForbiddenPatterns,
  getStaticFallbackOptions,
};
