const API = '/api';
let accessToken = localStorage.getItem('testTagAccessToken') || '';
let currentAssetId = null; // set once the asset is matched or saved, needed to log a test

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'register') {
      loadSiteOptions();
      loadRegister();
    }
  });
});

// ---------- Access token gate ----------
function ensureToken() {
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

function apiHeaders(extra = {}) {
  return { 'x-app-token': accessToken, ...extra };
}

// ---------- Site autocomplete ----------
async function loadSiteOptions() {
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
  extractBtn.disabled = false;
  document.getElementById('resultCard').style.display = 'none';
  document.getElementById('testCard').style.display = 'none';
  currentAssetId = null;
});

extractBtn.addEventListener('click', async () => {
  const site = document.getElementById('siteInput').value.trim();
  if (!site) {
    alert('Enter the site/client name first.');
    return;
  }
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

function normalizeDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// Try to find the existing asset: first by the tag number just read, then by
// site+location+plant number, then by serial number.
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
    const last = found.history[0];
    existingNotice.style.display = 'block';
    existingNotice.textContent = last
      ? `Existing asset - last test: ${last.test_date ? last.test_date.slice(0, 10) : 'unknown date'} (${last.result}). Saving will update its details and this will log a new test.`
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
  if (!site) {
    alert('Site is required.');
    return;
  }
  const payload = {
    site,
    location: document.getElementById('locationInput').value.trim() || null,
    appliance: document.getElementById('f_appliance').value.trim() || null,
    plant_no: document.getElementById('f_plant_no').value.trim() || null,
    brand: document.getElementById('f_brand').value.trim() || null,
    model_no: document.getElementById('f_model_no').value.trim() || null,
    serial_no: document.getElementById('f_serial_no').value.trim() || null,
  };

  try {
    const res = await fetch(`${API}/assets`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    currentAssetId = data.id;
    document.getElementById('testCard').style.display = 'block';
    extractStatus.textContent = 'Asset saved to register.';
  } catch (err) {
    alert(`Error saving asset: ${err.message}`);
  }
});

// ---------- Log test ----------
document.getElementById('saveTestBtn').addEventListener('click', async () => {
  if (!currentAssetId) {
    alert('Save the asset to the register first.');
    return;
  }
  const payload = {
    tag_no: document.getElementById('t_tag_no').value.trim() || null,
    tester_name: document.getElementById('t_tester_name').value.trim() || null,
    tester_licence: document.getElementById('t_tester_licence').value.trim() || null,
    result: document.getElementById('t_result').value,
    test_date: document.getElementById('t_test_date').value || null,
    next_due: document.getElementById('t_next_due').value || null,
    notes: document.getElementById('t_notes').value.trim() || null,
  };

  try {
    const res = await fetch(`${API}/assets/${currentAssetId}/tests`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to log test');
    document.getElementById('testStatus').textContent = 'Test logged. Ready for the next item.';
    setTimeout(resetScanForm, 1200);
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
  // deliberately keep Site and Location filled in, since the next scan is
  // usually the next item in the same room
}

// ---------- Register list ----------
const registerList = document.getElementById('registerList');
const searchInput = document.getElementById('searchInput');
const siteFilter = document.getElementById('siteFilter');

async function loadRegister() {
  registerList.innerHTML = '<p class="status">Loading...</p>';
  try {
    const params = new URLSearchParams();
    if (siteFilter.value.trim()) params.set('site', siteFilter.value.trim());
    if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
    const res = await fetch(`${API}/assets?${params}`, { headers: apiHeaders() });
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load');

    if (rows.length === 0) {
      registerList.innerHTML = '<p class="status">No assets found.</p>';
      return;
    }

    registerList.innerHTML = rows.map((r) => {
      const badge = r.last_result === 'pass' ? 'badge-pass' : r.last_result === 'fail' ? 'badge-fail' : 'badge-none';
      const badgeText = r.last_result ? r.last_result.toUpperCase() : 'NOT TESTED';
      const due = r.last_next_due ? new Date(r.last_next_due).toISOString().slice(0, 10) : '—';
      return `
        <div class="asset-row">
          <div class="plant-no">${escapeHtml(r.appliance || 'Unnamed item')} <span class="badge ${badge}">${badgeText}</span></div>
          <div class="meta">${escapeHtml(r.site)} · ${escapeHtml(r.location || '—')} ${r.plant_no ? '· Plant No. ' + escapeHtml(r.plant_no) : ''}</div>
          <div class="meta">${r.brand ? escapeHtml(r.brand) + ' ' : ''}${r.model_no ? escapeHtml(r.model_no) : ''} ${r.last_tag_no ? '· Tag ' + escapeHtml(r.last_tag_no) : ''}</div>
          <div class="meta">Next due: ${due}</div>
        </div>
      `;
    }).join('');
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

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Export ----------
document.getElementById('exportBtn').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (siteFilter.value.trim()) params.set('site', siteFilter.value.trim());
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
