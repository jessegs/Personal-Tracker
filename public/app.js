const $ = (id) => document.getElementById(id);

// ==== Auth ====
let currentUser = null;
let authMode = 'login';
let appInitialized = false;

const TOKEN_KEY = 'tracker.session';
const getStoredToken = () => localStorage.getItem(TOKEN_KEY);
const setStoredToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearStoredToken = () => localStorage.removeItem(TOKEN_KEY);

const authScreen = $('auth-screen');
const authForm = $('auth-form');
const authStatus = $('auth-status');
const authSubmit = $('auth-submit');
const authConfirmLabel = $('auth-confirm-label');
const authHelp = $('auth-help');

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    setAuthMode(tab.dataset.mode);
  });
});

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  if (mode === 'signup') {
    authConfirmLabel.hidden = false;
    $('auth-invite-label').hidden = false;
    authSubmit.textContent = 'Create account';
    $('auth-password').setAttribute('autocomplete', 'new-password');
    authHelp.innerHTML = "Already have an account? Switch to <strong>Sign in</strong> above.";
  } else {
    authConfirmLabel.hidden = true;
    $('auth-invite-label').hidden = true;
    authSubmit.textContent = 'Sign in';
    $('auth-password').setAttribute('autocomplete', 'current-password');
    authHelp.innerHTML = "Don't have an account? Switch to <strong>Create account</strong> above.";
  }
  setStatus(authStatus, '');
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  if (!username || !password) {
    setStatus(authStatus, 'Username and password required', 'error');
    return;
  }
  let inviteCode = '';
  if (authMode === 'signup') {
    if (password.length < 8) {
      setStatus(authStatus, 'Password must be at least 8 characters', 'error');
      return;
    }
    const confirm = $('auth-confirm').value;
    if (password !== confirm) {
      setStatus(authStatus, 'Passwords do not match', 'error');
      return;
    }
    inviteCode = $('auth-invite').value.trim();
    if (!inviteCode) {
      setStatus(authStatus, 'Invite code required', 'error');
      return;
    }
  }
  authSubmit.disabled = true;
  setStatus(authStatus, authMode === 'signup' ? 'Creating account…' : 'Signing in…');
  try {
    const path = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const payload = { username, password };
    if (authMode === 'signup') payload.invite_code = inviteCode;
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentUser = data.user;
    if (data.token) setStoredToken(data.token);
    if (data.adopted_legacy_data) {
      console.log('Existing pre-auth data was assigned to your new account.');
    }
    // Hard reload so the bearer token is picked up cleanly by every
    // subsequent request and any in-page state is reset.
    setStatus(authStatus, 'Welcome back!', 'success');
    window.location.replace('/');
    return;
  } catch (err) {
    setStatus(authStatus, err.message, 'error');
  } finally {
    authSubmit.disabled = false;
  }
});

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    currentUser = data.user;
    return currentUser;
  } catch {
    return null;
  }
}

function showAuthScreen() {
  authScreen.hidden = false;
  $('auth-username').focus();
}

function hideAuthScreen() {
  authScreen.hidden = true;
  authForm.reset();
  setAuthMode('login');
  setStatus(authStatus, '');
}

$('logout-btn').addEventListener('click', logout);

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* no-op */
  }
  clearStoredToken();
  window.location.replace('/');
}

// Wrap fetch to attach the bearer token from localStorage on every request,
// and to redirect to the auth screen on a 401 from non-auth endpoints.
const _origFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  init = { ...init };
  const headers = new Headers(init.headers || {});
  const token = getStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  init.headers = headers;
  const res = await _origFetch(input, init);
  const url = typeof input === 'string' ? input : input?.url || '';
  if (res.status === 401 && !url.includes('/api/auth/')) {
    clearStoredToken();
    currentUser = null;
    appInitialized = false;
    showAuthScreen();
  }
  return res;
};

const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const fmt = (n) => {
  const num = Number(n) || 0;
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
};

// ==== Tab switching ====
const TABS_WITH_DATE = new Set(['log', 'nutrition']);

function applyDateBarVisibility(tabName) {
  const bar = $('shared-date-bar');
  if (!bar) return;
  bar.hidden = !TABS_WITH_DATE.has(tabName);
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`${btn.dataset.tab}-tab`).classList.add('active');
    applyDateBarVisibility(btn.dataset.tab);
    if (btn.dataset.tab === 'photos') loadPhotos();
    if (btn.dataset.tab === 'habits') loadHabits();
    if (btn.dataset.tab === 'admin') loadAdminUsers();
  });
});

// ==== Date picker ====
const datePicker = $('date-picker');
datePicker.value = todayISO();
$('photo-date').value = todayISO();

datePicker.addEventListener('change', () => {
  loadEntries();
  syncWeightInput();
  loadWater();
  loadCheckIn();
  loadMeasurements();
});
$('prev-day').addEventListener('click', () => shiftDate(-1));
$('next-day').addEventListener('click', () => shiftDate(1));

function shiftDate(delta) {
  const [y, m, d] = datePicker.value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  datePicker.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  loadEntries();
  syncWeightInput();
  loadWater();
  loadCheckIn();
  loadMeasurements();
}

// ==== Status helper ====
function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `status ${kind}`;
  if (msg && kind !== 'error') {
    setTimeout(() => {
      if (el.textContent === msg) {
        el.textContent = '';
        el.className = 'status';
      }
    }, 2500);
  }
}

// ==== AI estimate ====
const estimateBtn = $('estimate-btn');
const status = $('status');

estimateBtn.addEventListener('click', async () => {
  const desc = $('food-description').value.trim();
  if (!desc) {
    setStatus(status, 'Enter a description first', 'error');
    return;
  }
  estimateBtn.disabled = true;
  setStatus(status, 'Estimating...');
  try {
    const res = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    $('m-calories').value = Math.round(data.calories);
    $('m-protein').value = data.protein;
    $('m-carbs').value = data.carbs;
    $('m-fat').value = data.fat;
    setStatus(status, 'Estimated. Review and click "Add to log".', 'success');
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    estimateBtn.disabled = false;
  }
});

// ==== Add entry ====
$('add-btn').addEventListener('click', addEntry);
$('clear-btn').addEventListener('click', clearForm);
$('save-template-btn').addEventListener('click', saveAsTemplate);

// ==== Scan label ====
let scanData = null; // per-serving values from the scan
const scanModal = $('scan-modal');
const scanFileInput = $('scan-label-input');

$('scan-label-btn').addEventListener('click', () => scanFileInput.click());
$('scan-modal-close').addEventListener('click', closeScanModal);
$('scan-cancel-btn').addEventListener('click', closeScanModal);
$('scan-add-btn').addEventListener('click', addScannedToLog);
$('scan-servings').addEventListener('input', updateScanTotals);

scanModal.addEventListener('click', (e) => {
  if (e.target === scanModal) closeScanModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !scanModal.hidden) closeScanModal();
});

scanFileInput.addEventListener('change', async () => {
  const file = scanFileInput.files[0];
  if (!file) return;
  await uploadScanLabel(file);
  scanFileInput.value = ''; // allow re-scanning the same file
});

async function uploadScanLabel(file) {
  // Open modal in loading state
  $('scan-result').hidden = true;
  $('scan-loading').hidden = false;
  scanModal.hidden = false;
  setStatus($('scan-status'), '');

  const fd = new FormData();
  fd.append('image', file);
  try {
    const res = await fetch('/api/scan-label', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    scanData = data;
    renderScanResult();
  } catch (err) {
    closeScanModal();
    setStatus(status, err.message, 'error');
  }
}

function renderScanResult() {
  $('scan-loading').hidden = true;
  $('scan-result').hidden = false;
  $('scan-product-name').textContent = scanData.product_name || '';
  $('scan-serving-size').textContent = scanData.serving_size
    ? `Serving size: ${scanData.serving_size}`
    : '';
  $('scan-per-cal').textContent = Math.round(scanData.calories);
  $('scan-per-protein').textContent = fmt(scanData.protein);
  $('scan-per-carbs').textContent = fmt(scanData.carbs);
  $('scan-per-fat').textContent = fmt(scanData.fat);
  $('scan-servings').value = '1';
  updateScanTotals();
}

function updateScanTotals() {
  if (!scanData) return;
  const s = parseFloat($('scan-servings').value) || 0;
  $('scan-total-cal').textContent = Math.round(scanData.calories * s);
  $('scan-total-protein').textContent = fmt(scanData.protein * s);
  $('scan-total-carbs').textContent = fmt(scanData.carbs * s);
  $('scan-total-fat').textContent = fmt(scanData.fat * s);
}

function closeScanModal() {
  scanModal.hidden = true;
  scanData = null;
}

async function addScannedToLog() {
  if (!scanData) return;
  const servings = parseFloat($('scan-servings').value);
  if (!Number.isFinite(servings) || servings <= 0) {
    setStatus($('scan-status'), 'Servings must be greater than 0', 'error');
    return;
  }
  const description = scanData.product_name
    ? `${scanData.product_name} (${servings}× serving)`
    : scanData.serving_size
      ? `${scanData.serving_size} (${servings}× serving)`
      : `Scanned label (${servings}× serving)`;
  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: datePicker.value,
        description,
        calories: scanData.calories * servings,
        protein: scanData.protein * servings,
        carbs: scanData.carbs * servings,
        fat: scanData.fat * servings,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    closeScanModal();
    setStatus(status, 'Added from label', 'success');
    loadEntries();
  } catch (err) {
    setStatus($('scan-status'), err.message, 'error');
  }
}

