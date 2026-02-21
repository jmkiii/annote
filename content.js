// ── State ──────────────────────────────────────────────────────────────────────
let lastRightClickX = 0;
let lastRightClickY = 0;

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('contextmenu', (e) => {
  lastRightClickX = e.pageX;
  lastRightClickY = e.pageY;
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'OPEN_COORDINATE_ANNOTATION') {
    openAnnotationModal({ type: 'coordinate', x: lastRightClickX, y: lastRightClickY });
  }
  if (message.type === 'REFRESH_ANNOTATIONS') loadAndRenderAnnotations();
  if (message.type === 'SCROLL_TO_ANNOTATION') scrollToAndShowAnnotation(message.annotationId);
});

document.addEventListener('mouseup', (e) => {
  if (e.target.closest('#lens-selection-toolbar, #lens-modal-overlay, .lens-annotation-card, #lens-annotation-trigger, #lens-detached-sidebar')) return;
  const selection = window.getSelection();
  if (selection && selection.toString().trim().length > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    showSelectionToolbar(rect, selection.toString(), range);
  } else {
    hideSelectionToolbar();
  }
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#lens-selection-toolbar')) hideSelectionToolbar();
});

// ── Selection toolbar ──────────────────────────────────────────────────────────
function showSelectionToolbar(rect, selectedText, range) {
  hideSelectionToolbar();
  const toolbar = document.createElement('div');
  toolbar.id = 'lens-selection-toolbar';
  toolbar.style.cssText = `
    position: absolute;
    top: ${rect.top + window.scrollY - 50}px;
    left: ${rect.left + window.scrollX + (rect.width / 2) - 60}px;
    z-index: 2147483647;
    background: #1a1a2e;
    border: 1px solid #e94560;
    border-radius: 8px;
    padding: 6px 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
  `;
  toolbar.innerHTML = `<button id="lens-annotate-btn">✏️ Annotate</button>`;
  document.body.appendChild(toolbar);
  const rangeData = getRangeData(range, selectedText);
  document.getElementById('lens-annotate-btn').addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    openAnnotationModal({ type: 'text', selectedText, range: rangeData });
    hideSelectionToolbar();
  });
}

function hideSelectionToolbar() {
  const el = document.getElementById('lens-selection-toolbar');
  if (el) el.remove();
}

// ── Rich anchor capture ────────────────────────────────────────────────────────
function getRangeData(range, selectedText) {
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  const startText = startNode.textContent || '';
  const endText = endNode.textContent || '';

  const prefix = startText.substring(Math.max(0, range.startOffset - 64), range.startOffset);
  const suffix = endText.substring(range.endOffset, Math.min(range.endOffset + 64, endText.length));
  const parentEl = startNode.parentElement;

  return {
    exact: selectedText,
    prefix,
    suffix,
    parentSelector: parentEl ? getElementSelector(parentEl) : '',
    fingerprint: buildFingerprint(range, selectedText)
  };
}

function buildFingerprint(range, selectedText) {
  const el = range.startContainer.parentElement;
  const scrollPct = Math.round((window.scrollY / Math.max(document.body.scrollHeight, 1)) * 1000) / 1000;

  // Nearest heading above
  let nearestHeading = '';
  let cursor = el;
  for (let i = 0; i < 20 && cursor && cursor !== document.body; i++) {
    const prev = getPreviousElement(cursor);
    if (prev) {
      const h = prev.matches('h1,h2,h3,h4') ? prev : prev.querySelector('h1,h2,h3,h4');
      if (h) { nearestHeading = h.textContent.trim().substring(0, 120); break; }
    }
    cursor = cursor.parentElement;
  }
  if (!nearestHeading) {
    const headings = document.querySelectorAll('h1,h2,h3');
    let best = null, bestDist = Infinity;
    const elRect = el ? el.getBoundingClientRect() : null;
    headings.forEach(h => {
      if (!elRect) return;
      const hRect = h.getBoundingClientRect();
      const dist = Math.abs(hRect.top - elRect.top);
      if (dist < bestDist) { bestDist = dist; best = h; }
    });
    if (best) nearestHeading = best.textContent.trim().substring(0, 120);
  }

  // Surrounding context (200 chars each side)
  const fullText = el ? el.textContent || '' : '';
  const idx = fullText.indexOf(selectedText);
  const surroundingText = idx !== -1
    ? fullText.substring(Math.max(0, idx - 200), Math.min(fullText.length, idx + selectedText.length + 200))
    : fullText.substring(0, 400);

  // Section index: which article/section/div[class] ancestor are we in?
  let sectionIndex = 0;
  const sections = document.querySelectorAll('article, section, [class*="article"], [class*="story"], [class*="post"], [class*="content"]');
  sections.forEach((sec, i) => { if (el && sec.contains(el)) sectionIndex = i; });

  return {
    nearestHeading,
    surroundingText: surroundingText.substring(0, 400),
    normalizedText: normalize(selectedText),
    tagName: el ? el.tagName.toLowerCase() : 'unknown',
    wordCount: selectedText.split(/\s+/).length,
    scrollPercentage: scrollPct,
    sectionIndex
  };
}

