// WA Quick Templates — Content Script
// No accede a IndexedDB directamente — pide templates al background via runtime.sendMessage

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'togglePanel') {
    togglePanel();
    sendResponse({ success: true });
    return;
  }
  if (message.action === 'insertTemplate') {
    // Llamado desde el popup cuando el usuario hace "Usar en WhatsApp"
    const { text, imageData } = message.template;
    const file = imageData
      ? new File([new Uint8Array(imageData.buffer)], 'template-image', { type: imageData.type })
      : null;
    insertTemplate({ text, file })
      .then(ok => sendResponse({ success: ok }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }
});

// ── Keyboard shortcut (detectado directamente en la página) ───────────────────
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
    e.preventDefault();
    togglePanel();
  }
});

// ── Panel state ───────────────────────────────────────────────────────────────
let panelEl = null;
let panelVisible = false;
let panelObjURLs = [];

function togglePanel() {
  if (panelVisible) {
    closePanel();
  } else {
    openPanel();
  }
}

async function openPanel() {
  if (!panelEl) buildPanel();
  panelEl.classList.add('waqt-visible');
  panelVisible = true;
  await refreshPanel();
  panelEl.querySelector('.waqt-search').focus();
  // Close when user clicks or focuses outside the panel
  setTimeout(() => document.addEventListener('mousedown', onOutsideClick), 0);
  setTimeout(() => document.addEventListener('focusin', onOutsideFocus), 0);
}

function closePanel() {
  if (!panelEl) return;
  panelEl.classList.remove('waqt-visible');
  panelVisible = false;
  revokeAllObjectURLs();
  document.removeEventListener('mousedown', onOutsideClick);
  document.removeEventListener('focusin', onOutsideFocus);
}

function onOutsideClick(e) {
  if (panelEl && !panelEl.contains(e.target)) closePanel();
}

function onOutsideFocus(e) {
  if (panelEl && !panelEl.contains(e.target)) closePanel();
}

// ── Build panel DOM ───────────────────────────────────────────────────────────
function buildPanel() {
  if (!document.getElementById('waqt-styles')) {
    const style = document.createElement('style');
    style.id = 'waqt-styles';
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);
  }

  panelEl = document.createElement('div');
  panelEl.id = 'waqt-panel';
  panelEl.innerHTML = `
    <div class="waqt-header">
      <div class="waqt-logo">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.38 5.07L2 22l5.1-1.34C8.53 21.53 10.22 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill="#25D366"/>
          <path d="M17 14.5c-.28-.14-1.65-.81-1.9-.9-.26-.1-.44-.14-.63.14-.19.28-.72.9-.88 1.08-.16.19-.32.21-.6.07-.28-.14-1.18-.44-2.25-1.4-.83-.74-1.39-1.65-1.56-1.93-.16-.28-.02-.43.12-.57.13-.13.28-.32.42-.49.14-.17.19-.28.28-.47.1-.19.05-.35-.02-.49-.07-.14-.63-1.52-.86-2.08-.23-.54-.46-.47-.63-.47-.17 0-.35-.02-.54-.02-.19 0-.49.07-.74.35-.26.28-.98.95-.98 2.33 0 1.37 1 2.7 1.14 2.89.14.19 1.97 3 4.77 4.21.67.29 1.19.46 1.6.59.67.21 1.28.18 1.76.11.54-.08 1.65-.67 1.88-1.32.23-.65.23-1.2.16-1.32-.07-.12-.26-.19-.54-.33z" fill="white"/>
        </svg>
      </div>
      <span class="waqt-title">Quick Templates</span>
      <span class="waqt-shortcut">Ctrl+Shift+Space</span>
      <button class="waqt-close" title="Cerrar">✕</button>
    </div>
    <div class="waqt-search-wrap">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input class="waqt-search" placeholder="Buscar templates..." autocomplete="off">
    </div>
    <div class="waqt-list"></div>
  `;

  panelEl.querySelector('.waqt-close').addEventListener('click', closePanel);
  panelEl.querySelector('.waqt-search').addEventListener('input', (e) => filterPanel(e.target.value));
  panelEl.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  document.body.appendChild(panelEl);
}

