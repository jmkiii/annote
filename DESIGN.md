# Annote — Design Document

A peer-to-peer annotation and drawing layer over the web. Participants leave comments, ratings, pictures, and freehand drawings anchored to any page, and see what others left there.

Core constraint: **Annote never talks to the sites you visit.** The page is read locally only to compute anchor positions. All network traffic goes exclusively to Annote relays over WebSocket.

---

## 1. System overview

```
┌──────────────────────────── Browser ────────────────────────────┐
│  Content script (per tab)          Service worker (background)  │
│  ┌──────────────────────┐          ┌─────────────────────────┐  │
│  │ Overlay UI           │ runtime  │ Identity (ECDSA keypair)│  │
│  │ Anchor engine        │◄────────►│ Relay pool (WebSocket)  │  │
│  │ Drawing canvas       │ messages │ Local event store       │  │
│  │ Annotation renderer  │          │ Merge / verify / dedupe │  │
│  └──────────────────────┘          └───────────┬─────────────┘  │
└────────────────────────────────────────────────┼────────────────┘
                                          WSS only (never HTTP
                                          to visited sites)
                                                 │
                          ┌──────────┐    ┌──────▼─────┐    ┌──────────┐
                          │ Relay B  │◄──►│  Relay A   │◄──►│ Relay C  │
                          └──────────┘    └────────────┘    └──────────┘
                          Dumb, interchangeable, anyone can run one.
```

Three components:

1. **Extension** (Manifest V3). Renders the overlay, computes anchors, and signs events.
2. **Relays**. Dumb store-and-forward servers for signed events, filterable by page. Anyone can run one; clients connect to several; no relay is trusted.
3. **Local event store**. Every client keeps and verifies its own copy of the signed events it has seen and merges them deterministically, so any one honest relay suffices.

## 2. Privacy model

- The content script reads the DOM to compute anchors and paints an overlay. It sends nothing to the page, injects no page-visible requests, and modifies nothing the site's own scripts can observe (overlay lives in a closed shadow root).
- The visited URL never leaves the machine in plaintext. Pages are identified by `pageId = SHA-256(normalizedUrl)`. Relays see which *hashes* are being subscribed to, not readable URLs (rainbow-table caveat: hashes of popular URLs are guessable — this hides the long tail, not the head; noted in §8).
- URL normalization before hashing: lowercase scheme+host, strip fragment, strip known tracking params (`utm_*`, `fbclid`, `gclid`, …), sort remaining query params. Users can toggle "whole site" scope, which uses `SHA-256(host)` instead.

## 3. Identity & integrity

Each participant has an **ECDSA P-256 keypair** generated on first run via WebCrypto (chosen over Ed25519 for universal browser support). This keypair is purely an identity and integrity mechanism — it signs everything you post so it can't be forged or altered in transit.

- `pubkey` (hex) is the author id.
- A signed `profile` event carries a display name and avatar; names are not unique — the key is the identity.
- Keys are exportable (JWK) for backup and multi-device use.
- Identities are pseudonymous and cheap to create by design.

## 4. Event schema

Everything — annotations, replies, ratings, drawings, profiles — is one envelope:

```json
{
  "id":      "<sha256 of canonical serialization of the fields below>",
  "pubkey":  "<author pubkey hex>",
  "created": 1780000000000,
  "kind":    "note | draw | rate | react | reply | media | profile | delete",
  "page":    "<pageId hex, omitted for profile>",
  "anchor":  { },
  "content": { },
  "refs":    ["<parent event id>"],
  "sig":     "<ECDSA-SHA256 over id>"
}
```

Canonical serialization: JSON with sorted keys, no whitespace, `sig` and `id` excluded. Any client and any relay can verify any event independently. Events are immutable; edits are new events `ref`ing the old; `delete` is a tombstone honored only when signed by the original author.

**Kinds**

| kind | content | notes |
|---|---|---|
| `note` | `{ text }` | comment anchored to selection or point |
| `draw` | `{ strokes: [{color,width,points:[[x,y,a?],…]}] }` | freehand ink; optional per-point alpha from **speed→opacity** (fast strokes fade, deliberate strokes are solid — organic look + soft bot resistance). Palette is sampled from the page itself via eyedropper. |
| `rate` | `{ stars: 1–5 }` | rates a page or (via `refs`) an annotation |
| `react` | `{ up: 1 }` | lightweight engagement |
| `reply` | `{ text }` | threaded under `refs[0]` |
| `media` | `{ mime, dataUrl }` | pictures, ≤ 256 KB after client-side downscale |
| `profile` | `{ name }` | latest one wins |

