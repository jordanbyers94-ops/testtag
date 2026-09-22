// Derived from wherever this script itself was loaded from, rather than hardcoded to '/api' —
// so this same file works unchanged both standalone (served at a domain's root, e.g. on
// Railway) and reverse-proxied under a path prefix (e.g. "/testtag/" on another site), without
// needing two versions or a build step. document.currentScript.src is the resolved URL of this
// <script> tag at the moment it runs; new URL('.', src) strips the filename, leaving the
// directory this page's assets (and therefore its API) live under.
const APP_BASE = (function () {
  const src = document.currentScript && document.currentScript.src;
  if (src) { try { return new URL('.', src).pathname; } catch (e) { /* fall through */ } }
  return '/';
})();
const API = APP_BASE.replace(/\/$/, '') + '/api';
// True when this page is being served from somewhere other than a domain root -- in practice,
// that means the /testtag/ reverse proxy on the Audit Tool's Cloudflare project (see
// functions/testtag/[[path]].js), which injects the real access token on every request server
// side. Reaching Test & Tag this way already went through the Audit Tool's own login, so its
// own separate token prompt is skipped entirely -- see ensureToken() below. Standalone hosting
// (APP_BASE === '/', e.g. directly on Railway) is unaffected and keeps asking as before.
const IS_PROXIED = APP_BASE !== '/';
let accessToken = localStorage.getItem('testTagAccessToken') || (IS_PROXIED ? 'proxied' : '');

// ---------- Home button (only meaningful when reached via the Audit Tool's proxy) ----------
// Standalone hosting (e.g. directly on Railway) has no "home" to go back to, so this only
// shows up when proxied under the Audit Tool -- APP_BASE is then something like "/testtag/",
// and the Audit Tool's own app lives one level up, at the domain root.
(function initHomeButton() {
  if (!IS_PROXIED) return;
  const btn = document.getElementById('btnHomeTestTag');
  if (!btn) return;
  btn.style.display = 'inline-block';
  const homeUrl = new URL('../', window.location.href).pathname;
  btn.addEventListener('click', () => { window.location.href = homeUrl; });
})();

// ---------- Cloud report upload (only meaningful when proxied under the Audit Tool) ----------
// "Upload Report to Cloud" and the "View all uploaded Test & Tag reports" link both need the
// Cloudflare-side /api/testtag-reports endpoint, which only exists on the Audit Tool's own
// domain -- so both are hidden entirely on standalone hosting (e.g. directly on Railway).
function getCloudToken() {
  const exp = Number(localStorage.getItem('cloudTokenExpiresAt') || 0);
  if (!exp || Date.now() > exp) return null;
  return localStorage.getItem('cloudToken');
}
(function initCloudReportsLink() {
  if (!IS_PROXIED) return;
  const wrap = document.getElementById('cloudReportsLinkWrap');
  if (wrap) wrap.style.display = 'block';
  const generateBtn = document.getElementById('generateReportBtn');
  if (generateBtn) generateBtn.textContent = 'Generate & Upload to Cloud';
})();
let currentAssetId = null;
let currentAssetIsTemp = false; // true while currentAssetId is a client-side tempId (offline, not yet synced)
let currentPhotoBase64 = null;
let currentPhotoMediaType = null;
let activeFilter = ''; // '' | 'fail' | 'repairable' | 'overdue' | 'soon'

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'register') { loadSiteOptions(); loadRegister(); }
    if (btn.dataset.tab === 'due') loadDueSummary();
    if (btn.dataset.tab === 'settings') renderSettingsTab();
  });
});

// ---------- Access token gate ----------
function ensureToken() {
  if (IS_PROXIED) return; // the /testtag/ proxy already supplied the real token server side
  if (!accessToken) document.getElementById('tokenGate').style.display = 'block';
}
document.getElementById('tokenSaveBtn').addEventListener('click', () => {
  const val = document.getElementById('tokenInput').value.trim();
  if (val) {
    accessToken = val;
    localStorage.setItem('testTagAccessToken', val);
    document.getElementById('tokenGate').style.display = 'none';
    loadSiteOptions();
  }
});
function apiHeaders(extra = {}) { return { 'x-app-token': accessToken, ...extra }; }

// ---------- Remembered tester ----------
// Backed by the shared technician-profile.js module (see that file for the full contract).
// When proxied under the Audit Tool (see IS_PROXIED above), this page shares an origin with it,
// so the technician's own name/licence from their Cloud Sync login is readable here directly and
// takes priority -- no retyping needed. Falls back to Test & Tag's own remembered values (set on
// the new Settings tab) whenever there's no active Audit Tool login to read, including always on
// standalone hosting. TESTER_PROFILE_PREFIX namespaces Test & Tag's own local-fallback storage
// keys so a future addon reusing the same module doesn't collide with these.
const TESTER_PROFILE_PREFIX = 'testTag';
function prefillTester() {
  const nameEl = document.getElementById('t_tester_name');
  const licenceEl = document.getElementById('t_tester_licence');
  const effective = TechnicianProfile.resolve(TESTER_PROFILE_PREFIX);
  nameEl.value = effective.name;
  licenceEl.value = effective.licence;
}
prefillTester();
function persistTester() {
  // Only writes back into the local-fallback slot -- if the tester field currently reflects a
  // cloud login, this is a harmless no-op for prefill purposes (cloud still takes priority next
  // time) but keeps the local fallback in sync in case the technician later logs out.
  TechnicianProfile.writeLocal(
    TESTER_PROFILE_PREFIX,
    document.getElementById('t_tester_name').value,
    document.getElementById('t_tester_licence').value
  );
}
function renderSettingsTab() {
  TechnicianProfile.renderSettingsScreen(document.getElementById('settingsContainer'), {
    prefix: TESTER_PROFILE_PREFIX,
    onChange: prefillTester,
  });
}

