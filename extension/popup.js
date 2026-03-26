(function () {
  const $ = (sel) => document.querySelector(sel);

  const startBtn = $('#startBtn');
  const cancelBtn = $('#cancelBtn');
  const resetBtn = $('#resetBtn');
  const downloadBtn = $('#downloadBtn');
  const logArea = $('#logArea');
  const progressSection = $('#progressSection');
  const progressBar = $('#progressBar');
  const progressText = $('#progressText');
  const exportedCount = $('#exportedCount');
  const totalCount = $('#totalCount');
  const skippedCount = $('#skippedCount');

  function log(msg) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    logArea.value += `[${ts}] ${msg}\n`;
    logArea.scrollTop = logArea.scrollHeight;
  }

  function updateUI(state) {
    const exported = state.exportedIds ? state.exportedIds.length : 0;
    const total = state.urlList ? state.urlList.length : 0;
    const skipped = state.skippedCount || 0;

    exportedCount.textContent = exported;
    totalCount.textContent = total || '—';
    skippedCount.textContent = skipped;

    // Show download button if we have saved data
    if (exported > 0 && !state.running) {
      downloadBtn.style.display = 'flex';
    } else {
      downloadBtn.style.display = 'none';
    }

    if (state.running) {
      startBtn.style.display = 'none';
      cancelBtn.style.display = 'flex';
      resetBtn.disabled = true;
      progressSection.style.display = 'block';

      if (total > 0) {
        const pct = Math.round(((exported + skipped) / total) * 100);
        progressBar.style.width = pct + '%';
        progressText.textContent = state.currentTitle
          ? `(${exported + skipped}/${total}) ${state.currentTitle}`
          : `${pct}% complete`;
      }
    } else {
      startBtn.style.display = 'flex';
      cancelBtn.style.display = 'none';
      resetBtn.disabled = false;

      if (total > 0) {
        const pct = Math.round(((exported + skipped) / total) * 100);
        progressBar.style.width = pct + '%';
        progressSection.style.display = 'block';
        progressText.textContent = state.completed
          ? `Done! Exported ${exported} conversations.`
          : `Paused at ${pct}%`;
      }
    }
  }

  // Load initial state
  chrome.storage.local.get(
    ['exportedIds', 'urlList', 'running', 'skippedCount', 'currentTitle', 'completed'],
    (data) => {
      updateUI(data);
      if (data.exportedIds && data.exportedIds.length > 0) {
        log(`Resumed: ${data.exportedIds.length} conversations already exported.`);
      }
    }
  );

  // Listen for progress messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'log') {
      log(msg.text);
    }
    if (msg.type === 'progress') {
      updateUI(msg.state);
    }
    if (msg.type === 'done') {
      log('Export complete!');
      updateUI(msg.state);
    }
    if (msg.type === 'error') {
      log('ERROR: ' + msg.text);
    }
  });

  startBtn.addEventListener('click', () => {
    log('Starting export...');
    chrome.runtime.sendMessage({ action: 'startExport' }, (resp) => {
      if (chrome.runtime.lastError) {
        log('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (resp && resp.error) {
        log('Error: ' + resp.error);
      }
    });
  });

  cancelBtn.addEventListener('click', () => {
    log('Cancelling...');
    chrome.storage.local.set({ cancelled: true });
    chrome.runtime.sendMessage({ action: 'cancelExport' });
  });

  downloadBtn.addEventListener('click', () => {
    log('Triggering download of saved data...');
    chrome.runtime.sendMessage({ action: 'downloadSaved' });
  });

  resetBtn.addEventListener('click', () => {
    if (!confirm('Clear all export history? This will re-export everything next time.')) return;
    chrome.storage.local.remove(
      ['exportedIds', 'urlList', 'skippedCount', 'currentTitle', 'running', 'completed'],
      () => {
        log('History cleared.');
        updateUI({});
      }
    );
  });

  // Poll storage every 2s to keep UI fresh (in case popup was reopened)
  setInterval(() => {
    chrome.storage.local.get(
      ['exportedIds', 'urlList', 'running', 'skippedCount', 'currentTitle', 'completed'],
      updateUI
    );
  }, 2000);
})();
