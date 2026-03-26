---
name: gemini-exporter
description: |
  Export all Google Gemini conversations via Playwright DOM extraction.
  Scrolls sidebar to discover all conversations, navigates to each one,
  scrolls up to load full history, extracts messages from DOM.

  Trigger on these phrases:
  - "/gemini-exporter", "导出Gemini", "导出Gemini对话", "export gemini"
  - "Gemini对话导出", "Gemini对话备份", "备份Gemini对话"
  - "抓取Gemini", "下载Gemini对话", "Gemini数据导出"
---

# Gemini Exporter — Full Conversation Export

Export **all** your Google Gemini conversations using Playwright + DOM extraction. No plugins needed.

## How It Works

1. Connects to Chrome via CDP (Chrome DevTools Protocol)
2. Scrolls sidebar to discover all conversation URLs (saved to `urls_index.json` for resume)
3. Navigates to each conversation
4. Scrolls up repeatedly to load full message history (lazy-loading)
5. Extracts User/Gemini messages from DOM (`.query-text` + `.markdown.markdown-main-panel`)
6. Saves each conversation as JSON + Markdown, plus merged output files

## Prerequisites

- Python 3.10+
- `pip install playwright`
- Chrome launched with `--remote-debugging-port=9222`

## Usage

### Step 1: Launch Chrome with debug port

Close all Chrome windows first, then:

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\USERNAME\chrome-debug-profile" --proxy-server="http://127.0.0.1:2080"

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug-profile"
```

### Step 2: Log in to Gemini

Open https://gemini.google.com/app in the debug Chrome, log in, expand sidebar.

### Step 3: Run exporter

```powershell
cd path/to/gemini-exporter
$env:NO_PROXY = "localhost,127.0.0.1"
python -u scripts/gemini_export_dom.py
```

## Output

- `gemini_export/{title}_{id}.json` — Individual conversation JSON
- `gemini_export/{title}_{id}.md` — Individual conversation Markdown
- `gemini_export/gemini_all_conversations.json` — Merged JSON
- `gemini_export/gemini_all_conversations.md` — Merged Markdown
- `gemini_export/urls_index.json` — Cached URL list (for resume)

## Resume Support

- URL index is cached: re-running skips sidebar collection
- Already exported conversations are skipped by conv_id detection
- Safe to interrupt and re-run

## Key Details

- Random delays (8-15s between conversations, 1-2.5s between scrolls) to avoid detection
- 20-minute timeout per conversation for very long chats
- DOM selectors: `.query-text` (user), `.markdown.markdown-main-panel` (Gemini)
- Title from `document.title`
