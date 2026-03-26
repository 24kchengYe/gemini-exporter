"""
Gemini Exporter - Direct DOM extraction via Playwright
No plugins needed. Scrolls up to load full conversation, extracts from DOM.
"""

import asyncio
import json
import os
import re
import random
import time
from pathlib import Path
from datetime import datetime
from playwright.async_api import async_playwright

GEMINI_APP_URL = "https://gemini.google.com/app"
OUTPUT_DIR = "gemini_export"
SLEEP_MIN = 8.0
SLEEP_MAX = 15.0


async def _scroll_sidebar_by_js(page, delta=400):
    """Scroll the sidebar container that holds /app/ links."""
    return await page.evaluate(
        """(delta) => {
        const links = document.querySelectorAll('a[href^="/app/"]');
        if (!links.length) return false;
        let el = links[0];
        while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            const overflow = style.overflowY || style.overflow;
            const scrollable = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
            if (scrollable && el.scrollHeight > el.clientHeight) {
                el.scrollTop += delta;
                return true;
            }
            el = el.parentElement;
        }
        const main = document.querySelector('nav') || document.querySelector('[role="navigation"]') || document.documentElement;
        if (main && main.scrollHeight > main.clientHeight) {
            main.scrollTop += delta;
            return true;
        }
        window.scrollBy(0, delta);
        return true;
    }""",
        delta,
    )


async def discover_conversation_urls(page):
    """Scroll sidebar to collect all conversation URLs."""
    await page.goto(GEMINI_APP_URL, wait_until="domcontentloaded", timeout=60000)
    await asyncio.sleep(3)

    seen_count = 0
    stable_rounds = 0
    max_stable = 12

    while stable_rounds < max_stable:
        all_urls = await page.evaluate("""
            () => {
                const links = document.querySelectorAll('a[href^="/app/"]');
                const urls = [];
                links.forEach(a => { if (a.href && !urls.includes(a.href)) urls.push(a.href); });
                return urls;
            }
        """)
        count = len(all_urls)

        if count > seen_count:
            seen_count = count
            stable_rounds = 0
            print(f"   Links found: {count}")
        else:
            stable_rounds += 1
            print(f"   No new links ({count}), stable {stable_rounds}/{max_stable}")

        try:
            scrolled = await _scroll_sidebar_by_js(page, 400)
            if not scrolled:
                box = await page.locator("a[href^='/app/']").first.bounding_box()
                if box:
                    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                await page.mouse.wheel(0, 400)
        except Exception:
            await page.mouse.wheel(0, 400)
        await asyncio.sleep(1.5)

    return list(dict.fromkeys(all_urls))


async def scroll_to_top_and_load_all(page):
    """Scroll conversation area to top to load all messages."""
    for attempt in range(60):
        at_top = await page.evaluate("""
            () => {
                const containers = document.querySelectorAll('.conversation-container');
                if (!containers.length) return true;
                let el = containers[0];
                while (el && el !== document.body) {
                    const style = window.getComputedStyle(el);
                    const overflow = style.overflowY || style.overflow;
                    if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay')
                        && el.scrollHeight > el.clientHeight) {
                        if (el.scrollTop <= 5) return true;
                        el.scrollTop = 0;
                        return false;
                    }
                    el = el.parentElement;
                }
                window.scrollTo(0, 0);
                return true;
            }
        """)
        if at_top:
            # Double check: wait a bit and see if new content loaded
            await asyncio.sleep(1)
            break
        await asyncio.sleep(1)