async function addEntry() {
  const description = $('food-description').value.trim();
  const calories = parseFloat($('m-calories').value) || 0;
  const protein = parseFloat($('m-protein').value) || 0;
  const carbs = parseFloat($('m-carbs').value) || 0;
  const fat = parseFloat($('m-fat').value) || 0;

  if (!description) {
    setStatus(status, 'Description required', 'error');
    return;
  }
  if (calories === 0 && protein === 0 && carbs === 0 && fat === 0) {
    setStatus(status, 'Enter macros or estimate with AI first', 'error');
    return;
  }

  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: datePicker.value,
        description,
        calories,
        protein,
        carbs,
        fat,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    clearForm();
    setStatus(status, 'Added', 'success');
    loadEntries();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

function clearForm() {
  $('food-description').value = '';
  $('m-calories').value = '';
  $('m-protein').value = '';
  $('m-carbs').value = '';
  $('m-fat').value = '';
}

// ==== Load entries ====
async function loadEntries() {
  try {
    const res = await fetch(`/api/entries?date=${datePicker.value}`);
    const entries = await res.json();
    renderEntries(entries);
  } catch (err) {
    console.error(err);
  }
}

function renderEntries(entries) {
  const list = $('entries-list');
  list.innerHTML = '';

  let totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No entries yet for this day.';
    list.appendChild(li);
  } else {
    for (const e of entries) {
      totals.calories += e.calories;
      totals.protein += e.protein;
      totals.carbs += e.carbs;
      totals.fat += e.fat;

      const li = document.createElement('li');
      li.className = 'entry';

      const main = document.createElement('div');
      main.className = 'entry-main';

      const desc = document.createElement('div');
      desc.className = 'entry-desc';
      desc.textContent = e.description;

      const macros = document.createElement('div');
      macros.className = 'entry-macros';
      const chips = [
        { cls: 'cal', text: `${fmt(e.calories)} kcal` },
        { cls: 'protein', text: `P ${fmt(e.protein)}g` },
        { cls: 'carbs', text: `C ${fmt(e.carbs)}g` },
        { cls: 'fat', text: `F ${fmt(e.fat)}g` },
      ];
      for (const c of chips) {
        const chip = document.createElement('span');
        chip.className = `macro-chip ${c.cls}`;
        const dot = document.createElement('span');
        dot.className = 'dot';
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(c.text));
        macros.appendChild(chip);
      }

      main.appendChild(desc);
      main.appendChild(macros);

      const del = document.createElement('button');
      del.className = 'entry-delete';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      del.title = 'Delete';
      del.addEventListener('click', () => deleteEntry(e.id));

      li.appendChild(main);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  $('total-calories').textContent = Math.round(totals.calories);
  $('total-protein').textContent = fmt(totals.protein);
  $('total-carbs').textContent = fmt(totals.carbs);
  $('total-fat').textContent = fmt(totals.fat);

  currentTotals = totals;
  applyGoalsToCards();
}

async function deleteEntry(id) {
  try {
    await fetch(`/api/entries/${id}`, { method: 'DELETE' });
    loadEntries();
  } catch (err) {
    console.error(err);
  }
}

// ==== Photos ====
const photoUploadBtn = $('photo-upload-btn');
const photoStatus = $('photo-status');
const photoFileInput = $('photo-file');
const photoFileLabel = $('photo-file-label');

photoFileInput.addEventListener('change', () => {
  const f = photoFileInput.files[0];
  photoFileLabel.textContent = f ? f.name : 'Choose photo';
});

photoUploadBtn.addEventListener('click', async () => {
  const file = $('photo-file').files[0];
  const date = $('photo-date').value;
  const note = $('photo-note').value.trim();
  if (!file) {
    setStatus(photoStatus, 'Choose a photo first', 'error');
    return;
  }
  if (!date) {
    setStatus(photoStatus, 'Pick a date', 'error');
    return;
  }

  const fd = new FormData();
  fd.append('photo', file);
  fd.append('date', date);
  fd.append('note', note);

  photoUploadBtn.disabled = true;
  setStatus(photoStatus, 'Uploading...');
  try {
    const res = await fetch('/api/photos', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    $('photo-file').value = '';
    $('photo-note').value = '';
    photoFileLabel.textContent = 'Choose photo';
    setStatus(photoStatus, 'Uploaded', 'success');
    loadPhotos();
  } catch (err) {
    setStatus(photoStatus, err.message, 'error');
  } finally {
    photoUploadBtn.disabled = false;
  }
});

async function loadPhotos() {
  try {
    const res = await fetch('/api/photos');
    const photos = await res.json();
    const gallery = $('photo-gallery');
    gallery.innerHTML = '';

    if (photos.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No photos yet.';
      gallery.appendChild(empty);
      return;
    }

    for (const p of photos) {
      const card = document.createElement('div');
      card.className = 'photo-card';

      const img = document.createElement('img');
      img.src = `/uploads/${p.filename}`;
      img.alt = p.note || p.date;
      img.addEventListener('click', () => openLightbox(img.src));

      const info = document.createElement('div');
      info.className = 'photo-info';

      const meta = document.createElement('div');
      meta.className = 'photo-meta';
      const date = document.createElement('div');
      date.className = 'date';
      date.textContent = p.date;
      meta.appendChild(date);
      if (p.note) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = p.note;
        meta.appendChild(note);
      }

      const del = document.createElement('button');
      del.className = 'photo-delete';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      del.title = 'Delete';
      del.addEventListener('click', () => deletePhoto(p.id));

      info.appendChild(meta);
      info.appendChild(del);
      card.appendChild(img);
      card.appendChild(info);
      gallery.appendChild(card);
    }
  } catch (err) {
    console.error(err);
  }
}

async function deletePhoto(id) {
  if (!confirm('Delete this photo?')) return;
  try {
    await fetch(`/api/photos/${id}`, { method: 'DELETE' });
    loadPhotos();
  } catch (err) {
    console.error(err);
  }
}

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// ==== Water ====
let currentWater = 0;
const waterCustomInput = $('water-custom');

document.querySelectorAll('.water-quick-btn[data-amount]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const amt = Number(btn.dataset.amount);
    if (Number.isFinite(amt) && amt > 0) logWater(amt);
  });
});

$('water-custom-btn').addEventListener('click', () => {
  const amt = Number(waterCustomInput.value);
  if (!Number.isFinite(amt) || amt <= 0) return;
  logWater(amt);
  waterCustomInput.value = '';
});

waterCustomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('water-custom-btn').click();
});

$('water-reset-btn').addEventListener('click', () => {
  if (currentWater === 0) return;
  if (!confirm('Reset water for this day?')) return;
  postWater(datePicker.value, 0);
});

async function loadWater() {
  try {
    const res = await fetch(`/api/water?date=${datePicker.value}`);
    const data = await res.json();
    currentWater = Number(data.oz) || 0;
    $('total-water').textContent = Math.round(currentWater);
    applyGoalsToCards();
  } catch (err) {
    console.error('Failed to load water', err);
  }
}

async function logWater(delta) {
  const newTotal = Math.max(0, currentWater + delta);
  await postWater(datePicker.value, newTotal);
}

async function postWater(date, oz) {
  try {
    const res = await fetch('/api/water', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, oz }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentWater = Number(data.oz) || 0;
    $('total-water').textContent = Math.round(currentWater);
    applyGoalsToCards();
  } catch (err) {
    console.error('Failed to log water', err);
  }
}

// ==== Meal templates (quick meals) ====
let currentMealTemplates = [];

async function loadMealTemplates() {
  try {
    const res = await fetch('/api/meal-templates');
    if (!res.ok) return;
    currentMealTemplates = await res.json();
    renderMealTemplates();
  } catch (err) {
    console.error('Failed to load meal templates', err);
  }
}

