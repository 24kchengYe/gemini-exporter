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
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim() || 'untitled';
  const idSuffix = convId ? '_' + convId.slice(0, 8) : '';
  return safe + idSuffix;
}

function extractConvId(url) {
  // URL like /app/abc123def or full URL
  const match = url.match(/\/app\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : url.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
}

function makeDataUrl(content, mimeType) {
  return `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);
}

function downloadFile(content, filename, mimeType) {
  return new Promise((resolve, reject) => {
    const url = makeDataUrl(content, mimeType);
    chrome.downloads.download(
      { url, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['exportedIds', 'urlList', 'running', 'cancelled', 'skippedCount', 'currentTitle', 'completed'],
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
  // Try to find an existing Gemini tab
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (tabs.length > 0) {
    geminiTabId = tabs[0].id;
    await chrome.tabs.update(geminiTabId, { active: true });
    sendLog('Using existing Gemini tab.');
    return geminiTabId;
  }
  // Create new tab
  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  geminiTabId = tab.id;
  await waitForTabLoad(geminiTabId);
  await sleep(3000);
  sendLog('Opened new Gemini tab.');
  return geminiTabId;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
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
  await sleep(3000); // wait for dynamic content
}

// ---- Content script messaging ----

async function sendToContent(tabId, message) {
  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    // Content script might already be there, ignore
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
    const label = msg.role === 'user' ? '--- User ---' : '--- Gemini ---';  // keep display label as Gemini
    md += `${label}\n\n${msg.content}\n\n`;
  }
  return md;
}

// ---- Main export flow ----

async function startExport() {
  const state = await getState();

  // If already running, bail
  if (state.running) {
    sendLog('Export already in progress.');
    return;
  }

  await setState({ running: true, cancelled: false, completed: false });

  try {
    const tabId = await ensureGeminiTab();

    // Step 1: Collect URLs (unless we already have them from a previous run)
    let urlList = state.urlList || [];
    let exportedIds = state.exportedIds || [];

    if (urlList.length === 0) {
      sendLog('Collecting conversation URLs from sidebar...');

      // Navigate to main page to see sidebar
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

    // Step 2: Export each conversation
    let skippedCount = state.skippedCount || 0;
    const allConversations = [];

    for (let i = 0; i < urlList.length; i++) {
      if (await isCancelled()) {
        sendLog('Export cancelled by user.');
        break;
      }

      const url = urlList[i];
      const convId = extractConvId(url);

      // Skip if already exported
      if (exportedIds.includes(convId)) {
        skippedCount++;
        continue;
      }

      const fullUrl = url.startsWith('http') ? url : `https://gemini.google.com${url}`;

      sendLog(`Exporting (${i + 1}/${urlList.length}): navigating...`);
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
          sendLog(`  Skipped (no messages found): ${fullUrl}`);
          skippedCount++;
          await setState({ skippedCount });
          sendProgress(await getState());
          continue;
        }

        const title = convData.title || 'Untitled';
        const baseName = safeName(title, convId);

        sendLog(`  "${title}" - ${convData.messages.length} messages`);
        await setState({ currentTitle: title });

        // Save individual JSON
        const jsonContent = JSON.stringify(convData, null, 2);
        await downloadFile(jsonContent, `gemini-export/${baseName}.json`, 'application/json');

        // Save individual MD
        const mdContent = conversationToMarkdown(convData);
        await downloadFile(mdContent, `gemini-export/${baseName}.md`, 'text/markdown');

        allConversations.push(convData);

        // Mark as exported
        exportedIds.push(convId);
        await setState({ exportedIds, skippedCount });
        sendProgress(await getState());

        // Random delay between conversations
        await randomDelay(3000, 6000);
      } catch (err) {
        sendLog(`  Error on ${fullUrl}: ${err.message}`);
        skippedCount++;
        await setState({ skippedCount });
        sendProgress(await getState());
        await sleep(2000);
      }
    }

    // Step 3: Generate merged files
    if (allConversations.length > 0 && !(await isCancelled())) {
      sendLog('Generating merged files...');

      const mergedJson = JSON.stringify(allConversations, null, 2);
      await downloadFile(mergedJson, 'gemini-export/_all_conversations.json', 'application/json');

      let mergedMd = `# Gemini Conversations Export\n\nTotal: ${allConversations.length} conversations\nDate: ${new Date().toISOString()}\n\n`;
      for (const conv of allConversations) {
        mergedMd += conversationToMarkdown(conv) + '\n\n';
      }
      await downloadFile(mergedMd, 'gemini-export/_all_conversations.md', 'text/markdown');

      sendLog(`Merged files saved (${allConversations.length} conversations).`);
    }

    const finalState = {
      running: false,
      completed: true,
      currentTitle: '',
    };
    await setState(finalState);
    const s = await getState();
    chrome.runtime.sendMessage({ type: 'done', state: s }).catch(() => {});
    sendLog(`Export finished. ${exportedIds.length} exported, ${skippedCount} skipped.`);
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
  }
  return true; // keep channel open for async
});
