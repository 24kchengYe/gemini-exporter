// ============================================================
// Gemini Internal API Client
// Extracts tokens from page, calls batchexecute RPCs directly
// ============================================================

const BATCHEXECUTE_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

// RPC IDs
const RPC_LIST_CHATS = 'MaZiqc';
const RPC_READ_CHAT = 'hNvQHb';

let _tokens = null;
let _reqId = Math.floor(Math.random() * 900000) + 100000;

// ---- Token extraction ----

function extractTokenFromHtml(html, key) {
  // Match patterns like "SNlM0e":"value" or "cfb2h":"value"
  const patterns = [
    new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`),
    new RegExp(`${key}.*?"([^"]+)"`),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

async function getTokens() {
  if (_tokens) return _tokens;

  const resp = await fetch('https://gemini.google.com/app', {
    credentials: 'include',
    headers: { 'Accept': 'text/html' },
  });
  const html = await resp.text();

  const at = extractTokenFromHtml(html, 'SNlM0e');
  const bl = extractTokenFromHtml(html, 'cfb2h');
  const sid = extractTokenFromHtml(html, 'FdrFJe');
  const hl = extractTokenFromHtml(html, 'TuX5cc') || 'en';

  if (!at) throw new Error('Failed to extract SNlM0e token. Are you logged in?');
  if (!bl) throw new Error('Failed to extract cfb2h token.');

  _tokens = { at, bl, sid, hl };
  return _tokens;
}

function clearTokens() {
  _tokens = null;
}

// ---- batchexecute call ----

async function batchExecute(rpcId, payload) {
  const tokens = await getTokens();
  _reqId += 1;

  const fReq = JSON.stringify([[
    [rpcId, JSON.stringify(payload), null, 'generic']
  ]]);

  const params = new URLSearchParams({
    'rpcids': rpcId,
    'source-path': '/app',
    'hl': tokens.hl,
    '_reqid': String(_reqId),
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
    throw new Error(`batchexecute failed: ${resp.status} ${resp.statusText}`);
  }

  const text = await resp.text();
  return parseResponse(text, rpcId);
}

// ---- Response parsing ----

function parseResponse(rawText, rpcId) {
  // Strip )]}' prefix
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
    } catch (e) {
      // skip unparseable frames
    }
  }

  // Find the frame with our rpcId
  for (const frame of frames) {
    const payload = findRpcPayload(frame, rpcId);
    if (payload !== null) {
      try {
        return JSON.parse(payload);
      } catch (e) {
        return payload;
      }
    }
  }

  return null;
}

function findRpcPayload(node, rpcId) {
  if (!Array.isArray(node)) return null;

  // Check if this is a wrb.fr entry: ["wrb.fr", "rpcId", "payload_json", ...]
  if (node[0] === 'wrb.fr' && node[1] === rpcId && typeof node[2] === 'string') {
    return node[2];
  }

  // Recurse into children
  for (const child of node) {
    const result = findRpcPayload(child, rpcId);
    if (result !== null) return result;
  }

  return null;
}

// ---- High-level API ----

async function listConversations(pageSize = 50, pinnedOnly = false) {
  const allChats = [];
  let nextToken = null;

  // Fetch both pinned and non-pinned
  for (const pinFlag of (pinnedOnly ? [1] : [1, 0])) {
    nextToken = null;
    do {
      const payload = [pageSize, nextToken, [pinFlag, null, 1]];
      const data = await batchExecute(RPC_LIST_CHATS, payload);

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

      // Pagination token
      nextToken = data[1] || null;
    } while (nextToken);
  }

  // Deduplicate by id
  const seen = new Set();
  return allChats.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

async function getConversation(convId) {
  const payload = [convId, 1000, null, 1, [1], [4], null, 1];
  const data = await batchExecute(RPC_READ_CHAT, payload);

  if (!data) return null;

  const messages = [];
  const turns = data[0] || [];

  for (const turn of turns) {
    if (!Array.isArray(turn)) continue;

    // User message
    try {
      const userText = turn[2]?.[0]?.[0];
      if (userText && typeof userText === 'string') {
        messages.push({ role: 'user', content: userText });
      }
    } catch (e) { /* skip */ }

    // Model response - get the first (selected) candidate
    try {
      const candidates = turn[3]?.[0];
      if (Array.isArray(candidates)) {
        // candidates[1][0] is the text content
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

  // Title from conversation metadata
  let title = 'Untitled';
  try {
    // Title might be at data[4] or from the turns
    if (data[4] && typeof data[4] === 'string') {
      title = data[4];
    }
  } catch (e) { /* use default */ }

  return {
    id: convId,
    title,
    messages,
    messageCount: messages.length,
    exportedAt: new Date().toISOString(),
  };
}

// Export for use by content script
if (typeof window !== 'undefined') {
  window.__geminiApi = {
    getTokens,
    clearTokens,
    listConversations,
    getConversation,
    batchExecute,
  };
}
