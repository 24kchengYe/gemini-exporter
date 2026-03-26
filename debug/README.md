# Debug Snippets

These scripts are designed to run in Chrome DevTools **Snippets** (Sources → Snippets → New snippet → paste → Ctrl+Enter) on a `gemini.google.com` page.

Use them to debug issues specific to your account/environment.

## Scripts

| File | Purpose |
|------|---------|
| `test_api.js` | Test hNvQHb API call and response parsing |
| `test_model.js` | Inspect model response structure (`turn[3]`) |
| `test_time.js` | Find timestamps in API response + check sidebar DOM structure |
| `test_title.js` | Search for title field in API response |
| `test_title2.js` | Deep search for strings in turn structure |

## How to use

1. Open `https://gemini.google.com/app` and log in
2. Open DevTools (F12) → **Sources** tab → **Snippets** (in left panel)
3. Click **+ New snippet**, paste script content
4. Press **Ctrl+Enter** to run
5. Check **Console** tab for output