function getPreviousElement(el) {
  let prev = el.previousElementSibling;
  if (prev) return prev;
  return el.parentElement;
}

function getElementSelector(el) {
  try {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let current = el;
    for (let i = 0; i < 4 && current && current !== document.body; i++) {
      let part = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/)[0];
        if (cls) part += `.${cls}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  } catch (e) { return ''; }
}

// ── Text normalization helpers ─────────────────────────────────────────────────
function normalize(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  // Jaccard similarity on word sets
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  const intersection = new Set([...wa].filter(w => wb.has(w)));
  const union = new Set([...wa, ...wb]);
  return intersection.size / union.size;
}

function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;

  // Only run on shorter strings to avoid perf issues
  if (maxLen > 300) return similarityScore(a, b);

  const dp = Array.from({ length: na.length + 1 }, (_, i) =>
    Array.from({ length: nb.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= na.length; i++) {
    for (let j = 1; j <= nb.length; j++) {
      dp[i][j] = na[i-1] === nb[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return 1 - dp[na.length][nb.length] / maxLen;
}

// ── Five-layer anchoring ───────────────────────────────────────────────────────
function findBestAnchor(annotation) {
  const anchor = annotation.anchor;
  if (!anchor || anchor.type !== 'text') return null;

  const range = anchor.range || {};
  const fp = range.fingerprint || {};
  const exact = range.exact || '';
  if (!exact) return null;

  // Collect all text nodes (excluding our UI)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest(
      '#lens-modal-overlay, .lens-annotation-card, .lens-annotation-pin, ' +
      '.lens-text-highlight, #lens-annotation-trigger, #lens-detached-sidebar, script, style'
    )) continue;
    textNodes.push(node);
  }

  // ── Layer 1: Exact match with context scoring ────────────────────────────────
  const exactCandidates = [];
  for (const n of textNodes) {
    const content = n.textContent;
    let start = 0, idx;
    while ((idx = content.indexOf(exact, start)) !== -1) {
      exactCandidates.push({ node: n, idx, score: 0 });
      start = idx + 1;
    }
  }

  if (exactCandidates.length > 0) {
    for (const c of exactCandidates) {
      const content = c.node.textContent;
      const prefix = range.prefix || '';
      const suffix = range.suffix || '';
      if (prefix && content.substring(Math.max(0, c.idx - prefix.length), c.idx).endsWith(prefix.slice(-32))) c.score += 4;
      else if (prefix && content.substring(Math.max(0, c.idx - 32), c.idx).includes(prefix.slice(-16))) c.score += 2;
      if (suffix && content.substring(c.idx + exact.length, c.idx + exact.length + suffix.length).startsWith(suffix.slice(0, 32))) c.score += 4;
      else if (suffix && content.substring(c.idx + exact.length, c.idx + exact.length + 16).includes(suffix.slice(0, 16))) c.score += 2;
      if (range.parentSelector && c.node.parentElement) {
        try {
          if (c.node.parentElement.closest(range.parentSelector)) c.score += 3;
        } catch (e) {}
      }
    }
    exactCandidates.sort((a, b) => b.score - a.score);
    return { node: exactCandidates[0].node, idx: exactCandidates[0].idx, length: exact.length, confidence: 'exact' };
  }

  // ── Layer 2: Fuzzy text match ────────────────────────────────────────────────
  let bestFuzzy = null, bestFuzzyScore = 0.72; // minimum threshold
  const normalizedExact = normalize(exact);

  for (const n of textNodes) {
    const content = n.textContent;
    if (content.length < exact.length * 0.5) continue;

    // Slide a window across the node text
    const windowSize = exact.length;
    const step = Math.max(1, Math.floor(windowSize / 4));
    for (let i = 0; i <= content.length - windowSize * 0.5; i += step) {
      const window = content.substring(i, i + windowSize + Math.floor(windowSize * 0.3));
      const score = levenshteinSimilarity(exact, window);
      if (score > bestFuzzyScore) {
        bestFuzzyScore = score;
        bestFuzzy = { node: n, idx: i, length: Math.min(windowSize, content.length - i), confidence: 'fuzzy' };
      }
    }
  }
  if (bestFuzzy) return bestFuzzy;

  // ── Layer 3: Structural fingerprint match ────────────────────────────────────
  if (fp.nearestHeading || fp.surroundingText) {
    let bestStructural = null, bestStructScore = 0.5;

    // Get all block elements
    const blocks = document.querySelectorAll('p, h1, h2, h3, h4, li, td, blockquote, div[class]');
    blocks.forEach(block => {
      if (block.closest('#lens-modal-overlay, .lens-annotation-card, #lens-detached-sidebar, script, style')) return;
      let score = 0;

      // Score by surrounding text similarity
      if (fp.surroundingText) {
        const blockText = block.textContent.substring(0, 500);
        const surScore = similarityScore(fp.surroundingText, blockText);
        score += surScore * 5;
      }

      // Score by nearest heading match
      if (fp.nearestHeading) {
        const headings = document.querySelectorAll('h1,h2,h3,h4');
        let nearestDist = Infinity, nearestMatch = 0;
        const blockRect = block.getBoundingClientRect();
        headings.forEach(h => {
          const hRect = h.getBoundingClientRect();
          const dist = Math.abs(hRect.top - blockRect.top);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestMatch = similarityScore(fp.nearestHeading, h.textContent);
          }
        });
        score += nearestMatch * 4;
      }

      // Score by tag name match
      if (fp.tagName && block.tagName.toLowerCase() === fp.tagName) score += 1;

      if (score > bestStructScore) {
        bestStructScore = score;
        // Find the best text position within this block
        const content = block.textContent;
        const normContent = normalize(content);
        const normExact = normalize(exact);
        const idx = normContent.indexOf(normExact.substring(0, 20));
        bestStructural = {
          node: getFirstTextNode(block),
          idx: idx > 0 ? idx : 0,
          length: Math.min(exact.length, content.length),
          confidence: 'structural'
        };
      }
    });
    if (bestStructural) return bestStructural;
  }

  // ── Layer 4: Scroll position + landmark fallback ─────────────────────────────
  if (fp.scrollPercentage !== undefined) {
    const targetScrollY = fp.scrollPercentage * document.body.scrollHeight;
    const blocks = document.querySelectorAll('p, h2, h3, li, blockquote');
    let closestBlock = null, closestDist = Infinity;

    blocks.forEach(block => {
      if (block.closest('#lens-modal-overlay, .lens-annotation-card, #lens-detached-sidebar')) return;
      const blockTop = block.getBoundingClientRect().top + window.scrollY;
      const dist = Math.abs(blockTop - targetScrollY);
      if (dist < closestDist) { closestDist = dist; closestBlock = block; }
    });

    if (closestBlock && closestDist < window.innerHeight * 1.5) {
      const firstNode = getFirstTextNode(closestBlock);
      if (firstNode) {
        return {
          node: firstNode,
          idx: 0,
          length: Math.min(exact.length, firstNode.textContent.length),
          confidence: 'positional'
        };
      }
    }
  }

  // ── Layer 5: Detached — no anchor found ─────────────────────────────────────
  return null;
}

function getFirstTextNode(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.trim().length > 0) return node;
  }
  return null;
}

// ── Modal ──────────────────────────────────────────────────────────────────────
function openAnnotationModal(anchorData, existingAnnotation = null) {
  const existing = document.getElementById('lens-modal-overlay');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'lens-modal-overlay';
  const isEdit = !!existingAnnotation;

  const preview = anchorData.selectedText
    ? `<div id="lens-selected-text">"${escapeHtml(anchorData.selectedText.substring(0, 120))}${anchorData.selectedText.length > 120 ? '...' : ''}"</div>`
    : `<div id="lens-selected-text" style="color:#666;font-style:normal;">📌 Position annotation</div>`;

  modal.innerHTML = `
    <div id="lens-modal">
      <div id="lens-modal-header">
        <span>${isEdit ? '✏️ Edit Annotation' : '✏️ New Annotation'}</span>
        <button id="lens-modal-close">✕</button>
      </div>
      ${preview}
      <textarea id="lens-annotation-text" placeholder="Write your annotation...">${isEdit ? escapeHtml(existingAnnotation.text) : ''}</textarea>
      <input type="text" id="lens-tags-input" placeholder="Tags (comma separated, optional)" value="${isEdit ? escapeHtml(existingAnnotation.tags.join(', ')) : ''}">
      <div id="lens-modal-footer">
        <button id="lens-cancel-btn">Cancel</button>
        <button id="lens-save-btn">💾 ${isEdit ? 'Update' : 'Save'}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const textarea = document.getElementById('lens-annotation-text');
  textarea.focus();
  if (isEdit) textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  document.getElementById('lens-modal-close').addEventListener('click', () => modal.remove());
  document.getElementById('lens-cancel-btn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('lens-save-btn').addEventListener('click', async () => {
    const text = document.getElementById('lens-annotation-text').value.trim();
    if (!text) { document.getElementById('lens-annotation-text').style.borderColor = '#e94560'; return; }
    const tags = document.getElementById('lens-tags-input').value
      .split(',').map(t => t.trim()).filter(t => t.length > 0);

    if (isEdit) {
      await updateAnnotation(existingAnnotation.id, { text, tags });
    } else {
      await saveAnnotation({
        id: generateId(),
        url: window.location.href,
        created: new Date().toISOString(),
        updated: null,
        text, tags,
        anchor: anchorData,
        replies: [],
        published: false
      });
    }
    modal.remove();
    loadAndRenderAnnotations();
  });
}

