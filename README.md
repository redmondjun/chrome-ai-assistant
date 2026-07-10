# Chrome AI Assistant

A Chrome extension that uses NVIDIA Nemotron models to read browser tabs, follow links, and generate documents with full reasoning transparency.

## Features

- **Read any tab** - Extracts full page content including text, links, and metadata
- **Follow links intelligently** - AI classifies link relevance before fetching (configurable depth/pages)
- **Hybrid AI** - Routes simple tasks to local Nemotron Mini 4B, complex tasks to cloud NIM (Nemotron 3 Nano/Super/Ultra)
- **Full transparency** - Shows reasoning steps and every link visited with relevance scores
- **Document generation** - Creates reports, summaries, analyses from gathered content
- **Private by default** - Local-first option with optional cloud fallback

## Installation

### Development

```bash
git clone <repo>
cd chrome-ai-extension
npm install
npm run build
```

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `dist/` folder

### Production

Download latest release from GitHub Releases and load as unpacked extension.

## Configuration

1. Click extension icon → Settings (gear)
2. Add your **NVIDIA API Key** (from [build.nvidia.com](https://build.nvidia.com))
3. Choose cloud model tier:
   - **Nemotron 3 Nano** - Fast, 1M context, good quality
   - **Nemotron 3 Super** - Balanced speed/quality
   - **Nemotron 3 Ultra** - Best quality, slower
4. Toggle **Local Model** for on-device processing (downloads ~2.5GB on first use)
5. Configure link following behavior

## Usage

1. Navigate to any page
2. Open side panel (click extension icon or use shortcut)
3. Ask questions:
   - `"Summarize this page"`
   - `"Follow the pricing links and create a comparison table"`
   - `"Write a technical report based on this documentation and its references"`
   - `"Extract all API endpoints mentioned here and in linked pages"`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                             │
├─────────────────────────────────────────────────────────────┤
│  Content Script    │  Background SW    │  Side Panel (React)│
│  - DOM extraction  │  - NIM API        │  - Chat UI         │
│  - Link detection  │  - Local LLM      │  - Reasoning panel │
│                    │  - Link fetching  │  - Links panel     │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
           ┌───────────────┐    ┌───────────────┐
           │ NVIDIA NIM    │    │ Local Model   │
           │ Nemotron 3    │    │ Nemotron Mini │
           │ (Cloud)       │    │ 4B (WASM)     │
           └───────────────┘    └───────────────┘
```

## Tech Stack

- **Extension**: Manifest V3, TypeScript, Vite
- **UI**: React 18, Tailwind CSS
- **Local LLM**: `@wllama/wllama` (llama.cpp WASM)
- **Cloud API**: NVIDIA NIM (OpenAI-compatible)
- **Storage**: IndexedDB (models), chrome.storage.sync (settings)

## Development

```bash
npm run dev      # Start dev server with HMR
npm run build    # Production build to dist/
npm run preview  # Preview production build
npm run lint     # Run ESLint
npm run typecheck # Run TypeScript check
```

## Privacy

- **Local-only mode**: All processing happens on-device, no data leaves your browser
- **Cloud mode**: Page content sent to NVIDIA NIM API (your API key, your account)
- **No telemetry**: No usage analytics or tracking
- **Open source**: Full code auditability

## Model Details

| Model | Parameters | Context | Location | Use Case |
|-------|-----------|---------|----------|----------|
| Nemotron Mini 4B | 4B | 8K | Local (WASM) | Classification, extraction, summaries |
| Nemotron 3 Nano | 30B | 1M | NIM Cloud | Complex reasoning, doc generation |
| Nemotron 3 Super | 120B | 1M | NIM Cloud | High-quality synthesis |
| Nemotron 3 Ultra | 550B | 1M | NIM Cloud | Best quality, research tasks |

## License

MIT License - see LICENSE file.

## Contributing

1. Fork the repo
2. Create feature branch
3. Make changes with tests
4. Submit PR

## Support

- Issues: GitHub Issues
- NVIDIA NIM: [build.nvidia.com](https://build.nvidia.com)
- Local LLM: [wllama](https://github.com/ngxson/wllama)