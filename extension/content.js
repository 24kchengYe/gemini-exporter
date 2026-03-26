// ============================================================
// Gemini Conversation Exporter - Content Script
// Hybrid: sidebar DOM for conversation list + API for content
// ============================================================

(function () {
  // Always re-register message handler (allows code updates without page reload)
  // Remove old listener if exists
  if (window.__geminiExporterListener) {
    try { chrome.runtime.onMessage.removeListener(window.__geminiExporterListener); } catch(e) {}
  }

  function messageHandler(msg, sender, sendResponse) {
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
  }

  window.__geminiExporterListener = messageHandler;
  chrome.runtime.onMessage.addListener(messageHandler);

  // ---- Sidebar URL collection (DOM) ----

  async function collectUrls() {
    const allLinks = () => {
      const anchors = document.querySelectorAll('a[href*="/app/"]');
      const result = new Map(); // href -> title
      anchors.forEach((a) => {
        const href = a.getAttribute('href');
        if (href && /\/app\/[a-zA-Z0-9]/.test(href) && !href.includes('SignOut')) {
          if (!result.has(href)) {
            // Get title from innerText, strip "Pinned chat" / "Shared" suffixes
            var rawText = (a.innerText || '').trim();
            var title = rawText.split('\n')[0].trim();  // first line only
            if (title.length < 2) title = '';
            result.set(href, title);
          }
        }
      });
      return result;
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

    const linkMap = allLinks();
    const urls = Array.from(linkMap.keys());
    const titles = {};
    linkMap.forEach(function(title, href) { titles[href] = title; });
    return { urls, titles, count: urls.length };
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

    if (!resp.ok) throw new Error(`API ${resp.status} ${resp.statusText}`);
    // Check for redirect to /sorry (rate limiting)
    if (resp.url && resp.url.includes('/sorry')) throw new Error('Rate limited by Google. Wait a few minutes.');

    const text = await resp.text();
    return parseConversationResponse(text, convId);
  }

  function parseConversationResponse(rawText, convId) {
    // Find the wrb.fr marker
    const marker = '"wrb.fr","hNvQHb","';
    const idx = rawText.indexOf(marker);
    if (idx < 0) return { error: 'No hNvQHb data in response', messages: [] };

    // Find the [ before the marker
    let bracketStart = idx;
    while (bracketStart > 0 && rawText[bracketStart] !== '[') bracketStart--;

    // Search for ,"generic"] closings and try to parse
    // This is the same approach that worked in the Snippet test
    var searchPos = idx + marker.length;
    for (var attempt = 0; attempt < 50; attempt++) {
      var gi = rawText.indexOf(',"generic"', searchPos);
      if (gi < 0) break;

      var cb = rawText.indexOf(']', gi + 10);
      if (cb >= 0) {
        var candidate = rawText.substring(bracketStart, cb + 1);
        try {
          var arr = JSON.parse(candidate);
          if (arr[0] === 'wrb.fr' && arr[1] === 'hNvQHb' && typeof arr[2] === 'string') {
            var parsed = JSON.parse(arr[2]);
            return extractMessagesFromParsed(parsed, convId);
          }
        } catch (e) {
          // Not the right closing, keep searching
        }
      }
      searchPos = gi + 1;
    }

    return { error: 'Failed to parse hNvQHb payload after ' + attempt + ' attempts', messages: [] };
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

      // Model response: turn[3][0][0] = selected candidate (extra nesting layer)
      try {
        const candidate = turn[3]?.[0]?.[0];
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

    // Title: use first user message
    let title = 'Untitled';
    if (messages.length > 0 && messages[0].role === 'user') {
      title = messages[0].content.slice(0, 80).replace(/\n/g, ' ').trim();
    }

    // Timestamps from turn[4][0] (Unix seconds)
    let createdAt = null;
    let lastMessageAt = null;
    try {
      var firstTurn = turns[0];
      if (firstTurn && firstTurn[4] && firstTurn[4][0]) {
        createdAt = new Date(firstTurn[4][0] * 1000).toISOString();
      }
      var lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn[4] && lastTurn[4][0]) {
        lastMessageAt = new Date(lastTurn[4][0] * 1000).toISOString();
      }
    } catch (e) { /* skip */ }

    return {
      id: convId,
      title,
      messages,
      messageCount: messages.length,
      url: `https://gemini.google.com/app/${convId}`,
      createdAt,
      lastMessageAt,
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
