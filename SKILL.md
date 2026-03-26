---
name: gemini-exporter
description: |
  Export all Google Gemini conversations via Chrome Extension or Playwright DOM extraction.
  Chrome Extension method: one-click export with visual progress UI, resume support, and automatic file downloads.
  Playwright method: scrolls sidebar to discover all conversations, navigates to each one, scrolls up to load full history, extracts messages from DOM.

  Trigger on these phrases:
  - "/gemini-exporter", "导出Gemini", "导出Gemini对话", "export gemini"
  - "Gemini对话导出", "Gemini对话备份", "备份Gemini对话"
  - "抓取Gemini", "下载Gemini对话", "Gemini数据导出"
---

# Gemini Exporter — Full Conversation Export

Export **all** your Google Gemini conversations. Two methods:

## Method 1: Chrome Extension (Recommended)

Located in `extension/` directory. Install via `chrome://extensions/` → Load unpacked.

### How It Works

1. Content script runs on gemini.google.com pages
2. Scrolls sidebar to discover all conversation URLs
3. Navigates to each conversation via tab.update
4. Content script scrolls up to load lazy-loaded messages
5. Extracts User/Gemini messages from DOM selectors
6. Downloads each conversation as JSON + Markdown via chrome.downloads API
7. Generates merged output files at the end

### Key Files

- `extension/manifest.json` — Manifest V3 config
- `extension/background.js` — Export orchestrator (tab management, download, resume logic)
- `extension/content.js` — DOM extraction (sidebar scroll, message extraction, 3 strategies)
- `extension/popup.html/js/css` — UI with progress bar, log, stats

### DOM Selectors

- User messages: `.query-text` (content prefix "You said" removed)
- Gemini replies: `.markdown.markdown-main-panel`
- Conversation containers: `.conversation-container`
- Sidebar links: `a[href*="/app/"]`
- Title: `document.title.replace(' - Google Gemini', '')`

### Resume Support

- `exportedIds` array stored in `chrome.storage.local`
- `urlList` cached after first sidebar scan
- Already-exported conversations skipped automatically
- Safe to close popup and reopen — state persists

## Method 2: Playwright Script (Legacy)

### Prerequisites

- Python 3.10+
- `pip install playwright`
- Chrome launched with `--remote-debugging-port=9222`

### Usage

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\USERNAME\chrome-debug-profile" --proxy-server="http://127.0.0.1:2080"

# Then run
$env:NO_PROXY = "localhost,127.0.0.1"
python -u scripts/gemini_export_dom.py
```

## Output

- `gemini-export/{title}_{id}.json` — Individual conversation JSON
- `gemini-export/{title}_{id}.md` — Individual conversation Markdown
- `gemini-export/_all_conversations.json` — Merged JSON
- `gemini-export/_all_conversations.md` — Merged Markdown