// ---------- Switch User ----------
// Clears this device's technician details entirely -- both the Audit Tool's own Cloud Sync
// login (if reached that way) and Test & Tag's own local-fallback name/licence/override -- so a
// shared device (a work tablet, say) can be handed off cleanly to the next technician rather
// than silently carrying over the previous one's name/licence onto their tests.
document.getElementById('switchUserBtn').addEventListener('click', () => {
  if (!confirm('Clear this device\'s saved technician details? The next person to use it will need to log in / enter their own name and licence.')) return;
  localStorage.removeItem('cloudToken');
  localStorage.removeItem('cloudTokenExpiresAt');
  localStorage.removeItem('cloudTechnicianName');
  localStorage.removeItem('cloudTechnicianLicense');
  TechnicianProfile.setOverride(TESTER_PROFILE_PREFIX, false);
  TechnicianProfile.writeLocal(TESTER_PROFILE_PREFIX, '', '');
  prefillTester();
  if (document.getElementById('tab-settings').classList.contains('active')) renderSettingsTab();
  alert('Details cleared. The next technician can enter their own name and licence in Settings (or log into Cloud Sync via the Audit Tool).');
});

// ---------- Local register cache (IndexedDB) ----------
// Mirrors the last successful online GET /api/assets response so the Register and Due tabs
// stay browsable with no connection at all, not just writable (see the offline queue below for
// the write side). Best-effort: every helper here swallows its own errors so a cache problem
// never blocks the app's real, server-backed behavior when online.
const IDB_NAME = 'testTagLocalCache';
const IDB_VERSION = 1;
function openIdb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbReplaceAllAssets(items) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      const store = tx.objectStore('assets');
      store.clear();
      items.forEach((item) => store.put(item));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* best-effort */ }
}
async function idbPutAsset(item) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put(item);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* best-effort */ }
}
async function idbGetAsset(id) {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readonly');
      const req = tx.objectStore('assets').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}
async function idbGetAllAssets() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readonly');
      const req = tx.objectStore('assets').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return []; }
}

// Optimistically updates the cached copy of an asset with a just-logged (but still queued)
// test result, so it shows up with its new Pass/Fail badge and due date immediately in the
// Register list rather than only after the next successful online refresh.
async function mergeOptimisticTest(assetId, payload) {
  const existing = (await idbGetAsset(assetId)) || { id: assetId };
  await idbPutAsset({
    ...existing,
    last_tag_no: payload.tag_no || existing.last_tag_no || null,
    last_result: payload.result || existing.last_result || null,
    last_next_due: payload.next_due || existing.last_next_due || null,
    last_tester_name: payload.tester_name || existing.last_tester_name || null,
    _pending: true,
  });
}

// Re-implements the same site/search/result/due filtering the server does in
// routes/assets.js's GET / handler, so a cached register behaves identically when browsed
// offline. Keep these two in sync if the server-side filtering logic changes.
function filterAssetsLocally(rows, { site, jobNumber, search, filter }) {
  let out = rows;
  if (site) out = out.filter((r) => (r.site || '').toLowerCase() === site.toLowerCase());
  if (jobNumber) out = out.filter((r) => (r.job_number || '').toLowerCase() === jobNumber.toLowerCase());
  if (search) {
    const q = search.toLowerCase();
    out = out.filter((r) => [r.appliance, r.plant_no, r.location, r.serial_no, r.brand, r.last_tag_no, r.job_number, r.client_name]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  if (filter === 'fail' || filter === 'repairable') out = out.filter((r) => r.last_result === filter);
  else if (filter === 'overdue' || filter === 'soon') {
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    out = out.filter((r) => {
      if (!r.last_next_due) return false;
      const due = String(r.last_next_due).slice(0, 10);
      return filter === 'overdue' ? due < today : (due >= today && due <= in30);
    });
  }
  return out;
}

// ---------- Offline queue ----------
// Extraction needs the network (it's an AI call) so it's disabled offline, but asset saves
// and test logs are queued locally and flushed automatically on reconnect. This is a
// best-effort queue, not a full offline cache of the register.
//
// Queue entries are typed rather than generic POST wrappers, specifically so a test logged
// against an asset that's ITSELF still queued (both saved in the same offline session) can be
// chained together correctly instead of being silently unsaveable:
//   { type: 'asset', tempId: 'temp_xxx', body }        -- a new/updated asset, not yet synced
//   { type: 'test',  assetId: 123, body }               -- test against an already-real asset id
//   { type: 'test',  assetTempId: 'temp_xxx', body }     -- test against a still-queued asset
const QUEUE_KEY = 'testTagOfflineQueue';
function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); updateOfflineBanner(); }
function enqueue(action) { const q = getQueue(); q.push(action); setQueue(q); }
function makeTempId() { return 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  const bannerText = document.getElementById('offlineBannerText');
  const syncBtn = document.getElementById('syncNowBtn');
  const q = getQueue();
  if (!navigator.onLine) {
    banner.style.display = 'flex';
    bannerText.textContent = q.length
      ? `Offline — ${q.length} item${q.length === 1 ? '' : 's'} queued, will sync once you're back online.`
      : "Offline — saves will queue and sync automatically once you're back online.";
    syncBtn.style.display = 'none'; // can't upload without a connection
    document.getElementById('extractBtn').disabled = true;
    document.getElementById('extractBtn').title = 'Photo reading needs an internet connection';
  } else if (q.length) {
    banner.style.display = 'flex';
    bannerText.textContent = `${q.length} item${q.length === 1 ? '' : 's'} waiting to upload.`;
    syncBtn.style.display = 'inline-block';
    syncBtn.disabled = false;
    syncBtn.textContent = 'Upload to Cloud';
    document.getElementById('extractBtn').disabled = !photoInput.files[0];
    document.getElementById('extractBtn').title = '';
  } else {
    banner.style.display = 'none';
    document.getElementById('extractBtn').disabled = !photoInput.files[0];
    document.getElementById('extractBtn').title = '';
  }
}

document.getElementById('syncNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  await flushQueue();
  updateOfflineBanner();
});