async def extract_conversation(page):
    """Extract all messages from current conversation page."""
    return await page.evaluate("""
        () => {
            var messages = [];
            var turns = document.querySelectorAll('.conversation-container');

            for (var i = 0; i < turns.length; i++) {
                var turn = turns[i];
                var userEl = turn.querySelector('.query-text');
                var asstEl = turn.querySelector('.markdown.markdown-main-panel');

                if (userEl) {
                    var uText = userEl.innerText.replace(/^You said/i, '').trim();
                    if (uText) messages.push({role: 'user', content: uText});
                }
                if (asstEl) {
                    var aText = asstEl.innerText.trim();
                    if (aText) messages.push({role: 'assistant', content: aText});
                }
            }

            // Fallback if .conversation-container not found
            if (messages.length === 0) {
                var userEls = document.querySelectorAll('.query-text');
                var asstEls = document.querySelectorAll('.markdown.markdown-main-panel');
                var maxLen = Math.max(userEls.length, asstEls.length);
                for (var j = 0; j < maxLen; j++) {
                    if (j < userEls.length) {
                        var ut = userEls[j].innerText.replace(/^You said/i, '').trim();
                        if (ut) messages.push({role: 'user', content: ut});
                    }
                    if (j < asstEls.length) {
                        var at2 = asstEls[j].innerText.trim();
                        if (at2) messages.push({role: 'assistant', content: at2});
                    }
                }
            }

            // Get title
            var titleEl = document.querySelector('h1') ||
                          document.querySelector('[class*="title"]') ||
                          document.querySelector('.conversation-title');
            var title = '';
            if (titleEl) title = titleEl.innerText.trim();
            if (!title) title = document.title.replace(' - Google Gemini', '').trim();

            return {title: title, messages: messages};
        }
    """)


def url_to_id(url):
    m = re.search(r"/app/([a-f0-9]+)", url)
    return m.group(1) if m else url


def safe_filename(title, max_len=60):
    """Convert title to safe filename."""
    # Replace unsafe chars
    safe = re.sub(r'[\\/:*?"<>|]', '_', title)
    safe = safe.strip().strip('.')
    if not safe:
        safe = "Untitled"
    return safe[:max_len]


def conv_to_markdown(title, messages, url):
    """Convert a conversation to Markdown string."""
    lines = []
    lines.append("=" * 60)
    lines.append(f"Conversation: {title}")
    lines.append(f"Messages: {len(messages)}")
    lines.append(f"URL: {url}")
    lines.append("=" * 60 + "\n")
    for msg in messages:
        label = "--- User ---" if msg["role"] == "user" else "--- Gemini ---"
        lines.append(f"{label}\n")
        lines.append(msg["content"])
        lines.append("")
    lines.append("")
    return "\n".join(lines)


async def export_one(page, url, output_dir):
    """Navigate to conversation, scroll to top, extract all messages."""
    conv_id = url_to_id(url)

    # Skip if already exported (check by ID prefix in filenames)
    existing = [f for f in output_dir.glob("*.json") if conv_id in f.stem]
    if existing:
        return True, "skipped", 0

    # Navigate
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(4)

    # Scroll to top to load all messages
    await scroll_to_top_and_load_all(page)
    await asyncio.sleep(2)

    # Extract
    data = await extract_conversation(page)
    title = data.get("title", "Untitled")
    messages = data.get("messages", [])

    # Build filename: "title_convid.json"
    safe_title = safe_filename(title)
    base_name = f"{safe_title}_{conv_id[:8]}"

    # Save JSON
    result = {
        "id": conv_id,
        "title": title,
        "url": url,
        "messages": messages,
        "messageCount": len(messages),
        "exportTime": datetime.now().isoformat(),
    }
    json_path = output_dir / f"{base_name}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # Save individual Markdown
    md_path = output_dir / f"{base_name}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(conv_to_markdown(title, messages, url))

    return True, title, len(messages)


