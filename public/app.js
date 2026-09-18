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
let currentAssetId = null;
let currentPhotoBase64 = null;
let currentPhotoMediaType = null;
let resultFilter = ''; // '' | 'fail'

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'register') { loadSiteOptions(); loadRegister(); }
    if (btn.dataset.tab === 'due') loadDueSummary();
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
// When proxied under the Audit Tool (see IS_PROXIED above), this page shares an origin with it,
// so the technician's own name/licence from their Cloud Sync login (cloudTechnicianName /
// cloudTechnicianLicense -- set by the Audit Tool's own sync.js) is readable here directly. That
// takes priority over Test & Tag's own separately-remembered tester, since it's already known
// and correct for whoever's logged in right now -- no retyping needed. Falls back to Test & Tag's
// own remembered values (or blank) whenever there's no active Audit Tool login to read, including
// always on standalone hosting.
function prefillTester() {
  const nameEl = document.getElementById('t_tester_name');
  const licenceEl = document.getElementById('t_tester_licence');
  const cloudName = IS_PROXIED ? localStorage.getItem('cloudTechnicianName') : null;
  if (cloudName) {
    nameEl.value = cloudName;
    licenceEl.value = localStorage.getItem('cloudTechnicianLicense') || '';
  } else {
    nameEl.value = localStorage.getItem('testTagTesterName') || '';
    licenceEl.value = localStorage.getItem('testTagTesterLicence') || '';
  }
}
prefillTester();
function persistTester() {
  localStorage.setItem('testTagTesterName', document.getElementById('t_tester_name').value.trim());
  localStorage.setItem('testTagTesterLicence', document.getElementById('t_tester_licence').value.trim());
}

// ---------- Offline queue ----------
// Extraction needs the network (it's an AI call) so it's disabled offline, but
// asset saves and test logs are queued locally and flushed automatically on
// reconnect. This is a best-effort queue, not a full offline cache of the register.
const QUEUE_KEY = 'testTagOfflineQueue';
function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); updateOfflineBanner(); }
function enqueue(action) { const q = getQueue(); q.push(action); setQueue(q); }

function updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  const q = getQueue();
  if (!navigator.onLine) {
    banner.style.display = 'block';
    document.getElementById('queueCount').textContent = q.length ? `(${q.length} queued)` : '';
    document.getElementById('extractBtn').disabled = true;
    document.getElementById('extractBtn').title = 'Photo reading needs an internet connection';
  } else {
    banner.style.display = q.length ? 'block' : 'none';
    document.getElementById('queueCount').textContent = q.length ? `(${q.length} still syncing)` : '';
    document.getElementById('extractBtn').disabled = !photoInput.files[0];
    document.getElementById('extractBtn').title = '';
  }
}

async function flushQueue() {
  if (!navigator.onLine) return;
  let q = getQueue();
  if (q.length === 0) return;
  const remaining = [];
  for (const action of q) {
    try {
      const res = await fetch(action.url, { method: action.method, headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(action.body) });
      if (!res.ok) throw new Error('sync failed');
    } catch (e) {
      remaining.push(action); // keep for next attempt
    }
  }
  setQueue(remaining);
  if (remaining.length === 0) loadRegister();
}

window.addEventListener('online', () => { updateOfflineBanner(); flushQueue(); });
window.addEventListener('offline', updateOfflineBanner);

