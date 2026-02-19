async function loadStats() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = await browser.storage.local.get('lens_annotations');
  const all = result['lens_annotations'] || [];
  const pageAnnotations = all.filter(a => a.url === tab.url);

  document.getElementById('total-count').textContent = pageAnnotations.length;
  document.getElementById('total-all').textContent =
    `${all.length} total annotation${all.length !== 1 ? 's' : ''} across all sites`;

  const list = document.getElementById('annotation-list');

  if (pageAnnotations.length === 0) {
    list.innerHTML = `<div id="no-annotations">
      No annotations here yet.<br>
      Highlight text or right-click to add one.
    </div>`;
  } else {
    list.innerHTML = '';
    [...pageAnnotations].reverse().forEach(ann => {
      const item = document.createElement('div');
      item.className = 'annotation-item';
      item.title = 'Click to scroll to this annotation';
      item.innerHTML = `
        <div class="ann-text">${escapeHtml(ann.text)}</div>
        <div class="ann-meta">
          ${ann.anchor.type === 'text' ? '📝 Text' : '📌 Pin'}
          &nbsp;•&nbsp;
          ${new Date(ann.created).toLocaleDateString()}
          ${ann.tags.length > 0 ? `&nbsp;•&nbsp;${ann.tags.map(t => '#' + escapeHtml(t)).join(' ')}` : ''}
        </div>
      `;

      item.addEventListener('click', async () => {
        await browser.tabs.sendMessage(tab.id, {
          type: 'SCROLL_TO_ANNOTATION',
          annotationId: ann.id
        });
        window.close();
      });

      list.appendChild(item);
    });
  }

  return { all, pageAnnotations, tab };
}

document.getElementById('export-btn').addEventListener('click', async () => {
  const result = await browser.storage.local.get('lens_annotations');
  const all = result['lens_annotations'] || [];
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lens-annotations-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('clear-page-btn').addEventListener('click', async () => {
  if (!confirm('Delete all annotations on this page?')) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = await browser.storage.local.get('lens_annotations');
  const remaining = (result['lens_annotations'] || []).filter(a => a.url !== tab.url);
  await browser.storage.local.set({ 'lens_annotations': remaining });
  await browser.tabs.sendMessage(tab.id, { type: 'REFRESH_ANNOTATIONS' });
  loadStats();
});

document.getElementById('view-all-btn').addEventListener('click', async () => {
  const result = await browser.storage.local.get('lens_annotations');
  const all = result['lens_annotations'] || [];
  const html = buildAllAnnotationsPage(all);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  browser.tabs.create({ url });
});

function buildAllAnnotationsPage(annotations) {
  const grouped = {};
  annotations.forEach(ann => {
    if (!grouped[ann.url]) grouped[ann.url] = [];
    grouped[ann.url].push(ann);
  });

  const sections = Object.entries(grouped).map(([url, anns]) => `
    <div class="site">
      <h2><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a></h2>
      ${anns.map(ann => `
        <div class="ann">
          <div class="ann-type">${ann.anchor.type === 'text' ? '📝 Text annotation' : '📌 Position annotation'}</div>
          ${ann.anchor.selectedText
            ? `<blockquote>${escapeHtml(ann.anchor.selectedText)}</blockquote>`
            : ''}
          <p>${escapeHtml(ann.text)}</p>
          ${ann.tags.length > 0
            ? `<div class="tags">${ann.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join(' ')}</div>`
            : ''}
          <div class="meta">${new Date(ann.created).toLocaleString()}</div>
        </div>
      `).join('')}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>The Lens — All Annotations</title>
<style>
  body { background:#1a1a2e; color:#e0e0e0; font-family:-apple-system,sans-serif; max-width:800px; margin:0 auto; padding:32px 20px; }
  h1 { color:#e94560; font-size:24px; margin-bottom:4px; }
  .subtitle { color:#555; font-size:13px; margin-bottom:28px; }
  .site { background:#16213e; border-radius:10px; margin-bottom:16px; padding:16px 20px; }
  h2 { font-size:12px; margin:0 0 12px; word-break:break-all; }
  h2 a { color:#e94560; text-decoration:none; }
  h2 a:hover { text-decoration:underline; }
  .ann { border-left:3px solid #e94560; margin:8px 0; padding:10px 14px; }
  .ann-type { color:#555; font-size:11px; margin-bottom:6px; }
  blockquote { background:rgba(233,69,96,0.1); border-left:3px solid #e94560; border-radius:0 4px 4px 0; color:#aaa; font-style:italic; font-size:13px; margin:6px 0; padding:6px 12px; }
  p { font-size:14px; line-height:1.55; margin:6px 0; }
  .meta { color:#444; font-size:11px; margin-top:8px; }
  .tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }
  .tag { background:rgba(233,69,96,0.15); border:1px solid rgba(233,69,96,0.35); border-radius:12px; color:#e94560; font-size:11px; padding:2px 8px; }
</style>
</head>
<body>
  <h1>🔍 The Lens</h1>
  <p class="subtitle">${annotations.length} annotation${annotations.length !== 1 ? 's' : ''} across ${Object.keys(grouped).length} page${Object.keys(grouped).length !== 1 ? 's' : ''}</p>
  ${sections || '<p style="color:#555">No annotations yet.</p>'}
</body>
</html>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

loadStats();