async def main():
    output_dir = Path(OUTPUT_DIR).resolve()
    os.makedirs(output_dir, exist_ok=True)

    print("=" * 60)
    print("Gemini Exporter (Direct DOM extraction)")
    print("  No plugins needed")
    print("=" * 60)

    async with async_playwright() as p:
        print("\nConnecting to Chrome...")
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        print("[ok] Connected")

        contexts = browser.contexts
        if not contexts:
            print("[x] No browser context found")
            return
        context = contexts[0]
        # Use existing page or create new one
        if context.pages:
            page = context.pages[0]
        else:
            page = await context.new_page()
        # Make sure page is usable, if not create a new one
        try:
            await page.title()
        except Exception:
            page = await context.new_page()

        # Phase 1: Discover conversations (or load from index)
        index_path = output_dir / "urls_index.json"

        if index_path.exists():
            with open(index_path, "r", encoding="utf-8") as f:
                urls = json.load(f)
            print(f"\n[ok] Loaded {len(urls)} conversations from urls_index.json (cached)")
        else:
            print(f"\n{'='*50}")
            print("Phase 1: Collecting conversation links")
            print(f"{'='*50}")

            urls = await discover_conversation_urls(page)
            print(f"\n[ok] Found {len(urls)} conversations")

            if not urls:
                print("[!] No conversations found.")
                return

            # Save index
            with open(index_path, "w", encoding="utf-8") as f:
                json.dump(urls, f, ensure_ascii=False, indent=2)
            print(f"[ok] Saved urls_index.json ({len(urls)} links)")

        # Phase 2: Export each conversation
        print(f"\n{'='*50}")
        print("Phase 2: Extracting conversations from DOM")
        print(f"{'='*50}")

        ok_count = 0
        empty_count = 0
        failed_list = []

        for i, url in enumerate(urls):
            conv_id = url_to_id(url)

            # Skip existing
            if (output_dir / f"{conv_id}.json").exists():
                print(f"\n[{i+1}/{len(urls)}] {conv_id[:16]}... [skip] already exists")
                ok_count += 1
                continue

            print(f"\n[{i+1}/{len(urls)}] {conv_id[:16]}...", end="", flush=True)

            try:
                success, title, msg_count = await asyncio.wait_for(
                    export_one(page, url, output_dir),
                    timeout=90
                )
                if msg_count > 0:
                    ok_count += 1
                    print(f" [ok] {title[:30]} ({msg_count} msgs)")
                else:
                    empty_count += 1
                    print(f" [!] {title[:30]} (0 msgs)")
            except asyncio.TimeoutError:
                print(f" [x] Timeout")
                failed_list.append(url)
            except Exception as e:
                print(f" [x] {str(e)[:50]}")
                failed_list.append(url)

            delay = random.uniform(SLEEP_MIN, SLEEP_MAX)
            print(f"   Waiting {delay:.1f}s...")
            await asyncio.sleep(delay)

        # Phase 3: Generate merged files
        print(f"\n{'='*50}")
        print("Phase 3: Generating merged output files")
        print(f"{'='*50}")

        all_data = []
        for jf in sorted(output_dir.glob("*.json")):
            if jf.name.startswith("gemini_"):
                continue
            try:
                with open(jf, "r", encoding="utf-8") as f:
                    all_data.append(json.load(f))
            except Exception:
                pass

        # Merged JSON
        merged_json = output_dir / "gemini_all_conversations.json"
        with open(merged_json, "w", encoding="utf-8") as f:
            json.dump(all_data, f, ensure_ascii=False, indent=2)

        # Merged Markdown
        merged_md = output_dir / "gemini_all_conversations.md"
        lines = []
        lines.append(f"<!-- Gemini Export: {len(all_data)} conversations -->")
        lines.append(f"<!-- Exported: {datetime.now().strftime('%Y-%m-%d %H:%M')} -->\n")

        for conv in all_data:
            title = conv.get("title", "Untitled")
            msg_count = conv.get("messageCount", 0)
            lines.append("=" * 60)
            lines.append(f"Conversation: {title}")
            lines.append(f"Messages: {msg_count}")
            lines.append("=" * 60 + "\n")

            for msg in conv.get("messages", []):
                label = "--- User ---" if msg["role"] == "user" else "--- Gemini ---"
                lines.append(f"{label}\n")
                lines.append(msg["content"])
                lines.append("")
            lines.append("")

        with open(merged_md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        print(f"\n[ok] Merged files saved:")
        print(f"   {merged_json}")
        print(f"   {merged_md}")

        # Summary
        print(f"\n{'='*50}")
        print(f"Done!")
        print(f"  Exported: {ok_count}")
        print(f"  Empty: {empty_count}")
        print(f"  Failed: {len(failed_list)}")
        print(f"  Output: {output_dir}/")
        print(f"{'='*50}")

        if failed_list:
            failed_path = output_dir / f"failed_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
            with open(failed_path, "w") as f:
                for url in failed_list:
                    f.write(url + "\n")
            print(f"\n[!] Failed URLs saved to: {failed_path}")

        # Don't close browser - keep Chrome running
        print("\n[ok] Chrome kept open. You can continue using it.")


if __name__ == "__main__":
    asyncio.run(main())