// ── Refresh: pide templates al background ─────────────────────────────────────
let allTemplates = [];

async function refreshPanel() {
  const listEl = panelEl.querySelector('.waqt-list');
  listEl.innerHTML = '<div class="waqt-loading">Cargando...</div>';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'getTemplates' });
    allTemplates = response?.templates || [];
    renderPanelList(allTemplates);
  } catch (err) {
    listEl.innerHTML = '<div class="waqt-empty"><span>Error al cargar templates</span></div>';
  }
}

function filterPanel(query) {
  const q = query.toLowerCase();
  const filtered = q
    ? allTemplates.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.text || '').toLowerCase().includes(q))
    : allTemplates;
  renderPanelList(filtered);
}

function renderPanelList(list) {
  revokeAllObjectURLs();
  const listEl = panelEl.querySelector('.waqt-list');
  listEl.innerHTML = '';

  if (list.length === 0) {
    listEl.innerHTML = `<div class="waqt-empty">
      <span>Sin templates</span>
      <small>Créalos desde el ícono de la extensión</small>
    </div>`;
    return;
  }

  list.forEach(t => {
    const item = document.createElement('div');
    item.className = 'waqt-item';

    let imgHtml = '';
    if (t.imageData) {
      const blob = new Blob([new Uint8Array(t.imageData.buffer)], { type: t.imageData.type });
      const url = URL.createObjectURL(blob);
      panelObjURLs.push(url);
      imgHtml = `<img class="waqt-thumb" src="${url}" alt="">`;
    }

    item.innerHTML = `
      ${imgHtml}
      <div class="waqt-item-body">
        <div class="waqt-item-name">${escHtml(t.name)}</div>
        ${t.text ? `<div class="waqt-item-text">${escHtml(t.text)}</div>` : ''}
      </div>`;

    item.addEventListener('click', () => useTemplate(t));
    listEl.appendChild(item);
  });
}

function revokeAllObjectURLs() {
  panelObjURLs.forEach(u => URL.revokeObjectURL(u));
  panelObjURLs = [];
}

// ── Usar template desde el panel ──────────────────────────────────────────────
async function useTemplate(t) {
  closePanel();
  await sleep(80);
  const file = t.imageData
    ? new File([new Uint8Array(t.imageData.buffer)], 'template-image', { type: t.imageData.type })
    : null;
  await insertTemplate({ text: t.text, file });
}

// ── Core: insertar en WhatsApp ────────────────────────────────────────────────
async function insertTemplate({ text, file }) {
  const inputBox = findInputBox();
  if (!inputBox) return false;

  if (file && text) return await insertImageWithCaption(file, text);
  if (file)         return await insertImageWithCaption(file, '');

  insertText(inputBox, text);
  return true;
}

function findInputBox() {
  const selectors = [
    'div[data-tab="10"][contenteditable="true"]',
    'div[data-testid="conversation-compose-box-input"]',
    'footer div[contenteditable="true"]',
    'div[contenteditable="true"][spellcheck="true"]',
    'div[data-lexical-editor="true"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function insertText(inputBox, text) {
  inputBox.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(inputBox);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  document.execCommand('insertText', false, text);
  inputBox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
}

async function insertImageWithCaption(file, captionText) {
  const inputBox = findInputBox();
  if (!inputBox) return false;

  const existingEditors = new Set(document.querySelectorAll('div[contenteditable="true"]'));

  const clipboardData = new DataTransfer();
  clipboardData.items.add(file);
  inputBox.focus();
  inputBox.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  await sleep(200);

  const footer = document.querySelector('footer') || document.querySelector('[data-testid="conversation-panel-body"]');
  if (footer) {
    const dt = new DataTransfer();
    dt.items.add(file);
    footer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(200);
  }

  if (!captionText) return true;

  const captionBox = await waitForNewContentEditable(existingEditors, 3500);
  if (!captionBox) return true;

  captionBox.focus();
  await sleep(80);
  document.execCommand('insertText', false, captionText);
  captionBox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));

  return true;
}