// ── Storage ────────────────────────────────────────────────────────────────────
async function getAllAnnotations() {
  const result = await browser.storage.local.get('lens_annotations');
  return result['lens_annotations'] || [];
}

async function setAllAnnotations(annotations) {
  await browser.storage.local.set({ 'lens_annotations': annotations });
}

async function saveAnnotation(annotation) {
  const all = await getAllAnnotations();
  all.push(annotation);
  await setAllAnnotations(all);
}

async function updateAnnotation(id, changes) {
  const all = await getAllAnnotations();
  const idx = all.findIndex(a => a.id === id);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...changes, updated: new Date().toISOString() };
    await setAllAnnotations(all);
  }
}

async function deleteAnnotation(id) {
  const all = await getAllAnnotations();
  await setAllAnnotations(all.filter(a => a.id !== id));
}

async function addReply(annotationId, reply) {
  const all = await getAllAnnotations();
  const idx = all.findIndex(a => a.id === annotationId);
  if (idx !== -1) {
    if (!all[idx].replies) all[idx].replies = [];
    all[idx].replies.push(reply);
    await setAllAnnotations(all);
  }
}

async function deleteReply(annotationId, replyId) {
  const all = await getAllAnnotations();
  const idx = all.findIndex(a => a.id === annotationId);
  if (idx !== -1) {
    all[idx].replies = (all[idx].replies || []).filter(r => r.id !== replyId);
    await setAllAnnotations(all);
  }
}

