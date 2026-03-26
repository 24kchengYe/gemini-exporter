// ============================================================
// Gemini Conversation Exporter - Background Service Worker
// Hybrid: sidebar DOM for list + batchexecute API for content
// ============================================================

let geminiTabId = null;

// ---- Helpers ----

function sendLog(text) {
  chrome.runtime.sendMessage({ type: 'log', text }).catch(() => {});
}

function sendProgress(state) {
  chrome.runtime.sendMessage({ type: 'progress', state }).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeName(title, convId) {
  const safe = title.replace(/[\\/:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').slice(0, 60).trim() || 'untitled';
  const idSuffix = convId ? '_' + convId.slice(0, 8) : '';
  return safe + idSuffix;
}

function extractConvId(url) {
  const match = url.match(/\/app\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : url.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['exportedIds', 'chatList', 'running', 'cancelled', 'skippedCount', 'currentTitle', 'completed', 'conversations'],
      resolve
    );
  });
}

async function setState(patch) {
  return new Promise((resolve) => chrome.storage.local.set(patch, resolve));
}

async function isCancelled() {
  const s = await getState();
  return !!s.cancelled;
}

// ---- Tab management ----

async function ensureGeminiTab() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (tabs.length > 0) {
    geminiTabId = tabs[0].id;
    await chrome.tabs.update(geminiTabId, { active: true });
    return geminiTabId;
  }
  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  geminiTabId = tab.id;
  await new Promise((resolve) => {
    function listener(id, info) {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 15000);
  });
  await sleep(3000);
  return geminiTabId;
}

async function sendToContent(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) { /* already injected */ }
  await sleep(300);

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ---- Markdown formatter ----

function conversationToMarkdown(conv) {
  const sep = '============================================================';
  let header = `${sep}\nConversation: ${conv.title}\nMessages: ${conv.messageCount || conv.messages.length}`;
  if (conv.createdAt) header += `\nCreated: ${conv.createdAt}`;
  if (conv.lastMessageAt) header += `\nLast message: ${conv.lastMessageAt}`;
  header += `\nURL: ${conv.url || ''}\n${sep}\n\n`;
  let md = header;
  for (const msg of conv.messages) {
    const label = msg.role === 'user' ? '--- User ---' : '--- Gemini ---';
    md += `${label}\n\n${msg.content}\n\n`;
  }
  return md;
}

function datePrefix(isoStr) {
  if (!isoStr) return '';
  return isoStr.slice(0, 10).replace(/-/g, ''); // "20260116"
}

// ---- Main export flow ----

