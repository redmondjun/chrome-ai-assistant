# Chrome AI Assistant - Implementation Plan

## Project Overview

Build a Chrome extension (Manifest V3) that:
1. Reads active tab content (text, links, metadata)
2. Optionally follows relevant links to gather more information
3. Uses hybrid AI (local Nemotron Mini 4B + cloud NIM Nemotron 3) to answer questions
4. Shows full reasoning trace and all visited links with relevance scores
5. Generates documents/reports based on gathered content

---

## Phase 1: Foundation (Week 1)

### Day 1-2: Project Setup
- [x] Initialize repo with Vite + TypeScript + React
- [x] Configure Tailwind CSS
- [x] Set up Manifest V3 with proper permissions
- [x] Create multi-entry Vite config (background, content-script, sidepanel, options, offscreen)
- [x] Set up shared types package
- [x] Create build scripts and `.gitignore`

### Day 3-4: Messaging & Storage
- [x] Background service worker skeleton
- [x] Message passing types and router
- [x] Chrome storage wrapper (settings sync)
- [x] Settings persistence with defaults
- [x] Settings change listeners

### Day 5: Content Extraction
- [x] Content script: readability-based text extraction
- [x] Link extraction with context snippets
- [x] Metadata extraction (Open Graph, JSON-LD, meta tags)
- [x] Message handler for `GET_TAB_CONTENT`

---

## Phase 2: AI Pipeline (Week 2)

### Day 6-7: Cloud AI (NIM)
- [x] NIM client with streaming support
- [x] API key management
- [x] Model selection (Nano/Super/Ultra)
- [x] Custom endpoint support
- [x] Error handling & retries

### Day 8-9: Local AI (WASM)
- [x] Integrate `@wllama/wllama`
- [x] Model download from Hugging Face (Nemotron Mini 4B Q4_K_M)
- [x] IndexedDB caching (2.5GB model)
- [x] Progress tracking UI
- [x] Streaming completion API
- [x] Memory management (context cleanup)

### Day 10: Hybrid Router
- [x] Task complexity classification
- [x] Auto-routing rules (simple→local, complex→cloud)
- [x] Force-cloud keywords
- [x] Manual override
- [x] Fallback logic

---

## Phase 3: Link Intelligence (Week 2-3)

### Day 11-12: Link Classification
- [x] LLM-based link relevance scoring (0-1)
- [x] Batch classification for efficiency
- [x] Fallback keyword scoring
- [x] Configurable threshold

### Day 13-14: Link Fetching
- [x] Offscreen document for JS-rendered pages
- [x] Fast fetch() for static content
- [x] Rate limiting & concurrency control
- [x] Timeout handling
- [x] Content extraction from fetched pages
- [x] Visited link tracking with status

---

## Phase 4: Analysis Pipeline (Week 3)

### Day 15-16: Pipeline Orchestration
- [x] `analyzeWithReasoning()` main entry point
- [x] Step-by-step reasoning emission
- [x] Streaming response handling
- [x] Link visit emission during fetch
- [x] Error recovery

### Day 17: Prompt Engineering
- [x] System prompts for each task type
- [x] Context window management
- [x] Source citation format
- [x] Multi-source synthesis prompt

---

## Phase 5: Side Panel UI (Week 3-4)

### Day 18-19: Chat Interface
- [x] Message list with streaming
- [x] User/assistant bubbles
- [x] Markdown rendering (marked.js)
- [x] Auto-scroll
- [x] Input with Enter/Shift+Enter

### Day 20: Transparency Panels
- [x] Reasoning panel (collapsible steps with timestamps)
- [x] Links visited panel (table with scores, status, snippets)
- [x] Tab switching between panels
- [x] Real-time updates during streaming

### Day 21: Toolbar & Settings Integration
- [x] Page title/URL display
- [x] Model selector dropdown
- [x] Local/cloud toggle with status
- [x] Panel visibility toggles
- [x] Auto-route checkbox

---

## Phase 6: Options Page (Week 4)

### Day 22-23: Full Settings UI
- [x] API key input (password field)
- [x] Cloud model selector
- [x] Custom NIM endpoint
- [x] Local model download manager (progress bar)
- [x] Link following config (depth, pages, rate limit, domains)
- [x] UI preferences (theme, panel visibility)
- [x] Privacy options (local-only, clear-on-close)
- [x] Export/Import settings JSON
- [x] Reset to defaults