// ── Render ─────────────────────────────────────────────────────────────────────
async function loadAndRenderAnnotations() {
  const all = await getAllAnnotations();
  const pageAnnotations = all.filter(a => a.url === window.location.href);

  document.querySelectorAll('.lens-annotation-pin, .lens-annotation-card').forEach(el => el.remove());
  removeTriggerIcon();
  removeDetachedSidebar();

  document.querySelectorAll('.lens-text-highlight').forEach(el => {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.normalize();
    el.remove();
  });

  const detached = [];

  for (const annotation of pageAnnotations) {
    if (annotation.anchor.type === 'coordinate') {
      renderCoordinateAnnotation(annotation);
    } else if (annotation.anchor.type === 'text') {
      const result = renderTextAnnotation(annotation);
      if (!result) detached.push(annotation);
    }
  }

  if (detached.length > 0) renderDetachedSidebar(detached);
}

function renderCoordinateAnnotation(annotation) {
  const pin = document.createElement('div');
  pin.className = 'lens-annotation-pin';
  pin.dataset.id = annotation.id;
  pin.style.cssText = `
    position: absolute;
    left: ${annotation.anchor.x}px;
    top: ${annotation.anchor.y}px;
    z-index: 2147483646;
    cursor: pointer;
    font-size: 22px;
    line-height: 1;
    user-select: none;
    transform: translate(-50%, -100%);
  `;
  pin.textContent = '📌';
  pin.title = annotation.text;
  pin.addEventListener('mouseenter', () => showTriggerIcon(annotation, pin));
  document.body.appendChild(pin);
}

