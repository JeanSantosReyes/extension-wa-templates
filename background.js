// Background service worker — puente entre popup (IndexedDB de extensión) y content script

// ── IndexedDB (mismo esquema que popup.js) ────────────────────────────────────
const DB_NAME = 'waqt_db';
const DB_VERSION = 2;
const STORE = 'templates';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('createdAt').getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = () => reject(req.error);
  });
}

// ── Serialize templates for messaging ─────────────────────────────────────────
// Blobs can't cross the message boundary → convert imageBlob to ArrayBuffer
async function serializeTemplates(templates) {
  return Promise.all(templates.map(async (t) => {
    let imageData = null;
    if (t.imageBlob) {
      const ab = await t.imageBlob.arrayBuffer();
      imageData = { buffer: Array.from(new Uint8Array(ab)), type: t.imageBlob.type };
    }
    return { id: t.id, name: t.name, text: t.text || '', imageData };
  }));
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Content script asks for all templates
  if (message.action === 'getTemplates') {
    dbGetAll()
      .then(templates => serializeTemplates(templates))
      .then(serialized => sendResponse({ templates: serialized }))
      .catch(() => sendResponse({ templates: [] }));
    return true; // async
  }

  // Keyboard shortcut → toggle panel in active WA tab
  if (message.action === 'toggle-panel-command') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('web.whatsapp.com')) {
        chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
      }
    });
    return;
  }
});

// ── Keyboard command ──────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('web.whatsapp.com')) {
        chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
      }
    });
  }
});
