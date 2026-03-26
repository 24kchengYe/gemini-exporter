---
name: gemini-exporter
description: |
  Export all Google Gemini conversations via Chrome Extension using internal batchexecute API.
  Hybrid approach: sidebar DOM for conversation list + hNvQHb RPC for complete content.
  One-click batch export with visual progress UI, timestamps, resume support, and automatic file downloads.

  Trigger on these phrases:
  - "/gemini-exporter", "导出Gemini", "导出Gemini对话", "export gemini"
  - "Gemini对话导出", "Gemini对话备份", "备份Gemini对话"
  - "抓取Gemini", "下载Gemini对话", "Gemini数据导出"
---

# Gemini Exporter — Batch Conversation Export via Internal API

Chrome Extension (Manifest V3) that exports all Gemini conversations using a hybrid approach:
sidebar DOM scrolling for conversation list + `hNvQHb` batchexecute RPC for complete content.

## Key Files

- `extension/manifest.json` — Manifest V3, permissions: storage, unlimitedStorage, scripting, tabs, downloads
- `extension/background.js` — Export orchestrator, manages sidebar scan → API fetch → download loop
- `extension/content.js` — Runs on gemini.google.com: token extraction, API calls, response parsing, Blob downloads
- `extension/popup.html/js/css` — Dark theme UI with progress bar, stats, log
- `extension/gemini-api.js` — Standalone API client (reference, not used by extension)
- `debug/` — Chrome Snippets for testing API responses on different accounts

## Architecture

1. **Sidebar DOM scroll** → collect `a[href*="/app/"]` URLs + `innerText` first line as title
2. **Token extraction** → `SNlM0e` (CSRF) + `cfb2h` (build label) from page HTML
3. **For each conversation** → `hNvQHb` batchexecute with `c_` prefixed ID, limit=1000
4. **Parse response** → find `["wrb.fr","hNvQHb","..."]` array, JSON.parse outer then inner
5. **Extract data** → user: `turn[2][0][0]`, model: `turn[3][0][0][1]`, timestamp: `turn[4][0]`
6. **Download** → Blob URL via content script `<a download="filename">`

## Critical Notes

- `MaZiqc` (list API) returns **encrypted** data — unusable, must use sidebar DOM instead
- Conversation IDs need `c_` prefix for API (URL has `a1b96a10`, API needs `c_a1b96a10`)
- Model response is at `turn[3][0][0]` not `turn[3][0]` (extra nesting layer)
- Don't store full conversations in `chrome.storage` (quota limit) — use `unlimitedStorage` + memory only
- Content script: don't use `__injected` guard — prevents code updates on extension reload
- Google rate limits after ~30+ rapid requests — 1.5s delay between calls, retry after 5-10 min on 405
