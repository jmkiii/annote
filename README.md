# Annote

> A democratic annotation layer for the web

**Annote** is a browser extension that lets you highlight text, drop pin annotations, and leave notes on any webpage — all stored locally in your browser. No account required, no data leaves your machine.

---

## Features

- **Text Highlighting** — Select any text on a page and click "Annotate" to attach a note to it
- **Coordinate Pins** — Right-click anywhere on a page to drop a 📌 pin annotation at that exact position
- **Five-Layer Anchor Resolution** — Annotations re-anchor intelligently even when page content changes, using exact match → fuzzy match → structural fingerprint → scroll position → detached fallback
- **Tagging** — Organize annotations with comma-separated tags
- **Replies** — Comment, agree (👍), or disagree (👎) on any annotation
- **Detached Sidebar** — Annotations whose original text is no longer found surface in a collapsible sidebar with options to re-anchor or delete
- **Re-anchor Mode** — Manually re-link a detached annotation to new text with one click
- **Export** — Export all annotations as JSON from the popup
- **Private Messaging (stub)** — Generate an encrypted base64 payload to manually send to an annotation's author (P2P relay not yet implemented)
- **100% Local** — All data lives in `browser.storage.local`; nothing is synced or transmitted

---

## File Structure

```
annote/
├── manifest.json      # Extension manifest (v2), permissions, icons
├── background.js      # Service worker: creates right-click context menu, routes messages
├── content.js         # Core logic: annotation modal, rendering, anchoring, cards, replies
├── content.css        # Styles for highlights, pins, cards, sidebar, modal
├── popup.html         # Toolbar popup UI (stats, actions, annotation list)
├── popup.js           # Popup logic: load stats, scroll-to, export, clear
├── icon48.png         # Extension icon (48px)
├── icon96.png         # Extension icon (96px)
└── generate-icon.html # Dev tool to generate icons in-browser
```

---

## Installation (Developer / Unpacked)

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json` from this repo

### Chrome / Edge / Brave
1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the root folder of this repo

---

## Usage

| Action | How |
|---|---|
| Annotate selected text | Select text on any page → click the **✏️ Annotate** toolbar that appears |
| Drop a pin | Right-click anywhere → **🔍 Add Annote Annotation Here** |
| View an annotation | Hover over a highlight or pin → click the **🔍** trigger icon |
| Edit / delete | Open the annotation card → use **✏️ Edit** or **🗑️** |
| See all annotations on page | Click the extension icon in the toolbar |
| Export all annotations | Popup → **📤 Export All (JSON)** |
| Re-anchor a detached note | Open the **📎 Detached** sidebar → click **🔗 Re-anchor**, select new text, confirm |

---

## Anchor Resolution (How It Stays Accurate)

When a page changes, Annote tries five strategies in order to find where an annotation belongs:

1. **Exact match** — finds the verbatim text, scored by surrounding prefix/suffix context
2. **Fuzzy match** — sliding-window Levenshtein similarity (threshold: 72%)
3. **Structural fingerprint** — matches by nearest heading + surrounding paragraph text + tag name
4. **Scroll position** — falls back to the closest block element at the original scroll percentage
5. **Detached** — surfaces in the sidebar if all layers fail

Confidence level (`exact`, `fuzzy`, `structural`, `positional`) is shown on the trigger icon and card.

---

## Permissions Used

| Permission | Reason |
|---|---|
| `storage` | Save annotations locally via `browser.storage.local` |
| `activeTab` | Read the current tab URL to associate annotations |
| `contextMenus` | Add the right-click "Add Annotation" menu item |
| `<all_urls>` | Inject content script on every page to render annotations |

---

## Roadmap

- [ ] Manifest v3 migration
- [ ] P2P relay for private messaging between annotation authors
- [ ] Sync / backup to a self-hosted server
- [ ] Public annotation sharing (opt-in)
- [ ] Search across all annotations
- [ ] Keyboard shortcuts

---

## License

MIT