async function startExport() {
  const state = await getState();

  if (state.running) {
    sendLog('Export already in progress.');
    return;
  }

  await setState({ running: true, cancelled: false, completed: false });

  try {
    const tabId = await ensureGeminiTab();
    sendLog('Connected to Gemini tab.');

    // Step 1: Get conversation list from sidebar DOM (or resume)
    let chatList = state.chatList || [];
    let exportedIds = state.exportedIds || [];
    let conversations = state.conversations || [];

    if (chatList.length === 0) {
      sendLog('Scrolling sidebar to collect conversations...');

      const resp = await sendToContent(tabId, { action: 'collectUrls' });
      if (resp?.error) {
        sendLog(`Error: ${resp.error}`);
        await setState({ running: false });
        return;
      }
      if (!resp?.urls || resp.urls.length === 0) {
        sendLog('No conversations found in sidebar.');
        await setState({ running: false });
        return;
      }

      // Convert URLs to chat list format (with titles from sidebar)
      const sidebarTitles = resp.titles || {};
      chatList = resp.urls.map(url => ({
        id: extractConvId(url),
        url,
        sidebarTitle: sidebarTitles[url] || '',
      }));
      await setState({ chatList });
      sendLog(`Found ${chatList.length} conversations. Now fetching via API...`);
    } else {
      sendLog(`Resuming: ${chatList.length} total, ${exportedIds.length} done.`);
    }

    // Step 2: Fetch each conversation via API (no navigation!)
    let skippedCount = state.skippedCount || 0;

    for (let i = 0; i < chatList.length; i++) {
      if (await isCancelled()) {
        sendLog('Cancelled by user.');
        break;
      }

      const chat = chatList[i];
      const convId = chat.id;

      if (exportedIds.includes(convId)) {
        skippedCount++;
        continue;
      }

      sendLog(`(${i + 1}/${chatList.length}) Fetching ${convId.slice(0, 8)}...`);
      await setState({
        currentTitle: `(${i + 1}/${chatList.length}) Loading...`,
        skippedCount,
      });
      sendProgress(await getState());

      try {
        const convData = await sendToContent(tabId, { action: 'apiGetConversation', convId });

        if (convData?.error) {
          sendLog(`  Error: ${convData.error}`);
          skippedCount++;
          await setState({ skippedCount });
          continue;
        }

        if (!convData?.messages || convData.messages.length === 0) {
          sendLog(`  Skipped (empty)`);
          skippedCount++;
          await setState({ skippedCount });
          continue;
        }

        // Title priority: sidebar title > API title (first user msg) > Untitled
        if (chat.sidebarTitle) {
          convData.title = chat.sidebarTitle;
        }
        const title = convData.title || 'Untitled';
        // Filename: date_title_id
        const dp = datePrefix(convData.createdAt);
        const baseName = (dp ? dp + '_' : '') + safeName(title, convId);
        sendLog(`  "${title}" — ${convData.messages.length} msgs`);
        await setState({ currentTitle: title });

        // Download immediately
        const jsonContent = JSON.stringify(convData, null, 2);
        const mdContent = conversationToMarkdown(convData);
        await sendToContent(tabId, {
          action: 'downloadFiles',
          files: {
            [`${baseName}.json`]: jsonContent,
            [`${baseName}.md`]: mdContent,
          },
        });

        conversations.push(convData);
        exportedIds.push(convId);
        await setState({ exportedIds, skippedCount, conversations });
        sendProgress(await getState());

        // Delay between requests to avoid rate limiting
        await sleep(1500);
      } catch (err) {
        sendLog(`  Error: ${err.message.slice(0, 80)}`);
        skippedCount++;
        await setState({ skippedCount });
        await sleep(1000);
      }
    }

    // Step 3: Download merged files
    if (conversations.length > 0 && !(await isCancelled())) {
      sendLog('Generating merged files...');

      const mergedFiles = {};
      mergedFiles['_all_conversations.json'] = JSON.stringify(conversations, null, 2);

      let mergedMd = `# Gemini Conversations Export\n\nTotal: ${conversations.length} conversations\nDate: ${new Date().toISOString()}\n\n`;
      for (const conv of conversations) {
        mergedMd += conversationToMarkdown(conv) + '\n\n';
      }
      mergedFiles['_all_conversations.md'] = mergedMd;
      mergedFiles['_urls_index.json'] = JSON.stringify(chatList, null, 2);

      try {
        await sendToContent(tabId, { action: 'downloadFiles', files: mergedFiles });
        sendLog('Merged files saved.');
      } catch (err) {
        sendLog(`Merged download error: ${err.message}`);
      }
    }

    await setState({ running: false, completed: true, currentTitle: '' });
    const s = await getState();
    chrome.runtime.sendMessage({ type: 'done', state: s }).catch(() => {});
    sendLog(`Done! ${exportedIds.length} exported, ${skippedCount} skipped.`);
  } catch (err) {
    sendLog(`Fatal error: ${err.message}`);
    chrome.runtime.sendMessage({ type: 'error', text: err.message }).catch(() => {});
    await setState({ running: false });
  }
}

// ---- Message listener ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startExport') {
    startExport();
    sendResponse({ ok: true });
  } else if (msg.action === 'cancelExport') {
    setState({ cancelled: true, running: false });
    sendResponse({ ok: true });
  } else if (msg.action === 'resetExport') {
    chrome.storage.local.remove(
      ['exportedIds', 'chatList', 'skippedCount', 'currentTitle', 'running', 'completed', 'cancelled', 'conversations'],
      () => sendResponse({ ok: true })
    );
  } else if (msg.action === 'downloadSaved') {
    downloadSavedData();
    sendResponse({ ok: true });
  }
  return true;
});

async function downloadSavedData() {
  const state = await getState();
  const conversations = state.conversations || [];
  if (conversations.length === 0) {
    sendLog('No saved data.');
    return;
  }
  const tabId = await ensureGeminiTab();
  await sleep(500);

  const files = {};
  for (const conv of conversations) {
    const name = safeName(conv.title || 'Untitled', conv.id);
    files[`${name}.json`] = JSON.stringify(conv, null, 2);
    files[`${name}.md`] = conversationToMarkdown(conv);
  }
  files['_all_conversations.json'] = JSON.stringify(conversations, null, 2);
  let md = `# Gemini Export\n\nTotal: ${conversations.length}\n\n`;
  for (const conv of conversations) md += conversationToMarkdown(conv) + '\n\n';
  files['_all_conversations.md'] = md;

  try {
    await sendToContent(tabId, { action: 'downloadFiles', files });
    sendLog(`Downloaded ${conversations.length} conversations.`);
  } catch (err) {
    sendLog(`Download error: ${err.message}`);
  }
}