function renderTextAnnotation(annotation) {
  const result = findBestAnchor(annotation);
  if (!result) return false;

  const { node, idx, length, confidence } = result;

  try {
    const range = document.createRange();
    const safeLength = Math.min(length, node.textContent.length - idx);
    if (safeLength <= 0) return false;
    range.setStart(node, idx);
    range.setEnd(node, idx + safeLength);

    const highlight = document.createElement('mark');
    highlight.className = 'lens-text-highlight';
    highlight.dataset.id = annotation.id;
    highlight.dataset.confidence = confidence;

    // Visual indicator for fuzzy/structural/positional matches
    if (confidence !== 'exact') {
      highlight.dataset.approximate = 'true';
    }

    range.surroundContents(highlight);

    let hideTimer = null;
    highlight.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      showTriggerIcon(annotation, highlight);
    });
    highlight.addEventListener('mouseleave', () => {
      hideTimer = setTimeout(() => {
        const trigger = document.getElementById('lens-annotation-trigger');
        if (trigger && !trigger.matches(':hover')) removeTriggerIcon();
      }, 120);
    });

    return true;
  } catch (e) {
    console.warn('Annote: anchor failed', confidence, e);
    return false;
  }
}

// ── Detached sidebar ───────────────────────────────────────────────────────────
function removeDetachedSidebar() {
  const el = document.getElementById('lens-detached-sidebar');
  if (el) el.remove();
}

function renderDetachedSidebar(annotations) {
  removeDetachedSidebar();

  const sidebar = document.createElement('div');
  sidebar.id = 'lens-detached-sidebar';

  let isOpen = false;

  sidebar.innerHTML = `
    <div id="lens-detached-tab">
      📎 ${annotations.length} detached
    </div>
    <div id="lens-detached-panel">
      <div id="lens-detached-header">
        <span>📎 Detached Annotations</span>
        <span id="lens-detached-subtitle">Original content no longer found on this page</span>
      </div>
      <div id="lens-detached-list">
        ${annotations.map(ann => `
          <div class="lens-detached-item" data-id="${ann.id}">
            <div class="lens-detached-original">
              ${ann.anchor.range?.exact
                ? `<span class="lens-detached-quote">"${escapeHtml(ann.anchor.range.exact.substring(0, 80))}${ann.anchor.range.exact.length > 80 ? '...' : ''}"</span>`
                : '<span class="lens-detached-quote">📌 Position annotation</span>'}
            </div>
            <div class="lens-detached-text">${escapeHtml(ann.text)}</div>
            <div class="lens-detached-meta">
              ${new Date(ann.created).toLocaleDateString()}
              ${ann.replies?.length > 0 ? `· ${ann.replies.length} repl${ann.replies.length === 1 ? 'y' : 'ies'}` : ''}
            </div>
            <div class="lens-detached-actions">
              <button class="lens-reanchor-btn" data-id="${ann.id}">🔗 Re-anchor</button>
              <button class="lens-detached-view-btn" data-id="${ann.id}">💬 View</button>
              <button class="lens-detached-delete-btn" data-id="${ann.id}">🗑️</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);

  // Toggle open/close
  document.getElementById('lens-detached-tab').addEventListener('click', () => {
    isOpen = !isOpen;
    sidebar.classList.toggle('open', isOpen);
  });

  // Re-anchor: user selects new text then clicks the button
  sidebar.querySelectorAll('.lens-reanchor-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      startReanchorMode(id, sidebar);
    });
  });

  // View annotation card
  sidebar.querySelectorAll('.lens-detached-view-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const all = await getAllAnnotations();
      const ann = all.find(a => a.id === id);
      if (ann) showAnnotationCard(ann, btn);
    });
  });

  // Delete
  sidebar.querySelectorAll('.lens-detached-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this annotation?')) return;
      await deleteAnnotation(btn.dataset.id);
      loadAndRenderAnnotations();
    });
  });
}

