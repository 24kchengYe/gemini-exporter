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
        await setState({ exportedIds, skippedCount });
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

// ---- Gems export flow ----

function gemToMarkdown(gem) {
  const sep = '============================================================';
  let md = `${sep}\n`;
  md += `# ${gem.name}\n\n`;
  if (gem.description) md += `**Description:** ${gem.description}\n\n`;
  md += `**Type:** ${gem.isCustom ? 'Custom' : 'System/Predefined'}\n`;
  md += `**ID:** ${gem.id}\n`;
  md += `**Exported:** ${gem.exportedAt}\n\n`;
  if (gem.prompt) {
    md += `## System Instructions\n\n${gem.prompt}\n\n`;
  }
  md += `${sep}\n\n`;
  return md;
}

async function startGemsExport() {
  const state = await getState();
  if (state.running) {
    sendLog('Export already in progress.');
    return;
  }

  await setState({ running: true, cancelled: false, completed: false });

  try {
    const tabId = await ensureGeminiTab();
    sendLog('Connected to Gemini tab.');
    sendLog('Fetching Gems via API...');

    const result = await sendToContent(tabId, { action: 'apiListGems' });

    if (result?.error) {
      sendLog(`Error: ${result.error}`);
      await setState({ running: false });
      return;
    }

    const gems = result?.gems || [];
    if (gems.length === 0) {
      sendLog('No Gems found.');
      await setState({ running: false, completed: true });
      return;
    }

    const customGems = gems.filter(g => g.isCustom);
    const systemGems = gems.filter(g => !g.isCustom);
    sendLog(`Found ${gems.length} Gems (${customGems.length} custom, ${systemGems.length} system).`);

    // Download individual Gem files
    const files = {};

    for (const gem of gems) {
      const prefix = gem.isCustom ? 'custom' : 'system';
      const name = safeName(gem.name, gem.id);
      files[`gems/${prefix}_${name}.json`] = JSON.stringify(gem, null, 2);
      files[`gems/${prefix}_${name}.md`] = gemToMarkdown(gem);
    }

    // Merged files
    files['gems/_all_gems.json'] = JSON.stringify(gems, null, 2);

    let mergedMd = `# Gemini Gems Export\n\nTotal: ${gems.length} (${customGems.length} custom, ${systemGems.length} system)\nDate: ${new Date().toISOString()}\n\n`;
    mergedMd += '## Custom Gems\n\n';
    for (const gem of customGems) mergedMd += gemToMarkdown(gem);
    if (systemGems.length > 0) {
      mergedMd += '## System/Predefined Gems\n\n';
      for (const gem of systemGems) mergedMd += gemToMarkdown(gem);
    }
    files['gems/_all_gems.md'] = mergedMd;

    // Summary index
    const index = gems.map(g => ({
      id: g.id,
      name: g.name,
      isCustom: g.isCustom,
      hasPrompt: !!g.prompt,
      descriptionPreview: (g.description || '').slice(0, 100),
    }));
    files['gems/_gems_index.json'] = JSON.stringify(index, null, 2);

    sendLog(`Downloading ${Object.keys(files).length} files...`);
    await sendToContent(tabId, { action: 'downloadFiles', files });

    await setState({ running: false, completed: true, currentTitle: '' });
    chrome.runtime.sendMessage({ type: 'done', state: await getState() }).catch(() => {});
    sendLog(`Done! Exported ${gems.length} Gems.`);
  } catch (err) {
    sendLog(`Fatal error: ${err.message}`);
    chrome.runtime.sendMessage({ type: 'error', text: err.message }).catch(() => {});
    await setState({ running: false });
  }
}

// ---- My Stuff export flow ----

async function startMyStuffExport() {
  const state = await getState();
  if (state.running) {
    sendLog('Export already in progress.');
    return;
  }

  await setState({ running: true, cancelled: false, completed: false });

  try {
    // Step 1: Navigate to /mystuff/documents
    sendLog('Navigating to My Stuff documents...');
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    let tabId;
    if (tabs.length > 0) {
      tabId = tabs[0].id;
      await chrome.tabs.update(tabId, { url: 'https://gemini.google.com/mystuff/documents', active: true });
    } else {
      const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/mystuff/documents', active: true });
      tabId = tab.id;
    }

    // Wait for page load
    await new Promise((resolve) => {
      function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 15000);
    });
    await sleep(3000);
    geminiTabId = tabId;

    sendLog('Collecting documents from DOM...');
    const result = await sendToContent(tabId, { action: 'collectMyStuff' });

    if (result?.error) {
      sendLog('Error: ' + result.error);
      await setState({ running: false });
      return;
    }

    const docs = result?.documents || [];
    const media = result?.media || [];
    sendLog('Found ' + docs.length + ' documents, ' + media.length + ' media items.');

    const files = {};

    // Export documents
    for (const doc of docs) {
      const name = safeName(doc.title, '');
      const docMd = `# ${doc.title}\n\n**Date:** ${doc.date || 'Unknown'}\n\n${doc.preview}\n`;
      files['mystuff_docs_' + name + '.md'] = docMd;
      files['mystuff_docs_' + name + '.json'] = JSON.stringify(doc, null, 2);
    }

    // Export media URLs
    if (media.length > 0) {
      const mediaIndex = media.map((m, i) => ({
        index: i + 1,
        thumbnail: m.thumbnail,
        fullSize: m.fullSize,
        alt: m.alt,
      }));
      files['mystuff_media_index.json'] = JSON.stringify(mediaIndex, null, 2);

      let mediaMd = '# Gemini Media Export\n\nTotal: ' + media.length + ' images\n\n';
      media.forEach(function(m, i) {
        mediaMd += '## Image ' + (i + 1) + '\n\n';
        mediaMd += '- Full size: ' + m.fullSize + '\n';
        mediaMd += '- Thumbnail: ' + m.thumbnail + '\n\n';
      });
      files['mystuff_media_index.md'] = mediaMd;
    }

    // Merged summary
    files['mystuff__mystuff_summary.json'] = JSON.stringify({
      documents: docs,
      mediaCount: media.length,
      exportedAt: new Date().toISOString(),
    }, null, 2);

    let summaryMd = '# Gemini My Stuff Export\n\n';
    summaryMd += 'Date: ' + new Date().toISOString() + '\n';
    summaryMd += 'Documents: ' + docs.length + '\n';
    summaryMd += 'Media: ' + media.length + '\n\n';
    summaryMd += '## Documents\n\n';
    for (const doc of docs) {
      summaryMd += '### ' + doc.title + '\n';
      summaryMd += '*' + (doc.date || 'Unknown date') + '*\n\n';
      summaryMd += doc.preview + '\n\n---\n\n';
    }
    files['mystuff__mystuff_summary.md'] = summaryMd;

    sendLog('Downloading ' + Object.keys(files).length + ' files...');
    await sendToContent(tabId, { action: 'downloadFiles', files });

    await setState({ running: false, completed: true, currentTitle: '' });
    chrome.runtime.sendMessage({ type: 'done', state: await getState() }).catch(() => {});
    sendLog('Done! Exported ' + docs.length + ' documents + ' + media.length + ' media.');
  } catch (err) {
    sendLog('Fatal error: ' + err.message);
    chrome.runtime.sendMessage({ type: 'error', text: err.message }).catch(() => {});
    await setState({ running: false });
  }
}

// ---- Message listener ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startExport') {
    startExport();
    sendResponse({ ok: true });
  } else if (msg.action === 'startGemsExport') {
    startGemsExport();
    sendResponse({ ok: true });
  } else if (msg.action === 'startMyStuffExport') {
    startMyStuffExport();
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