## 5. Anchoring (the hard problem)

An annotation must survive reflows, redesigns, and dynamic content. Annote uses a fallback chain, best first:

1. **TextQuote** (for text selections): `{ exact, prefix, suffix }` — 32 chars of context each side. Re-attached by exact search, then fuzzy search (case/whitespace-insensitive sliding match). This is the W3C Web Annotation approach and survives most redesigns.
2. **CSS-path + offset**: serialized element path with `nth-of-type` indices, plus character offsets. Fast when the DOM hasn't changed.
3. **Document-relative position**: `{ x: px, yRatio: scrollY/docHeight }`. Used for point annotations ("pin anywhere") and as last-resort fallback for text.

Drawings always use document-relative coordinates normalized to a 1440-px reference width, scaled at render time.

The full resolver is **five layers**: exact match scored by prefix/suffix context → whitespace/case-normalized match → sliding-window Levenshtein fuzzy match (≥72% similarity, work-bounded) → structural fingerprint (surrounding-text similarity + nearest heading + tag) → document-position fallback. Each annotation surfaces its **confidence** (`exact / fuzzy / structural / positional`) in the UI — approximate pins render amber with a warning in the thread.

If every layer fails, the annotation lands in a page-level **"orphaned"** tray rather than being dropped, and the author can **re-anchor** it to newly selected text (implemented as a new event referencing the old plus a tombstone, keeping the log immutable).

## 6. Relay protocol

Line-oriented JSON over WebSocket, deliberately Nostr-like:

```
client → relay:  ["EVENT", <event>]                        publish
client → relay:  ["SUB", <subId>, {"pages":[...], "kinds":[...], "since": ts}]
client → relay:  ["UNSUB", <subId>]
relay  → client: ["EVENT", <subId>, <event>]               match (stored + live)
relay  → client: ["EOSE", <subId>]                         end of stored events
relay  → client: ["OK", <eventId>, true|false, <msg>]      publish ack
```

Relay responsibilities: verify signature, verify `id`, dedupe, persist (SQLite/JSON), forward to matching subscriptions, and gossip to peer relays it's configured with. Nothing else — relays hold no trust. Clients publish every event to *all* connected relays and merge/dedupe on receipt, so any one honest relay suffices.

## 7. Extension architecture

- **Content script** (isolated world, closed shadow-root UI): anchor engine, annotation pins + threads, star ratings, image attach, drawing canvas (pointer events → stroke arrays), sidebar listing page annotations. Talks to the service worker via `chrome.runtime` messages only.
- **Service worker**: holds the keypair, relay pool with reconnect/backoff, event store, and a signing oracle (content scripts never see the private key).
- **Popup**: display name, relay list, and identity backup.
- **Permissions**: `storage` + content-script injection only; the extension makes zero HTTP requests — WebSocket to user-configured relays only.

## 8. Threat model (abridged)

| Threat | Mitigation |
|---|---|
| Relay censors/drops events | Multi-relay publish, client-side merge; run your own relay |
| Relay forges events | Impossible — signatures verified client-side |
| Spam/abuse annotations | Client-side mute list (by pubkey), rating-weighted sort, volume caps in UI |
| URL-hash deanonymization | Hashing protects long-tail pages only; documented honestly; future: PIR or bucketed prefixes |
| Malicious relay floods client | Per-relay rate limiting, event size caps (32 KB, media 256 KB) |
| XSS via annotation content | All content rendered as text nodes, never innerHTML; media restricted to image MIME |

## 9. Roadmap

1. **Now (this prototype):** single-relay dev setup, core annotation kinds, five-layer anchoring.
2. **Beta:** relay gossip mesh, IndexedDB persistence, tags + search, encrypted DMs (requires an ECDH keypair alongside the signing key).
3. **Pure-P2P option:** WebRTC mesh between co-visitors of the same page, relays demoted to bootstrap/backfill.
