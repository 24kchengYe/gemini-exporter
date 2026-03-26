// ============================================================
// Gemini Conversation Exporter - Content Script
// Hybrid: sidebar DOM for conversation list + API for content
// ============================================================

(function () {
  if (window.__geminiExporterInjected) return;
  window.__geminiExporterInjected = true;

  // ---- Message handler ----

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'collectUrls') {
      collectUrls()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message, urls: [] }));
      return true;
    }

    if (msg.action === 'apiGetConversation') {
      apiGetConversation(msg.convId)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message, messages: [] }));
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

  // ---- Sidebar URL collection (DOM) ----

  async function collectUrls() {
    const allLinks = () => {
      const anchors = document.querySelectorAll('a[href*="/app/"]');
      const urls = new Set();
      anchors.forEach((a) => {
        const href = a.getAttribute('href');
        if (href && /\/app\/[a-zA-Z0-9]/.test(href) && !href.includes('SignOut')) {
          urls.add(href);
        }
      });
      return urls;
    };

    // Find scrollable sidebar
    function findSidebarScroller() {
      const firstLink = document.querySelector('a[href^="/app/"]');
      if (firstLink) {
        let parent = firstLink.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 50) {
            return parent;
          }
          parent = parent.parentElement;
        }
      }
      return null;
    }

    const scroller = findSidebarScroller();
    let prevCount = 0;
    let stableRounds = 0;
    const maxStableRounds = 12;

    if (scroller) {
      for (let i = 0; i < 200; i++) {
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise((r) => setTimeout(r, 1500));

        const currentCount = allLinks().size;
        if (currentCount === prevCount) {
          stableRounds++;
          if (stableRounds >= maxStableRounds) break;
        } else {
          stableRounds = 0;
          prevCount = currentCount;
        }
      }
      scroller.scrollTop = 0;
    }

    const urls = Array.from(allLinks());
    return { urls, count: urls.length };
  }

  // ---- Token extraction ----

  let _cachedTokens = null;

  function extractTokens() {
    if (_cachedTokens) return _cachedTokens;

    const html = document.documentElement.innerHTML;

    function extract(key) {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      return m ? m[1] : null;
    }

    const at = extract('SNlM0e');
    const bl = extract('cfb2h');
    if (!at) return null;

    _cachedTokens = { at, bl };
    return _cachedTokens;
  }

  // ---- API: Get single conversation via hNvQHb ----

  async function apiGetConversation(convId) {
    const tokens = extractTokens();
    if (!tokens) throw new Error('Token extraction failed. Are you logged in?');

    // Ensure c_ prefix
    const fullId = convId.startsWith('c_') ? convId : 'c_' + convId;

    const fReq = JSON.stringify([[
      ['hNvQHb', JSON.stringify([fullId, 1000, null, 1, [1], [4], null, 1]), null, 'generic']
    ]]);

    const params = new URLSearchParams({
      rpcids: 'hNvQHb',
      'source-path': '/app',
      hl: 'en',
      rt: 'c',
    });
    if (tokens.bl) params.set('bl', tokens.bl);

    const body = new URLSearchParams({
      at: tokens.at,
      'f.req': fReq,
    });

    const resp = await fetch(
      `https://gemini.google.com/_/BardChatUi/data/batchexecute?${params}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body: body.toString(),
      }
    );

    if (!resp.ok) throw new Error(`API ${resp.status}`);

    const text = await resp.text();
    return parseConversationResponse(text, convId);
  }

  function parseConversationResponse(rawText, convId) {
    // The hNvQHb payload is a JSON string embedded inside the wrb.fr array.
    // Format: ["wrb.fr","hNvQHb","<escaped_json_payload>","generic"]
    // The payload itself is a JSON-escaped string that we need to unescape and parse.

    // Step 1: Find the payload start after "wrb.fr","hNvQHb","
    const marker = '"wrb.fr","hNvQHb","';
    const idx = rawText.indexOf(marker);
    if (idx < 0) return { error: 'No hNvQHb data in response', messages: [] };
    const payloadStart = idx + marker.length;

    // Step 2: The payload is embedded in outer JSON as ["wrb.fr","hNvQHb","PAYLOAD","generic"]
    // So we extract by wrapping it: parse the surrounding array from ["wrb.fr"...
    // Find the start of the outer array containing this wrb.fr
    let bracketStart = idx;
    while (bracketStart > 0 && rawText[bracketStart] !== '[') bracketStart--;

    // Find the matching end — look for ,"generic"] after the payload
    // Search for the pattern: ","generic"] which closes this entry
    const genericMarker = ',"generic"';
    let searchPos = payloadStart;
    let genericIdx = -1;

    // Find ","generic" that is NOT inside the escaped payload string
    // The payload string ends at an unescaped quote before ,"generic"
    while (searchPos < rawText.length) {
      const gIdx = rawText.indexOf(genericMarker, searchPos);
      if (gIdx < 0) break;

      // Check that the quote before ","generic" is the closing quote of the payload
      // by verifying it's preceded by an even number of backslashes (unescaped quote)
      let backslashes = 0;
      let checkPos = gIdx - 1;
      while (checkPos >= 0 && rawText[checkPos] === '\\') { backslashes++; checkPos--; }

      if (backslashes % 2 === 0 && rawText[gIdx - 1] === '"') {
        // This could be our closing. But we need to verify it's not inside escaped content.
        // Try to parse the wrb.fr array from bracketStart to after "]"
        const closeBracket = rawText.indexOf(']', gIdx + genericMarker.length);
        if (closeBracket >= 0) {
          const outerStr = rawText.substring(bracketStart, closeBracket + 1);
          try {
            const outerArr = JSON.parse(outerStr);
            // outerArr should be ["wrb.fr","hNvQHb","<payload_json_string>","generic"]
            if (outerArr[0] === 'wrb.fr' && outerArr[1] === 'hNvQHb' && typeof outerArr[2] === 'string') {
              const parsed = JSON.parse(outerArr[2]);
              return extractMessagesFromParsed(parsed, convId);
            }
          } catch (e) {
            // Not the right closing, keep searching
          }
        }
      }
      searchPos = gIdx + 1;
    }

    return { error: 'Failed to parse hNvQHb payload', messages: [] };
  }

  function extractMessagesFromParsed(parsed, convId) {
    if (!parsed || !Array.isArray(parsed)) {
      return { error: 'Invalid response structure', messages: [] };
    }

    if (!parsed || !Array.isArray(parsed)) {
      return { error: 'Invalid response structure', messages: [] };
    }

    // Extract messages from parsed conversation data
    const messages = [];
    const turns = parsed[0] || [];

    for (const turn of turns) {
      if (!Array.isArray(turn)) continue;

      // User message: turn[2][0][0]
      try {
        const userParts = turn[2]?.[0];
        if (Array.isArray(userParts)) {
          const userText = userParts[0];
          if (userText && typeof userText === 'string') {
            messages.push({ role: 'user', content: userText });
          }
        }
      } catch (e) { /* skip */ }

      // Model response: turn[3][0] = selected candidate
      try {
        const candidate = turn[3]?.[0];
        if (Array.isArray(candidate)) {
          const parts = candidate[1];
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
      if (parsed[4] && typeof parsed[4] === 'string') {
        title = parsed[4];
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

  // ---- Helper: find wrb.fr payload in nested array ----

  function findWrbFr(node, rpcId) {
    if (!Array.isArray(node)) return null;
    if (node[0] === 'wrb.fr' && node[1] === rpcId) return node[2];
    for (const child of node) {
      const r = findWrbFr(child, rpcId);
      if (r !== null) return r;
    }
    return null;
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