function renderMealTemplates() {
  const wrap = $('quick-meals');
  const list = $('quick-meals-list');
  list.innerHTML = '';

  if (currentMealTemplates.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  for (const t of currentMealTemplates) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'quick-meal-chip';
    chip.title = `${t.name} · ${Math.round(t.calories)} kcal · P${fmt(t.protein)} C${fmt(t.carbs)} F${fmt(t.fat)}`;

    const name = document.createElement('span');
    name.className = 'meal-name';
    name.textContent = t.name;

    const cal = document.createElement('span');
    cal.className = 'meal-cal';
    cal.textContent = `${Math.round(t.calories)} kcal`;

    chip.appendChild(name);
    chip.appendChild(cal);

    chip.addEventListener('click', () => logMealTemplate(t.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'quick-meal-delete';
    del.title = `Delete "${t.name}"`;
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMealTemplate(t.id, t.name);
    });

    chip.appendChild(del);
    list.appendChild(chip);
  }
}

async function saveAsTemplate() {
  const description = $('food-description').value.trim();
  const calories = parseFloat($('m-calories').value) || 0;
  const protein = parseFloat($('m-protein').value) || 0;
  const carbs = parseFloat($('m-carbs').value) || 0;
  const fat = parseFloat($('m-fat').value) || 0;

  if (!description) {
    setStatus(status, 'Enter a name in the description field first', 'error');
    return;
  }
  if (calories === 0 && protein === 0 && carbs === 0 && fat === 0) {
    setStatus(status, 'Enter macros (or use AI estimate) before saving', 'error');
    return;
  }
  try {
    const res = await fetch('/api/meal-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: description, calories, protein, carbs, fat }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    setStatus(status, 'Saved as quick meal', 'success');
    loadMealTemplates();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

async function logMealTemplate(id) {
  try {
    const res = await fetch(`/api/meal-templates/${id}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: datePicker.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    setStatus(status, `Added "${data.description}"`, 'success');
    loadEntries();
    // Refresh templates so the just-used one bubbles to the top via last_used_at
    loadMealTemplates();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

async function deleteMealTemplate(id, name) {
  if (!confirm(`Delete quick meal "${name}"?`)) return;
  try {
    await fetch(`/api/meal-templates/${id}`, { method: 'DELETE' });
    loadMealTemplates();
  } catch (err) {
    console.error('Failed to delete template', err);
  }
}

// ==== Goals ====
let currentGoals = {};
let currentTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

const goalStatus = $('goals-status');

async function loadGoals() {
  try {
    const res = await fetch('/api/goals');
    currentGoals = await res.json();
    renderGoalForm();
    applyGoalsToCards();
  } catch (err) {
    console.error('Failed to load goals', err);
  }
}

function renderGoalForm() {
  const g = currentGoals || {};
  $('g-calories').value = g.daily_calories ?? '';
  $('g-protein-pct').value = g.daily_protein_pct ?? '';
  $('g-carbs-pct').value = g.daily_carbs_pct ?? '';
  $('g-fat-pct').value = g.daily_fat_pct ?? '';
  $('g-water').value = g.daily_water_oz ?? '';
  $('g-weight').value = g.goal_weight ?? '';
  $('g-weight-unit').value = g.weight_unit || 'lbs';
  $('g-bf').value = g.goal_body_fat ?? '';
  updateMacroPctHint();
}

function updateMacroPctHint() {
  const hint = $('macro-pct-hint');
  if (!hint) return;
  const p = Number($('g-protein-pct').value) || 0;
  const c = Number($('g-carbs-pct').value) || 0;
  const f = Number($('g-fat-pct').value) || 0;
  const sum = p + c + f;
  const cal = Number($('g-calories').value);
  if (!cal && sum === 0) {
    hint.textContent = '';
    return;
  }

  let parts = [];
  if (cal && p) parts.push(`${Math.round((cal * p / 100) / 4)}g protein`);
  if (cal && c) parts.push(`${Math.round((cal * c / 100) / 4)}g carbs`);
  if (cal && f) parts.push(`${Math.round((cal * f / 100) / 9)}g fat`);
  let pieces = [];
  if (parts.length) pieces.push(`Targets: ${parts.join(' · ')}.`);
  if (sum > 0) {
    if (Math.abs(sum - 100) < 0.5) {
      pieces.push('Macros add up to 100%.');
    } else {
      pieces.push(`Macros add up to ${sum}% (typical splits total 100%).`);
    }
  }
  hint.textContent = pieces.join(' ');
}

['g-calories', 'g-protein-pct', 'g-carbs-pct', 'g-fat-pct'].forEach((id) => {
  $(id).addEventListener('input', updateMacroPctHint);
});

async function saveGoals() {
  const payload = {
    daily_calories: $('g-calories').value,
    daily_protein_pct: $('g-protein-pct').value,
    daily_carbs_pct: $('g-carbs-pct').value,
    daily_fat_pct: $('g-fat-pct').value,
    daily_water_oz: $('g-water').value,
    goal_weight: $('g-weight').value,
    weight_unit: $('g-weight-unit').value,
    goal_body_fat: $('g-bf').value,
  };
  try {
    const res = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentGoals = data;
    applyGoalsToCards();
    syncWeightInput();
    renderWeightChart();
    closeGoalsModal();
  } catch (err) {
    setStatus(goalStatus, err.message, 'error');
  }
}

$('goals-save-btn').addEventListener('click', saveGoals);

// Goals modal
const goalsModal = $('goals-modal');
$('open-goals-btn').addEventListener('click', () => openGoalsModal('body'));
$('open-goals-btn-nutrition').addEventListener('click', () => openGoalsModal('nutrition'));
$('goals-modal-close').addEventListener('click', closeGoalsModal);
$('goals-modal-cancel').addEventListener('click', closeGoalsModal);

goalsModal.addEventListener('click', (e) => {
  if (e.target === goalsModal) closeGoalsModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !goalsModal.hidden) closeGoalsModal();
});

function openGoalsModal(mode = 'all') {
  renderGoalForm();
  const showNutrition = mode === 'all' || mode === 'nutrition';
  const showBody = mode === 'all' || mode === 'body';
  $('goals-section-nutrition').hidden = !showNutrition;
  $('goals-section-body').hidden = !showBody;
  $('goals-modal-title').textContent =
    mode === 'nutrition' ? 'Nutrition goals' :
    mode === 'body' ? 'Body composition goals' :
    'Goals';
  goalsModal.hidden = false;
}

function closeGoalsModal() {
  goalsModal.hidden = true;
  setStatus(goalStatus, '');
}

const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

function gramTargetFromPct(macro) {
  const cal = Number(currentGoals.daily_calories);
  const pct = Number(currentGoals[`daily_${macro}_pct`]);
  if (!cal || !pct || cal <= 0 || pct <= 0) return null;
  return (cal * (pct / 100)) / KCAL_PER_G[macro];
}

function applyGoalsToCards() {
  setRing('cal', 'calories', currentTotals.calories, currentGoals.daily_calories, 'kcal');
  setRing('protein', 'protein', currentTotals.protein, gramTargetFromPct('protein'), 'g');
  setRing('carbs', 'carbs', currentTotals.carbs, gramTargetFromPct('carbs'), 'g');
  setRing('fat', 'fat', currentTotals.fat, gramTargetFromPct('fat'), 'g');
  setRing('water', 'water', currentWater, currentGoals.daily_water_oz, 'oz');
}

function setRing(cardClass, key, current, goal, unit) {
  const card = document.querySelector(`.total-card.${cardClass}`);
  if (!card) return;
  const goalNum = Number(goal);
  const hasGoal = goalNum && goalNum > 0;

  let progress = 0;
  let isOver = false;
  if (hasGoal) {
    const ratio = current / goalNum;
    progress = Math.min(ratio, 1);
    isOver = ratio > 1;
  }
  card.style.setProperty('--progress', progress.toFixed(3));
  card.classList.toggle('over', isOver);

  // Set dashoffset directly on the SVG circle to avoid cross-browser issues
  // with var()/calc() inside SVG presentation properties.
  const ringFg = card.querySelector('.ring-fg');
  if (ringFg) {
    const offset = 100 * (1 - progress);
    ringFg.style.strokeDashoffset = String(offset);
  }

  const goalEl = $(`goal-${key}`);
  if (!goalEl) return;
  if (hasGoal) {
    const remain = goalNum - current;
    if (isOver) {
      goalEl.textContent = `+${fmt(-remain)}${unit === 'kcal' ? '' : unit} over`;
      goalEl.classList.add('over');
    } else {
      goalEl.textContent = `${fmt(remain)}${unit === 'kcal' ? '' : unit} left of ${fmt(goalNum)}`;
      goalEl.classList.remove('over');
    }
  } else {
    goalEl.textContent = 'no goal set';
    goalEl.classList.remove('over');
  }
}

// ==== Weight ====
let currentWeights = [];
const weightStatus = $('weight-status');
const weightInput = $('weight-input');

$('weight-log-btn').addEventListener('click', logWeight);
weightInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') logWeight();
});
$('bf-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') logWeight();
});

async function loadWeights() {
  try {
    const res = await fetch('/api/weights?days=30');
    currentWeights = await res.json();
    syncWeightInput();
    renderWeightChart();
  } catch (err) {
    console.error('Failed to load weights', err);
  }
}

function syncWeightInput() {
  const date = datePicker.value;
  const entry = currentWeights.find((w) => w.date === date);
  weightInput.value = entry && entry.weight != null ? entry.weight : '';
  $('bf-input').value = entry && entry.body_fat != null ? entry.body_fat : '';

  $('weight-unit-tag').textContent = currentGoals.weight_unit || 'lbs';

  const today = todayISO();
  $('weight-date-label').textContent = date === today ? 'today' : date;
}

async function logWeight() {
  const wValue = parseFloat(weightInput.value);
  const bfValue = parseFloat($('bf-input').value);
  const date = datePicker.value;

  const hasW = Number.isFinite(wValue) && wValue > 0;
  const hasBF = Number.isFinite(bfValue) && bfValue >= 0 && bfValue <= 100;

  if (!hasW && !hasBF) {
    setStatus(weightStatus, 'Enter weight or body fat', 'error');
    return;
  }

  const payload = { date };
  if (hasW) payload.weight = wValue;
  if (hasBF) payload.body_fat = bfValue;

  try {
    const res = await fetch('/api/weights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    setStatus(weightStatus, 'Logged', 'success');
    await loadWeights();
  } catch (err) {
    setStatus(weightStatus, err.message, 'error');
  }
}

function renderWeightChart() {
  const svg = $('weight-chart');
  const empty = $('weight-empty');
  svg.innerHTML = '';

  // Build a 30-day window ending today
  const days = 30;
  const dayStrings = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dayStrings.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    );
  }

  const wMap = new Map(
    currentWeights.filter((w) => w.weight != null).map((w) => [w.date, w.weight])
  );
  const bfMap = new Map(
    currentWeights.filter((w) => w.body_fat != null).map((w) => [w.date, w.body_fat])
  );

  const goalWeight = Number(currentGoals.goal_weight);
  const goalBF = Number(currentGoals.goal_body_fat);
  const hasGoalW = goalWeight > 0;
  const hasGoalBF = goalBF > 0;

  // Compute Y ranges with 15% padding
  const computeRange = (vals, defaultPad) => {
    if (vals.length === 0) return null;
    if (vals.length === 1) return [vals[0] - defaultPad, vals[0] + defaultPad];
    let mn = Math.min(...vals);
    let mx = Math.max(...vals);
    if (mn === mx) return [mn - defaultPad, mx + defaultPad];
    const pad = (mx - mn) * 0.15;
    return [mn - pad, mx + pad];
  };

  const wValues = [...wMap.values()];
  if (hasGoalW) wValues.push(goalWeight);
  const bfValues = [...bfMap.values()];
  if (hasGoalBF) bfValues.push(goalBF);

  const wRange = computeRange(wValues, 5);
  const bfRange = computeRange(bfValues, 2);

  if (!wRange && !bfRange) {
    empty.hidden = false;
    svg.style.display = 'none';
    return;
  }
  empty.hidden = true;
  svg.style.display = 'block';

  const W = 600;
  const H = 220;
  const PAD = { top: 30, right: 50, bottom: 30, left: 50 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xAt = (i) => PAD.left + (i / (days - 1)) * innerW;

  const yAtW = (v) => {
    const [mn, mx] = wRange;
    return PAD.top + (1 - (v - mn) / (mx - mn)) * innerH;
  };
  const yAtBF = (v) => {
    const [mn, mx] = bfRange;
    return PAD.top + (1 - (v - mn) / (mx - mn)) * innerH;
  };

  const BF_COLOR = '#ff9d6b';

  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, parent = svg, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  };

  // Defs — weight gradient
  const defs = make('defs', {});
  const grad = make(
    'linearGradient',
    { id: 'weightGradient', x1: '0', y1: '0', x2: '1', y2: '0' },
    defs
  );
  make('stop', { offset: '0%', 'stop-color': '#7c5cff' }, grad);
  make('stop', { offset: '100%', 'stop-color': '#4cc9ff' }, grad);

  // Grid lines (4 ticks); label both axes when applicable
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const frac = i / yTicks;
    let yp;
    if (wRange) {
      const v = wRange[0] + (wRange[1] - wRange[0]) * frac;
      yp = yAtW(v);
      make('line', {
        x1: PAD.left,
        x2: W - PAD.right,
        y1: yp,
        y2: yp,
        stroke: 'rgba(255,255,255,0.05)',
        'stroke-width': 1,
      });
      make(
        'text',
        {
          x: PAD.left - 8,
          y: yp + 4,
          fill: '#c5cad6',
          'font-size': 11,
          'text-anchor': 'end',
          'font-weight': 500,
        },
        svg,
        v.toFixed(1)
      );
    } else if (bfRange) {
      const v = bfRange[0] + (bfRange[1] - bfRange[0]) * frac;
      yp = yAtBF(v);
      make('line', {
        x1: PAD.left,
        x2: W - PAD.right,
        y1: yp,
        y2: yp,
        stroke: 'rgba(255,255,255,0.05)',
        'stroke-width': 1,
      });
    }

    if (bfRange) {
      // Right-side body fat label, aligned to its own scale
      const v = bfRange[0] + (bfRange[1] - bfRange[0]) * frac;
      const ypBF = yAtBF(v);
      make(
        'text',
        {
          x: W - PAD.right + 8,
          y: ypBF + 4,
          fill: BF_COLOR,
          'font-size': 11,
          'text-anchor': 'start',
          'font-weight': 600,
        },
        svg,
        `${v.toFixed(1)}%`
      );
    }
  }

  // X-axis labels (start, middle, end)
  const labelIdx = [0, Math.floor(days / 2), days - 1];
  for (const i of labelIdx) {
    const [, m, d] = dayStrings[i].split('-');
    make(
      'text',
      {
        x: xAt(i),
        y: H - PAD.bottom + 18,
        fill: '#7a8093',
        'font-size': 11,
        'text-anchor': 'middle',
        'font-weight': 500,
      },
      svg,
      `${parseInt(m, 10)}/${parseInt(d, 10)}`
    );
  }

  // Legend (top)
  let legendX = PAD.left;
  const legendY = 14;
  if (wMap.size > 0 || hasGoalW) {
    make('rect', {
      x: legendX,
      y: legendY - 6,
      width: 16,
      height: 3,
      fill: 'url(#weightGradient)',
      rx: 1.5,
    });
    make(
      'text',
      { x: legendX + 22, y: legendY + 4, fill: '#c5cad6', 'font-size': 10, 'font-weight': 700, 'letter-spacing': '0.08em' },
      svg,
      'WEIGHT'
    );
    legendX += 92;
  }
  if (bfMap.size > 0 || hasGoalBF) {
    make('rect', { x: legendX, y: legendY - 6, width: 16, height: 3, fill: BF_COLOR, rx: 1.5 });
    make(
      'text',
      { x: legendX + 22, y: legendY + 4, fill: '#c5cad6', 'font-size': 10, 'font-weight': 700, 'letter-spacing': '0.08em' },
      svg,
      'BODY FAT'
    );
  }

  // Goal weight line (dashed purple)
  if (hasGoalW && wRange && goalWeight >= wRange[0] && goalWeight <= wRange[1]) {
    const gy = yAtW(goalWeight);
    make('line', {
      x1: PAD.left,
      x2: W - PAD.right,
      y1: gy,
      y2: gy,
      stroke: '#b9a8ff',
      'stroke-width': 1.5,
      'stroke-dasharray': '5 4',
      opacity: '0.7',
    });
    make(
      'text',
      {
        x: W - PAD.right - 6,
        y: gy - 6,
        fill: '#b9a8ff',
        'font-size': 10,
        'text-anchor': 'end',
        'font-weight': 600,
      },
      svg,
      `Goal ${goalWeight.toFixed(1)}`
    );
  }

  // Goal body fat line (dashed orange)
  if (hasGoalBF && bfRange && goalBF >= bfRange[0] && goalBF <= bfRange[1]) {
    const gy = yAtBF(goalBF);
    make('line', {
      x1: PAD.left,
      x2: W - PAD.right,
      y1: gy,
      y2: gy,
      stroke: BF_COLOR,
      'stroke-width': 1.5,
      'stroke-dasharray': '5 4',
      opacity: '0.7',
    });
    make(
      'text',
      {
        x: PAD.left + 6,
        y: gy - 6,
        fill: BF_COLOR,
        'font-size': 10,
        'text-anchor': 'start',
        'font-weight': 600,
      },
      svg,
      `Goal ${goalBF.toFixed(1)}%`
    );
  }

  // Weight line + dots
  if (wRange) {
    const wPoints = [];
    for (let i = 0; i < days; i++) {
      if (wMap.has(dayStrings[i])) wPoints.push({ i, v: wMap.get(dayStrings[i]) });
    }
    if (wPoints.length > 1) {
      const path = wPoints
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(p.i)} ${yAtW(p.v)}`)
        .join(' ');
      make('path', {
        d: path,
        fill: 'none',
        stroke: 'url(#weightGradient)',
        'stroke-width': 2.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
    }
    for (const p of wPoints) {
      make('circle', {
        cx: xAt(p.i),
        cy: yAtW(p.v),
        r: 4,
        fill: '#0a0c10',
        stroke: 'url(#weightGradient)',
        'stroke-width': 2,
      });
    }
  }

  // Body fat line + dots
  if (bfRange) {
    const bfPoints = [];
    for (let i = 0; i < days; i++) {
      if (bfMap.has(dayStrings[i])) bfPoints.push({ i, v: bfMap.get(dayStrings[i]) });
    }
    if (bfPoints.length > 1) {
      const path = bfPoints
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(p.i)} ${yAtBF(p.v)}`)
        .join(' ');
      make('path', {
        d: path,
        fill: 'none',
        stroke: BF_COLOR,
        'stroke-width': 2.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
    }
    for (const p of bfPoints) {
      make('circle', {
        cx: xAt(p.i),
        cy: yAtBF(p.v),
        r: 4,
        fill: '#0a0c10',
        stroke: BF_COLOR,
        'stroke-width': 2,
      });
    }
  }
}

// ==== Share ====
const shareBtn = $('share-btn');
shareBtn.addEventListener('click', () => shareDay(datePicker.value));

async function shareDay(date) {
  shareBtn.disabled = true;
  setStatus(status, 'Generating image…');
  try {
    const [photosRes, entriesRes, weightsRes] = await Promise.all([
      fetch('/api/photos'),
      fetch(`/api/entries?date=${date}`),
      fetch('/api/weights?days=30'),
    ]);
    const photos = await photosRes.json();
    const entries = await entriesRes.json();
    const weights = await weightsRes.json();

    const photo = photos.find((p) => p.date === date);
    if (!photo) {
      setStatus(status, `No photo logged for ${date}. Upload one in the Photos tab first.`, 'error');
      return;
    }

    const totals = entries.reduce(
      (a, e) => ({
        calories: a.calories + e.calories,
        protein: a.protein + e.protein,
        carbs: a.carbs + e.carbs,
        fat: a.fat + e.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );

    const weightEntry = weights.find((w) => w.date === date);

    const blob = await composeShareImage({
      date,
      photoUrl: `/uploads/${photo.filename}`,
      totals,
      goals: currentGoals,
      weight: weightEntry ? weightEntry.weight : null,
    });

    const file = new File([blob], `macro-${date}.png`, { type: 'image/png' });

    // Try native share (iOS, Android, some desktop browsers)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: `Progress · ${date}`,
        });
        setStatus(status, 'Shared!', 'success');
        return;
      } catch (err) {
        if (err.name === 'AbortError') {
          setStatus(status, '');
          return;
        }
        // fall through to download
      }
    }

    // Fallback: download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `macro-${date}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(status, 'Downloaded', 'success');
  } catch (err) {
    console.error(err);
    setStatus(status, err.message || 'Share failed', 'error');
  } finally {
    shareBtn.disabled = false;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load photo'));
    img.src = src;
  });
}

function formatShareDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

async function composeShareImage({ date, photoUrl, totals, goals, weight }) {
  const W = 1080;
  const PHOTO_H = 1080;
  const MACROS_H = 540;
  const H = PHOTO_H + MACROS_H;

  const img = await loadImage(photoUrl);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 1. Photo (cover-fit into 1080x1080)
  const ratio = Math.max(W / img.width, PHOTO_H / img.height);
  const drawW = img.width * ratio;
  const drawH = img.height * ratio;
  ctx.drawImage(img, (W - drawW) / 2, (PHOTO_H - drawH) / 2, drawW, drawH);

  // Subtle bottom gradient over photo for separation
  const photoFade = ctx.createLinearGradient(0, PHOTO_H - 160, 0, PHOTO_H);
  photoFade.addColorStop(0, 'rgba(10,12,16,0)');
  photoFade.addColorStop(1, 'rgba(10,12,16,0.6)');
  ctx.fillStyle = photoFade;
  ctx.fillRect(0, PHOTO_H - 160, W, 160);

  // 2. Macros panel background
  const panelGrad = ctx.createLinearGradient(0, PHOTO_H, 0, H);
  panelGrad.addColorStop(0, '#0a0c10');
  panelGrad.addColorStop(1, '#161a22');
  ctx.fillStyle = panelGrad;
  ctx.fillRect(0, PHOTO_H, W, MACROS_H);

  // Top accent bar (purple→cyan gradient)
  const accent = ctx.createLinearGradient(0, 0, W, 0);
  accent.addColorStop(0, '#7c5cff');
  accent.addColorStop(1, '#4cc9ff');
  ctx.fillStyle = accent;
  ctx.fillRect(0, PHOTO_H, W, 5);

  // 3. Header row: date (left) + weight badge (right)
  ctx.fillStyle = '#c5cad6';
  ctx.font = '700 30px Inter, "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(formatShareDate(date).toUpperCase(), 60, PHOTO_H + 50);

  if (weight) {
    const unit = goals.weight_unit || 'lbs';
    const wText = `Weight: ${Number.isInteger(weight) ? weight : weight.toFixed(1)} ${unit}`;
    ctx.font = '700 40px Inter, sans-serif';
    const metrics = ctx.measureText(wText);
    const padX = 26, padY = 16;
    const boxW = metrics.width + padX * 2;
    const boxH = 40 + padY * 2;
    const boxX = W - 60 - boxW;
    const boxY = PHOTO_H + 50 + 15 - boxH / 2;
    // pill background
    ctx.fillStyle = 'rgba(124,92,255,0.18)';
    ctx.beginPath();
    const r = boxH / 2;
    ctx.moveTo(boxX + r, boxY);
    ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
    ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
    ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
    ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#b9a8ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(wText, boxX + boxW / 2, boxY + boxH / 2 + 2);
  }

  // 4. Four macro rings
  const cal = Number(goals.daily_calories);
  const gramFromPct = (pctField, kpg) => {
    const pct = Number(goals[pctField]);
    if (!cal || !pct || cal <= 0 || pct <= 0) return null;
    return (cal * (pct / 100)) / kpg;
  };

  const macros = [
    { label: 'CALORIES', cur: totals.calories, goal: cal, color: '#ff8a4c', unit: '' },
    { label: 'PROTEIN', cur: totals.protein, goal: gramFromPct('daily_protein_pct', 4), color: '#ff5c8a', unit: 'g' },
    { label: 'CARBS', cur: totals.carbs, goal: gramFromPct('daily_carbs_pct', 4), color: '#ffc857', unit: 'g' },
    { label: 'FAT', cur: totals.fat, goal: gramFromPct('daily_fat_pct', 9), color: '#4dd6a8', unit: 'g' },
  ];

  const cellW = W / 4;
  const ringCenterY = PHOTO_H + 260;
  const ringR = 78;
  const ringWidth = 12;

  for (let i = 0; i < macros.length; i++) {
    const m = macros[i];
    const cx = cellW * i + cellW / 2;

    // Background ring
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = ringWidth;
    ctx.beginPath();
    ctx.arc(cx, ringCenterY, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // Progress arc
    const goalNum = Number(m.goal) || 0;
    if (goalNum > 0) {
      const ratio = m.cur / goalNum;
      const progress = Math.min(ratio, 1);
      const isOver = ratio > 1;
      ctx.strokeStyle = isOver ? '#ff5c7a' : m.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = ringWidth;
      ctx.beginPath();
      ctx.arc(
        cx,
        ringCenterY,
        ringR,
        -Math.PI / 2,
        -Math.PI / 2 + progress * Math.PI * 2
      );
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Center value
    const cur = m.cur;
    const display = cur >= 100 ? Math.round(cur).toString() : cur.toFixed(cur < 10 ? 1 : 0);
    ctx.fillStyle = '#f0f2f7';
    ctx.font = '700 40px "Space Grotesk", Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(display, cx, ringCenterY - 4);

    // Tiny unit inside ring (under the value)
    ctx.fillStyle = '#7a8093';
    ctx.font = '600 12px Inter, sans-serif';
    ctx.fillText(m.label === 'CALORIES' ? 'KCAL' : 'G', cx, ringCenterY + 26);

    // Label
    ctx.fillStyle = m.color;
    ctx.font = '700 18px Inter, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(m.label, cx, ringCenterY + ringR + 28);

    // Goal text
    if (goalNum > 0) {
      ctx.fillStyle = '#7a8093';
      ctx.font = '500 18px Inter, sans-serif';
      ctx.fillText(`of ${Math.round(goalNum)}${m.unit}`, cx, ringCenterY + ringR + 56);
    } else {
      ctx.fillStyle = '#565c6e';
      ctx.font = '500 16px Inter, sans-serif';
      ctx.fillText('no goal', cx, ringCenterY + ringR + 56);
    }
  }

  // 5. Footer brand
  ctx.fillStyle = '#565c6e';
  ctx.font = '700 16px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('PERSONAL TRACKER', W / 2, H - 32);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image export failed'))),
      'image/png'
    );
  });
}