// Wraps a POST call: sends immediately if online, queues it if offline.
// queuedAssetId lets a queued "log test" action reference an asset that was
// itself just queued (see saveAssetBtn handler) rather than a real numeric id.
async function postOrQueue(url, body) {
  if (navigator.onLine) {
    const res = await fetch(url, { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  enqueue({ url, method: 'POST', body });
  return null; // caller must handle "queued, no id yet"
}

// ---------- Site autocomplete ----------
async function loadSiteOptions() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`${API}/assets/sites`, { headers: apiHeaders() });
    if (!res.ok) return;
    const sites = await res.json();
    const opts = sites.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
    document.getElementById('siteOptions').innerHTML = opts;
    document.getElementById('siteOptionsRegister').innerHTML = opts;
  } catch (e) { /* non-fatal */ }
}

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
  currentAssetId = null;
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
  currentAssetId = null;
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
    document.getElementById('t_result').value = ex.pass_fail_on_tag === 'fail' ? 'fail' : 'pass';
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
  };

  try {
    if (navigator.onLine) {
      const data = await postOrQueue(`${API}/assets`, payload);
      currentAssetId = data.id;
      document.getElementById('testCard').style.display = 'block';
      extractStatus.textContent = 'Asset saved to register.';
    } else {
      // Can't get a real asset id while offline - queue the asset save and let
      // the test-log step queue against a lookup-by-plant-no marker instead.
      enqueue({ url: `${API}/assets`, method: 'POST', body: payload });
      currentAssetId = 'PENDING';
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
    if (navigator.onLine && currentAssetId !== 'PENDING') {
      await postOrQueue(`${API}/assets/${currentAssetId}/tests`, payload);
      document.getElementById('testStatus').textContent = 'Test logged. Ready for the next item.';
    } else {
      // Either genuinely offline, or the parent asset save is itself still
      // queued (no real id yet) - queue this against a placeholder that the
      // queue can't resolve automatically. Flag it clearly rather than silently
      // dropping it.
      document.getElementById('testStatus').textContent = 'Offline with no saved asset id yet - please retry logging this test once back online and the asset has synced.';
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
  currentAssetId = null;
  currentPhotoBase64 = null;
}

// ---------- Register list ----------
const registerList = document.getElementById('registerList');
const searchInput = document.getElementById('searchInput');
const siteFilter = document.getElementById('siteFilter');

document.getElementById('filterAllBtn').addEventListener('click', () => setResultFilter(''));
document.getElementById('filterFailBtn').addEventListener('click', () => setResultFilter('fail'));
function setResultFilter(f) {
  resultFilter = f;
  document.getElementById('filterAllBtn').classList.toggle('active', f === '');
  document.getElementById('filterFailBtn').classList.toggle('active', f === 'fail');
  loadRegister();
}

async function loadRegister() {
  registerList.innerHTML = '<p class="status">Loading...</p>';
  try {
    const params = new URLSearchParams();
    if (siteFilter.value.trim()) params.set('site', siteFilter.value.trim());
    if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
    if (resultFilter) params.set('result', resultFilter);
    const res = await fetch(`${API}/assets?${params}`, { headers: apiHeaders() });
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load');

    if (rows.length === 0) {
      registerList.innerHTML = '<p class="status">No assets found.</p>';
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    registerList.innerHTML = rows.map((r) => {
      const badge = r.last_result === 'pass' ? 'badge-pass' : r.last_result === 'fail' ? 'badge-fail' : 'badge-none';
      const badgeText = r.last_result ? r.last_result.toUpperCase() : 'NOT TESTED';
      const due = r.last_next_due ? String(r.last_next_due).slice(0, 10) : null;
      let rowClass = '';
      if (due && due < today) rowClass = 'overdue';
      else if (due && due <= in30) rowClass = 'soon';
      return `
        <div class="asset-row ${rowClass}" data-asset-id="${r.id}" data-appliance="${escapeHtml(r.appliance || '')}">
          <div class="plant-no">${escapeHtml(r.appliance || 'Unnamed item')} <span class="badge ${badge}">${badgeText}</span></div>
          <div class="meta">${escapeHtml(r.site)} · ${escapeHtml(r.location || '—')} ${r.plant_no ? '· Plant No. ' + escapeHtml(r.plant_no) : ''}</div>
          <div class="meta">${r.brand ? escapeHtml(r.brand) + ' ' : ''}${r.model_no ? escapeHtml(r.model_no) : ''} ${r.last_tag_no ? '· Tag ' + escapeHtml(r.last_tag_no) : ''}</div>
          <div class="meta">Next due: ${due || '—'}${rowClass === 'overdue' ? ' (OVERDUE)' : rowClass === 'soon' ? ' (due soon)' : ''}</div>
        </div>
      `;
    }).join('');

    registerList.querySelectorAll('.asset-row').forEach((el) => {
      el.addEventListener('click', () => openHistoryModal(el.dataset.assetId, el.dataset.appliance));
    });
  } catch (err) {
    registerList.innerHTML = `<p class="status">Error: ${err.message}</p>`;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('refreshBtn').addEventListener('click', loadRegister);
searchInput.addEventListener('input', debounce(loadRegister, 350));
siteFilter.addEventListener('input', debounce(loadRegister, 350));
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

async function openHistoryModal(assetId, appliance) {
  document.getElementById('historyModalTitle').textContent = appliance || 'Test history';
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
        const newResult = prompt('Result (pass/fail):');
        if (!newResult || !['pass', 'fail'].includes(newResult.trim().toLowerCase())) { if (newResult !== null) alert('Must be "pass" or "fail" - no changes made.'); return; }
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
          ${Number(r.overdue) === 0 && Number(r.due_soon) === 0 && Number(r.fails) === 0 ? 'All clear' : ''}
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
document.getElementById('exportBtn').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (siteFilter.value.trim()) params.set('site', siteFilter.value.trim());
  if (resultFilter) params.set('result', resultFilter);
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

// ---------- Init ----------
ensureToken();
loadSiteOptions();
updateOfflineBanner();
if (navigator.onLine) flushQueue();
