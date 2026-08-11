# Chrome AI Assistant

A Chrome extension that uses NVIDIA Nemotron models to read browser tabs, follow links, and generate documents with full reasoning transparency.

## Features

- **Read any tab** - Extracts full page content including text, links, and metadata
- **Follow links intelligently** - AI classifies link relevance before fetching (configurable depth/pages)
- **Attach multiple pages** - Save open tabs or pasted URLs as reusable, conversation-specific context
- **Scalable Deep Research** - Investigates hundreds of sources with bounded batched model requests
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
   - **GLM 5.2** - Agentic reasoning, coding, and long-horizon tasks with 1M context
   - **MiniMax M3** - Multimodal reasoning, coding, and tool use with 1M context
4. Toggle **Local Model** for on-device processing (downloads ~2.5GB on first use)
5. Configure link following behavior

### Accounts and cross-device sync

Accounts are optional. Without one, chats and settings stay in the current Chrome profile. With an
account, chat history and non-secret preferences sync through Supabase. NVIDIA API keys, downloaded
models, local-model selection, and the local-only preference never upload.

1. Create a Supabase project and apply
   `supabase/migrations/202608030001_account_sync.sql` in the SQL editor or with the Supabase CLI.
2. Copy `.env.example` to `.env.local` and set the project URL and publishable key. Never place a
   service-role key in an extension build.
3. Enable Email and Google under Authentication → Providers. Create Google's OAuth client as a web
   application and use the Supabase callback URL shown on the provider page.
4. Build/load the extension, copy its ID from `chrome://extensions`, and add
   `https://EXTENSION_ID.chromiumapp.org/auth` to Supabase Authentication → URL Configuration →
   Redirect URLs. Published builds use their fixed Chrome Web Store extension ID; development builds
   need a stable unpacked-extension ID or a matching redirect entry.
5. Change the Confirm signup and Reset password email templates to display `{{ .Token }}` as a
   6-digit code. Configure custom SMTP before production; Supabase's default mailer is only suitable
   for testing.

When **Local-only mode** is enabled, account access and synchronization pause completely. Changes
remain queued in local storage and synchronize after local-only mode is disabled.

## Usage

1. Navigate to any page
2. Open side panel (click extension icon or use shortcut)
3. Ask questions:
   - `"Summarize this page"`
   - `"Follow the pricing links and create a comparison table"`
   - `"Write a technical report based on this documentation and its references"`
   - `"Extract all API endpoints mentioned here and in linked pages"`

### Attaching additional pages

Use **Attach pages** in the side panel when a request needs context from more than the active tab.

- Choose another readable open tab or paste an HTTP(S) URL.
- Close the attachment panel with **Close** in its top-right corner, or click **Attach pages** again.
- Remembered pages remain in the current Chrome profile after Chrome restarts.
- Select remembered pages independently for each conversation. Clearing a selection detaches the
  page without deleting it from the remembered-page library.
- The extension stores a snapshot when a page is added. Requests continue using that snapshot until
  you choose **Refresh**; a failed refresh preserves the previous snapshot and displays a warning.
- Deep Research always uses selected snapshots as grounding context. It follows links from an
  attached page only when the model determines that those links are relevant to the request.

Attached pages and authenticated retrieval are read-only. The assistant can draft content grounded
in those pages, but it does not edit Confluence, Jira, or other authenticated sites.

For research jobs with many subjects, the extension collects source evidence first and analyzes it
in bounded batches. The persisted request budget prevents a large ticket list from creating one
model request per ticket and exhausting the model worker.

## Debugging a Chat

To export the conversation currently selected in the side panel, open `chrome://extensions`,
enable Developer mode, then click **Service worker / Inspect** for Chrome AI Assistant. Run this
in the Console:

```js
(async () => {
  const storage = await chrome.storage.local.get(null);
  const account = storage['chrome-ai-account-state'];
  const scope = account?.user?.id || 'anonymous';
  const chats =
    storage[`chrome-ai-conversations:${scope}`] || storage['chrome-ai-conversations'] || [];
  const activeChatId =
    storage[`chrome-ai-active-conversation:${scope}`] || storage['chrome-ai-active-conversation'];

  const activeChat = chats.find(chat => chat.id === activeChatId) || chats[0];

  if (!activeChat) {
    console.error(`No chats found for storage scope "${scope}".`);
    return;
  }

  const json = JSON.stringify(activeChat, null, 2);
  console.log(json);

  try {
    await navigator.clipboard.writeText(json);
    console.info('Active chat JSON copied to clipboard.');
  } catch {
    console.info('Clipboard access was unavailable; copy the JSON from the console.');
  }
})();
```

Chats are stored under account-scoped keys. Signed-out chats use the `anonymous` scope; signed-in
chats use the account's user ID. The exporter above determines that scope automatically and falls
back to the legacy unscoped keys for older installations.

Chat exports can contain sensitive page text and retrieved internal-source excerpts. Redact that
data before sharing the JSON outside your organization.

### Debugging Link Selection

Link candidates are logged in the extension service worker console so development-time relevance
mistakes remain auditable. Open `chrome://extensions`, enable Developer mode, click **Service
worker / Inspect**, and filter the Console for `[research]`.

Each `link-decision` entry records the URL, title, depth, score, outcome, and reason. Outcomes are
`selected`, `discarded`, or `skipped`. Reasons distinguish relevance thresholds from blocked
domains, navigation links, duplicates, child-classification limits, and page-budget limits.
The same records are persisted in the assistant message's `linkDecisions` array and are included
when exporting the active chat JSON.

The displayed percentage is a candidate selection score, not a calibrated probability that the
source is relevant. The console records whether scores came from the model or the keyword fallback.

These logs can contain internal URLs and page titles. Redact them before sharing outside your
organization.

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
- **Storage**: IndexedDB (models and research jobs), chrome.storage.local (chats and saved page
  snapshots), chrome.storage.sync (non-secret settings)

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
- **Device-local page library**: Saved page URLs, extracted text, and conversation selections are
  stored only in the current Chrome profile and are not included in account sync
- **Open source**: Full code auditability

## Model Details

| Model            | Parameters | Context | Location     | Use Case                              |
| ---------------- | ---------- | ------- | ------------ | ------------------------------------- |
| Nemotron Mini 4B | 4B         | 8K      | Local (WASM) | Classification, extraction, summaries |
| Nemotron 3 Nano  | 30B        | 1M      | NIM Cloud    | Complex reasoning, doc generation     |
| Nemotron 3 Super | 120B       | 1M      | NIM Cloud    | High-quality synthesis                |
| Nemotron 3 Ultra | 550B       | 1M      | NIM Cloud    | Best quality, research tasks          |

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
