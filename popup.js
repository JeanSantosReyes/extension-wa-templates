// ── IndexedDB ─────────────────────────────────────────────────────────────────
// Images stored as Blob objects — no base64 anywhere.
// Schema: { id, name, text, imageBlob (Blob|null), imageType (string), createdAt }

const DB_NAME = 'waqt_db';
const DB_VERSION = 2;
const STORE = 'templates';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Drop old store if upgrading from v1 (had different schema)
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

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── State ─────────────────────────────────────────────────────────────────────
let templates = [];
let editingId = null;
let deleteId = null;
let currentFile = null;     // raw File object from <input> or drag
let currentObjectURL = null; // revokable URL for <img> preview

// ── DOM ───────────────────────────────────────────────────────────────────────
const templateList     = document.getElementById('templateList');
const emptyState       = document.getElementById('emptyState');
const searchInput      = document.getElementById('searchInput');
const modalOverlay     = document.getElementById('modalOverlay');
const deleteOverlay    = document.getElementById('deleteOverlay');
const modalTitle       = document.getElementById('modalTitle');
const templateName     = document.getElementById('templateName');
const templateText     = document.getElementById('templateText');
const imageInput       = document.getElementById('imageInput');
const imageUploadArea  = document.getElementById('imageUploadArea');
const uploadPlaceholder = document.getElementById('uploadPlaceholder');
const imagePreview     = document.getElementById('imagePreview');
const previewImg       = document.getElementById('previewImg');
const charCount        = document.getElementById('charCount');
const toast            = document.getElementById('toast');

// ── Load & Render ─────────────────────────────────────────────────────────────
async function loadTemplates() {
  templates = await dbGetAll();
  renderTemplates();
}

function renderTemplates() {
  const query = searchInput.value.toLowerCase();
  const filtered = query
    ? templates.filter(t =>
        t.name.toLowerCase().includes(query) ||
        (t.text || '').toLowerCase().includes(query))
    : templates;

  templateList.innerHTML = '';
  if (filtered.length === 0) {
    templateList.appendChild(emptyState);
    emptyState.style.display = 'flex';
    return;
  }
  emptyState.style.display = 'none';
  filtered.forEach(t => templateList.appendChild(createCard(t)));
}

