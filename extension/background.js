// ============================================================
// Gemini Conversation Exporter - Background Service Worker
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

function randomDelay(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
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
      ['exportedIds', 'urlList', 'running', 'cancelled', 'skippedCount', 'currentTitle', 'completed', 'conversations'],
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
    sendLog('Using existing Gemini tab.');
    return geminiTabId;
  }
  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  geminiTabId = tab.id;
  await waitForTabLoad(geminiTabId);
  await sleep(3000);
  sendLog('Opened new Gemini tab.');
  return geminiTabId;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway after timeout
    }, 30000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateAndWait(tabId, url) {
  const loadPromise = waitForTabLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  await loadPromise;
  await sleep(3000);
}

// ---- Content script messaging ----

async function sendToContent(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    // Content script might already be there
  }
  await sleep(500);

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
  let md = `${sep}\nConversation: ${conv.title}\nMessages: ${conv.messages.length}\nURL: ${conv.url}\n${sep}\n\n`;
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

    // Step 1: Collect URLs
    let urlList = state.urlList || [];
    let exportedIds = state.exportedIds || [];
    let conversations = state.conversations || [];

    if (urlList.length === 0) {
      sendLog('Collecting conversation URLs from sidebar...');
      await navigateAndWait(tabId, 'https://gemini.google.com/app');
      await sleep(2000);

      const resp = await sendToContent(tabId, { action: 'collectUrls' });
      if (!resp || !resp.urls || resp.urls.length === 0) {
        sendLog('No conversations found in sidebar.');
        await setState({ running: false });
        return;
      }

      urlList = resp.urls;
      await setState({ urlList });
      sendLog(`Found ${urlList.length} conversations.`);
    } else {
      sendLog(`Resuming with ${urlList.length} URLs, ${exportedIds.length} already exported.`);
    }

    // Step 2: Export each conversation (store data in memory, not download yet)
    let skippedCount = state.skippedCount || 0;

    for (let i = 0; i < urlList.length; i++) {
      if (await isCancelled()) {
        sendLog('Export cancelled by user.');
        break;
      }

      const url = urlList[i];
      const convId = extractConvId(url);

      if (exportedIds.includes(convId)) {
        skippedCount++;
        continue;
      }

      const fullUrl = url.startsWith('http') ? url : `https://gemini.google.com${url}`;

      sendLog(`(${i + 1}/${urlList.length}) Navigating...`);
      await setState({
        currentTitle: `Loading... (${i + 1}/${urlList.length})`,
        skippedCount,
      });
      sendProgress(await getState());

      try {
        await navigateAndWait(tabId, fullUrl);
        await sleep(2000);

        const convData = await sendToContent(tabId, { action: 'extractConversation', url: fullUrl });

        if (!convData || !convData.messages || convData.messages.length === 0) {
          sendLog(`  Skipped (no messages): ${convId.slice(0, 8)}`);
          skippedCount++;
          await setState({ skippedCount });
          sendProgress(await getState());
          continue;
        }

        const title = convData.title || 'Untitled';
        const baseName = safeName(title, convId);
        convData.id = convId;
        convData.baseName = baseName;

        sendLog(`  "${title}" - ${convData.messages.length} msgs`);
        await setState({ currentTitle: title });

        // Download immediately via content script Blob URLs
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
        await setState({ exportedIds, skippedCount });
        sendProgress(await getState());

        await randomDelay(3000, 6000);
      } catch (err) {
        sendLog(`  Error: ${err.message.slice(0, 80)}`);
        skippedCount++;
        await setState({ skippedCount });
        sendProgress(await getState());
        await sleep(2000);
      }
    }

    // Save conversations to storage
    await setState({ conversations, skippedCount });

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
      mergedFiles['_urls_index.json'] = JSON.stringify(urlList, null, 2);

      await navigateAndWait(tabId, 'https://gemini.google.com/app');
      await sleep(1000);

      try {
        await sendToContent(tabId, { action: 'downloadFiles', files: mergedFiles });
        sendLog('Merged files downloaded.');
      } catch (err) {
        sendLog(`Merged download error: ${err.message}`);
      }
    }

    await setState({
      running: false,
      completed: true,
      currentTitle: '',
    });
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
      ['exportedIds', 'urlList', 'skippedCount', 'currentTitle', 'running', 'completed', 'cancelled', 'conversations'],
      () => sendResponse({ ok: true })
    );
  } else if (msg.action === 'downloadSaved') {
    // Re-trigger download of saved data
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
  await sleep(1000);

  const files = {};
  for (const conv of conversations) {
    const name = conv.baseName || safeName(conv.title || 'Untitled', conv.id);
    files[`${name}.json`] = JSON.stringify(conv, null, 2);
    files[`${name}.md`] = conversationToMarkdown(conv);
  }
  files['_all_conversations.json'] = JSON.stringify(conversations, null, 2);
  let mergedMd = `# Gemini Conversations Export\n\nTotal: ${conversations.length}\nDate: ${new Date().toISOString()}\n\n`;
  for (const conv of conversations) {
    mergedMd += conversationToMarkdown(conv) + '\n\n';
  }
  files['_all_conversations.md'] = mergedMd;
  files['_urls_index.json'] = JSON.stringify(state.urlList || [], null, 2);

  try {
    await sendToContent(tabId, { action: 'downloadFiles', files });
    sendLog(`Downloaded ${conversations.length} conversations.`);
  } catch (err) {
    sendLog(`Download error: ${err.message}`);
  }
}
