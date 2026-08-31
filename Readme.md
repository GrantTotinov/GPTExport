# GPTExport

A small Chrome extension that exports a ChatGPT conversation to Markdown and copies it to your clipboard — no server, no account, everything runs locally in your browser.

## Features

- Exports the **entire** conversation, not just what's currently rendered — ChatGPT virtualizes long chats (removes old messages from the DOM as you scroll), so the extension auto-scrolls to the top first and collects every message along the way.
- Preserves formatting: code blocks (with language tags), lists, bold/italic, links, headings, and blockquotes are converted to proper Markdown instead of being flattened to plain text.
- **Copy to clipboard** or **download as a `.md` file** — the download gets an automatic filename built from the conversation title and today's date.
- **Settings page** to customize heading style, message spacing, and whether to include an export timestamp.
- Live progress feedback while scrolling long conversations.
- Falls back gracefully if ChatGPT changes its layout: the extension tries several known selectors before giving up, and reports a clear error instead of silently exporting nothing.
- No external requests, no analytics, no permissions beyond what's needed to read the active ChatGPT tab, write to the clipboard, save a file, and store your settings.

## Installing (unpacked, for development/testing)

1. Clone this repo and install dependencies:
   ```bash
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (top right).
5. Click **Load unpacked** and select the `dist/` folder produced by the build.

## Usage

1. Open any conversation on `chatgpt.com`.
2. Click the GPTExport icon in your toolbar.
3. Click **Copy Conversation** to copy the Markdown straight to your clipboard, or click **Export Conversation** to open a small menu and pick **.md** or **.txt** to download instead (the `.txt` option strips Markdown syntax down to plain text).
4. The extension scrolls through the full conversation and either copies or downloads it depending on what you picked.
5. If you copied, paste (`Ctrl+V` / `Cmd+V`) wherever you like.

Click **Settings** at the bottom of the popup to customize heading style (`## User` / `**User:**` / none), spacing between messages, and whether to include an export timestamp.

## How it works

- **`content.ts`** runs on `chatgpt.com` pages. It scrolls the conversation container to the top, collecting every message it encounters along the way (deduplicated by a stable ID — ChatGPT's own `data-message-id` for assistant replies, a content hash for user messages, since those aren't given a stable ID by the page itself). Message order is reconstructed via a topological sort based on each message's on-screen position at the time it was seen, since virtualization means messages aren't always collected in final reading order.
- **`popup.ts`** triggers the export and turns the collected messages into a Markdown string.
- **`background.ts`** + **`offscreen.ts`** handle the clipboard write. Manifest V3 service workers can't access the clipboard directly, so a short-lived offscreen document does it instead.

## Project structure

```
src/
  content.ts      # Runs on chatgpt.com, scrolls + extracts messages
  popup.ts        # Popup UI logic (copy + export menu)
  markdown-strip.ts # Converts generated Markdown to plain text for .txt export
  options.ts       # Settings page logic
  settings.ts      # Shared settings types/defaults (used by popup + options)
  background.ts   # Service worker, coordinates the offscreen document
  offscreen.ts     # Clipboard write (offscreen document)
public/
  manifest.json
  popup.html
  options.html
  offscreen.html
  icons/
```

## Limitations

- Only works on `chatgpt.com` (not the legacy `chat.openai.com` domain, which now redirects there anyway).
- Depends on ChatGPT's current DOM structure (`data-message-author-role`, `.markdown`, `.user-message-bubble-color`, `[data-scroll-root]`). If OpenAI changes these, extraction may break until the extension is updated.
- Two user messages with byte-for-byte identical text will be treated as the same message (their IDs are derived from content, since the page doesn't expose a stable ID for user turns).

## Contributing

Issues and pull requests are welcome. If ChatGPT's markup changes and extraction breaks, please include a browser console log (`F12` → Console tab while running an export) when filing an issue — it makes diagnosing DOM changes much faster.

## License

MIT — see [LICENSE](./LICENSE).