function waitForNewContentEditable(existingSet, timeoutMs) {
  return new Promise(resolve => {
    const captionSelectors = [
      'div[data-testid="media-caption-input-container"] div[contenteditable="true"]',
      'div[data-testid="media-caption-input"]',
    ];
    const start = Date.now();
    const interval = setInterval(() => {
      for (const sel of captionSelectors) {
        const el = document.querySelector(sel);
        if (el && !existingSet.has(el)) { clearInterval(interval); resolve(el); return; }
      }
      for (const el of document.querySelectorAll('div[contenteditable="true"]')) {
        if (!existingSet.has(el)) { clearInterval(interval); resolve(el); return; }
      }
      if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve(null); }
    }, 100);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Panel CSS ─────────────────────────────────────────────────────────────────
const PANEL_CSS = `
#waqt-panel {
  position: fixed;
  bottom: 80px;
  right: 20px;
  width: 300px;
  background: #0d0f12;
  border: 1px solid #2a3040;
  border-radius: 14px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.6);
  display: flex;
  flex-direction: column;
  z-index: 99999;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: #e8edf5;
  opacity: 0;
  transform: translateY(12px) scale(0.97);
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease;
  overflow: hidden;
}
#waqt-panel.waqt-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: all;
}
.waqt-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid #2a3040;
  background: #161a20;
  flex-shrink: 0;
}
.waqt-logo {
  width: 26px; height: 26px;
  background: linear-gradient(135deg,#128C7E,#25D366);
  border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.waqt-title {
  font-weight: 700;
  font-size: 13px;
  color: #e8edf5;
  letter-spacing: -0.01em;
}
.waqt-shortcut {
  margin-left: auto;
  font-size: 10px;
  color: #4a5568;
  background: #1e242d;
  border: 1px solid #2a3040;
  padding: 2px 6px;
  border-radius: 5px;
  white-space: nowrap;
}
.waqt-close {
  background: none;
  border: none;
  color: #4a5568;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color 0.12s, background 0.12s;
  flex-shrink: 0;
}
.waqt-close:hover { color: #e8edf5; background: #2a3040; }
.waqt-search-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid #2a3040;
  background: #161a20;
  flex-shrink: 0;
}
.waqt-search-wrap svg { color: #4a5568; flex-shrink: 0; }
.waqt-search {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: #e8edf5;
  font-size: 12px;
  font-family: inherit;
}
.waqt-search::placeholder { color: #4a5568; }
.waqt-list {
  max-height: 186px;
  overflow-y: auto;
  padding: 6px;
  scrollbar-width: thin;
  scrollbar-color: #2a3040 transparent;
}
.waqt-loading {
  padding: 24px;
  text-align: center;
  color: #4a5568;
  font-size: 12px;
}
.waqt-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 30px 16px;
  color: #4a5568;
  text-align: center;
}
.waqt-empty small { font-size: 11px; }
.waqt-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px solid transparent;
  transition: background 0.12s, border-color 0.12s;
  margin-bottom: 3px;
  cursor: pointer;
}
.waqt-item:hover {
  background: #161a20;
  border-color: #2a3040;
}
.waqt-thumb {
  width: 40px; height: 40px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #2a3040;
  flex-shrink: 0;
}
.waqt-item-body {
  flex: 1;
  min-width: 0;
}
.waqt-item-name {
  font-weight: 600;
  font-size: 12px;
  color: #e8edf5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.waqt-item-text {
  font-size: 11px;
  color: #8b96a8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
`;
