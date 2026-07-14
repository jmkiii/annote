// Annote content script: overlay UI, anchoring, drawing.
// Reads the page DOM only to compute anchors. Sends nothing to the page or its origin.
(() => {
  if (window.__annote) return;
  window.__annote = true;

  const REF_W = 1440; // reference width for stored coordinates
  const state = {
    pageId: null, pubkey: null,
    events: new Map(), profiles: {},
    mode: "browse", // browse | pin | photo | draw
    openThread: null,
    conf: new Map(),   // event id -> anchor confidence
    pos: new Map(),    // event id -> anchor position (doc coords)
    hlRects: [],       // highlight hit-areas for overlap disambiguation
    reanchor: null,    // event id being re-anchored
    threadPath: null,  // climb stack: [rootId, ..., currentId]
  };

  // ---------- background port (self-healing) ----------
  const api = globalThis.browser ?? globalThis.chrome;
  let port = null;

  function onPortMessage(msg) {
    if (msg.type === "init") {
      state.pageId = msg.pageId;
      state.pubkey = msg.pubkey;
      state.profiles = msg.profiles || {};
      for (const ev of msg.events) state.events.set(ev.id, ev);
      state.relayCount = msg.relayCount || 0;
      renderAll();
      refreshPanels();
      flushPending();
      toast(`Annote connected ✓ (${state.relayCount} relay${state.relayCount === 1 ? "" : "s"})`);
    } else if (msg.type === "status") {
      state.relayCount = msg.relayCount || 0;
      if (sidebarOpen) { sidebarOpen = false; togglePanel(); }
    } else if (msg.type === "event" || msg.type === "published") {
      const ev = msg.event;
      if (msg.type === "published") toast("Saved ✓");
      if (!state.events.has(ev.id)) {
        state.events.set(ev.id, ev);
        renderAll();
        refreshPanels();
      }
    } else if (msg.type === "error") {
      toast("Annote error: " + msg.message, true);
    }
  }

  function connectPort(attempt = 0) {
    try {
      port = api.runtime.connect({ name: "annote" });
    } catch {
      port = null;
      toast("Annote was reloaded — refresh this page to reconnect.", true);
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => connectPort(attempt + 1), Math.min(5000, 500 * 2 ** attempt));
    });
    port.postMessage({ type: "join", url: location.href });
  }

  const pending = [];
  const publish = (fields) => {
    if (!state.pageId || !port) {
      pending.push(fields);
      toast("Annote: connecting to background — your annotation is queued\u2026", true);
      if (!port) connectPort();
      return;
    }
    try {
      port.postMessage({ type: "publish", page: state.pageId, ...fields });
    } catch {
      pending.push(fields);
      toast("Annote: connection lost — queued; refresh if this persists.", true);
    }
  };
  function flushPending() {
    while (pending.length && port && state.pageId) {
      const f = pending.shift();
      try { port.postMessage({ type: "publish", page: state.pageId, ...f }); }
      catch { pending.unshift(f); break; }
    }
  }

  function refreshPanels() {
    if (state.openThread) openThread(state.openThread);
    else if (sidebarOpen) { sidebarOpen = false; togglePanel(); }
  }

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const short = (pk) => state.profiles[pk] || (pk ? pk.slice(0, 8) : "?");
  // Earth-tone identity: every key maps to moss / clay / ochre / slate / umber.
  const EARTH = ["#606c38", "#bc6c25", "#dda15e", "#4a4e69", "#7f5539"];
  const authorColor = (pk) => {
    let h = 0;
    for (let i = 0; i < (pk || "").length; i += 4) h = ((h * 33) + pk.charCodeAt(i)) >>> 0;
    return EARTH[h % EARTH.length];
  };
  const seedFrom = (id) => {
    let s = 2166136261;
    for (let i = 0; i < Math.min(16, id.length); i++) s = ((s ^ id.charCodeAt(i)) * 16777619) >>> 0;
    return s;
  };
  const mulberry = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const scale = () => document.documentElement.scrollWidth / REF_W;
  const toRef = (x, y) => [x / scale(), y / scale()];
  const fromRef = (x, y) => [x * scale(), y * scale()];
  const docH = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);

  const deletedIds = () => {
    const dead = new Set();
    for (const e of state.events.values())
      if (e.kind === "delete" && e.refs)
        for (const r of e.refs) {
          const t = state.events.get(r);
          if (t && t.pubkey === e.pubkey) dead.add(r);
        }
    return dead;
  };
  const live = (kind) => {
    const dead = deletedIds();
    return [...state.events.values()].filter(e => e.kind === kind && !dead.has(e.id));
  };
  const childrenOf = (id, kind) => live(kind).filter(e => e.refs && e.refs[0] === id);

  // ---------- shadow overlay ----------
  const host = el("div");
  host.style.cssText = "all:initial; position:absolute; top:0; left:0; width:0; height:0; z-index:2147483647;"; // max int32 — nothing stacks above the layer
  const root = host.attachShadow({ mode: "closed" });
  const style = el("style");
  style.textContent = CSS_TEXT();
  root.appendChild(style);
  // Ink-bleed filter: turbulence-displaced edges make highlights read as watercolor, not UI.
  const svgDefs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgDefs.setAttribute("width", "0"); svgDefs.setAttribute("height", "0");
  svgDefs.style.position = "absolute";
  svgDefs.innerHTML = '<filter id="an-bleed" x="-30%" y="-30%" width="160%" height="160%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.045 0.09" numOctaves="2" seed="7" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="7"/>' +
    '<feGaussianBlur stdDeviation="0.35"/></filter>';
  root.appendChild(svgDefs);

  const layer = el("div", "an-layer");      // document-coord layer (pins, highlights)
  const drawCanvas = el("canvas", "an-canvas"); // viewport canvas for drawings
  const ui = el("div", "an-ui");            // fixed UI (toolbar, panels)
  root.append(drawCanvas, layer, ui);
  document.documentElement.appendChild(host);
  // Max z-index ties are broken by DOM order. Our host is the last child of <html>,
  // so we outrank everything — unless the site appends to <html> after us. If it
  // does, quietly re-append ourselves. Watches only <html>'s direct children: ~free.
  new MutationObserver(() => {
    if (document.documentElement.lastElementChild !== host)
      document.documentElement.appendChild(host);
  }).observe(document.documentElement, { childList: true });

  // ---------- toast ----------
  const toastEl = el("div", "an-toast");
  toastEl.style.display = "none";
  ui.appendChild(toastEl);
  let toastT = null;
  function toast(msg, err) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("an-terr", !!err);
    toastEl.style.display = "block";
    clearTimeout(toastT);
    toastT = setTimeout(() => (toastEl.style.display = "none"), err ? 5000 : 1800);
  }

  // ---------- toolbar ----------
  const bar = el("div", "an-bar");
  const mkBtn = (label, title, fn) => {
    const b = el("button", "an-btn", label);
    b.title = title;
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };
  const setMode = (m) => {
    state.mode = state.mode === m ? "browse" : m;
    if (state.mode !== "browse" && hiddenAll) setHidden(false);
    bar.querySelectorAll(".an-btn").forEach(b => b.classList.remove("an-on"));
    if (state.mode !== "browse") modeBtns[state.mode]?.classList.add("an-on");
    drawCanvas.style.pointerEvents = state.mode === "draw" ? "auto" : "none";
    document.documentElement.style.cursor = state.mode === "pin" || state.mode === "photo" ? "crosshair" : "";
    drawUI.style.display = state.mode === "draw" ? "flex" : "none";
  };
  const modeBtns = {
    pin: mkBtn("📌", "Pin a comment anywhere (click page)", () => setMode("pin")),
    photo: mkBtn("🖼", "Pin a picture (click page)", () => setMode("photo")),
    draw: mkBtn("✏️", "Draw on this page", () => setMode("draw")),
  };
  let hiddenAll = false;
  function setHidden(h) {
    hiddenAll = h;
    layer.style.display = h ? "none" : "";
    drawCanvas.style.visibility = h ? "hidden" : "";
    if (h) closePanel();
    eyeBtn.classList.toggle("an-on", h);
  }
  const eyeBtn = mkBtn("👁", "Hide/show the Annote layer (view the pristine page)", () => {
    setHidden(!hiddenAll);
    toast(hiddenAll ? "Annote layer hidden — the page as it was" : "Annote layer visible");
  });
  mkBtn("☰", "Annotations on this page", () => togglePanel());
  ui.appendChild(bar);

  // ---------- click-to-pin ----------
  document.addEventListener("click", (e) => {
    if (state.mode !== "pin" && state.mode !== "photo") return;
    if (e.composedPath().includes(host)) return;
    e.preventDefault(); e.stopPropagation();
    const [x, y] = toRef(e.pageX, e.pageY);
    if (state.mode === "pin") {
      const text = prompt("Annote — leave a comment here:");
      if (text) publish({ kind: "note", anchor: { type: "point", x, y }, content: { text } });
    } else {
      pickImage((dataUrl, mime) =>
        publish({ kind: "media", anchor: { type: "point", x, y }, content: { mime, dataUrl } }));
    }
    setMode("browse");
  }, true);

  function pickImage(cb) {
    const inp = el("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        const s = Math.min(1, 800 / Math.max(img.width, img.height));
        c.width = img.width * s; c.height = img.height * s;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL("image/jpeg", 0.8);
        if (dataUrl.length > 256 * 1024) return alert("Annote: image too large even after downscale.");
        cb(dataUrl, "image/jpeg");
      };
      img.src = URL.createObjectURL(f);
    };
    inp.click();
  }

  // ---------- text selection → annotate ----------
  const selBubble = el("button", "an-selbtn", "Annote ✎");
  selBubble.style.display = "none";
  ui.appendChild(selBubble);
  document.addEventListener("mouseup", () => setTimeout(() => {
    const sel = window.getSelection();
    if (state.mode !== "browse" || !sel || sel.isCollapsed || !sel.toString().trim()) {
      selBubble.style.display = "none"; return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    selBubble.style.display = "block";
    selBubble.style.left = Math.min(window.innerWidth - 90, r.right) + "px";
    selBubble.style.top = Math.max(4, r.top - 30) + "px";
  }, 0));
  selBubble.onclick = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const anchor = quoteAnchor(sel);
    selBubble.style.display = "none";
    if (state.reanchor) {
      const old = state.events.get(state.reanchor);
      state.reanchor = null;
      if (old) {
        publish({ kind: "note", anchor, content: old.content, refs: [old.id] });
        publish({ kind: "delete", refs: [old.id], content: {} });
        toast("Re-anchored ✓");
      }
      sel.removeAllRanges();
      return;
    }
    const text = prompt(`Annote — comment on:\n“${anchor.exact.slice(0, 120)}”`);
    if (text) publish({ kind: "note", anchor, content: { text } });
    sel.removeAllRanges();
  };

  // ---------- anchoring ----------
  function pageText() {
    // Concatenated text with node map, skipping our host.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => host.contains(n.parentNode) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text = "", map = [];
    for (let n; (n = walker.nextNode());) {
      map.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
    return { text, map };
  }

  function quoteAnchor(sel) {
    const exact = sel.toString();
    const { text } = pageText();
    const idx = text.indexOf(exact);
    // Structural fingerprint (ported from the original Annote prototype)
    let fp = {};
    try {
      const range = sel.getRangeAt(0);
      const elmt = range.startContainer.parentElement;
      const top = range.getBoundingClientRect().top + scrollY;
      let heading = "", bestTop = -Infinity;
      for (const h of document.querySelectorAll("h1,h2,h3,h4")) {
        const t = h.getBoundingClientRect().top + scrollY;
        if (t <= top && t > bestTop) { bestTop = t; heading = h.textContent.trim().slice(0, 120); }
      }
      fp = {
        heading,
        surrounding: (elmt?.closest("p,li,td,blockquote,h1,h2,h3,h4,div")?.textContent || "").slice(0, 400),
        tag: elmt ? elmt.tagName.toLowerCase() : "",
        yr: top / Math.max(1, docH()),
      };
    } catch {}
    return {
      type: "quote",
      exact,
      prefix: idx >= 0 ? text.slice(Math.max(0, idx - 32), idx) : "",
      suffix: idx >= 0 ? text.slice(idx + exact.length, idx + exact.length + 32) : "",
      fp,
    };
  }

  // ---------- similarity helpers (ported) ----------
  const anNorm = (s) => (s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  function anJaccard(a, b) {
    const wa = new Set(anNorm(a).split(" ")), wb = new Set(anNorm(b).split(" "));
    if (!wa.size || !wb.size) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    return inter / (wa.size + wb.size - inter);
  }
  function anLev(a, b) {
    const na = anNorm(a), nb = anNorm(b);
    if (na === nb) return 1;
    const maxLen = Math.max(na.length, nb.length);
    if (!maxLen) return 1;
    if (maxLen > 300) return anJaccard(a, b);
    let prev = Array.from({ length: nb.length + 1 }, (_, j) => j);
    for (let i = 1; i <= na.length; i++) {
      const cur = [i];
      for (let j = 1; j <= nb.length; j++)
        cur[j] = na[i - 1] === nb[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
      prev = cur;
    }
    return 1 - prev[nb.length] / maxLen;
  }

  function rangeAt(map, idx, len) {
    const end = idx + len;
    const range = document.createRange();
    let ok = false;
    for (const m of map) {
      if (m.start <= idx && idx < m.end) { range.setStart(m.node, idx - m.start); ok = true; }
      if (m.start < end && end <= m.end) { range.setEnd(m.node, end - m.start); break; }
    }
    try { return ok && !range.collapsed ? range : null; } catch { return null; }
  }

  // Five-layer anchor resolution (ported from jmkiii/annote):
  // exact+context -> normalized -> Levenshtein fuzzy -> structural fingerprint -> positional -> orphan
  function locateQuote(anchor) {
    const { text, map } = pageText();
    const exact = anchor.exact || "";
    if (!exact) return null;

    // Layer 1: exact occurrences, scored by prefix/suffix context
    const cands = [];
    let from = 0, i;
    while ((i = text.indexOf(exact, from)) !== -1 && cands.length < 50) {
      let score = 0;
      if (anchor.prefix && text.slice(Math.max(0, i - anchor.prefix.length), i) === anchor.prefix) score += 4;
      if (anchor.suffix && text.slice(i + exact.length, i + exact.length + anchor.suffix.length) === anchor.suffix) score += 4;
      cands.push({ i, score });
      from = i + 1;
    }
    if (cands.length) {
      cands.sort((a, b) => b.score - a.score);
      const r = rangeAt(map, cands[0].i, exact.length);
      if (r) return { range: r, confidence: "exact" };
    }

    // Layer 1.5: whitespace/case-insensitive
    {
      const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");
      const nIdx = norm(text).indexOf(norm(exact));
      if (nIdx >= 0) {
        let raw = 0, n = 0;
        while (n < nIdx && raw < text.length) {
          if (/\s/.test(text[raw]) && raw > 0 && /\s/.test(text[raw - 1])) { raw++; continue; }
          raw++; n++;
        }
        const r = rangeAt(map, raw, exact.length);
        if (r) return { range: r, confidence: "exact" };
      }
    }

    // Layer 2: per-node sliding-window Levenshtein (bounded work)
    if (exact.length >= 12) {
      let best = null, bestScore = 0.72, budget = 2500;
      for (const m of map) {
        const content = m.node.data;
        if (content.length < exact.length * 0.5) continue;
        const win = exact.length, step = Math.max(8, win >> 2);
        for (let j = 0; j + win * 0.5 <= content.length && budget > 0; j += step, budget--) {
          const s = anLev(exact, content.substr(j, win + (win >> 2)));
          if (s > bestScore) { bestScore = s; best = { node: m.node, j, len: Math.min(win, content.length - j) }; }
        }
        if (budget <= 0) break;
      }
      if (best) {
        try {
          const r = document.createRange();
          r.setStart(best.node, best.j);
          r.setEnd(best.node, best.j + best.len);
          return { range: r, confidence: "fuzzy" };
        } catch {}
      }
    }

    // Layer 3: structural fingerprint (surrounding-text similarity + tag)
    const fp = anchor.fp;
    if (fp && (fp.heading || fp.surrounding)) {
      let bestB = null, bestS = 0.45;
      for (const b of document.querySelectorAll("p,h1,h2,h3,h4,li,td,blockquote")) {
        if (host.contains(b)) continue;
        let s = 0;
        if (fp.surrounding) s += anJaccard(fp.surrounding, (b.textContent || "").slice(0, 500)) * 5;
        if (fp.heading) s += anJaccard(fp.heading, (b.textContent || "").slice(0, 200));
        if (fp.tag && b.tagName.toLowerCase() === fp.tag) s += 0.5;
        if (s > bestS) { bestS = s; bestB = b; }
      }
      if (bestB) return { block: bestB, confidence: "structural" };
    }

    // Layer 4: document position
    if (fp && typeof fp.yr === "number") {
      const targetY = fp.yr * docH();
      let bestB = null, bestD = Infinity;
      for (const b of document.querySelectorAll("p,h2,h3,li,blockquote")) {
        if (host.contains(b)) continue;
        const d = Math.abs(b.getBoundingClientRect().top + scrollY - targetY);
        if (d < bestD) { bestD = d; bestB = b; }
      }
      if (bestB && bestD < innerHeight * 1.5) return { block: bestB, confidence: "positional" };
    }

    return null; // Layer 5: orphaned
  }

  function anchorPosition(ev) {
    const a = ev.anchor;
    if (!a) return null;
    if (a.type === "point") {
      const [x, y] = fromRef(a.x, a.y);
      return { x, y, rects: [] };
    }
    if (a.type === "quote") {
      const res = locateQuote(a);
      if (!res) return null;
      if (res.range) {
        const rects = [...res.range.getClientRects()].map(r => ({
          x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height,
        }));
        const first = rects[0];
        return first ? { x: first.x + first.w, y: first.y, rects, confidence: res.confidence } : null;
      }
      const r = res.block.getBoundingClientRect();
      return {
        x: r.right + scrollX, y: r.top + scrollY, confidence: res.confidence,
        rects: [{ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }],
      };
    }
    return null;
  }

  // ---------- rendering ----------
  const orphans = [];
  function renderAll() {
    layer.textContent = "";
    layer.style.height = docH() + "px";
    orphans.length = 0;
    state.hlRects.length = 0;
    const hlDivs = []; // for the well-trodden post-pass

    for (const ev of [...live("note"), ...live("media")]) {
      const pos = anchorPosition(ev);
      if (!pos) { orphans.push(ev); continue; }
      state.conf.set(ev.id, pos.confidence || "exact");
      state.pos.set(ev.id, { x: pos.x, y: pos.y });
      const col = authorColor(ev.pubkey);
      const rnd = mulberry(seedFrom(ev.id));
      const approx = pos.confidence && pos.confidence !== "exact";

      // Organic watercolor highlight: irregular blob, ink-bleed edges, hover-intent bubble.
      for (const r of pos.rects) {
        const h = el("div", "an-hl");
        const br = () => (28 + rnd() * 45).toFixed(0);
        Object.assign(h.style, {
          left: (r.x - 3) + "px", top: (r.y - 2) + "px",
          width: (r.w + 6) + "px", height: (r.h + 4) + "px",
          background: col,
          borderRadius: `${br()}% ${br()}% ${br()}% ${br()}% / ${br()}% ${br()}% ${br()}% ${br()}%`,
          transform: `rotate(${((rnd() - 0.5) * 1.2).toFixed(2)}deg)`,
        });
        if (approx) h.classList.add("an-hl-approx");
        state.hlRects.push({ id: ev.id, x: r.x - 3, y: r.y - 2, w: r.w + 6, h: r.h + 4 });
        hlDivs.push({ div: h, id: ev.id, x: r.x - 3, y: r.y - 2, w: r.w + 6, h: r.h + 4, approx });
        let hovT = null;
        h.onmouseenter = (e) => {
          h.classList.add("an-hl-hot");
          if (h.dataset.base) h.style.opacity = Math.min(0.55, parseFloat(h.dataset.base) + 0.14);
          const cx = e.clientX, cy = e.clientY;
          hovT = setTimeout(() => resolveOpen(ev.id, cx, cy), 1100);
        };
        h.onmouseleave = () => {
          h.classList.remove("an-hl-hot");
          if (h.dataset.base) h.style.opacity = h.dataset.base;
          clearTimeout(hovT);
        };
        h.onclick = (e) => { e.stopPropagation(); clearTimeout(hovT); resolveOpen(ev.id, e.clientX, e.clientY); };
        layer.appendChild(h);
      }

      // Vegetation: engagement grows a sprout from the anchor. Consensus curves; contention thorns.
      const veg = sprout(ev,
        pos.rects[0] ? pos.rects[0].x + pos.rects[0].w * 0.3 : pos.x,
        pos.rects[0] ? pos.rects[0].y : pos.y);
      if (veg) layer.appendChild(veg);

      // Quote-anchored notes need no pin — the highlight itself is the affordance.
      if (ev.anchor?.type === "quote" && pos.rects.length) continue;
      const pin = el("div", "an-pin", ev.kind === "media" ? "🖼" : "💬");
      pin.style.background = col;
      const n = childrenOf(ev.id, "reply").length;
      if (n) pin.appendChild(el("span", "an-count", String(n)));
      pin.style.left = pos.x + "px";
      pin.style.top = pos.y + "px";
      if (approx) {
        pin.classList.add("an-approx");
        pin.title = "Approximate match — the page content may have changed";
      }
      pin.onclick = (e) => { e.stopPropagation(); openThread(ev.id); };
      layer.appendChild(pin);
    }
    // Well-trodden text: where highlights overlap, the stain deepens — a path
    // worn into grass. Count distinct other annotations intersecting each blob
    // and scale its resting opacity, so busy passages read darker before any click.
    for (const it of hlDivs) {
      let n = 0;
      const seen = new Set();
      for (const r of state.hlRects) {
        if (r.id === it.id || seen.has(r.id)) continue;
        if (it.x < r.x + r.w && r.x < it.x + it.w && it.y < r.y + r.h && r.y < it.y + it.h) {
          seen.add(r.id); n++;
        }
      }
      if (n > 0) {
        const base = Math.min(0.45, (it.approx ? 0.09 : 0.15) + n * 0.09).toFixed(2);
        it.div.style.animation = "none"; // breathing would fight the inline opacity
        it.div.style.opacity = base;
        it.div.dataset.base = base;
      }
    }
    redrawStrokes();
    updateBarBadge();
  }

  // When highlights overlap, let the reader choose which annotation to open.
  const picker = el("div", "an-picker");
  picker.style.display = "none";
  ui.appendChild(picker);
  function hidePicker() { picker.style.display = "none"; }
  document.addEventListener("click", (e) => { if (!e.composedPath().includes(host)) hidePicker(); }, true);
  addEventListener("scroll", hidePicker, { passive: true });

  function overlappingAt(px, py) {
    const ids = [];
    for (const r of state.hlRects)
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h && !ids.includes(r.id)) ids.push(r.id);
    return ids;
  }

  function resolveOpen(id, clientX, clientY) {
    const ids = overlappingAt(clientX + scrollX, clientY + scrollY);
    if (ids.length <= 1) { hidePicker(); openThread(id); return; }
    picker.textContent = "";
    picker.appendChild(el("div", "an-meta an-pickhead", `${ids.length} annotations here`));
    for (const oid of ids) {
      const oev = state.events.get(oid);
      if (!oev) continue;
      const row = el("button", "an-branch");
      const d = el("span", "an-dot");
      d.style.background = authorColor(oev.pubkey);
      row.appendChild(d);
      const mine = oev.pubkey === state.pubkey;
      row.appendChild(el("span", "an-branchtxt",
        `${mine ? "you" : short(oev.pubkey)}: ${(oev.content?.text || "").slice(0, 60)}`));
      const n = childrenOf(oid, "reply").length;
      if (n) row.appendChild(el("span", "an-branchsub", `↑${n}`));
      row.onclick = (e) => { e.stopPropagation(); hidePicker(); openThread(oid); };
      picker.appendChild(row);
    }
    picker.style.left = Math.max(8, Math.min(innerWidth - 300, clientX + 10)) + "px";
    picker.style.top = Math.max(8, Math.min(innerHeight - 220, clientY + 12)) + "px";
    picker.style.display = "block";
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function sprout(ev, baseX, baseY) {
    const reacts = childrenOf(ev.id, "react");
    const ups = reacts.filter(e => e.content?.up !== -1).length;
    const downs = reacts.length - ups;
    const energy = childrenOf(ev.id, "reply").length * 2 + ups;
    if (energy < 1) return null;
    const thorny = downs > ups;
    const rnd = mulberry(seedFrom(ev.id));
    const col = authorColor(ev.pubkey);
    const H = Math.min(80, 16 + energy * 8), W = 90;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.setAttribute("class", "an-veg");
    svg.style.left = (baseX - W / 2) + "px";
    svg.style.top = (baseY - H) + "px";
    const grow = (x, y, angle, len, depth, width) => {
      if (depth <= 0 || len < 2.5) return;
      const wob = (rnd() - 0.5) * (thorny ? 1.5 : 0.6);
      const a2 = angle + wob;
      const ex = x + Math.cos(a2) * len, ey = y + Math.sin(a2) * len;
      const cx = x + Math.cos(angle + wob * 1.8) * len * 0.6, cy = y + Math.sin(angle + wob * 1.8) * len * 0.6;
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", `M${x.toFixed(1)} ${y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
      p.setAttribute("stroke", col);
      p.setAttribute("stroke-width", width.toFixed(1));
      p.setAttribute("fill", "none");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("opacity", thorny ? "0.5" : "0.45");
      svg.appendChild(p);
      if (!thorny && depth === 1 && rnd() > 0.3) {
        const leaf = document.createElementNS(SVGNS, "circle");
        leaf.setAttribute("cx", ex.toFixed(1)); leaf.setAttribute("cy", ey.toFixed(1));
        leaf.setAttribute("r", (1.5 + rnd() * 2.2).toFixed(1));
        leaf.setAttribute("fill", col); leaf.setAttribute("opacity", "0.3");
        svg.appendChild(leaf);
      }
      const spread = thorny ? 0.85 + rnd() * 0.3 : 0.3 + rnd() * 0.25;
      grow(ex, ey, a2 - spread, len * 0.72, depth - 1, width * 0.7);
      if (rnd() > 0.25) grow(ex, ey, a2 + spread, len * 0.72, depth - 1, width * 0.7);
    };
    grow(W / 2, H, -Math.PI / 2, H * 0.42, Math.min(4, 1 + Math.ceil(energy / 3)), 2.2);
    return svg;
  }

  function updateBarBadge() {
    const n = live("note").length + live("media").length + live("draw").length;
    bar.dataset.count = n || "";
    bar.classList.toggle("an-has", n > 0);
  }

  // ---------- thought bubble: climbable tree threading ----------
  // The trunk is the original annotation. Climbing into a reply narrows focus to that
  // branch; the trunk stays visible as a slim bar; back climbs down one level.
  const panel = el("div", "an-panel");
  panel.style.display = "none";
  ui.appendChild(panel);

  function openThread(id) {
    if (!state.events.get(id)) return;
    if (!Array.isArray(state.threadPath) || state.threadPath[state.threadPath.length - 1] !== id)
      state.threadPath = [id];
    renderThread();
  }

  function positionBubble() {
    const rootId = state.threadPath && state.threadPath[0];
    const pos = rootId && state.pos.get(rootId);
    if (pos) {
      let left = pos.x - scrollX + 14, top = pos.y - scrollY + 16;
      left = Math.max(8, Math.min(innerWidth - 356, left));
      top = Math.max(8, Math.min(innerHeight - 340, top));
      panel.style.left = left + "px"; panel.style.top = top + "px"; panel.style.right = "auto";
    } else {
      panel.style.left = "auto"; panel.style.right = "12px"; panel.style.top = "12px";
    }
  }

  function renderThread() {
    const path = state.threadPath;
    const ev = path && state.events.get(path[path.length - 1]);
    if (!ev) return;
    state.openThread = ev.id;
    sidebarOpen = false;
    panel.textContent = "";
    panel.className = "an-panel an-bubble";
    panel.style.display = "block";
    positionBubble();

    const deep = path.length > 1;
    const root = state.events.get(path[0]);
    if (deep && root) {
      const trunk = el("div", "an-trunk", `⌄ trunk · “${(root.content?.text || "…").slice(0, 56)}”`);
      trunk.title = "Back to the trunk";
      trunk.onclick = () => { state.threadPath = [path[0]]; renderThread(); };
      panel.appendChild(trunk);
    }

    const head = el("div", "an-head");
    const who = el("div", "an-meta an-who");
    const dot = el("span", "an-dot");
    const col = authorColor(ev.pubkey);
    dot.style.background = col;
    dot.style.boxShadow = `0 0 8px ${col}`;
    who.append(dot, document.createTextNode(` ${short(ev.pubkey)} · ${new Date(ev.created).toLocaleDateString()}`));
    head.appendChild(who);
    const hbtns = el("div", "an-acts");
    if (deep) {
      const back = el("button", "an-mini", "‹ climb down");
      back.onclick = () => { state.threadPath.pop(); renderThread(); };
      hbtns.appendChild(back);
    }
    const x = el("button", "an-mini", "✕");
    x.onclick = closePanel;
    hbtns.appendChild(x);
    head.appendChild(hbtns);
    panel.appendChild(head);

    if (ev.kind === "media" && /^data:image\//.test(ev.content?.dataUrl || "")) {
      const img = el("img", "an-img");
      img.src = ev.content.dataUrl;
      panel.appendChild(img);
    } else {
      panel.appendChild(el("div", "an-thought", ev.content?.text || ""));
    }
    if (!deep && ev.anchor?.type === "quote")
      panel.appendChild(el("div", "an-quote", `“${ev.anchor.exact.slice(0, 120)}”`));
    const conf = state.conf.get(ev.id);
    if (!deep && conf && conf !== "exact")
      panel.appendChild(el("div", "an-warn",
        conf === "fuzzy" ? "⚠ Approximate text match" :
        conf === "structural" ? "⚠ Structural match — original text may have changed" :
        "⚠ Position match — content may have shifted"));

    const acts = el("div", "an-acts");
    const reacts = childrenOf(ev.id, "react");
    const ups = reacts.filter(e => e.content?.up !== -1).length;
    const downs = reacts.length - ups;
    const upBtn = el("button", "an-mini", `▲ ${ups}`);
    upBtn.title = "Agree (mints NOTE to the author)";
    upBtn.onclick = () => publish({ kind: "react", refs: [ev.id], content: { up: 1 } });
    const downBtn = el("button", "an-mini", `▼ ${downs}`);
    downBtn.title = "Disagree (social signal only — never mints)";
    downBtn.onclick = () => publish({ kind: "react", refs: [ev.id], content: { up: -1 } });
    acts.append(upBtn, downBtn);
    if (ev.pubkey === state.pubkey) {
      const del = el("button", "an-mini", "delete");
      del.onclick = () => { publish({ kind: "delete", refs: [ev.id], content: {} }); closePanel(); };
      acts.appendChild(del);
    }
    panel.appendChild(acts);

    const branches = childrenOf(ev.id, "reply").sort((a, b) => a.created - b.created);
    if (branches.length)
      panel.appendChild(el("div", "an-meta an-branchlbl", `↑ ${branches.length} branch${branches.length === 1 ? "" : "es"}`));
    for (const r of branches) {
      const row = el("button", "an-branch");
      const rd = el("span", "an-dot");
      rd.style.background = authorColor(r.pubkey);
      row.appendChild(rd);
      row.appendChild(el("span", "an-branchtxt", (r.content?.text || "").slice(0, 90)));
      const subs = childrenOf(r.id, "reply").length;
      if (subs) row.appendChild(el("span", "an-branchsub", `↑${subs}`));
      row.onclick = () => { state.threadPath.push(r.id); renderThread(); };
      panel.appendChild(row);
    }

    const box = el("textarea", "an-input");
    box.placeholder = deep ? "Grow this branch…" : "Add a branch…";
    const send = el("button", "an-send", "Reply");
    send.onclick = () => {
      if (box.value.trim()) publish({ kind: "reply", refs: [ev.id], content: { text: box.value.trim() } });
      box.value = "";
    };
    panel.append(box, send);
  }

  function headerRow(title) {
    const h = el("div", "an-head");
    h.appendChild(el("b", null, title));
    const x = el("button", "an-mini", "✕");
    x.onclick = closePanel;
    h.appendChild(x);
    return h;
  }
  function closePanel() {
    panel.style.display = "none";
    panel.className = "an-panel";
    state.openThread = null; state.threadPath = null; sidebarOpen = false;
  }

  // ---------- sidebar (list + page rating + orphans) ----------
  let sidebarOpen = false;
  function togglePanel() {
    if (sidebarOpen) return closePanel();
    sidebarOpen = true; state.openThread = null; state.threadPath = null;
    panel.className = "an-panel";
    panel.style.left = "auto"; panel.style.right = "12px"; panel.style.top = "12px";
    panel.textContent = "";
    panel.style.display = "block";
    panel.appendChild(headerRow("Annote — this page"));
    const rc = state.relayCount || 0;
    panel.appendChild(el("div", "an-meta", state.pageId
      ? `background ✓ · ${rc} relay(s)${rc ? "" : " — sharing OFFLINE: start the relay to sync across browsers"}`
      : "⚠ background not connected — saves are queued"));

    // page rating
    const ratings = live("rate").filter(e => e.page === state.pageId && !e.refs?.length);
    const avg = ratings.length ? ratings.reduce((s, e) => s + (e.content?.stars || 0), 0) / ratings.length : 0;
    const mine = ratings.filter(e => e.pubkey === state.pubkey).sort((a, b) => b.created - a.created)[0];
    const rateRow = el("div", "an-item");
    const label = ratings.length
      ? `Page rating ${avg.toFixed(1)}★ (${ratings.length})${mine ? ` · yours: ${mine.content.stars}★` : ""}`
      : "No ratings yet — click a star to rate this page";
    rateRow.appendChild(el("div", "an-meta", label));
    const stars = el("div", "an-stars");
    const shown = mine ? mine.content.stars : Math.round(avg);
    for (let i = 1; i <= 5; i++) {
      const s = el("span", "an-star", i <= shown ? "★" : "☆");
      s.title = `Rate ${i}★`;
      s.onclick = () => { publish({ kind: "rate", content: { stars: i } }); toast(`Rating ${i}★…`); };
      stars.appendChild(s);
    }
    rateRow.appendChild(stars);
    panel.appendChild(rateRow);

    const list = [...live("note"), ...live("media")].sort((a, b) => b.created - a.created);
    for (const ev of list) {
      const row = el("div", "an-item an-rowlink");
      row.appendChild(el("div", "an-meta", `${short(ev.pubkey)} · ${childrenOf(ev.id, "react").length}▲`));
      row.appendChild(el("div", "an-text", ev.kind === "media" ? "🖼 picture" : (ev.content?.text || "").slice(0, 80)));
      row.onclick = () => {
        const pos = anchorPosition(ev);
        if (pos) scrollTo({ top: pos.y - 200, behavior: "smooth" });
        openThread(ev.id);
      };
      panel.appendChild(row);
    }
    const draws = live("draw").length;
    if (draws) panel.appendChild(el("div", "an-item an-meta", `✏️ ${draws} drawing layer(s) on this page`));
    if (orphans.length) {
      panel.appendChild(el("div", "an-meta an-orph", `⚠ ${orphans.length} annotation(s) lost their spot on this page:`));
      for (const ev of orphans) {
        const row = el("div", "an-item an-rowlink");
        row.appendChild(el("div", "an-text", (ev.content?.text || "🖼 picture").slice(0, 80)));
        row.onclick = () => openThread(ev.id);
        if (ev.pubkey === state.pubkey && ev.kind === "note") {
          const rb = el("button", "an-mini", "🔗 re-anchor");
          rb.onclick = (e) => {
            e.stopPropagation();
            state.reanchor = ev.id;
            closePanel();
            toast("Re-anchor: select the new text, then click “Annote ✎”.");
          };
          row.appendChild(rb);
        }
        panel.appendChild(row);
      }
    }
    if (!list.length && !orphans.length && !draws)
      panel.appendChild(el("div", "an-item an-meta", "Nothing here yet. Select text, or use 📌 ✏️ 🖼 to be first — pioneers earn NOTE."));
  }

  // ---------- drawing ----------
  const drawUI = el("div", "an-drawui");
  drawUI.style.display = "none";
  let penColor = "#e33", penWidth = 6, pickingColor = false;
  const curSwatch = el("span", "an-cur");
  curSwatch.title = "Current ink";
  curSwatch.style.background = penColor;
  drawUI.appendChild(curSwatch);
  const setPen = (c) => { penColor = c; curSwatch.style.background = c; };
  for (const c of ["#e33", "#27c", "#2a2", "#f90", "#000"]) {
    const sw = el("button", "an-swatch");
    sw.style.background = c;
    sw.onclick = () => setPen(c);
    drawUI.appendChild(sw);
  }
  const dropBtn = el("button", "an-btn", "💧");
  dropBtn.title = "Eyedropper — draw only in the page's own colors";
  dropBtn.onclick = () => {
    pickingColor = true;
    dropBtn.classList.add("an-on");
    toast("Click anywhere to sample the page's ink");
  };
  drawUI.appendChild(dropBtn);
  const doneBtn = el("button", "an-send", "Save drawing");
  drawUI.appendChild(doneBtn);
  ui.appendChild(drawUI);

  // Sample the page's own palette: text color if there's text, else nearest opaque background.
  function samplePageColor(cx, cy) {
    host.style.display = "none";
    const elmt = document.elementFromPoint(cx, cy);
    host.style.display = "";
    if (!elmt) return null;
    const transparent = (c) => !c || c === "transparent" || /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c);
    const cs = getComputedStyle(elmt);
    const hasText = [...elmt.childNodes].some(n => n.nodeType === 3 && n.data.trim());
    if (hasText && !transparent(cs.color)) return cs.color;
    for (let cur = elmt; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return transparent(cs.color) ? "#000" : cs.color;
  }

  let currentStrokes = [], activeStroke = null;
  let inkT = 0, inkX = 0, inkY = 0, inkA = 1; // speed→opacity state
  function sizeCanvas() {
    drawCanvas.width = innerWidth * devicePixelRatio;
    drawCanvas.height = innerHeight * devicePixelRatio;
    drawCanvas.style.width = innerWidth + "px";
    drawCanvas.style.height = innerHeight + "px";
    redrawStrokes();
  }
  function redrawStrokes() {
    const ctx = drawCanvas.getContext("2d");
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineCap = ctx.lineJoin = "round";
    const s = scale();
    const paint = (strokes) => {
      for (const st of strokes) {
        ctx.strokeStyle = st.color;
        let px = null, py = null;
        for (const p of st.points) {
          const x = p[0] * s - scrollX, y = p[1] * s - scrollY;
          if (px !== null) {
            const a = p.length > 2 ? p[2] : 1;
            ctx.globalAlpha = a;
            ctx.lineWidth = st.width * (0.55 + 0.45 * a); // pressure look: faint ink is thinner
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          px = x; py = y;
        }
      }
      ctx.globalAlpha = 1;
    };
    for (const ev of live("draw")) paint(ev.content?.strokes || []);
    paint(currentStrokes);
    if (activeStroke) paint([activeStroke]);
  }
  drawCanvas.addEventListener("pointerdown", (e) => {
    if (state.mode !== "draw") return;
    if (pickingColor) {
      pickingColor = false;
      dropBtn.classList.remove("an-on");
      const c = samplePageColor(e.clientX, e.clientY);
      if (c) { setPen(c); toast(`Ink sampled from the page`); }
      return;
    }
    inkT = e.timeStamp; inkX = e.pageX; inkY = e.pageY; inkA = 1;
    activeStroke = { color: penColor, width: penWidth, points: [[...toRef(e.pageX, e.pageY), 1]] };
    drawCanvas.setPointerCapture(e.pointerId);
  });
  drawCanvas.addEventListener("pointermove", (e) => {
    if (!activeStroke) return;
    // Ink physics: fast strokes fade, slow deliberate strokes lay down solid ink.
    const dt = Math.max(1, e.timeStamp - inkT);
    const dist = Math.hypot(e.pageX - inkX, e.pageY - inkY);
    const speed = dist / dt; // px/ms
    const target = Math.max(0.06, Math.min(1, 1 - speed / 2.5));
    inkA = inkA * 0.65 + target * 0.35; // smoothed so ink doesn't flicker
    inkT = e.timeStamp; inkX = e.pageX; inkY = e.pageY;
    activeStroke.points.push([...toRef(e.pageX, e.pageY), Math.round(inkA * 100) / 100]);
    redrawStrokes();
  });
  drawCanvas.addEventListener("pointerup", () => {
    if (activeStroke && activeStroke.points.length > 1) currentStrokes.push(activeStroke);
    activeStroke = null;
    redrawStrokes();
  });
  doneBtn.onclick = () => {
    if (currentStrokes.length)
      publish({ kind: "draw", anchor: { type: "doc" }, content: { strokes: currentStrokes } });
    currentStrokes = [];
    setMode("browse");
  };

  // ---------- reflow handling ----------
  let rAF = null;
  addEventListener("scroll", () => { cancelAnimationFrame(rAF); rAF = requestAnimationFrame(redrawStrokes); }, { passive: true });
  let resizeT = null;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { sizeCanvas(); renderAll(); }, 250); });
  sizeCanvas();
  connectPort();

  // ---------- styles ----------
  function CSS_TEXT() { return `
    * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
    .an-layer { position:absolute; top:0; left:0; width:100%; pointer-events:none; }
    .an-canvas { position:fixed; top:0; left:0; pointer-events:none; z-index:1; }
    .an-ui { position:fixed; top:0; left:0; width:0; height:0; z-index:3; }
    .an-bar { position:fixed; bottom:18px; right:18px; display:flex; gap:6px; background:#1b1b1f; padding:8px;
      border-radius:24px; box-shadow:0 4px 18px rgba(0,0,0,.35); pointer-events:auto; }
    .an-bar.an-has::after { content: attr(data-count); position:absolute; top:-6px; right:-2px; background:#e33;
      color:#fff; font-size:11px; border-radius:10px; padding:1px 6px; }
    .an-btn { background:none; border:none; font-size:18px; cursor:pointer; border-radius:16px; padding:4px 8px; }
    .an-btn:hover, .an-btn.an-on { background:#3a3a44; }
    .an-selbtn { position:fixed; z-index:4; background:#1b1b1f; color:#fff; border:none; border-radius:14px;
      padding:4px 10px; font-size:12px; cursor:pointer; pointer-events:auto; }
    .an-pin { position:absolute; transform:translate(-4px,-100%); background:#ffd54a; border-radius:10px 10px 10px 2px;
      padding:2px 6px; font-size:13px; cursor:pointer; pointer-events:auto; box-shadow:0 2px 6px rgba(0,0,0,.3); }
    .an-pin.an-approx { background:#ffb14a; outline:2px dashed rgba(170,102,0,.8); }
    .an-warn { color:#a60; font-size:11px; margin-top:4px; }
    .an-count { background:#e33; color:#fff; font-size:10px; border-radius:8px; padding:0 4px; margin-left:3px; }
    .an-hl { position:absolute; background:rgba(255,213,74,.32); border-bottom:2px solid rgba(230,170,0,.8); pointer-events:none; }
    .an-panel { position:fixed; top:12px; right:12px; width:320px; max-height:80vh; overflow:auto; background:#fff;
      color:#111; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.35); padding:10px; pointer-events:auto; font-size:13px; }
    .an-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
    .an-item { border-top:1px solid #eee; padding:8px 2px; }
    .an-reply { margin-left:14px; }
    .an-rowlink { cursor:pointer; } .an-rowlink:hover { background:#f6f6f6; }
    .an-meta { color:#777; font-size:11px; margin-bottom:3px; }
    .an-text { white-space:pre-wrap; word-wrap:break-word; }
    .an-quote { color:#875; font-size:11px; font-style:italic; margin-top:4px; }
    .an-img { max-width:100%; border-radius:6px; margin-top:4px; }
    .an-acts { margin-top:6px; display:flex; gap:6px; }
    .an-mini { background:#f0f0f2; border:none; border-radius:8px; padding:2px 8px; cursor:pointer; font-size:12px; }
    .an-input { width:100%; min-height:48px; margin-top:8px; border:1px solid #ddd; border-radius:8px; padding:6px; font-size:13px; }
    .an-send { margin-top:6px; background:#1b1b1f; color:#fff; border:none; border-radius:8px; padding:5px 12px; cursor:pointer; }
    .an-stars { font-size:22px; cursor:pointer; color:#e6aa00; margin-top:2px; user-select:none; }
    .an-star:hover { transform:scale(1.15); display:inline-block; }
    .an-orph { margin-top:10px; color:#a60; }
    .an-drawui { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); display:flex; gap:8px; align-items:center;
      background:#1b1b1f; padding:8px 12px; border-radius:20px; pointer-events:auto; }
    .an-swatch { width:22px; height:22px; border-radius:50%; border:2px solid #fff; cursor:pointer; }
    .an-cur { width:24px; height:24px; border-radius:50%; border:2px dashed #999; display:inline-block; }
    .an-toast { position:fixed; bottom:74px; right:18px; background:#1b1b1f; color:#9f9; padding:6px 14px;
      border-radius:14px; font-size:12px; pointer-events:none; box-shadow:0 4px 14px rgba(0,0,0,.35); }
    .an-toast.an-terr { color:#f99; }

    /* ---------- organic layer: earth tones, frosted glass, watercolor ---------- */
    .an-hl {
      opacity:.15; filter:url(#an-bleed); pointer-events:auto; cursor:pointer;
      border-bottom:none; transition:opacity .45s ease; animation:an-breathe 8s ease-in-out infinite;
    }
    .an-hl-hot { opacity:.34; animation:none; }
    /* drifted anchors: no warning borders — the stain just washes out, like a fading memory */
    .an-hl.an-hl-approx { opacity:.09; filter:url(#an-bleed) blur(2.5px); }
    .an-hl.an-hl-approx.an-hl-hot { opacity:.22; }
    @keyframes an-breathe { 0%,100% { opacity:.13; } 50% { opacity:.20; } }
    .an-veg { position:absolute; pointer-events:none; overflow:visible; filter:url(#an-bleed); }
    .an-pin { background:#bc6c25; color:#f6efe0; border-radius:12px 12px 12px 3px; }
    .an-panel {
      background:rgba(26,28,22,.78); color:#efece2;
      backdrop-filter:blur(16px) saturate(1.15); -webkit-backdrop-filter:blur(16px) saturate(1.15);
      border:1px solid rgba(255,255,255,.13); border-radius:22px;
      box-shadow:0 22px 60px rgba(0,0,0,.45);
    }
    .an-bubble { position:fixed; width:340px; }
    .an-trunk {
      font:italic 11px Georgia, serif; color:rgba(239,236,226,.6);
      border-bottom:1px solid rgba(255,255,255,.1); padding:2px 2px 8px; margin-bottom:8px;
      cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .an-trunk:hover { color:rgba(239,236,226,.95); }
    .an-dot { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:2px; vertical-align:-1px; }
    .an-who { display:flex; align-items:center; gap:5px; }
    .an-thought { font:italic 16px/1.55 Georgia, 'Iowan Old Style', serif; color:#f4f1e7; margin:10px 2px 4px; white-space:pre-wrap; }
    .an-branchlbl { margin-top:12px; letter-spacing:.06em; text-transform:uppercase; font-size:9px; }
    .an-branch {
      display:flex; align-items:center; gap:8px; width:100%; text-align:left; margin-top:6px;
      background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.07);
      border-radius:14px; padding:9px 12px; color:rgba(239,236,226,.75);
      font-size:12px; cursor:pointer; transition:background .25s, transform .25s;
    }
    .an-branch:hover { background:rgba(255,255,255,.11); color:#fff; transform:translateX(3px); }
    .an-branchtxt { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .an-branchsub { font-size:9px; font-weight:700; color:rgba(221,161,94,.9); }
    .an-panel .an-item { border-top:1px solid rgba(255,255,255,.08); }
    .an-panel .an-rowlink:hover { background:rgba(255,255,255,.06); }
    .an-panel .an-meta { color:#b6b09c; }
    .an-panel .an-text { color:#efece2; }
    .an-panel .an-quote { color:#cbb08a; }
    .an-panel .an-mini { background:rgba(255,255,255,.09); color:#efece2; }
    .an-panel .an-mini:hover { background:rgba(255,255,255,.18); }
    .an-panel .an-input {
      background:rgba(0,0,0,.25); border:1px solid rgba(255,255,255,.12); color:#f4f1e7;
      margin-top:10px; border-radius:12px;
    }
    .an-panel .an-input::placeholder { color:rgba(239,236,226,.35); }
    .an-send { background:#606c38; color:#f6efe0; }
    .an-send:hover { background:#71813f; }
    .an-stars { color:#dda15e; }
    .an-picker {
      position:fixed; width:280px; z-index:6; pointer-events:auto; padding:8px 10px;
      background:rgba(26,28,22,.88); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
      border:1px solid rgba(255,255,255,.14); border-radius:16px;
      box-shadow:0 16px 44px rgba(0,0,0,.5); color:#efece2;
    }
    .an-pickhead { letter-spacing:.06em; text-transform:uppercase; font-size:9px; color:#b6b09c; margin-bottom:4px; }
    .an-bar { background:#1c1e18; border:1px solid rgba(255,255,255,.08); }
    .an-btn:hover, .an-btn.an-on { background:rgba(221,161,94,.25); }
  `; }
})();