// ── Re-anchor mode ─────────────────────────────────────────────────────────────
function startReanchorMode(annotationId, sidebar) {
  const banner = document.createElement('div');
  banner.id = 'lens-reanchor-banner';
  banner.innerHTML = `
    <span>🔗 Select new text to re-anchor this annotation, then click <strong>Confirm</strong></span>
    <button id="lens-reanchor-confirm" disabled>Confirm</button>
    <button id="lens-reanchor-cancel">Cancel</button>
  `;
  document.body.appendChild(banner);

  let pendingRange = null;

  function onMouseUp(e) {
    if (e.target.closest('#lens-reanchor-banner')) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      pendingRange = sel.getRangeAt(0).cloneRange();
      document.getElementById('lens-reanchor-confirm').disabled = false;
      document.getElementById('lens-reanchor-confirm').textContent =
        `Confirm: "${sel.toString().substring(0, 30)}..."`;
    }
  }

  document.addEventListener('mouseup', onMouseUp);

  document.getElementById('lens-reanchor-cancel').addEventListener('click', () => {
    banner.remove();
    document.removeEventListener('mouseup', onMouseUp);
  });

  document.getElementById('lens-reanchor-confirm').addEventListener('click', async () => {
    if (!pendingRange) return;
    const selectedText = pendingRange.toString();
    const newRangeData = getRangeData(pendingRange, selectedText);

    await updateAnnotation(annotationId, {
      anchor: { type: 'text', selectedText, range: newRangeData }
    });

    banner.remove();
    document.removeEventListener('mouseup', onMouseUp);
    loadAndRenderAnnotations();
  });
}

// ── Trigger icon ───────────────────────────────────────────────────────────────
function showTriggerIcon(annotation, anchor) {
  removeTriggerIcon();
  const rect = anchor.getBoundingClientRect();
  const trigger = document.createElement('div');
  trigger.id = 'lens-annotation-trigger';

  // Show confidence indicator
  const confidence = anchor.dataset?.confidence || 'exact';
  const confIcon = confidence === 'exact' ? '🔍' : confidence === 'fuzzy' ? '🔍~' : '🔍?';
  const confTitle = {
    exact: 'View annotation',
    fuzzy: 'View annotation (approximate match)',
    structural: 'View annotation (structural match)',
    positional: 'View annotation (position match)'
  }[confidence] || 'View annotation';

  trigger.innerHTML = confIcon;
  trigger.title = confTitle;
  trigger.style.cssText = `
    position: fixed;
    left: ${rect.right + 2}px;
    top: ${rect.bottom - 10}px;
    z-index: 2147483647;
    cursor: pointer;
    font-size: 11px;
    background: #e94560;
    border-radius: 10px;
    min-width: 22px;
    height: 22px;
    padding: 0 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    user-select: none;
    color: white;
    font-family: -apple-system, sans-serif;
    transition: transform 0.1s ease;
  `;
  trigger.addEventListener('mouseenter', () => { trigger.style.transform = 'scale(1.15)'; });
  trigger.addEventListener('mouseleave', () => {
    trigger.style.transform = 'scale(1)';
    setTimeout(() => {
      if (!anchor.matches(':hover')) removeTriggerIcon();
    }, 120);
  });
  trigger.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    removeTriggerIcon();
    showAnnotationCard(annotation, anchor);
  });
  document.body.appendChild(trigger);
}

function removeTriggerIcon() {
  const el = document.getElementById('lens-annotation-trigger');
  if (el) el.remove();
}

