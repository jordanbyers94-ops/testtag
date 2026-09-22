// ============================================================================
// Aus Air Electrical -- shared Technician Profile module.
//
// CANONICAL COPY: cloud_pwa/public/shared/technician-profile.js
// Copy this exact file, unchanged, into any new addon app's public/ folder
// (this file, test_tag_app/public/technician-profile.js, is that same copy).
// There's no shared build/bundle across these apps -- each addon (Test & Tag,
// and whatever comes after it) is its own separately-deployed static+Node
// app -- so "shared" here means "the same vendored file plus the same
// localStorage contract", not a shared runtime or API call.
//
// THE CONTRACT
// ------------
// When a technician logs into the Audit Tool's own Cloud Sync, it writes:
//   localStorage['cloudTechnicianName']    e.g. "Jordan Byers"
//   localStorage['cloudTechnicianLicense'] e.g. "69969" (may be '')
//   localStorage['cloudToken']             presence == still logged in
// (see cloud_pwa/sync_source.js's cloudLogin()). Any addon reverse-proxied
// under the Audit Tool's own domain (e.g. Test & Tag at /testtag/) shares
// that origin, so these three keys are readable here directly -- no API call
// needed, and no extra login screen for the addon itself.
//
// Each addon also keeps its own *local fallback* profile, namespaced by a
// short prefix unique to that addon (Test & Tag uses 'testTag'), used
// whenever there's no active Audit Tool login to read from (standalone
// hosting away from the Audit Tool's domain, or logged out):
//   localStorage['<prefix>TesterName']
//   localStorage['<prefix>TesterLicence']
//   localStorage['<prefix>UseLocalTester']   '1' forces local even when a
//                                             cloud login IS present (the
//                                             technician opted to use
//                                             different details on this
//                                             device specifically)
//
// USAGE
// -----
//   TechnicianProfile.resolve(prefix) -> { name, licence, source: 'cloud'|'local' }
//     Call this to prefill any tester/name/licence field in your addon.
//
//   TechnicianProfile.renderSettingsScreen(containerEl, { prefix, onChange })
//     Renders a complete, self-contained "My Details" settings card into
//     containerEl. Wire this up to a "Settings" tab/screen in your addon so
//     the technician can see where their details are coming from, and set
//     local ones when there's no cloud login. onChange(effective) fires
//     after every save/toggle so the host app can refresh any prefilled
//     forms immediately.
// ============================================================================
(function (global) {
  function readCloud() {
    const name = (localStorage.getItem('cloudTechnicianName') || '').trim();
    if (!name) return null;
    return { name, licence: localStorage.getItem('cloudTechnicianLicense') || '' };
  }

  function readLocal(prefix) {
    return {
      name: localStorage.getItem(prefix + 'TesterName') || '',
      licence: localStorage.getItem(prefix + 'TesterLicence') || '',
    };
  }

  function writeLocal(prefix, name, licence) {
    localStorage.setItem(prefix + 'TesterName', (name || '').trim());
    localStorage.setItem(prefix + 'TesterLicence', (licence || '').trim());
  }

  function getOverride(prefix) {
    return localStorage.getItem(prefix + 'UseLocalTester') === '1';
  }

  function setOverride(prefix, val) {
    if (val) localStorage.setItem(prefix + 'UseLocalTester', '1');
    else localStorage.removeItem(prefix + 'UseLocalTester');
  }

  // The effective profile to prefill forms with: the Audit Tool login wins unless the
  // technician has explicitly opted to use their own local details on this device, or
  // there's simply no cloud login available (standalone hosting, or logged out).
  function resolve(prefix) {
    const cloud = readCloud();
    if (cloud && !getOverride(prefix)) return { name: cloud.name, licence: cloud.licence, source: 'cloud' };
    const local = readLocal(prefix);
    return { name: local.name, licence: local.licence, source: 'local' };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Renders a self-contained "My Details" card into containerEl. Safe to call repeatedly
  // (e.g. every time the Settings tab is shown) -- it always re-reads current storage state
  // first, so it reflects the latest login/local values rather than going stale.
  function renderSettingsScreen(containerEl, opts) {
    const prefix = opts && opts.prefix;
    const onChange = opts && opts.onChange;
    if (!containerEl || !prefix) return;

    const cloud = readCloud();
    const override = getOverride(prefix);
    const local = readLocal(prefix);

    containerEl.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('h3');
    heading.textContent = 'My Details';
    card.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '-6px';
    hint.textContent = 'Your name and licence number are used on every test you log, and shown on generated reports.';
    card.appendChild(hint);

    if (cloud) {
      const status = document.createElement('div');
      status.className = 'notice';
      status.style.display = 'block';
      status.innerHTML = 'Signed in via the Audit Tool as <strong>' + escapeHtml(cloud.name) + '</strong>'
        + (cloud.licence ? ' &middot; Licence <strong>' + escapeHtml(cloud.licence) + '</strong>' : ' &middot; <em>no licence number on file</em>')
        + '. These come from your Audit Tool login -- to change them, ask your admin to update your technician profile there.';
      card.appendChild(status);

      const toggleLabel = document.createElement('label');
      toggleLabel.style.display = 'flex';
      toggleLabel.style.alignItems = 'center';
      toggleLabel.style.gap = '8px';
      toggleLabel.style.marginTop = '12px';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = override;
      toggle.id = prefix + '_useLocalToggle';
      const toggleText = document.createElement('span');
      toggleText.textContent = 'Use different details on this device instead';
      toggleLabel.appendChild(toggle);
      toggleLabel.appendChild(toggleText);
      card.appendChild(toggleLabel);

      toggle.addEventListener('change', () => {
        setOverride(prefix, toggle.checked);
        renderSettingsScreen(containerEl, opts); // re-render to show/hide the editable fields
        if (onChange) onChange(resolve(prefix));
      });
    }

    if (!cloud || override) {
      const nameLabel = document.createElement('label');
      nameLabel.textContent = 'Name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = prefix + '_settingsName';
      nameInput.value = local.name;
      nameLabel.appendChild(nameInput);
      card.appendChild(nameLabel);

      const licLabel = document.createElement('label');
      licLabel.textContent = 'Licence Number';
      const licInput = document.createElement('input');
      licInput.type = 'text';
      licInput.id = prefix + '_settingsLicence';
      licInput.value = local.licence;
      licLabel.appendChild(licInput);
      card.appendChild(licLabel);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-primary';
      saveBtn.id = prefix + '_settingsSaveBtn';
      saveBtn.textContent = 'Save';
      card.appendChild(saveBtn);

      const status = document.createElement('div');
      status.className = 'status';
      status.id = prefix + '_settingsStatus';
      card.appendChild(status);

      saveBtn.addEventListener('click', () => {
        if (!nameInput.value.trim()) { status.textContent = 'Name is required.'; return; }
        writeLocal(prefix, nameInput.value, licInput.value);
        status.textContent = 'Saved.';
        if (onChange) onChange(resolve(prefix));
      });
    }

    containerEl.appendChild(card);
  }

  global.TechnicianProfile = {
    readCloud, readLocal, writeLocal, getOverride, setOverride, resolve, renderSettingsScreen,
  };
})(window);