---

## Phase 7: Polish & Release (Week 4)

### Day 24-25: Edge Cases & Testing
- [ ] Content script injection on SPA navigation
- [ ] Offscreen document lifecycle
- [ ] Memory pressure handling (large pages)
- [ ] Network error recovery
- [ ] Model download resume
- [ ] Settings migration

### Day 26: Documentation
- [x] README.md
- [x] PLAN.md (this file)
- [ ] Architecture diagram
- [ ] Contributing guide

### Day 27: Build & Release
- [ ] Production build optimization
- [ ] Chrome Web Store assets (icons, screenshots)
- [ ] Version bump & tag
- [ ] GitHub Release

---

## Technical Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Local LLM | `@wllama/wllama` | Best WASM llama.cpp binding, active maintenance |
| Model format | GGUF Q4_K_M | Best quality/size ratio for 4B model |
| Model hosting | Hugging Face | Free, reliable, versioned |
| Cloud API | NVIDIA NIM | OpenAI-compatible, free tier, Nemotron models |
| State management | React useState + chrome.runtime | Simple, no extra deps |
| Styling | Tailwind CSS | Utility-first, small bundle, dark mode |
| Build | Vite | Fast HMR, multi-entry support |
| Storage | IndexedDB + chrome.storage.sync | Large model files + cross-device settings |
| Message passing | Typed message router | Type safety, easy debugging |

---

## Remaining Work (Post-MVP)

| Feature | Priority | Effort |
|---------|----------|--------|
| PDF/image content extraction | Medium | High |
| Multi-tab context | Medium | Medium |
| Conversation history persistence | Low | Low |
| Prompt templates library | Low | Medium |
| Team/shared workspaces | Low | High |
| Self-hosted NIM auto-discovery | Medium | Medium |
| Keyboard shortcuts | Low | Low |
| Context menu actions | Low | Low |

---

## File Structure (Target)

```
chrome-ai-extension/
├── dist/                      # Build output (gitignored)
├── public/
│   ├── manifest.json          # Generated by build
│   ├── offscreen.html         # Offscreen document
│   └── icons/                 # Extension icons
├── src/
│   ├── manifest.ts            # Manifest generator
│   ├── background/
│   │   ├── index.ts           # Service worker entry
│   │   ├── messaging.ts       # Message router
│   │   ├── api/
│   │   │   ├── nim-client.ts  # NIM streaming client
│   │   │   ├── local-client.ts # wllama wrapper
│   │   │   └── router.ts      # Hybrid routing logic
│   │   ├── content/
│   │   │   ├── extractor.ts   # Content extraction
│   │   │   ├── link-fetcher.ts # Offscreen + fetch
│   │   │   └── classifier.ts  # Link relevance scoring
│   │   ├── pipeline/
│   │   │   └── analyze.ts     # Main analysis orchestrator
│   │   └── storage/
│   │       └── settings.ts    # Settings persistence
│   ├── content-script/
│   │   └── index.ts           # DOM extraction
│   ├── sidepanel/
│   │   ├── index.html         # Side panel entry
│   │   ├── main.tsx           # React app
│   │   ├── App.tsx            # Main component
│   │   ├── components/
│   │   │   ├── Toolbar.tsx
│   │   │   ├── MessageItem.tsx
│   │   │   ├── ReasoningPanel.tsx
│   │   │   ├── LinksVisitedPanel.tsx
│   │   │   └── ModelSelector.tsx
│   │   ├── hooks/
│   │   │   ├── useChat.ts
│   │   │   └── useSettings.ts
│   │   └── styles.css
│   ├── options/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── SettingsForm.tsx
│   │   └── options.css
│   └── shared/
│       ├── types.ts           # All shared interfaces
│       └── utils.ts           # Helpers
├── .opencode/
│   └── review.yaml            # Code review config
├── README.md
├── PLAN.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
└── postcss.config.js
```

---

## Success Criteria

- [ ] Extension loads without errors
- [ ] Reads page content accurately
- [ ] Classifies links with >70% relevance accuracy
- [ ] Streams responses from both local and cloud
- [ ] Shows reasoning steps in real-time
- [ ] Displays visited links with scores
- [ ] Settings persist across sessions
- [ ] Model downloads and runs locally
- [ ] No memory leaks during extended use
- [ ] Build produces valid Chrome extension