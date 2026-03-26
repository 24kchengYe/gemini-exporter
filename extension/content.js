// ============================================================
// Gemini Conversation Exporter - Content Script
// Uses internal API (batchexecute) for fast, complete extraction
// Falls back to DOM extraction if API fails
// ============================================================

(function () {
  if (window.__geminiExporterInjected) return;
  window.__geminiExporterInjected = true;

  // ---- Message handler ----

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extractTokens') {
      extractTokens()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.action === 'apiListConversations') {
      apiListConversations(msg.pageSize || 50)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.action === 'apiGetConversation') {
      apiGetConversation(msg.convId)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.action === 'downloadFiles') {
      downloadFilesAsBlobs(msg.files)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });

  // ---- Token extraction from current page HTML ----

  async function extractTokens() {
    // Try extracting from current page first
    let html = document.documentElement.innerHTML;

    // If we're not on the right page, fetch it
    if (!html.includes('SNlM0e')) {
      const resp = await fetch('https://gemini.google.com/app', {
        credentials: 'include',
      });
      html = await resp.text();
    }

    function extract(key) {
      const patterns = [
        new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`),
        new RegExp(`\\["${key}","([^"]+)"\\]`),
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
      }
      return null;
    }

    const at = extract('SNlM0e');
    const bl = extract('cfb2h');
    const sid = extract('FdrFJe');
    const hl = extract('TuX5cc') || 'en';

    if (!at) throw new Error('Failed to extract SNlM0e token. Make sure you are logged in.');

    return { at, bl, sid, hl };
  }

  // ---- batchexecute caller ----

  async function batchExecute(tokens, rpcId, payload) {
    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const BATCHEXECUTE_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

    const fReq = JSON.stringify([[
      [rpcId, JSON.stringify(payload), null, 'generic']
    ]]);

    const params = new URLSearchParams({
      'rpcids': rpcId,
      'source-path': '/app',
      'hl': tokens.hl,
      '_reqid': String(reqId),
      'rt': 'c',
    });
    if (tokens.bl) params.set('bl', tokens.bl);
    if (tokens.sid) params.set('f.sid', tokens.sid);

    const body = new URLSearchParams({
      'at': tokens.at,
      'f.req': fReq,
    });

    const resp = await fetch(`${BATCHEXECUTE_URL}?${params.toString()}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'X-Same-Domain': '1',
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error(`API error: ${resp.status}`);
    }

    const text = await resp.text();
    return parseResponse(text, rpcId);
  }

  // ---- Response parsing ----

  function parseResponse(rawText, rpcId) {
    let text = rawText;
    if (text.startsWith(")]}'")) {
      text = text.substring(text.indexOf('\n') + 1);
    }

    // Parse length-prefixed frames
    const frames = [];
    let pos = 0;
    while (pos < text.length) {
      const nlIdx = text.indexOf('\n', pos);
      if (nlIdx < 0) break;
      const len = parseInt(text.substring(pos, nlIdx), 10);
      if (isNaN(len)) { pos = nlIdx + 1; continue; }
      const frameText = text.substring(nlIdx + 1, nlIdx + 1 + len);
      pos = nlIdx + 1 + len;
      try {
        frames.push(JSON.parse(frameText));
      } catch (e) { /* skip */ }
    }

    for (const frame of frames) {
      const payload = findRpcPayload(frame, rpcId);
      if (payload !== null) {
        try { return JSON.parse(payload); } catch (e) { return payload; }
      }
    }
    return null;
  }

  function findRpcPayload(node, rpcId) {
    if (!Array.isArray(node)) return null;
    if (node[0] === 'wrb.fr' && node[1] === rpcId && typeof node[2] === 'string') {
      return node[2];
    }
    for (const child of node) {
      const result = findRpcPayload(child, rpcId);
      if (result !== null) return result;
    }
    return null;
  }

  // ---- API: List all conversations ----

  let _cachedTokens = null;

  async function getTokens() {
    if (!_cachedTokens) {
      _cachedTokens = await extractTokens();
    }
    return _cachedTokens;
  }

  async function apiListConversations(pageSize) {
    const tokens = await getTokens();
    const allChats = [];

    for (const pinFlag of [1, 0]) {
      let nextToken = null;
      do {
        const payload = [pageSize, nextToken, [pinFlag, null, 1]];
        const data = await batchExecute(tokens, 'MaZiqc', payload);
        if (!data) break;

        const rows = data[2] || data[0] || [];
        if (!Array.isArray(rows) || rows.length === 0) break;

        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          allChats.push({
            id: row[0],
            title: row[1] || 'Untitled',
            isPinned: !!row[2],
            timestamp: row[5] ? row[5][0] : null,
          });
        }

        nextToken = data[1] || null;
      } while (nextToken);
    }

    // Deduplicate
    const seen = new Set();
    const unique = allChats.filter(c => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    return { conversations: unique, count: unique.length };
  }

  // ---- API: Get single conversation ----

  async function apiGetConversation(convId) {
    const tokens = await getTokens();
    const payload = [convId, 1000, null, 1, [1], [4], null, 1];
    const data = await batchExecute(tokens, 'hNvQHb', payload);

    if (!data) return { error: 'No data returned', messages: [] };

    const messages = [];
    const turns = data[0] || [];

    for (const turn of turns) {
      if (!Array.isArray(turn)) continue;

      // User message: turn[2][0][0]
      try {
        const userText = turn[2]?.[0]?.[0];
        if (userText && typeof userText === 'string') {
          messages.push({ role: 'user', content: userText });
        }
      } catch (e) { /* skip */ }

      // Model response: turn[3][0] = selected candidate
      try {
        const candidates = turn[3]?.[0];
        if (Array.isArray(candidates)) {
          const parts = candidates[1];
          if (Array.isArray(parts)) {
            let text = '';
            for (const part of parts) {
              if (typeof part === 'string') {
                text += part;
              } else if (Array.isArray(part) && typeof part[0] === 'string') {
                text += part[0];
              }
            }
            if (text) {
              messages.push({ role: 'assistant', content: text });
            }
          }
        }
      } catch (e) { /* skip */ }
    }

    // Title
    let title = 'Untitled';
    try {
      if (data[4] && typeof data[4] === 'string') {
        title = data[4];
      }
    } catch (e) { /* default */ }

    return {
      id: convId,
      title,
      messages,
      messageCount: messages.length,
      url: `https://gemini.google.com/app/${convId}`,
      exportedAt: new Date().toISOString(),
    };
  }

  // ---- File download via Blob URLs ----

  async function downloadFilesAsBlobs(files) {
    const filenames = Object.keys(files);
    let downloaded = 0;

    for (const filename of filenames) {
      const content = files[filename];
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();

      await new Promise((r) => setTimeout(r, 100));
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      downloaded++;
    }

    return { downloaded, total: filenames.length };
  }
})();