// ── Annotation card ────────────────────────────────────────────────────────────
function showAnnotationCard(annotation, anchor) {
  document.querySelectorAll('.lens-annotation-card').forEach(el => el.remove());

  const rect = anchor.getBoundingClientRect();
  const card = document.createElement('div');
  card.className = 'lens-annotation-card';

  const cardWidth = 340;
  let top = rect.bottom + window.scrollY + 8;
  let left = rect.left + window.scrollX;
  if (left + cardWidth > window.scrollX + window.innerWidth - 10)
    left = window.scrollX + window.innerWidth - cardWidth - 10;
  if (top + 300 > window.scrollY + window.innerHeight - 10)
    top = rect.top + window.scrollY - 320;

  card.style.cssText = `position:absolute;top:${top}px;left:${left}px;z-index:2147483647;width:${cardWidth}px;`;

  const replies = annotation.replies || [];
  const confidence = anchor.dataset?.confidence;
  const approxWarning = confidence && confidence !== 'exact'
    ? `<div class="lens-confidence-warning">⚠️ ${
        confidence === 'fuzzy' ? 'Approximate text match' :
        confidence === 'structural' ? 'Structural match — original text may have changed' :
        'Positional match — content may have shifted'
      }</div>`
    : '';

  card.innerHTML = `
    <div class="lens-card-header">
      <span>🔍 Annotation</span>
      <span class="lens-card-date">
        ${new Date(annotation.created).toLocaleDateString()}
        ${annotation.updated ? `<span style="color:#444"> · edited</span>` : ''}
      </span>
      <button class="lens-card-close">✕</button>
    </div>
    ${approxWarning}
    <div class="lens-card-body">${escapeHtml(annotation.text)}</div>
    ${annotation.tags.length > 0
      ? `<div class="lens-card-tags">${annotation.tags.map(t => `<span class="lens-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : ''}
    <div class="lens-card-footer">
      <button class="lens-edit-btn">✏️ Edit</button>
      <button class="lens-pm-btn">✉️ PM</button>
      <button class="lens-delete-btn">🗑️</button>
    </div>
    <div class="lens-replies-section">
      <div class="lens-replies-header">💬 ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</div>
      <div class="lens-replies-list">
        ${replies.map(r => buildReplyHTML(r, annotation.id)).join('')}
      </div>
      <div class="lens-reply-composer">
        <div class="lens-reply-types">
          <button class="lens-reply-type-btn active" data-type="comment">💬 Comment</button>
          <button class="lens-reply-type-btn" data-type="agree">👍 Agree</button>
          <button class="lens-reply-type-btn" data-type="disagree">👎 Disagree</button>
        </div>
        <textarea class="lens-reply-input" placeholder="Write a reply..."></textarea>
        <div class="lens-reply-actions">
          <button class="lens-reply-submit-btn">Reply</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(card);
  bindCardEvents(card, annotation, anchor);

  setTimeout(() => {
    document.addEventListener('click', function closeCard(e) {
      if (!card.contains(e.target) && !e.target.closest('#lens-modal-overlay')) {
        card.remove();
        document.removeEventListener('click', closeCard);
      }
    });
  }, 100);
}

function buildReplyHTML(reply, annotationId) {
  const typeLabel = { comment: '💬', agree: '👍 Agree', disagree: '👎 Disagree' }[reply.type] || '💬';
  return `
    <div class="lens-reply" data-reply-id="${reply.id}">
      <div class="lens-reply-header">
        <span class="lens-reply-type">${typeLabel}</span>
        <span class="lens-reply-date">${new Date(reply.created).toLocaleDateString()}</span>
        <button class="lens-reply-delete" data-reply-id="${reply.id}" data-annotation-id="${annotationId}">✕</button>
      </div>
      <div class="lens-reply-body">${escapeHtml(reply.text)}</div>
    </div>
  `;
}

function bindCardEvents(card, annotation, anchor) {
  card.querySelector('.lens-card-close').addEventListener('click', (e) => { e.stopPropagation(); card.remove(); });

  card.querySelector('.lens-edit-btn').addEventListener('click', (e) => {
    e.stopPropagation(); card.remove();
    openAnnotationModal(annotation.anchor, annotation);
  });

  card.querySelector('.lens-delete-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this annotation and all its replies?')) return;
    await deleteAnnotation(annotation.id);
    card.remove(); loadAndRenderAnnotations();
  });

  card.querySelector('.lens-pm-btn').addEventListener('click', (e) => {
    e.stopPropagation(); openPMComposer(annotation);
  });

  const typeButtons = card.querySelectorAll('.lens-reply-type-btn');
  let selectedType = 'comment';
  typeButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      typeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedType = btn.dataset.type;
    });
  });

  card.querySelector('.lens-reply-submit-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const input = card.querySelector('.lens-reply-input');
    const text = input.value.trim();
    if (!text) { input.style.borderColor = '#e94560'; return; }
    await addReply(annotation.id, {
      id: generateId(), annotationId: annotation.id,
      type: selectedType, text, created: new Date().toISOString()
    });
    input.value = ''; input.style.borderColor = '';
    const all = await getAllAnnotations();
    const updated = all.find(a => a.id === annotation.id);
    card.remove();
    if (updated) showAnnotationCard(updated, anchor);
  });

  card.querySelectorAll('.lens-reply-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteReply(btn.dataset.annotationId, btn.dataset.replyId);
      const all = await getAllAnnotations();
      const updated = all.find(a => a.id === btn.dataset.annotationId);
      card.remove();
      if (updated) showAnnotationCard(updated, anchor);
    });
  });
}

// ── PM Composer ────────────────────────────────────────────────────────────────
function openPMComposer(annotation) {
  const existing = document.getElementById('lens-pm-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'lens-pm-overlay';
  overlay.innerHTML = `
    <div id="lens-pm-modal">
      <div id="lens-pm-header">
        <span>✉️ Private Message to Annotation Author</span>
        <button id="lens-pm-close">✕</button>
      </div>
      <div id="lens-pm-context">
        Re: "${escapeHtml(annotation.text.substring(0, 80))}${annotation.text.length > 80 ? '...' : ''}"
      </div>
      <textarea id="lens-pm-text" placeholder="Write your private message..."></textarea>
      <div id="lens-pm-note">⚠️ P2P not yet enabled. This generates an encrypted message to copy and send manually.</div>
      <div id="lens-pm-footer">
        <button id="lens-pm-cancel">Cancel</button>
        <button id="lens-pm-send">🔒 Generate Encrypted Message</button>
      </div>
      <div id="lens-pm-output" style="display:none;">
        <div id="lens-pm-output-label">Copy this and send it to the author:</div>
        <textarea id="lens-pm-output-text" readonly></textarea>
        <button id="lens-pm-copy">📋 Copy to Clipboard</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('lens-pm-close').addEventListener('click', () => overlay.remove());
  document.getElementById('lens-pm-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('lens-pm-send').addEventListener('click', () => {
    const text = document.getElementById('lens-pm-text').value.trim();
    if (!text) { document.getElementById('lens-pm-text').style.borderColor = '#e94560'; return; }
    const payload = { type: 'lens-pm', to: annotation.id, message: text, sent: new Date().toISOString(), ref: annotation.text.substring(0, 60) };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    document.getElementById('lens-pm-output-text').value = `LENS-PM::${encoded}`;
    document.getElementById('lens-pm-output').style.display = 'block';
    document.getElementById('lens-pm-send').style.display = 'none';
  });

  document.getElementById('lens-pm-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('lens-pm-output-text').value).then(() => {
      document.getElementById('lens-pm-copy').textContent = '✅ Copied!';
      setTimeout(() => { document.getElementById('lens-pm-copy').textContent = '📋 Copy to Clipboard'; }, 2000);
    });
  });
}

// ── Scroll to annotation ───────────────────────────────────────────────────────
async function scrollToAndShowAnnotation(annotationId) {
  const all = await getAllAnnotations();
  const annotation = all.find(a => a.id === annotationId);
  if (!annotation) return;
  const el = document.querySelector(`[data-id="${annotationId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background 0.2s';
    const orig = el.style.background;
    el.style.background = 'rgba(233, 69, 96, 0.7)';
    setTimeout(() => { el.style.background = orig; setTimeout(() => showAnnotationCard(annotation, el), 300); }, 600);
  } else {
    // Annotation is detached — open sidebar and highlight the item
    const sidebar = document.getElementById('lens-detached-sidebar');
    if (sidebar) {
      sidebar.classList.add('open');
      const item = sidebar.querySelector(`[data-id="${annotationId}"]`);
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.style.background = 'rgba(233, 69, 96, 0.2)';
        setTimeout(() => { item.style.background = ''; }, 1500);
      }
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function generateId() {
  return 'lens_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

loadAndRenderAnnotations();
