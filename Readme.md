# GPTExport

A small Chrome extension that exports a ChatGPT conversation to Markdown and copies it to your clipboard — no server, no account, everything runs locally in your browser.

## Features

- Exports the **entire** conversation, not just what's currently rendered — ChatGPT virtualizes long chats (removes old messages from the DOM as you scroll), so the extension auto-scrolls to the top first and collects every message along the way.
- Preserves formatting: code blocks (with language tags), lists, bold/italic, links, headings, and blockquotes are converted to proper Markdown instead of being flattened to plain text.
- Copies straight to your clipboard — paste anywhere.
- Live progress feedback while scrolling long conversations.
- No external requests, no analytics, no permissions beyond what's needed to read the active ChatGPT tab and write to the clipboard.

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
3. Click **Export Conversation**.
4. The extension scrolls through the full conversation, converts it to Markdown, and copies it to your clipboard.
5. Paste (`Ctrl+V` / `Cmd+V`) wherever you like.

## How it works

- **`content.ts`** runs on `chatgpt.com` pages. It scrolls the conversation container to the top, collecting every message it encounters along the way (deduplicated by a stable ID — ChatGPT's own `data-message-id` for assistant replies, a content hash for user messages, since those aren't given a stable ID by the page itself). Message order is reconstructed via a topological sort based on each message's on-screen position at the time it was seen, since virtualization means messages aren't always collected in final reading order.
- **`popup.ts`** triggers the export and turns the collected messages into a Markdown string.
- **`background.ts`** + **`offscreen.ts`** handle the clipboard write. Manifest V3 service workers can't access the clipboard directly, so a short-lived offscreen document does it instead.

## Project structure

```
src/
  content.ts      # Runs on chatgpt.com, scrolls + extracts messages
  popup.ts        # Popup UI logic
  background.ts   # Service worker, coordinates the offscreen document
  offscreen.ts     # Clipboard write (offscreen document)
public/
  manifest.json
  popup.html
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
