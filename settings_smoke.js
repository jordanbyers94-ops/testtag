// Smoke test for the new Settings tab / shared technician-profile.js module: cloud-login
// display + override toggle, local-fallback editing when there's no cloud login, and that the
// per-test tester fields immediately reflect whatever the Settings tab resolves to.
const { JSDOM, VirtualConsole } = require('jsdom');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  const map = {
    '/': 'public/index.html',
    '/index.html': 'public/index.html',
    '/app.js': 'public/app.js',
    '/technician-profile.js': 'public/technician-profile.js',
    '/style.css': 'public/style.css',
  };
  const file = map[req.url.split('?')[0]];
  if (!file) { res.statusCode = 404; return res.end('not found: ' + req.url); }
  res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, file), 'utf8'));
});

let failures = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
  if (!cond) failures++;
}

async function run() {
  const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
  const base = `http://localhost:${port}/`;

  // ---- Scenario A: no cloud login (standalone) -- Settings tab should show editable fields ----
  {
    const virtualConsole = new VirtualConsole();
    const errors = [];
    virtualConsole.on('jsdomError', (e) => errors.push(e.message || String(e)));
    const dom = await JSDOM.fromURL(base, { runScripts: 'dangerously', resources: 'usable', virtualConsole, pretendToBeVisual: true });
    const { window } = dom;
    window.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
    await new Promise((r) => window.addEventListener('load', () => setTimeout(r, 200)));
    const doc = window.document;

    doc.querySelector('[data-tab="settings"]').click();
    await new Promise((r) => setTimeout(r, 100));
    const card = doc.getElementById('settingsContainer');
    check('Settings screen renders "My Details" heading (no cloud login)', card.textContent.includes('My Details'));
    check('No cloud-login notice shown when standalone', !card.textContent.includes('Signed in via the Audit Tool'));

    const nameInput = doc.getElementById('testTag_settingsName');
    const licInput = doc.getElementById('testTag_settingsLicence');
    check('Editable Name field present', !!nameInput);
    check('Editable Licence field present', !!licInput);

    nameInput.value = 'Alex Fitter';
    licInput.value = '12345';
    doc.getElementById('testTag_settingsSaveBtn').click();
    await new Promise((r) => setTimeout(r, 50));
    check('Save confirms', doc.getElementById('testTag_settingsStatus').textContent.includes('Saved'));
    check('Local storage now holds the saved name', window.localStorage.getItem('testTagTesterName') === 'Alex Fitter');

    // Switch to the Scan tab and confirm the test-log tester fields picked up the saved details.
    doc.querySelector('[data-tab="scan"]').click();
    await new Promise((r) => setTimeout(r, 50));
    check('Tester Name field reflects the saved Settings value', doc.getElementById('t_tester_name').value === 'Alex Fitter');
    check('Tester Licence field reflects the saved Settings value', doc.getElementById('t_tester_licence').value === '12345');

    console.log('Scenario A window errors:', errors.length ? errors.join('; ') : 'none');
    if (errors.length) failures++;
    dom.window.close();
  }

  // ---- Scenario B: an active Audit Tool cloud login -- Settings should show it read-only,
  // with an override toggle, and the per-test fields should prefill from the cloud values ----
  {
    const virtualConsole = new VirtualConsole();
    const errors = [];
    virtualConsole.on('jsdomError', (e) => errors.push(e.message || String(e)));
    const dom = await JSDOM.fromURL(base, { runScripts: 'dangerously', resources: 'usable', virtualConsole, pretendToBeVisual: true });
    const { window } = dom;
    window.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
    window.localStorage.setItem('cloudTechnicianName', 'Jordan Byers');
    window.localStorage.setItem('cloudTechnicianLicense', '69969');
    await new Promise((r) => window.addEventListener('load', () => setTimeout(r, 200)));
    const doc = window.document;

    check('Tester Name prefilled from cloud login on the Scan tab', doc.getElementById('t_tester_name').value === 'Jordan Byers');
    check('Tester Licence prefilled from cloud login on the Scan tab', doc.getElementById('t_tester_licence').value === '69969');

    doc.querySelector('[data-tab="settings"]').click();
    await new Promise((r) => setTimeout(r, 100));
    const card = doc.getElementById('settingsContainer');
    check('Settings shows the cloud-login notice with the technician name', card.textContent.includes('Jordan Byers'));
    check('Settings shows the cloud licence number', card.textContent.includes('69969'));
    check('No editable Name field while a cloud login is active (no override yet)', !doc.getElementById('testTag_settingsName'));

    const toggle = doc.getElementById('testTag_useLocalToggle');
    check('Override toggle present', !!toggle);
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 50));
    check('Editable fields appear once override is checked', !!doc.getElementById('testTag_settingsName'));

    doc.getElementById('testTag_settingsName').value = 'Casey Overridden';
    doc.getElementById('testTag_settingsLicence').value = '99999';
    doc.getElementById('testTag_settingsSaveBtn').click();
    await new Promise((r) => setTimeout(r, 50));

    doc.querySelector('[data-tab="scan"]').click();
    await new Promise((r) => setTimeout(r, 50));
    check('Overridden local details now win over the cloud login on the Scan tab', doc.getElementById('t_tester_name').value === 'Casey Overridden');

    console.log('Scenario B window errors:', errors.length ? errors.join('; ') : 'none');
    if (errors.length) failures++;
    dom.window.close();
  }

  server.close();
  process.exit(failures ? 1 : 0);
}

run();