// ==== Body Measurements ====
const MEASUREMENT_FIELDS = [
  { key: 'neck',        label: 'Neck',     color: '#4cc9ff' },
  { key: 'shoulders',   label: 'Shoulders',color: '#7c5cff' },
  { key: 'left_bicep',  label: 'L. Bicep', color: '#4dd6a8' },
  { key: 'right_bicep', label: 'R. Bicep', color: '#2ec4b6' },
  { key: 'chest',       label: 'Chest',    color: '#ff8a4c' },
  { key: 'waist',       label: 'Waist',    color: '#ff5c8a' },
  { key: 'left_thigh',  label: 'L. Thigh', color: '#ffc857' },
  { key: 'right_thigh', label: 'R. Thigh', color: '#ff9d6b' },
];

let currentMeasurement = {};
let currentMeasurements = [];
const measurementsStatus = $('measurements-status');

$('measurements-log-btn').addEventListener('click', logMeasurements);

async function loadMeasurements() {
  try {
    const [oneRes, listRes] = await Promise.all([
      fetch(`/api/measurement?date=${datePicker.value}`),
      fetch('/api/measurements?days=30'),
    ]);
    currentMeasurement = await oneRes.json();
    currentMeasurements = await listRes.json();
    syncMeasurementInputs();
    renderMeasurementsChart();
  } catch (err) {
    console.error('Failed to load measurements', err);
  }
}