// Processes the queue in order (asset actions before the test actions that reference them,
// since they were enqueued in that order). Resolves each synced asset's tempId to its real id
// as it goes, so a test queued this same offline session against a still-temp asset gets sent
// right after that asset syncs, in the same pass. A test whose asset hasn't synced yet (still
// failing, or genuinely not reached this pass) stays queued rather than being dropped.
async function flushQueue() {
  if (!navigator.onLine) return;
  let q = getQueue();
  if (q.length === 0) return;
  const tempIdMap = {};
  const remaining = [];
  for (const action of q) {
    try {
      if (action.type === 'asset') {
        const res = await fetch(`${API}/assets`, { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(action.body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'sync failed');
        tempIdMap[action.tempId] = data.id;
      } else if (action.type === 'test') {
        const assetId = action.assetId || tempIdMap[action.assetTempId];
        if (!assetId) { remaining.push(action); continue; } // its asset hasn't synced yet -- retry next time
        const res = await fetch(`${API}/assets/${assetId}/tests`, { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(action.body) });
        if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'sync failed'); }
      }
    } catch (e) {
      remaining.push(action); // keep for next attempt
    }
  }
  setQueue(remaining);
  if (remaining.length === 0) loadRegister();
}

window.addEventListener('online', () => { updateOfflineBanner(); flushQueue(); });
window.addEventListener('offline', updateOfflineBanner);

// ---------- Site autocomplete + remembered Client Name ----------
// site name (lowercased) -> client name, so the Scan tab can auto-fill Client Name once a
// technician picks/types a Site that's already on file -- one less thing to retype on every
// return visit to the same site.
let siteClientNames = {};

async function loadSiteOptions() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`${API}/assets/sites`, { headers: apiHeaders() });
    if (!res.ok) return;
    const sites = await res.json();
    const opts = sites.map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
    document.getElementById('siteOptions').innerHTML = opts;
    document.getElementById('siteOptionsRegister').innerHTML = opts;
    siteClientNames = {};
    sites.forEach((s) => { if (s.client_name) siteClientNames[s.name.toLowerCase()] = s.client_name; });
  } catch (e) { /* non-fatal */ }
}

// Auto-fills Client Name from the remembered value for the typed/picked Site, but only when
// Client Name is currently empty -- never overwrites something the technician already typed
// (e.g. a one-off client name for a site normally used by someone else).
function autofillClientNameFromSite() {
  const site = document.getElementById('siteInput').value.trim();
  const clientNameInput = document.getElementById('clientNameInput');
  if (!site || clientNameInput.value.trim()) return;
  const remembered = siteClientNames[site.toLowerCase()];
  if (remembered) clientNameInput.value = remembered;
}
document.getElementById('siteInput').addEventListener('change', autofillClientNameFromSite);
// 'input' also fires when a datalist option is clicked/selected (unlike 'change' alone in some
// browsers), so this covers picking from the dropdown as well as typing then tabbing away.
document.getElementById('siteInput').addEventListener('input', autofillClientNameFromSite);

// ---------- Photo capture / extraction ----------
const photoInput = document.getElementById('photoInput');
const extractBtn = document.getElementById('extractBtn');
const preview = document.getElementById('preview');
const extractStatus = document.getElementById('extractStatus');

photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;
  preview.innerHTML = '';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  preview.appendChild(img);
  extractBtn.disabled = !navigator.onLine;
  document.getElementById('resultCard').style.display = 'none';
  document.getElementById('testCard').style.display = 'none';
  document.getElementById('retestBanner').style.display = 'none';
  currentAssetId = null;
  currentAssetIsTemp = false;
  currentPhotoBase64 = null;
});

document.getElementById('skipExtractBtn').addEventListener('click', () => {
  const site = document.getElementById('siteInput').value.trim();
  if (!site) { alert('Enter the site/client name first.'); return; }
  ['f_appliance', 'f_plant_no', 'f_brand', 'f_model_no', 'f_serial_no'].forEach((id) => document.getElementById(id).value = '');
  document.getElementById('t_tag_no').value = '';
  document.getElementById('resultCard').style.display = 'block';
  document.getElementById('testCard').style.display = 'block';
  document.getElementById('existingNotice').style.display = 'none';
  document.getElementById('retestBanner').style.display = 'none';
  currentAssetId = null;
  currentAssetIsTemp = false;
  currentPhotoBase64 = null;
});

