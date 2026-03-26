// ============================================================
// Gemini Conversation Exporter - Background Service Worker
// Uses internal API via content script — no navigation needed
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
    return geminiTabId;
  }
  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: false });
  geminiTabId = tab.id;
  // Wait for load
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
  await sleep(2000);
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
  let md = `${sep}\nConversation: ${conv.title}\nMessages: ${conv.messageCount || conv.messages.length}\nURL: ${conv.url || ''}\n${sep}\n\n`;
  for (const msg of conv.messages) {
    const label = msg.role === 'user' ? '--- User ---' : '--- Gemini ---';
    md += `${label}\n\n${msg.content}\n\n`;
  }
  return md;
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

    // Step 1: Get conversation list via API
    let chatList = state.chatList || [];
    let exportedIds = state.exportedIds || [];
    let conversations = state.conversations || [];

    if (chatList.length === 0) {
      sendLog('Fetching conversation list via API...');

      const resp = await sendToContent(tabId, { action: 'apiListConversations', pageSize: 50 });
      if (resp?.error) {
        sendLog(`Error: ${resp.error}`);
        await setState({ running: false });
        return;
      }
      if (!resp?.conversations || resp.conversations.length === 0) {
        sendLog('No conversations found.');
        await setState({ running: false });
        return;
      }

      chatList = resp.conversations;
      await setState({ chatList });
      sendLog(`Found ${chatList.length} conversations via API.`);
    } else {
      sendLog(`Resuming: ${chatList.length} total, ${exportedIds.length} already exported.`);
    }

    // Step 2: Export each conversation via API (no navigation!)
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

      sendLog(`(${i + 1}/${chatList.length}) "${chat.title}"...`);
      await setState({
        currentTitle: `${chat.title} (${i + 1}/${chatList.length})`,
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
          sendLog(`  Skipped (no messages)`);
          skippedCount++;
          await setState({ skippedCount });
          continue;
        }

        // Use title from list if API didn't return one
        if (convData.title === 'Untitled' && chat.title !== 'Untitled') {
          convData.title = chat.title;
        }
        convData.url = `https://gemini.google.com/app/${convId}`;

        const baseName = safeName(convData.title, convId);
        sendLog(`  ${convData.messages.length} msgs → ${baseName}`);

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

        // Small delay to avoid rate limiting
        await sleep(500);
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
    sendLog('No saved data to download.');
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
  let mergedMd = `# Gemini Conversations Export\n\nTotal: ${conversations.length}\nDate: ${new Date().toISOString()}\n\n`;
  for (const conv of conversations) {
    mergedMd += conversationToMarkdown(conv) + '\n\n';
  }
  files['_all_conversations.md'] = mergedMd;

  try {
    await sendToContent(tabId, { action: 'downloadFiles', files });
    sendLog(`Downloaded ${conversations.length} conversations.`);
  } catch (err) {
    sendLog(`Download error: ${err.message}`);
  }
}