function syncMeasurementInputs() {
  for (const f of MEASUREMENT_FIELDS) {
    const el = $(`m-${f.key}`);
    if (!el) continue;
    el.value = currentMeasurement[f.key] != null ? currentMeasurement[f.key] : '';
  }
}

async function logMeasurements() {
  const payload = { date: datePicker.value };
  let any = false;
  for (const f of MEASUREMENT_FIELDS) {
    const v = $(`m-${f.key}`).value.trim();
    if (v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      setStatus(measurementsStatus, `${f.label} must be a positive number`, 'error');
      return;
    }
    payload[f.key] = n;
    any = true;
  }
  if (!any) {
    setStatus(measurementsStatus, 'Enter at least one measurement', 'error');
    return;
  }
  try {
    const res = await fetch('/api/measurement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentMeasurement = data;
    syncMeasurementInputs();
    setStatus(measurementsStatus, 'Logged', 'success');
    loadMeasurements();
  } catch (err) {
    setStatus(measurementsStatus, err.message, 'error');
  }
}

function renderMeasurementsChart() {
  const svg = $('measurements-chart');
  const empty = $('measurements-empty');
  svg.innerHTML = '';

  // Build per-field maps date -> value
  const maps = {};
  let anyData = false;
  for (const f of MEASUREMENT_FIELDS) {
    const m = new Map(
      currentMeasurements
        .filter((row) => row[f.key] != null)
        .map((row) => [row.date, row[f.key]])
    );
    maps[f.key] = m;
    if (m.size > 0) anyData = true;
  }

  if (!anyData) {
    empty.hidden = false;
    svg.style.display = 'none';
    return;
  }
  empty.hidden = true;
  svg.style.display = 'block';

  const days = 30;
  const today = new Date();
  const dayStrings = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dayStrings.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    );
  }

  // Y-range across all fields
  const allValues = [];
  for (const f of MEASUREMENT_FIELDS) {
    for (const v of maps[f.key].values()) allValues.push(v);
  }
  let yMin = Math.min(...allValues);
  let yMax = Math.max(...allValues);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.15;
    yMin -= pad;
    yMax += pad;
  }

  const W = 600, H = 240;
  const PAD = { top: 56, right: 50, bottom: 30, left: 50 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xAt = (i) => PAD.left + (i / (days - 1)) * innerW;
  const yAt = (v) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, parent = svg, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  };

  // Y-axis grid + labels (in inches)
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const yp = yAt(v);
    make('line', {
      x1: PAD.left, x2: W - PAD.right, y1: yp, y2: yp,
      stroke: 'rgba(255,255,255,0.05)', 'stroke-width': 1,
    });
    make(
      'text',
      { x: PAD.left - 8, y: yp + 4, fill: '#c5cad6', 'font-size': 11, 'text-anchor': 'end', 'font-weight': 500 },
      svg, `${v.toFixed(1)}"`
    );
  }

  // X-axis labels
  const labelIdx = [0, Math.floor(days / 2), days - 1];
  for (const i of labelIdx) {
    const [, m, d] = dayStrings[i].split('-');
    make(
      'text',
      { x: xAt(i), y: H - PAD.bottom + 18, fill: '#7a8093', 'font-size': 11, 'text-anchor': 'middle', 'font-weight': 500 },
      svg, `${parseInt(m, 10)}/${parseInt(d, 10)}`
    );
  }

  // Legend (4 columns over 2 rows above the plot)
  const legendCols = 4;
  const legendItemW = (W - PAD.left - PAD.right) / legendCols;
  for (let idx = 0; idx < MEASUREMENT_FIELDS.length; idx++) {
    const f = MEASUREMENT_FIELDS[idx];
    if (maps[f.key].size === 0) continue;
    const col = idx % legendCols;
    const row = Math.floor(idx / legendCols);
    const lx = PAD.left + col * legendItemW;
    const ly = 14 + row * 18;
    make('rect', { x: lx, y: ly - 6, width: 14, height: 3, fill: f.color, rx: 1.5 });
    make(
      'text',
      { x: lx + 20, y: ly + 4, fill: '#c5cad6', 'font-size': 10, 'font-weight': 700, 'letter-spacing': '0.06em' },
      svg, f.label.toUpperCase()
    );
  }

  // Lines + dots per field
  for (const f of MEASUREMENT_FIELDS) {
    const m = maps[f.key];
    if (m.size === 0) continue;
    const pts = [];
    for (let i = 0; i < days; i++) {
      if (m.has(dayStrings[i])) pts.push({ i, v: m.get(dayStrings[i]) });
    }
    if (pts.length > 1) {
      const path = pts
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(p.i)} ${yAt(p.v)}`)
        .join(' ');
      make('path', {
        d: path, fill: 'none', stroke: f.color, 'stroke-width': 2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: '0.9',
      });
    }
    for (const p of pts) {
      make('circle', {
        cx: xAt(p.i), cy: yAt(p.v), r: 3.5,
        fill: '#0a0c10', stroke: f.color, 'stroke-width': 1.8,
      });
    }
  }
}

// ==== Daily check-in (sleep + stress) ====
let currentCheckIn = { sleep_minutes: null, stress_level: null };
let currentCheckIns = [];
const checkInStatus = $('check-in-status');

$('check-in-log-btn').addEventListener('click', logCheckIn);

async function loadCheckIn() {
  try {
    const [oneRes, listRes] = await Promise.all([
      fetch(`/api/check-in?date=${datePicker.value}`),
      fetch('/api/check-ins?days=30'),
    ]);
    const data = await oneRes.json();
    currentCheckIn = data;
    currentCheckIns = await listRes.json();
    syncCheckInInputs();
    renderCheckInChart();
  } catch (err) {
    console.error('Failed to load check-in', err);
  }
}

function syncCheckInInputs() {
  const mins = currentCheckIn.sleep_minutes;
  if (mins != null) {
    $('sleep-hours').value = Math.floor(mins / 60);
    $('sleep-minutes').value = String(mins % 60).padStart(2, '0');
  } else {
    $('sleep-hours').value = '';
    $('sleep-minutes').value = '';
  }
  $('stress-level').value =
    currentCheckIn.stress_level != null ? currentCheckIn.stress_level : '';
}

function readSleepMinutes() {
  const hStr = $('sleep-hours').value.trim();
  const mStr = $('sleep-minutes').value.trim();
  if (hStr === '' && mStr === '') return null;
  const h = Number(hStr) || 0;
  const m = Number(mStr) || 0;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  if (h < 0 || h > 24 || m < 0 || m > 59) return NaN;
  return h * 60 + m;
}

async function logCheckIn() {
  const sleepMins = readSleepMinutes();
  const stressRaw = $('stress-level').value;
  const stress = stressRaw === '' ? null : Number(stressRaw);

  if (Number.isNaN(sleepMins)) {
    setStatus(checkInStatus, 'Sleep must be 0–24h, 0–59m', 'error');
    return;
  }
  if (sleepMins === null && stress === null) {
    setStatus(checkInStatus, 'Enter sleep or stress', 'error');
    return;
  }
  if (stress !== null && (!Number.isInteger(stress) || stress < 1 || stress > 10)) {
    setStatus(checkInStatus, 'Stress must be 1-10', 'error');
    return;
  }

  const payload = { date: datePicker.value };
  if (sleepMins !== null) payload.sleep_minutes = sleepMins;
  if (stress !== null) payload.stress_level = stress;

  try {
    const res = await fetch('/api/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentCheckIn = data;
    syncCheckInInputs();
    setStatus(checkInStatus, 'Logged', 'success');
    // Refresh chart with new data
    loadCheckIn();
  } catch (err) {
    setStatus(checkInStatus, err.message, 'error');
  }
}

function renderCheckInChart() {
  const svg = $('check-in-chart');
  const empty = $('check-in-empty');
  svg.innerHTML = '';

  const days = 30;
  const dayStrings = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dayStrings.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    );
  }

  const sleepMap = new Map(
    currentCheckIns.filter((c) => c.sleep_minutes != null).map((c) => [c.date, c.sleep_minutes])
  );
  const stressMap = new Map(
    currentCheckIns.filter((c) => c.stress_level != null).map((c) => [c.date, c.stress_level])
  );

  const computeRange = (vals, defaultPad) => {
    if (vals.length === 0) return null;
    if (vals.length === 1) return [vals[0] - defaultPad, vals[0] + defaultPad];
    let mn = Math.min(...vals), mx = Math.max(...vals);
    if (mn === mx) return [mn - defaultPad, mx + defaultPad];
    const pad = (mx - mn) * 0.15;
    return [mn - pad, mx + pad];
  };

  const sleepRange = computeRange([...sleepMap.values()], 30);
  // Stress always uses fixed 0-10 scale for legibility
  const stressRange = stressMap.size > 0 ? [0, 10.5] : null;

  if (!sleepRange && !stressRange) {
    empty.hidden = false;
    svg.style.display = 'none';
    return;
  }
  empty.hidden = true;
  svg.style.display = 'block';

  const W = 600, H = 220;
  const PAD = { top: 30, right: 50, bottom: 30, left: 50 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xAt = (i) => PAD.left + (i / (days - 1)) * innerW;

  const yAtSleep = (v) => {
    const [mn, mx] = sleepRange;
    return PAD.top + (1 - (v - mn) / (mx - mn)) * innerH;
  };
  const yAtStress = (v) => {
    const [mn, mx] = stressRange;
    return PAD.top + (1 - (v - mn) / (mx - mn)) * innerH;
  };

  const STRESS_COLOR = '#ff9d6b';

  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, parent = svg, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  };

  const defs = make('defs', {});
  const grad = make(
    'linearGradient',
    { id: 'sleepGradient', x1: '0', y1: '0', x2: '1', y2: '0' },
    defs
  );
  make('stop', { offset: '0%', 'stop-color': '#7c5cff' }, grad);
  make('stop', { offset: '100%', 'stop-color': '#4cc9ff' }, grad);

  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const frac = i / yTicks;
    if (sleepRange) {
      const v = sleepRange[0] + (sleepRange[1] - sleepRange[0]) * frac;
      const yp = yAtSleep(v);
      make('line', {
        x1: PAD.left, x2: W - PAD.right, y1: yp, y2: yp,
        stroke: 'rgba(255,255,255,0.05)', 'stroke-width': 1,
      });
      const hours = (v / 60).toFixed(1);
      make(
        'text',
        { x: PAD.left - 8, y: yp + 4, fill: '#c5cad6', 'font-size': 11, 'text-anchor': 'end', 'font-weight': 500 },
        svg, `${hours}h`
      );
    } else if (stressRange) {
      const v = stressRange[0] + (stressRange[1] - stressRange[0]) * frac;
      const yp = yAtStress(v);
      make('line', {
        x1: PAD.left, x2: W - PAD.right, y1: yp, y2: yp,
        stroke: 'rgba(255,255,255,0.05)', 'stroke-width': 1,
      });
    }

    if (stressRange) {
      const v = stressRange[0] + (stressRange[1] - stressRange[0]) * frac;
      const ypStress = yAtStress(v);
      make(
        'text',
        { x: W - PAD.right + 8, y: ypStress + 4, fill: STRESS_COLOR, 'font-size': 11, 'text-anchor': 'start', 'font-weight': 600 },
        svg, v.toFixed(0)
      );
    }
  }

  const labelIdx = [0, Math.floor(days / 2), days - 1];
  for (const i of labelIdx) {
    const [, m, d] = dayStrings[i].split('-');
    make(
      'text',
      { x: xAt(i), y: H - PAD.bottom + 18, fill: '#7a8093', 'font-size': 11, 'text-anchor': 'middle', 'font-weight': 500 },
      svg, `${parseInt(m, 10)}/${parseInt(d, 10)}`
    );
  }

  // Legend
  let legendX = PAD.left;
  const legendY = 14;
  if (sleepMap.size > 0) {
    make('rect', { x: legendX, y: legendY - 6, width: 16, height: 3, fill: 'url(#sleepGradient)', rx: 1.5 });
    make(
      'text',
      { x: legendX + 22, y: legendY + 4, fill: '#c5cad6', 'font-size': 10, 'font-weight': 700, 'letter-spacing': '0.08em' },
      svg, 'SLEEP'
    );
    legendX += 80;
  }
  if (stressMap.size > 0) {
    make('rect', { x: legendX, y: legendY - 6, width: 16, height: 3, fill: STRESS_COLOR, rx: 1.5 });
    make(
      'text',
      { x: legendX + 22, y: legendY + 4, fill: '#c5cad6', 'font-size': 10, 'font-weight': 700, 'letter-spacing': '0.08em' },
      svg, 'STRESS'
    );
  }

  // Sleep line + dots
  if (sleepRange) {
    const sleepPts = [];
    for (let i = 0; i < days; i++) {
      if (sleepMap.has(dayStrings[i])) sleepPts.push({ i, v: sleepMap.get(dayStrings[i]) });
    }
    if (sleepPts.length > 1) {
      const path = sleepPts
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(p.i)} ${yAtSleep(p.v)}`)
        .join(' ');
      make('path', {
        d: path, fill: 'none', stroke: 'url(#sleepGradient)',
        'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      });
    }
    for (const p of sleepPts) {
      make('circle', {
        cx: xAt(p.i), cy: yAtSleep(p.v), r: 4,
        fill: '#0a0c10', stroke: 'url(#sleepGradient)', 'stroke-width': 2,
      });
    }
  }

  // Stress line + dots
  if (stressRange) {
    const stressPts = [];
    for (let i = 0; i < days; i++) {
      if (stressMap.has(dayStrings[i])) stressPts.push({ i, v: stressMap.get(dayStrings[i]) });
    }
    if (stressPts.length > 1) {
      const path = stressPts
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(p.i)} ${yAtStress(p.v)}`)
        .join(' ');
      make('path', {
        d: path, fill: 'none', stroke: STRESS_COLOR,
        'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      });
    }
    for (const p of stressPts) {
      make('circle', {
        cx: xAt(p.i), cy: yAtStress(p.v), r: 4,
        fill: '#0a0c10', stroke: STRESS_COLOR, 'stroke-width': 2,
      });
    }
  }
}

// ==== Habits ====
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const habitForm = $('habit-form');
const habitStatus = $('habit-status');
const habitModal = $('habit-modal');
const addHabitBtn = $('add-habit-btn');

addHabitBtn.addEventListener('click', openHabitModal);
$('habit-modal-close').addEventListener('click', closeHabitModal);
$('habit-modal-cancel').addEventListener('click', closeHabitModal);

habitModal.addEventListener('click', (e) => {
  if (e.target === habitModal) closeHabitModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !habitModal.hidden) closeHabitModal();
});

function openHabitModal() {
  habitModal.hidden = false;
  setTimeout(() => $('habit-name').focus(), 50);
}

function closeHabitModal() {
  habitModal.hidden = true;
  $('habit-name').value = '';
  setDayPicker('0000000');
  setStatus(habitStatus, '');
}

document.querySelectorAll('#habit-form-days .day-pill').forEach((pill) => {
  pill.addEventListener('click', () => pill.classList.toggle('active'));
});

document.querySelectorAll('.habit-preset').forEach((btn) => {
  btn.addEventListener('click', () => setDayPicker(btn.dataset.preset));
});

function setDayPicker(dayStr) {
  document.querySelectorAll('#habit-form-days .day-pill').forEach((pill, i) => {
    pill.classList.toggle('active', dayStr[i] === '1');
  });
}

function readDayPicker() {
  let s = '';
  for (let i = 0; i < 7; i++) {
    const pill = document.querySelector(`#habit-form-days .day-pill[data-day="${i}"]`);
    s += pill && pill.classList.contains('active') ? '1' : '0';
  }
  return s;
}

habitForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('habit-name').value.trim();
  if (!name) {
    setStatus(habitStatus, 'Enter a habit name', 'error');
    return;
  }
  const days = readDayPicker();
  if (days === '0000000') {
    setStatus(habitStatus, 'Pick at least one day', 'error');
    return;
  }
  try {
    const res = await fetch('/api/habits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, days }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    closeHabitModal();
    loadHabits();
  } catch (err) {
    setStatus(habitStatus, err.message, 'error');
  }
});

async function loadHabits() {
  const today = todayISO();
  try {
    const [habitsRes, complRes] = await Promise.all([
      fetch('/api/habits'),
      fetch(`/api/habit-completions?date=${today}`),
    ]);
    const habits = await habitsRes.json();
    const completedIds = new Set(await complRes.json());
    renderHabitsToday(habits, completedIds, today);
    renderAllHabits(habits);
  } catch (err) {
    console.error('Failed to load habits', err);
  }
}

function renderHabitsToday(habits, completedIds, today) {
  const list = $('habits-today-list');
  list.innerHTML = '';

  const dow = new Date().getDay();
  $('habits-today-day').textContent = DAY_FULL[dow];

  const todays = habits.filter((h) => h.days[dow] === '1');

  if (todays.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = habits.length === 0
      ? 'No habits yet. Add your first one below.'
      : 'No habits scheduled for today. Enjoy the day off.';
    list.appendChild(empty);
    return;
  }

  for (const h of todays) {
    const li = document.createElement('li');
    li.className = 'habit-today-item';
    const isDone = completedIds.has(h.id);
    if (isDone) li.classList.add('completed');

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'habit-checkbox';
    checkbox.setAttribute('aria-label', isDone ? `Mark "${h.name}" as not done` : `Mark "${h.name}" as done`);
    checkbox.setAttribute('aria-pressed', isDone ? 'true' : 'false');
    checkbox.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    checkbox.addEventListener('click', () => toggleHabit(h.id, today, !isDone));

    const name = document.createElement('span');
    name.className = 'habit-today-name';
    name.textContent = h.name;

    li.appendChild(checkbox);
    li.appendChild(name);
    list.appendChild(li);
  }
}