// ── Card ──────────────────────────────────────────────────────────────────────
function createCard(t) {
  const card = document.createElement('div');
  card.className = 'template-card';

  let badges = '';
  if (t.text)      badges += '<span class="badge badge-text">Texto</span>';
  if (t.imageBlob) badges += '<span class="badge badge-img">Imagen</span>';

  // Build image thumb from Blob if present
  let imgHtml = '';
  if (t.imageBlob) {
    const url = URL.createObjectURL(t.imageBlob);
    imgHtml = `<img class="card-image-thumb" src="${url}" alt="preview" data-objurl="${url}">`;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-name">${escHtml(t.name)}</div>
      <div class="card-actions">
        <button class="card-btn edit" title="Editar">✏️</button>
        <button class="card-btn delete" title="Eliminar">🗑</button>
      </div>
    </div>
    ${imgHtml}
    ${t.text ? `<div class="card-text">${escHtml(t.text)}</div>` : ''}
    <div class="card-footer"><div class="card-badges">${badges}</div></div>`;

  card.querySelector('.edit').addEventListener('click', e => { e.stopPropagation(); openEditModal(t.id); });
  card.querySelector('.delete').addEventListener('click', e => { e.stopPropagation(); openDeleteConfirm(t.id); });
  card.addEventListener('click', () => sendToWhatsApp(t));

  return card;
}

// ── Send to WhatsApp ──────────────────────────────────────────────────────────
function sendToWhatsApp(t) {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab?.url?.includes('web.whatsapp.com')) {
      showToast('Abre WhatsApp Web primero', 'error');
      return;
    }

    // We can't send a Blob directly over message passing → convert to ArrayBuffer
    let imageData = null;
    if (t.imageBlob) {
      const ab = await t.imageBlob.arrayBuffer();
      imageData = { buffer: Array.from(new Uint8Array(ab)), type: t.imageBlob.type };
    }

    chrome.tabs.sendMessage(tab.id, {
      action: 'insertTemplate',
      template: { text: t.text, imageData }
    }, (response) => {
      if (chrome.runtime.lastError) {
        showToast('Recarga WhatsApp Web e intenta de nuevo', 'error');
        return;
      }
      if (response?.success) {
        showToast('✓ Template enviado', 'success');
        window.close();
      } else {
        showToast('Abre un chat primero', 'error');
      }
    });
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openNewModal() {
  editingId = null;
  revokePreview();
  modalTitle.textContent = 'Nuevo Template';
  templateName.value = '';
  templateText.value = '';
  charCount.textContent = '0';
  hideImagePreview();
  modalOverlay.classList.add('active');
  templateName.focus();
}

async function openEditModal(id) {
  const t = templates.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  revokePreview();
  currentFile = t.imageBlob ? new File([t.imageBlob], 'image', { type: t.imageBlob.type }) : null;
  modalTitle.textContent = 'Editar Template';
  templateName.value = t.name;
  templateText.value = t.text || '';
  charCount.textContent = (t.text || '').length;
  if (t.imageBlob) {
    currentObjectURL = URL.createObjectURL(t.imageBlob);
    showImagePreview(currentObjectURL);
  } else {
    hideImagePreview();
  }
  modalOverlay.classList.add('active');
  templateName.focus();
}

function closeModal() {
  modalOverlay.classList.remove('active');
  editingId = null;
  revokePreview();
  currentFile = null;
  hideImagePreview();
}

async function saveTemplate() {
  const name = templateName.value.trim();
  const text = templateText.value.trim();

  if (!name) {
    templateName.focus();
    templateName.style.borderColor = '#ff4757';
    setTimeout(() => templateName.style.borderColor = '', 1500);
    return;
  }
  if (!text && !currentFile) {
    showToast('Agrega texto o imagen al template', 'error');
    return;
  }

  // Convert File → Blob for storage (Blob is lighter — no filename metadata)
  const blob = currentFile ? currentFile.slice(0, currentFile.size, currentFile.type) : null;

  const existing = templates.find(t => t.id === editingId);
  const record = {
    id: editingId || Date.now().toString(),
    name,
    text,
    imageBlob: blob,
    createdAt: existing?.createdAt || Date.now()
  };

  await dbPut(record);
  showToast(editingId ? '✓ Template actualizado' : '✓ Template guardado', 'success');
  await loadTemplates();
  closeModal();
}

// ── Delete ────────────────────────────────────────────────────────────────────
function openDeleteConfirm(id) {
  const t = templates.find(x => x.id === id);
  if (!t) return;
  deleteId = id;
  document.getElementById('deleteTemplateName').textContent = t.name;
  deleteOverlay.classList.add('active');
}

async function confirmDelete() {
  await dbDelete(deleteId);
  await loadTemplates();
  deleteOverlay.classList.remove('active');
  showToast('Template eliminado', 'success');
  deleteId = null;
}

// ── Image preview ─────────────────────────────────────────────────────────────
function revokePreview() {
  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }
}

function showImagePreview(url) {
  previewImg.src = url;
  imagePreview.style.display = 'block';
  uploadPlaceholder.style.display = 'none';
}

function hideImagePreview() {
  previewImg.src = '';
  imagePreview.style.display = 'none';
  uploadPlaceholder.style.display = 'flex';
}

function handleImageFile(file) {
  if (!file?.type.startsWith('image/')) return;
  revokePreview();
  currentFile = file;
  currentObjectURL = URL.createObjectURL(file);
  showImagePreview(currentObjectURL);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2500);
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Events ────────────────────────────────────────────────────────────────────
document.getElementById('btnNewTemplate').addEventListener('click', openNewModal);
document.getElementById('btnCloseModal').addEventListener('click', closeModal);
document.getElementById('btnCancel').addEventListener('click', closeModal);
document.getElementById('btnSave').addEventListener('click', saveTemplate);
document.getElementById('btnCancelDelete').addEventListener('click', () => deleteOverlay.classList.remove('active'));
document.getElementById('btnConfirmDelete').addEventListener('click', confirmDelete);

searchInput.addEventListener('input', renderTemplates);
templateText.addEventListener('input', () => { charCount.textContent = templateText.value.length; });

imageUploadArea.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', e => { if (e.target.files[0]) handleImageFile(e.target.files[0]); });
document.getElementById('removeImage').addEventListener('click', e => {
  e.stopPropagation();
  revokePreview();
  currentFile = null;
  hideImagePreview();
  imageInput.value = '';
});

imageUploadArea.addEventListener('dragover', e => { e.preventDefault(); imageUploadArea.classList.add('drag-over'); });
imageUploadArea.addEventListener('dragleave', () => imageUploadArea.classList.remove('drag-over'));
imageUploadArea.addEventListener('drop', e => {
  e.preventDefault();
  imageUploadArea.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleImageFile(e.dataTransfer.files[0]);
});

modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
deleteOverlay.addEventListener('click', e => { if (e.target === deleteOverlay) deleteOverlay.classList.remove('active'); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); deleteOverlay.classList.remove('active'); }
});

loadTemplates();