extractBtn.addEventListener('click', async () => {
  const site = document.getElementById('siteInput').value.trim();
  if (!site) { alert('Enter the site/client name first.'); return; }
  const file = photoInput.files[0];
  if (!file) return;
  extractStatus.textContent = 'Reading tag...';
  extractBtn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('photo', file);
    const res = await fetch(`${API}/extract`, { method: 'POST', headers: apiHeaders(), body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Extraction failed');

    currentPhotoBase64 = await fileToBase64(file);
    currentPhotoMediaType = file.type || 'image/jpeg';

    const ex = data.extracted || {};
    document.getElementById('f_appliance').value = ex.appliance || '';
    document.getElementById('f_plant_no').value = ex.plant_no || '';
    document.getElementById('f_brand').value = ex.brand || '';
    document.getElementById('f_model_no').value = ex.model_no || '';
    document.getElementById('f_serial_no').value = ex.serial_no || '';
    document.getElementById('t_tag_no').value = ex.tag_no || '';
    document.getElementById('t_result').value = ['fail', 'repairable'].includes(ex.pass_fail_on_tag) ? ex.pass_fail_on_tag : 'pass';
    document.getElementById('t_test_date').value = normalizeDate(ex.test_date_on_tag);

    document.getElementById('resultCard').style.display = 'block';
    extractStatus.textContent = ex.confidence_notes ? `Note: ${ex.confidence_notes}` : 'Done - check details below.';

    await tryMatchExisting(site, ex);
  } catch (err) {
    extractStatus.textContent = `Error: ${err.message}`;
  } finally {
    extractBtn.disabled = false;
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
function normalizeDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

async function tryMatchExisting(site, ex) {
  const location = document.getElementById('locationInput').value.trim();
  const existingNotice = document.getElementById('existingNotice');
  let found = null;

  if (ex.tag_no) {
    const r = await fetch(`${API}/assets/by-tag/${encodeURIComponent(ex.tag_no)}`, { headers: apiHeaders() });
    if (r.ok) found = await r.json();
  }
  if (!found && (ex.plant_no || ex.serial_no)) {
    const params = new URLSearchParams({ site, location, plant_no: ex.plant_no || '', serial_no: ex.serial_no || '' });
    const r = await fetch(`${API}/assets/match?${params}`, { headers: apiHeaders() });
    if (r.ok) found = await r.json();
  }

  if (found) {
    currentAssetId = found.asset.id;
    currentAssetIsTemp = false;
    document.getElementById('categoryInput').value = found.asset.environment_category || '';
    const last = found.history[0];
    existingNotice.style.display = 'block';
    existingNotice.textContent = last
      ? `Existing asset - last test: ${last.test_date || 'unknown date'} (${last.result}). Saving will update its details and this will log a new test.`
      : 'Existing asset, no prior test on record.';
  } else {
    currentAssetId = null;
    existingNotice.style.display = 'none';
  }
  document.getElementById('testCard').style.display = 'block';
}

// ---------- Save asset ----------
document.getElementById('saveAssetBtn').addEventListener('click', async () => {
  const site = document.getElementById('siteInput').value.trim();
  if (!site) { alert('Site is required.'); return; }
  const payload = {
    site,
    location: document.getElementById('locationInput').value.trim() || null,
    environment_category: document.getElementById('categoryInput').value || null,
    appliance: document.getElementById('f_appliance').value.trim() || null,
    plant_no: document.getElementById('f_plant_no').value.trim() || null,
    brand: document.getElementById('f_brand').value.trim() || null,
    model_no: document.getElementById('f_model_no').value.trim() || null,
    serial_no: document.getElementById('f_serial_no').value.trim() || null,
    client_name: document.getElementById('clientNameInput').value.trim() || null,
    job_number: document.getElementById('jobNumberInput').value.trim() || null,
  };

  try {
    if (navigator.onLine) {
      const res = await fetch(`${API}/assets`, { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      currentAssetId = data.id;
      currentAssetIsTemp = false;
      document.getElementById('testCard').style.display = 'block';
      extractStatus.textContent = 'Asset saved to register.';
    } else {
      // Can't get a real asset id while offline -- queue the asset save under a client-side
      // tempId, so a test logged against it (below) can be chained to sync right after.
      const tempId = makeTempId();
      enqueue({ type: 'asset', tempId, body: payload });
      currentAssetId = tempId;
      currentAssetIsTemp = true;
      // Merge it into the local register cache immediately (not just the queue) so it actually
      // shows up in the Register tab right away, marked "Pending sync", rather than being
      // invisible until the next successful online refresh.
      idbPutAsset({
        id: tempId, site: payload.site, location: payload.location, appliance: payload.appliance,
        plant_no: payload.plant_no, brand: payload.brand, model_no: payload.model_no,
        serial_no: payload.serial_no, environment_category: payload.environment_category,
        notes: payload.notes, client_name: payload.client_name, job_number: payload.job_number,
        last_tag_no: null, last_result: null, last_next_due: null,
        last_tester_name: null, _pending: true,
      });
      document.getElementById('testCard').style.display = 'block';
      extractStatus.textContent = 'Offline - asset queued, will sync when back online.';
    }
  } catch (err) {
    alert(`Error saving asset: ${err.message}`);
  }
});

// ---------- Log test ----------
document.getElementById('saveTestBtn').addEventListener('click', async () => {
  if (!currentAssetId) { alert('Save the asset to the register first.'); return; }
  persistTester();
  const payload = {
    tag_no: document.getElementById('t_tag_no').value.trim() || null,
    tester_name: document.getElementById('t_tester_name').value.trim() || null,
    tester_licence: document.getElementById('t_tester_licence').value.trim() || null,
    result: document.getElementById('t_result').value,
    test_date: document.getElementById('t_test_date').value || null,
    next_due: document.getElementById('t_next_due').value || null,
    notes: document.getElementById('t_notes').value.trim() || null,
    photo_base64: currentPhotoBase64 || null,
    photo_media_type: currentPhotoMediaType || null,
  };

  try {
    if (navigator.onLine && !currentAssetIsTemp) {
      const res = await fetch(`${API}/assets/${currentAssetId}/tests`, { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      document.getElementById('testStatus').textContent = 'Test logged. Ready for the next item.';
    } else if (currentAssetIsTemp) {
      // The parent asset is itself still queued -- queue this test against the same tempId so
      // flushQueue() can chain them together once the asset syncs (see flushQueue above).
      enqueue({ type: 'test', assetTempId: currentAssetId, body: payload });
      await mergeOptimisticTest(currentAssetId, payload);
      document.getElementById('testStatus').textContent = 'Offline - test result saved and queued, will sync with its asset once back online.';
    } else {
      // Asset was already saved with a real id (earlier, while online); we've since gone
      // offline before logging the test. Queue it against that real id directly.
      enqueue({ type: 'test', assetId: currentAssetId, body: payload });
      await mergeOptimisticTest(currentAssetId, payload);
      document.getElementById('testStatus').textContent = 'Offline - test result queued, will sync when back online.';
    }
    setTimeout(resetScanForm, 1400);
  } catch (err) {
    document.getElementById('testStatus').textContent = `Error: ${err.message}`;
  }
});

function resetScanForm() {
  photoInput.value = '';
  preview.innerHTML = '';
  extractBtn.disabled = true;
  extractStatus.textContent = '';
  document.getElementById('resultCard').style.display = 'none';
  document.getElementById('testCard').style.display = 'none';
  document.getElementById('testStatus').textContent = '';
  document.getElementById('t_tag_no').value = '';
  document.getElementById('t_notes').value = '';
  document.getElementById('retestBanner').style.display = 'none';
  currentAssetId = null;
  currentAssetIsTemp = false;
  currentPhotoBase64 = null;
}

// ---------- Register list ----------
const registerList = document.getElementById('registerList');
const searchInput = document.getElementById('searchInput');
const siteFilter = document.getElementById('siteFilter');
const jobNumberFilter = document.getElementById('jobNumberFilter');

document.getElementById('filterAllBtn').addEventListener('click', () => setActiveFilter(''));
document.getElementById('filterFailBtn').addEventListener('click', () => setActiveFilter('fail'));
document.getElementById('filterRepairableBtn').addEventListener('click', () => setActiveFilter('repairable'));
document.getElementById('filterOverdueBtn').addEventListener('click', () => setActiveFilter('overdue'));
document.getElementById('filterSoonBtn').addEventListener('click', () => setActiveFilter('soon'));
function setActiveFilter(f) {
  activeFilter = f;
  document.getElementById('filterAllBtn').classList.toggle('active', f === '');
  document.getElementById('filterFailBtn').classList.toggle('active', f === 'fail');
  document.getElementById('filterRepairableBtn').classList.toggle('active', f === 'repairable');
  document.getElementById('filterOverdueBtn').classList.toggle('active', f === 'overdue');
  document.getElementById('filterSoonBtn').classList.toggle('active', f === 'soon');
  loadRegister();
}

async function loadRegister() {
  registerList.innerHTML = '<p class="status">Loading...</p>';
  const site = siteFilter.value.trim();
  const jobNumber = jobNumberFilter.value.trim();
  const search = searchInput.value.trim();
  let rows;
  let fromCache = false;

  try {
    if (!navigator.onLine) throw new Error('offline');
    const params = new URLSearchParams();
    if (site) params.set('site', site);
    if (jobNumber) params.set('job_number', jobNumber);
    if (search) params.set('search', search);
    if (activeFilter === 'fail' || activeFilter === 'repairable') params.set('result', activeFilter);
    else if (activeFilter === 'overdue') params.set('due', 'overdue');
    else if (activeFilter === 'soon') params.set('due', 'soon');
    const res = await fetch(`${API}/assets?${params}`, { headers: apiHeaders() });
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load');
    // Mirror the full unfiltered register into the local cache (only when this fetch itself
    // wasn't already filtered) so an offline browse later has the complete picture to filter
    // client-side, not just whatever slice happened to be on screen when connection dropped.
    if (!site && !jobNumber && !search && !activeFilter) idbReplaceAllAssets(rows);
  } catch (err) {
    try {
      const cached = await idbGetAllAssets();
      rows = filterAssetsLocally(cached, { site, jobNumber, search, filter: activeFilter });
      fromCache = true;
    } catch (idbErr) {
      registerList.innerHTML = `<p class="status">Error: ${err.message}</p>`;
      return;
    }
  }

  if (rows.length === 0) {
    registerList.innerHTML = `<p class="status">No assets found.${fromCache ? ' (showing last saved copy, offline)' : ''}</p>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const cacheNotice = fromCache
    ? '<p class="status" style="color:#e65100;">Showing the last saved copy — offline, so this may not include very recent changes.</p>'
    : '';

  registerList.innerHTML = cacheNotice + rows.map((r) => {
    const badge = r.last_result === 'pass' ? 'badge-pass' : r.last_result === 'fail' ? 'badge-fail' : r.last_result === 'repairable' ? 'badge-repairable' : 'badge-none';
    const badgeText = r.last_result ? r.last_result.toUpperCase() : 'NOT TESTED';
    const due = r.last_next_due ? String(r.last_next_due).slice(0, 10) : null;
    let rowClass = '';
    if (due && due < today) rowClass = 'overdue';
    else if (due && due <= in30) rowClass = 'soon';
    const pendingBadge = r._pending ? '<span class="badge" style="background:#fff3e0;color:#e65100;">Pending sync</span>' : '';
    return `
      <div class="asset-row ${rowClass}" data-asset-id="${r.id}" data-appliance="${escapeHtml(r.appliance || '')}">
        <div class="plant-no">${escapeHtml(r.appliance || 'Unnamed item')} <span class="badge ${badge}">${badgeText}</span> ${pendingBadge}</div>
        <div class="meta">${escapeHtml(r.site)} · ${escapeHtml(r.location || '—')} ${r.plant_no ? '· Plant No. ' + escapeHtml(r.plant_no) : ''}</div>
        ${(r.client_name || r.job_number) ? `<div class="meta">${r.client_name ? escapeHtml(r.client_name) : ''}${r.client_name && r.job_number ? ' · ' : ''}${r.job_number ? 'Job ' + escapeHtml(r.job_number) : ''}</div>` : ''}
        <div class="meta">${r.brand ? escapeHtml(r.brand) + ' ' : ''}${r.model_no ? escapeHtml(r.model_no) : ''} ${r.last_tag_no ? '· Tag ' + escapeHtml(r.last_tag_no) : ''}</div>
        <div class="meta">Next due: ${due || '—'}${rowClass === 'overdue' ? ' (OVERDUE)' : rowClass === 'soon' ? ' (due soon)' : ''}</div>
      </div>
    `;
  }).join('');

  registerList.querySelectorAll('.asset-row').forEach((el) => {
    el.addEventListener('click', () => {
      if (String(el.dataset.assetId).startsWith('temp_')) {
        alert('This item is still queued to sync and doesn\'t have its test history available yet. It will be fully viewable once back online and synced.');
        return;
      }
      openHistoryModal(el.dataset.assetId, el.dataset.appliance);
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('refreshBtn').addEventListener('click', loadRegister);
searchInput.addEventListener('input', debounce(loadRegister, 350));
siteFilter.addEventListener('input', debounce(loadRegister, 350));
jobNumberFilter.addEventListener('input', debounce(loadRegister, 350));
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- Site rename ----------
document.getElementById('renameSiteBtn').addEventListener('click', async () => {
  const oldName = siteFilter.value.trim();
  if (!oldName) { alert('Type the site name into the "Filter by site" box first, then rename it.'); return; }
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === oldName) return;
  try {
    const res = await fetch(`${API}/assets/sites/${encodeURIComponent(oldName)}`, {
      method: 'PATCH', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ newName: newName.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rename failed');
    siteFilter.value = newName.trim();
    loadSiteOptions();
    loadRegister();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// ---------- Test history modal (view / edit / delete) ----------
const historyModal = document.getElementById('historyModal');
document.getElementById('closeHistoryModal').addEventListener('click', () => historyModal.style.display = 'none');
let modalAssetId = null;
let modalAppliance = null;

async function openHistoryModal(assetId, appliance) {
  modalAssetId = assetId;
  modalAppliance = appliance;
  document.getElementById('historyModalTitle').textContent = appliance || 'Test history';
  document.getElementById('editAssetForm').style.display = 'none';
  document.getElementById('editAssetStatus').textContent = '';
  const historyList = document.getElementById('historyList');
  historyList.innerHTML = '<p class="status">Loading...</p>';
  historyModal.style.display = 'flex';

  try {
    const res = await fetch(`${API}/assets/${assetId}/history`, { headers: apiHeaders() });
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load history');
    if (rows.length === 0) { historyList.innerHTML = '<p class="status">No tests logged yet.</p>'; return; }

    historyList.innerHTML = rows.map((t) => `
      <div class="history-entry" data-test-id="${t.id}" data-asset-id="${assetId}">
        <div><strong>${t.result.toUpperCase()}</strong> — ${t.test_date ? String(t.test_date).slice(0,10) : 'no date'} ${t.tag_no ? '· Tag ' + escapeHtml(t.tag_no) : ''}</div>
        <div class="meta">Tester: ${escapeHtml(t.tester_name || '—')} ${t.tester_licence ? '(' + escapeHtml(t.tester_licence) + ')' : ''}</div>
        <div class="meta">Next due: ${t.next_due ? String(t.next_due).slice(0,10) : '—'}</div>
        ${t.notes ? `<div class="meta">Notes: ${escapeHtml(t.notes)}</div>` : ''}
        ${t.has_photo ? `<img data-photo-for="${t.id}" alt="test photo" />` : ''}
        <div class="row-actions">
          <button class="btn edit-test-btn">Edit</button>
          <button class="btn delete-test-btn">Delete</button>
        </div>
      </div>
    `).join('');

    historyList.querySelectorAll('img[data-photo-for]').forEach(async (img) => {
      const testId = img.dataset.photoFor;
      const r = await fetch(`${API}/assets/tests/${testId}/photo`, { headers: apiHeaders() });
      if (r.ok) img.src = URL.createObjectURL(await r.blob());
    });

    historyList.querySelectorAll('.delete-test-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const entry = e.target.closest('.history-entry');
        if (!confirm('Delete this test record? This cannot be undone.')) return;
        const res = await fetch(`${API}/assets/${entry.dataset.assetId}/tests/${entry.dataset.testId}`, { method: 'DELETE', headers: apiHeaders() });
        if (res.ok) { entry.remove(); loadRegister(); } else { alert('Failed to delete.'); }
      });
    });

    historyList.querySelectorAll('.edit-test-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const entry = e.target.closest('.history-entry');
        const testId = entry.dataset.testId;
        const newResult = prompt('Result (pass/fail/repairable):');
        if (!newResult || !['pass', 'fail', 'repairable'].includes(newResult.trim().toLowerCase())) { if (newResult !== null) alert('Must be "pass", "fail", or "repairable" - no changes made.'); return; }
        const newDate = prompt('Test date (YYYY-MM-DD), leave blank to keep as-is:');
        const newDue = prompt('Next due (YYYY-MM-DD), leave blank to keep as-is:');
        const body = { result: newResult.trim().toLowerCase() };
        if (newDate) body.test_date = newDate.trim();
        if (newDue) body.next_due = newDue.trim();
        fetch(`${API}/assets/${assetId}/tests/${testId}`, { method: 'PATCH', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
          .then((r) => { if (r.ok) { openHistoryModal(assetId, appliance); loadRegister(); } else alert('Update failed.'); });
      });
    });
  } catch (err) {
    historyList.innerHTML = `<p class="status">Error: ${err.message}</p>`;
  }
}

// ---------- Log New Test (quick retest from the register, no re-scan needed) ----------
// Jumps to the Scan tab and shows the test-log form directly against this already-known
// asset, skipping site/location entry and the photo/extract step entirely -- most test & tag
// work is retesting items already on the register, so this is the common path in practice.
document.getElementById('quickRetestBtn').addEventListener('click', async () => {
  if (!modalAssetId) return;
  historyModal.style.display = 'none';
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'scan'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-scan'));

  const banner = document.getElementById('retestBanner');
  banner.style.display = 'block';
  banner.textContent = 'Loading item...';

  try {
    const res = await fetch(`${API}/assets/${modalAssetId}`, { headers: apiHeaders() });
    const asset = await res.json();
    if (!res.ok) throw new Error(asset.error || 'Failed to load item');

    banner.textContent = `Retesting: ${asset.appliance || 'item'} — ${asset.site}${asset.location ? ' / ' + asset.location : ''}${asset.plant_no ? ' (Plant No. ' + asset.plant_no + ')' : ''}`;

    currentAssetId = asset.id;
    currentAssetIsTemp = false;
    currentPhotoBase64 = null;
    currentPhotoMediaType = null;
    document.getElementById('siteInput').value = asset.site || '';
    document.getElementById('locationInput').value = asset.location || '';
    document.getElementById('categoryInput').value = asset.environment_category || '';
    document.getElementById('clientNameInput').value = asset.client_name || '';
    document.getElementById('jobNumberInput').value = asset.job_number || '';
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('testCard').style.display = 'block';
    document.getElementById('t_tag_no').value = '';
    document.getElementById('t_notes').value = '';
    document.getElementById('t_test_date').value = '';
    document.getElementById('t_next_due').value = '';
    document.getElementById('t_result').value = 'pass';
    document.getElementById('testStatus').textContent = '';
  } catch (err) {
    banner.textContent = `Error loading item: ${err.message}`;
  }
});

// ---------- Edit Item (fix a mistaken entry after the fact) ----------
document.getElementById('editAssetBtn').addEventListener('click', async () => {
  if (!modalAssetId) return;
  const form = document.getElementById('editAssetForm');
  const statusEl = document.getElementById('editAssetStatus');
  statusEl.textContent = 'Loading...'; statusEl.className = 'status';
  form.style.display = 'block';
  try {
    const res = await fetch(`${API}/assets/${modalAssetId}`, { headers: apiHeaders() });
    const asset = await res.json();
    if (!res.ok) throw new Error(asset.error || 'Failed to load item');
    document.getElementById('edit_site').value = asset.site || '';
    document.getElementById('edit_location').value = asset.location || '';
    document.getElementById('edit_appliance').value = asset.appliance || '';
    document.getElementById('edit_plant_no').value = asset.plant_no || '';
    document.getElementById('edit_brand').value = asset.brand || '';
    document.getElementById('edit_model_no').value = asset.model_no || '';
    document.getElementById('edit_serial_no').value = asset.serial_no || '';
    document.getElementById('edit_client_name').value = asset.client_name || '';
    document.getElementById('edit_job_number').value = asset.job_number || '';
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'status err';
  }
});

document.getElementById('cancelAssetEditBtn').addEventListener('click', () => {
  document.getElementById('editAssetForm').style.display = 'none';
});

document.getElementById('saveAssetEditBtn').addEventListener('click', async () => {
  if (!modalAssetId) return;
  const statusEl = document.getElementById('editAssetStatus');
  const site = document.getElementById('edit_site').value.trim();
  if (!site) { statusEl.textContent = 'Site is required.'; statusEl.className = 'status err'; return; }
  const payload = {
    site,
    location: document.getElementById('edit_location').value.trim() || null,
    appliance: document.getElementById('edit_appliance').value.trim() || null,
    plant_no: document.getElementById('edit_plant_no').value.trim() || null,
    brand: document.getElementById('edit_brand').value.trim() || null,
    model_no: document.getElementById('edit_model_no').value.trim() || null,
    serial_no: document.getElementById('edit_serial_no').value.trim() || null,
    client_name: document.getElementById('edit_client_name').value.trim() || null,
    job_number: document.getElementById('edit_job_number').value.trim() || null,
  };
  statusEl.textContent = 'Saving...'; statusEl.className = 'status';
  try {
    const res = await fetch(`${API}/assets/${modalAssetId}`, { method: 'PATCH', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    statusEl.textContent = 'Saved.'; statusEl.className = 'status ok';
    document.getElementById('editAssetForm').style.display = 'none';
    document.getElementById('historyModalTitle').textContent = data.appliance || 'Test history';
    modalAppliance = data.appliance;
    loadSiteOptions();
    loadRegister();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'status err';
  }
});

// ---------- Delete Item (remove a mistaken entry entirely, not just a test result) ----------
document.getElementById('deleteAssetBtn').addEventListener('click', async () => {
  if (!modalAssetId) return;
  if (!confirm(`Delete "${modalAppliance || 'this item'}" from the register? This permanently removes it and its whole test history. This can't be undone.`)) return;
  try {
    const res = await fetch(`${API}/assets/${modalAssetId}`, { method: 'DELETE', headers: apiHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    historyModal.style.display = 'none';
    loadRegister();
  } catch (err) {
    alert(`Error deleting item: ${err.message}`);
  }
});

// ---------- Due dashboard ----------
async function loadDueSummary() {
  const el = document.getElementById('dueSummary');
  el.innerHTML = '<p class="status">Loading...</p>';
  try {
    const res = await fetch(`${API}/assets/due-summary`, { headers: apiHeaders() });
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load');
    if (rows.length === 0) { el.innerHTML = '<p class="status">No data yet.</p>'; return; }

    el.innerHTML = rows.map((r) => `
      <div class="due-site-row" data-site="${escapeHtml(r.site)}">
        <div class="site-name">${escapeHtml(r.site)}</div>
        <div class="meta">
          ${Number(r.overdue) > 0 ? `<span class="due-count overdue">${r.overdue} overdue</span>` : ''}
          ${Number(r.due_soon) > 0 ? `<span class="due-count soon">${r.due_soon} due soon</span>` : ''}
          ${Number(r.fails) > 0 ? `<span class="due-count fails">${r.fails} failed</span>` : ''}
          ${Number(r.repairable) > 0 ? `<span class="due-count repairable">${r.repairable} repairable</span>` : ''}
          ${Number(r.overdue) === 0 && Number(r.due_soon) === 0 && Number(r.fails) === 0 && Number(r.repairable) === 0 ? 'All clear' : ''}
        </div>
        <div class="meta">${r.total_assets} items on register</div>
      </div>
    `).join('');

    el.querySelectorAll('.due-site-row').forEach((row) => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'register'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-register'));
        siteFilter.value = row.dataset.site;
        loadSiteOptions();
        loadRegister();
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="status">Error: ${err.message}</p>`;
  }
}

// ---------- Export ----------
// exportScopeType picks whether Export/Generate Report scope by Site (the "Filter by site" box)
// or by Job Number (the "Filter by job number" box) -- exactly one of the two is sent, mirroring
// how the register/report backend routes accept either.
function currentScope() {
  const byJobNumber = document.getElementById('exportScopeType').value === 'job_number';
  const value = (byJobNumber ? jobNumberFilter.value : siteFilter.value).trim();
  return { byJobNumber, value };
}

document.getElementById('exportBtn').addEventListener('click', () => {
  // No value in the chosen scope's filter box exports the same consolidated "all sites" view
  // this always has -- the scope toggle only matters once a value is actually typed in.
  const { byJobNumber, value } = currentScope();
  const params = new URLSearchParams();
  if (value) params.set(byJobNumber ? 'job_number' : 'site', value);
  if (activeFilter === 'fail' || activeFilter === 'repairable') params.set('result', activeFilter);
  fetch(`${API}/register/export?${params}`, { headers: apiHeaders() })
    .then((res) => res.blob())
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `test-tag-register-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    });
});

// ---------- Generate Report (the client-facing "Test Register" .docx, per site+visit) ----------
// Holds the most recently generated report's blob + the site/test date it covers, so "Upload
// Report to Cloud" can re-send the SAME bytes the technician just downloaded rather than
// re-generating them -- cleared every time the modal is (re)opened so a stale report can never
// be uploaded under a different site/date by mistake.
let lastGeneratedReport = null;
function formatDMY(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d)) return isoDate;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

document.getElementById('reportBtn').addEventListener('click', async () => {
  const { byJobNumber, value } = currentScope();
  if (!value) { alert(byJobNumber ? 'Type a job number into the "Filter by job number" box first -- reports are generated per job.' : 'Type a site into the "Filter by site" box first -- reports are generated per site.'); return; }

  const statusEl = document.getElementById('reportModalStatus');
  const select = document.getElementById('reportDateSelect');
  const generateBtn = document.getElementById('generateReportBtn');
  statusEl.textContent = '';
  document.getElementById('reportScopeLabel').firstChild.textContent = byJobNumber ? 'Job Number' : 'Site';
  document.getElementById('reportSiteDisplay').value = value;
  document.getElementById('reportSiteDisplay').dataset.scopeType = byJobNumber ? 'job_number' : 'site';
  select.innerHTML = '<option>Loading...</option>';
  generateBtn.disabled = true;
  lastGeneratedReport = null;
  document.getElementById('uploadReportCloudStatus').textContent = '';
  document.getElementById('reportModal').style.display = 'flex';

  try {
    const params = new URLSearchParams();
    params.set(byJobNumber ? 'job_number' : 'site', value);
    const res = await fetch(`${API}/register/report-dates?${params}`, { headers: apiHeaders() });
    const dates = await res.json();
    if (!res.ok) throw new Error(dates.error || 'Failed to load test dates');
    if (!dates.length) {
      select.innerHTML = '';
      statusEl.textContent = `No test dates recorded for this ${byJobNumber ? 'job number' : 'site'} yet -- log at least one test first.`;
      statusEl.className = 'status err';
      return;
    }
    select.innerHTML = dates.map((d) => `<option value="${d}">${formatDMY(d)}</option>`).join('');
    generateBtn.disabled = false;
  } catch (err) {
    select.innerHTML = '';
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'status err';
  }
});

document.getElementById('closeReportModal').addEventListener('click', () => {
  document.getElementById('reportModal').style.display = 'none';
});

// Generates the report, then either uploads it straight to the cloud (when reached via the
// Audit Tool's proxy with an active Cloud Sync login -- no local download/open on the device at
// all, just the upload) or, when that's not possible (standalone hosting, or no valid cloud
// login yet), falls back to triggering the local browser download so the technician still gets
// the file -- one button, one combined status line, per how this was asked for (previously two
// separate buttons/steps).
document.getElementById('generateReportBtn').addEventListener('click', async () => {
  const scopeDisplay = document.getElementById('reportSiteDisplay');
  const scopeValue = scopeDisplay.value;
  const byJobNumber = scopeDisplay.dataset.scopeType === 'job_number';
  const testDate = document.getElementById('reportDateSelect').value;
  if (!testDate) return;
  const statusEl = document.getElementById('reportModalStatus');
  const uploadStatusEl = document.getElementById('uploadReportCloudStatus');
  const generateBtn = document.getElementById('generateReportBtn');
  statusEl.textContent = 'Generating…'; statusEl.className = 'status';
  uploadStatusEl.textContent = '';
  generateBtn.disabled = true;
  try {
    const params = new URLSearchParams();
    params.set(byJobNumber ? 'job_number' : 'site', scopeValue);
    params.set('test_date', testDate);
    const res = await fetch(`${API}/register/report?${params}`, { headers: apiHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Report generation failed');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const m = disposition.match(/filename="?([^"]+)"?/);
    const filename = m ? m[1] : `Test_Register_${scopeValue}_${testDate}.docx`;

    lastGeneratedReport = { blob, site: byJobNumber ? null : scopeValue, jobNumber: byJobNumber ? scopeValue : null, testDate };

    // Only fall back to a local browser download when we can't upload straight to the cloud --
    // when we CAN upload, do that and nothing else: no local download/open-on-device at all.
    const token = IS_PROXIED ? getCloudToken() : null;

    if (!token) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);

      if (!IS_PROXIED) {
        statusEl.textContent = 'Downloaded.'; statusEl.className = 'status ok';
      } else {
        statusEl.textContent = 'Downloaded.'; statusEl.className = 'status ok';
        uploadStatusEl.textContent = 'Not uploaded to the cloud — log into the Audit Tool\'s Cloud Sync first.';
        uploadStatusEl.className = 'status err';
      }
    } else {
      statusEl.textContent = 'Uploading to the cloud…'; statusEl.className = 'status';
      try {
        const form = new FormData();
        form.append('docx', lastGeneratedReport.blob, 'report.docx');
        if (lastGeneratedReport.site) form.append('site', lastGeneratedReport.site);
        if (lastGeneratedReport.jobNumber) form.append('jobNumber', lastGeneratedReport.jobNumber);
        form.append('testDate', lastGeneratedReport.testDate);
        form.append('deviceLabel', navigator.userAgent.slice(0, 120));
        // Root-relative: this page is reverse-proxied under the Audit Tool's own domain when
        // IS_PROXIED is true (see APP_BASE above), so this always shares the same origin as
        // /api/testtag-reports regardless of the proxy path Test & Tag itself is mounted at.
        const uploadRes = await fetch('/api/testtag-reports', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        const data = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok) throw new Error(data.error || 'Upload failed');
        statusEl.textContent = 'Uploaded to the cloud.'; statusEl.className = 'status ok';
      } catch (uploadErr) {
        // The upload failed, so give the technician the file the only other way they can get
        // it: the local download, same as the no-token path above.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        statusEl.textContent = 'Downloaded (cloud upload failed).'; statusEl.className = 'status err';
        uploadStatusEl.textContent = `Cloud upload failed: ${uploadErr.message}`; uploadStatusEl.className = 'status err';
      }
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'status err';
  } finally {
    generateBtn.disabled = false;
  }
});

// ---------- Import ----------
document.getElementById('importInput').addEventListener('change', async () => {
  const file = document.getElementById('importInput').files[0];
  if (!file) return;
  const importStatus = document.getElementById('importStatus');
  importStatus.textContent = 'Importing...';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const params = new URLSearchParams();
    if (siteFilter.value.trim()) params.set('site', siteFilter.value.trim());
    const res = await fetch(`${API}/register/import?${params}`, { method: 'POST', headers: apiHeaders(), body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    importStatus.textContent = `Site "${data.site}": imported ${data.imported}, skipped ${data.skipped}, ${data.errorCount} errors.`;
    loadSiteOptions();
    loadRegister();
  } catch (err) {
    importStatus.textContent = `Error: ${err.message}`;
  }
});

// ---------- Service worker (app-shell offline caching) ----------
// Registered with a relative path so its scope is wherever this app is actually being served
// from -- domain root when standalone, "/testtag/" when reverse-proxied under the Audit Tool.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker registration failed:', e));
  });
}

// ---------- Init ----------
ensureToken();
loadSiteOptions();
updateOfflineBanner();
if (navigator.onLine) flushQueue();