function renderAllHabits(habits) {
  const list = $('all-habits-list');
  list.innerHTML = '';

  if (habits.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No habits yet. Add one above.';
    list.appendChild(empty);
    return;
  }

  for (const h of habits) {
    const li = document.createElement('li');
    li.className = 'habit-item';

    const name = document.createElement('div');
    name.className = 'habit-item-name';
    name.textContent = h.name;

    const days = document.createElement('div');
    days.className = 'habit-item-days';
    for (let i = 0; i < 7; i++) {
      const dot = document.createElement('span');
      dot.className = 'habit-day-dot';
      if (h.days[i] === '1') dot.classList.add('active');
      dot.textContent = DAY_LABELS[i];
      days.appendChild(dot);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'habit-delete';
    del.title = 'Delete habit';
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.addEventListener('click', () => deleteHabit(h.id, h.name));

    li.appendChild(name);
    li.appendChild(days);
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function toggleHabit(habitId, date, completed) {
  try {
    const res = await fetch('/api/habit-completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ habit_id: habitId, date, completed }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed');
    }
    loadHabits();
  } catch (err) {
    console.error('Failed to toggle habit', err);
  }
}

async function deleteHabit(id, name) {
  if (!confirm(`Delete "${name}"? This will also remove its completion history.`)) return;
  try {
    await fetch(`/api/habits/${id}`, { method: 'DELETE' });
    loadHabits();
  } catch (err) {
    console.error('Failed to delete habit', err);
  }
}

// ==== Admin ====

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load users');
    }
    const users = await res.json();
    renderAdminUsers(users);
  } catch (err) {
    console.error('Failed to load admin users', err);
  }
}

