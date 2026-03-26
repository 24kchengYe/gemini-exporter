// ============================================================
// Gemini Conversation Exporter - Content Script
// Runs on gemini.google.com pages
// ============================================================

(function () {
  // Prevent double-injection
  if (window.__geminiExporterInjected) return;
  window.__geminiExporterInjected = true;

  // ---- URL Collection ----

  async function collectUrls() {
    // Find the sidebar scrollable container that holds conversation links
    const allLinks = () => {
      const anchors = document.querySelectorAll('a[href*="/app/"]');
      const urls = new Set();
      anchors.forEach((a) => {
        const href = a.getAttribute('href');
        // Only conversation links, not the main /app page
        if (href && /\/app\/[a-zA-Z0-9]/.test(href)) {
          urls.add(href);
        }
      });
      return urls;
    };

    // Find scrollable sidebar container
    function findSidebarScroller() {
      // Try common sidebar containers
      const candidates = document.querySelectorAll(
        'nav, [role="navigation"], [class*="sidebar"], [class*="history"], [class*="drawer"]'
      );
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 50) {
          return el;
        }
      }

      // Fallback: find any scrollable ancestor of conversation links
      const firstLink = document.querySelector('a[href*="/app/"]');
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

    // Scroll sidebar to load all conversations
    const scroller = findSidebarScroller();
    let prevCount = 0;
    let stableRounds = 0;
    const maxStableRounds = 12;

    if (scroller) {
      for (let i = 0; i < 200; i++) {
        // Safety limit
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
      // Scroll back to top
      scroller.scrollTop = 0;
    }

    const urls = Array.from(allLinks());
    return { urls, count: urls.length };
  }

  // ---- Conversation Extraction ----

  async function extractConversation(url) {
    // Wait for conversation containers to appear
    await waitForSelector('.conversation-container, [class*="conversation"], [class*="message"]', 15000);
    await new Promise((r) => setTimeout(r, 1500));

    // Scroll to top to load lazy-loaded messages
    await scrollConversationToTop();

    // Extract messages
    const messages = [];

    // Strategy 1: query-text + markdown panels (known Gemini structure)
    const turns = document.querySelectorAll(
      '.conversation-container, [class*="conversation-turn"], [class*="query-content"], [class*="response-container"], [class*="message-content"]'
    );

    if (turns.length > 0) {
      // Try structured extraction from conversation containers
      const convContainers = document.querySelectorAll('.conversation-container');
      if (convContainers.length > 0) {
        convContainers.forEach((container) => {
          // User message
          const userEl = container.querySelector(
            '.query-text, [class*="query-text"], [class*="user-message"], [class*="request"]'
          );
          if (userEl) {
            let text = userEl.innerText.trim();
            // Remove common prefixes
            text = text.replace(/^(You said|You)\s*\n*/i, '').trim();
            if (text) {
              messages.push({ role: 'user', content: text });
            }
          }

          // Gemini response
          const geminiEl = container.querySelector(
            '.markdown.markdown-main-panel, [class*="markdown-main"], [class*="model-response"], [class*="response-content"]'
          );
          if (geminiEl) {
            const text = geminiEl.innerText.trim();
            if (text) {
              messages.push({ role: 'assistant', content: text });
            }
          }
        });
      }
    }

    // Strategy 2: Fallback - try to find alternating user/model blocks
    if (messages.length === 0) {
      const queryTexts = document.querySelectorAll(
        '.query-text, [class*="query-text"], [data-message-author-role="user"]'
      );
      const responseTexts = document.querySelectorAll(
        '.markdown.markdown-main-panel, [class*="markdown-main"], [data-message-author-role="model"]'
      );

      const maxLen = Math.max(queryTexts.length, responseTexts.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < queryTexts.length) {
          let text = queryTexts[i].innerText.trim();
          text = text.replace(/^(You said|You)\s*\n*/i, '').trim();
          if (text) messages.push({ role: 'user', content: text });
        }
        if (i < responseTexts.length) {
          const text = responseTexts[i].innerText.trim();
          if (text) messages.push({ role: 'assistant', content: text });
        }
      }
    }

    // Strategy 3: Ultra-fallback - grab all text blocks with role inference
    if (messages.length === 0) {
      const allBlocks = document.querySelectorAll(
        '[class*="message"], [class*="turn"], [class*="content-block"]'
      );
      allBlocks.forEach((block) => {
        const text = block.innerText.trim();
        if (!text || text.length < 2) return;
        const hasMarkdown = block.querySelector('code, pre, ol, ul, table, h1, h2, h3');
        const role = hasMarkdown ? 'assistant' : 'user';
        messages.push({ role, content: text });
      });
    }

    // Title extraction: try multiple strategies
    let title = '';

    // Strategy 1: Try to find the conversation title element in the page
    const titleCandidates = [
      'h1.conversation-title',
      '[class*="conversation-title"]',
      '[class*="chat-title"]',
      'h1',
    ];
    for (const sel of titleCandidates) {
      const el = document.querySelector(sel);
      if (el) {
        const t = el.innerText.trim();
        if (t && t !== 'Google Gemini' && t !== 'Gemini' && t.length > 1) {
          title = t;
          break;
        }
      }
    }

    // Strategy 2: Use document.title but strip "Google Gemini" variations
    if (!title) {
      title = document.title
        .replace(/^Google Gemini\s*[-–—:]\s*/i, '')  // "Google Gemini - XXX" -> "XXX"
        .replace(/\s*[-–—:]\s*Google Gemini\s*$/i, '')  // "XXX - Google Gemini" -> "XXX"
        .trim();
      // If title is still just "Google Gemini" or empty, try first user message
      if (!title || /^Google\s*Gemini$/i.test(title)) {
        const firstUser = document.querySelector('.query-text, [class*="query-text"]');
        if (firstUser) {
          title = firstUser.innerText.replace(/^(You said|You)\s*\n*/i, '').trim().slice(0, 80);
        }
      }
    }

    if (!title) title = 'Untitled';

    return {
      title,
      messages,
      url: url || window.location.href,
      exportedAt: new Date().toISOString(),
    };
  }

  // ---- Helpers ----

  function waitForSelector(selector, timeout = 10000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  async function scrollConversationToTop() {
    // Find the main scrollable conversation area
    function findConvScroller() {
      const candidates = document.querySelectorAll(
        'main, [role="main"], [class*="chat-container"], [class*="conversation-scroll"], [class*="infinite-scroller"]'
      );
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 100) {
          return el;
        }
      }

      // Fallback: look for scrollable parent of conversation content
      const convEl = document.querySelector(
        '.conversation-container, [class*="conversation"]'
      );
      if (convEl) {
        let parent = convEl.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 100) {
            return parent;
          }
          parent = parent.parentElement;
        }
      }

      return document.documentElement;
    }

    const scroller = findConvScroller();
    if (!scroller) return;

    // Repeatedly scroll to top and wait for lazy-loaded content
    // Gemini loads more messages as you scroll up, increasing scrollHeight
    let prevHeight = scroller.scrollHeight;
    let stableRounds = 0;
    const maxStableRounds = 5; // stop after 5 rounds with no new content
    const maxAttempts = 120;   // safety limit for very long conversations

    for (let i = 0; i < maxAttempts; i++) {
      // Scroll to very top
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 1500));

      const newHeight = scroller.scrollHeight;
      if (newHeight > prevHeight) {
        // New content loaded — reset stable counter
        prevHeight = newHeight;
        stableRounds = 0;
      } else {
        stableRounds++;
        if (stableRounds >= maxStableRounds) break;
      }
    }

    // Final: scroll to very bottom then back to top to ensure full render
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 1000));
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 500));
  }

  // ---- Message handler ----

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'collectUrls') {
      collectUrls()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message, urls: [] }));
      return true; // async response
    }

    if (msg.action === 'extractConversation') {
      extractConversation(msg.url)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message, messages: [] }));
      return true; // async response
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

      // Small delay to avoid browser throttling rapid downloads
      await new Promise((r) => setTimeout(r, 100));

      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      downloaded++;
    }

    return { downloaded, total: filenames.length };
  }
})();
