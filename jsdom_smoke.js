const { JSDOM } = require('jsdom');
const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');
const appJs = fs.readFileSync('public/app.js', 'utf8');
const techProfileJs = fs.readFileSync('public/technician-profile.js', 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(appJs).toString('base64');
const techProfileDataUrl = 'data:text/javascript;base64,' + Buffer.from(techProfileJs).toString('base64');
html = html.replace('<script src="./technician-profile.js"></script>', `<script src="${techProfileDataUrl}"></script>`);
html = html.replace('<script src="./app.js"></script>', `<script src="${dataUrl}"></script>`);
html = html.replace('<link rel="stylesheet" href="./style.css" />', '');

let assets = [
  { id: 1, site: 'Holy Spirit Primary', location: 'Tuckshop', appliance: 'Microwave', plant_no: '12', brand: 'Sharp', model_no: 'R-21', serial_no: 'SN1', environment_category: 'commercial_kitchen', last_tag_no: 'TAG-1', last_result: 'pass', last_next_due: '2020-07-01', last_tester_name: null },
];
const testLogs = [];
const logs = [];

function makeFetch() {
  return async (url, opts = {}) => {
    logs.push(`${opts.method || 'GET'} ${url}`);
    const u = new URL(url, 'http://localhost/testtag/');
    const path = u.pathname.replace(/^\/(?:testtag\/)?api/, '');
    const method = opts.method || 'GET';
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, blob: async () => ({}) });
    const notFound = (body) => ({ ok: false, status: 404, json: async () => body });

    if (path === '/assets/sites') return ok([{ name: 'Holy Spirit Primary', client_name: 'Holy Spirit Catholic Primary School' }]);
    if (path.match(/^\/assets\/\d+$/) && method === 'GET') {
      const id = Number(path.split('/')[2]);
      const a = assets.find(x => x.id === id);
      return a ? ok(a) : notFound({ error: 'Not found' });
    }
    if (path.match(/^\/assets\/\d+$/) && method === 'PATCH') {
      const id = Number(path.split('/')[2]);
      const a = assets.find(x => x.id === id);
      Object.assign(a, JSON.parse(opts.body));
      return ok(a);
    }
    if (path.match(/^\/assets\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[2]);
      assets = assets.filter(x => x.id !== id);
      return ok({ ok: true });
    }
    if (path.match(/^\/assets\/\d+\/tests$/) && method === 'POST') {
      testLogs.push(JSON.parse(opts.body));
      return ok({ id: 99, ...JSON.parse(opts.body) });
    }
    if (path.startsWith('/assets') && method === 'GET' && path.match(/^\/assets(\?|$)/)) return ok(assets);
    if (path.match(/^\/assets\/\d+\/history$/)) return ok([]);
    if (path === '/assets/due-summary') return ok([]);
    return ok({});
  };
}

const dom = new JSDOM(html, {
  url: 'http://localhost/testtag/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});
const { window } = dom;
window.fetch = makeFetch();
window.alert = (msg) => logs.push('ALERT: ' + msg);
window.confirm = () => true;
window.localStorage.setItem('testTagAccessToken', 'x');

let errors = [];
window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await wait(400);
  const doc = window.document;

  function click(id) {
    const el = doc.getElementById(id);
    if (!el) { errors.push(`click target missing: #${id}`); return; }
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  function setVal(id, val) {
    const el = doc.getElementById(id);
    if (!el) { errors.push(`setVal target missing: #${id}`); return; }
    el.value = val;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  // ---------- Site remembers Client Name (Scan tab, default-active on load) ----------
  setVal('siteInput', 'Holy Spirit Primary');
  await wait(100);
  const autofilled = doc.getElementById('clientNameInput').value;
  console.log('Client Name auto-filled from remembered site:', autofilled);
  if (autofilled !== 'Holy Spirit Catholic Primary School') errors.push(`Client Name did not auto-fill from the remembered site (got "${autofilled}")`);

  // Doesn't clobber a client name the technician already typed for a one-off/different client.
  setVal('siteInput', '');
  setVal('clientNameInput', 'A Different Client');
  setVal('siteInput', 'Holy Spirit Primary');
  await wait(100);
  const notOverwritten = doc.getElementById('clientNameInput').value;
  console.log('Client Name NOT overwritten when already filled in:', notOverwritten);
  if (notOverwritten !== 'A Different Client') errors.push(`An already-filled Client Name was overwritten (got "${notOverwritten}")`);
  setVal('clientNameInput', ''); // reset for the rest of the scenarios below

  doc.querySelector('.tab-btn[data-tab="register"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);

  const registerHtml = doc.getElementById('registerList').innerHTML;
  console.log('Register list rendered non-empty:', registerHtml.includes('Microwave'));

  const row = doc.querySelector('.asset-row');
  if (!row) errors.push('no .asset-row rendered to click for history modal');
  else row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);

  console.log('History modal shown:', doc.getElementById('historyModal').style.display === 'flex');

  click('editAssetBtn');
  await wait(200);
  console.log('Edit form visible:', doc.getElementById('editAssetForm').style.display === 'block');
  console.log('Edit form prefilled appliance:', doc.getElementById('edit_appliance').value);
  setVal('edit_appliance', 'Microwave Oven (Fixed)');
  click('saveAssetEditBtn');
  await wait(300);
  console.log('Modal title updated after edit:', doc.getElementById('historyModalTitle').textContent);
  console.log('Backend received PATCH with new appliance:', assets[0].appliance === 'Microwave Oven (Fixed)');

  click('quickRetestBtn');
  await wait(300);
  console.log('Scan tab active after quick retest:', doc.getElementById('tab-scan').classList.contains('active'));
  console.log('Retest banner text:', doc.getElementById('retestBanner').textContent);
  console.log('Test card shown for quick retest:', doc.getElementById('testCard').style.display === 'block');
  console.log('Result card hidden for quick retest:', doc.getElementById('resultCard').style.display === 'none');

  // Regression check for "tested items showing as unfound in the report": the Test Date field
  // must default to today rather than being left blank -- a blank/null test_date never matches
  // a report's exact-date filter, so the item wrongly shows as "unfound" despite being tested.
  const todayStr = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  console.log('Test Date defaults to today after quick retest:', doc.getElementById('t_test_date').value === todayStr);

  setVal('t_result', 'fail');
  click('saveTestBtn');
  await wait(300);
  console.log('Test status after logging retest:', doc.getElementById('testStatus').textContent);
  console.log('Backend received the test log:', testLogs.length === 1 && testLogs[0].result === 'fail');
  console.log('Backend received a non-null test_date matching today:', testLogs.length === 1 && testLogs[0].test_date === todayStr);

  doc.querySelector('.tab-btn[data-tab="register"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  const row2 = doc.querySelector('.asset-row');
  if (row2) row2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  click('deleteAssetBtn');
  await wait(300);
  console.log('Modal closed after delete:', doc.getElementById('historyModal').style.display !== 'flex');
  console.log('Asset removed from mock store:', assets.length === 0);

  click('filterOverdueBtn');
  await wait(150);
  console.log('Overdue filter active class applied:', doc.getElementById('filterOverdueBtn').classList.contains('active'));
  console.log('All filter class removed:', !doc.getElementById('filterAllBtn').classList.contains('active'));
  console.log('due=overdue param sent:', logs.some(l => l.includes('due=overdue')));

  console.log('--- window errors ---');
  if (errors.length) { errors.forEach(e => console.log('ERROR:', e)); process.exitCode = 1; }
  else console.log('none');

  process.exit(process.exitCode || 0);
})();