function renderAdminUsers(users) {
  const list = $('admin-users-list');
  list.innerHTML = '';
  $('admin-user-count').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;

  if (users.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No users.';
    list.appendChild(empty);
    return;
  }

  for (const u of users) {
    const li = document.createElement('li');
    li.className = 'admin-user-row';
    if (currentUser && u.id === currentUser.id) li.classList.add('self');

    const main = document.createElement('div');
    main.className = 'admin-user-main';

    const name = document.createElement('div');
    name.className = 'admin-user-name';
    name.textContent = u.username;
    if (currentUser && u.id === currentUser.id) {
      const tag = document.createElement('span');
      tag.className = 'you-badge';
      tag.textContent = 'You';
      name.appendChild(tag);
    }
    if (u.is_admin) {
      const tag = document.createElement('span');
      tag.className = 'admin-badge';
      tag.textContent = 'Admin';
      name.appendChild(tag);
    }

    const meta = document.createElement('div');
    meta.className = 'admin-user-meta';
    const createdDate = u.created_at ? new Date(u.created_at + 'Z') : null;
    const created = createdDate
      ? createdDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : 'unknown';
    const last = u.last_entry_at
      ? new Date(u.last_entry_at + 'Z').toLocaleDateString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
        })
      : '—';
    meta.innerHTML = `<span>Joined ${created}</span><span>Last entry ${last}</span><span>ID ${u.id}</span>`;

    main.appendChild(name);
    main.appendChild(meta);

    const stats = document.createElement('div');
    stats.className = 'admin-stats';
    const statItems = [
      ['Entries', u.entries_count],
      ['Photos', u.photos_count],
      ['Weights', u.weights_count],
      ['Habits', u.habits_count],
    ];
    for (const [label, count] of statItems) {
      const wrap = document.createElement('div');
      const num = document.createElement('span');
      num.textContent = count;
      const lbl = document.createElement('span');
      lbl.className = 'stat-label';
      lbl.textContent = label;
      wrap.appendChild(num);
      wrap.appendChild(lbl);
      stats.appendChild(wrap);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'admin-delete';
    del.title = 'Delete user';
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    if (currentUser && u.id === currentUser.id) {
      del.disabled = true;
      del.title = "You can't delete your own admin account";
    } else {
      del.addEventListener('click', () => deleteAdminUser(u.id, u.username));
    }

    li.appendChild(main);
    li.appendChild(stats);
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function deleteAdminUser(id, username) {
  const msg = `Delete user "${username}" (id ${id})?\n\nThis permanently removes all their:\n• Food entries\n• Photos (files + records)\n• Weights & body measurements\n• Water & lifestyle logs\n• Habits & completions\n• Goals & meal templates\n• Sessions (they'll be logged out)\n\nThis cannot be undone.`;
  if (!confirm(msg)) return;
  try {
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    loadAdminUsers();
  } catch (err) {
    alert('Failed to delete user: ' + err.message);
  }
}

// ==== Init ====

function enterApp() {
  if (currentUser) {
    $('user-name').textContent = currentUser.username;
    // Show admin-only UI if this user has the flag
    document.querySelectorAll('.admin-only').forEach((el) => {
      el.hidden = !currentUser.is_admin;
    });
  }
  appInitialized = true;
  loadEntries();
  loadGoals().then(() => {
    loadWeights();
    loadWater();
  });
  loadCheckIn();
  loadMeasurements();
  loadMealTemplates();
}

(async () => {
  const user = await checkAuth();
  if (user) {
    enterApp();
  } else {
    showAuthScreen();
  }
})();
