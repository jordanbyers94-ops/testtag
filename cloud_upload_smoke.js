// Smoke test for the combined "Generate & Upload to Cloud" report button, the Site/Job Number
// export-and-report scope toggle, and the Switch User control -- all reverse-proxied under the
// Audit Tool (mirroring /testtag/), since these features only fully engage there (cloud upload
// needs the Audit Tool's own /api/testtag-reports; the Home/Switch User buttons only show up
// proxied too).
const { JSDOM, VirtualConsole } = require('jsdom');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  const map = {
    '/testtag/': 'public/index.html',
    '/testtag/index.html': 'public/index.html',
    '/testtag/app.js': 'public/app.js',
    '/testtag/technician-profile.js': 'public/technician-profile.js',
    '/testtag/style.css': 'public/style.css',
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
  const base = `http://localhost:${port}/testtag/`;

  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e.message || String(e)));
  const dom = await JSDOM.fromURL(base, { runScripts: 'dangerously', resources: 'usable', virtualConsole, pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  // jsdom doesn't implement createObjectURL/revokeObjectURL -- app.js uses these purely to
  // trigger the browser's own download of the generated report, unrelated to what this test
  // is checking (the cloud upload call), so stub them out.
  window.URL.createObjectURL = () => 'blob:mock-url';
  window.URL.revokeObjectURL = () => {};

  window.localStorage.setItem('cloudTechnicianName', 'Jordan Byers');
  window.localStorage.setItem('cloudTechnicianLicense', '69969');
  // No cloudToken/cloudTokenExpiresAt yet -- simulates "logged into Cloud Sync a while ago,
  // session since expired" so Generate should still download, but skip the upload half.

  const uploadCalls = [];
  const reportDatesCalls = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/register/report-dates')) {
      reportDatesCalls.push(u);
      return { ok: true, status: 200, json: async () => ['2026-03-06'] };
    }
    if (u.includes('/register/report?')) {
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'Content-Disposition' ? 'attachment; filename="Test_Register_Site_2026-03-06.docx"' : null) },
        blob: async () => new window.Blob(['fake docx bytes'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      };
    }
    if (u.endsWith('/api/testtag-reports') && opts.method === 'POST') {
      uploadCalls.push({ url: u, headers: opts.headers, body: opts.body });
      return { ok: true, status: 200, json: async () => ({ id: 'report-123', uploadedAt: new Date().toISOString() }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  await new Promise((r) => window.addEventListener('load', () => setTimeout(r, 200)));

  doc.querySelector('[data-tab="register"]').click();
  await new Promise((r) => setTimeout(r, 100));

  check('Cloud reports link visible when proxied', doc.getElementById('cloudReportsLinkWrap').style.display === 'block');
  check('Generate button relabeled for the combined flow when proxied', doc.getElementById('generateReportBtn').textContent === 'Generate & Upload to Cloud');

  // ---------- Scenario A: Site scope, no valid cloud token -- download only, no upload ----------
  doc.getElementById('siteFilter').value = 'William Jolly Bridge';
  doc.getElementById('reportBtn').click();
  await new Promise((r) => setTimeout(r, 150));

  check('report-dates requested with site param', reportDatesCalls.some((u) => u.includes('site=William')));
  check('Scope label reads Site', doc.getElementById('reportScopeLabel').firstChild.textContent === 'Site');

  doc.getElementById('generateReportBtn').click();
  await new Promise((r) => setTimeout(r, 150));

  check('No upload attempted without a valid cloud token', uploadCalls.length === 0);
  check('Download still reported as successful', doc.getElementById('reportModalStatus').textContent === 'Downloaded.');
  check('Upload status explains why nothing was uploaded', doc.getElementById('uploadReportCloudStatus').textContent.toLowerCase().includes('log into'));

  // ---------- Scenario B: Site scope, valid cloud token -- combined download + upload ----------
  window.localStorage.setItem('cloudToken', 'test-token-abc');
  window.localStorage.setItem('cloudTokenExpiresAt', String(Date.now() + 3600000));
  doc.getElementById('generateReportBtn').click();
  await new Promise((r) => setTimeout(r, 150));

  check('Exactly one upload call made', uploadCalls.length === 1);
  if (uploadCalls.length === 1) {
    const call = uploadCalls[0];
    check('Upload posted to /api/testtag-reports (root, not the Test & Tag API prefix)', call.url === '/api/testtag-reports');
    check('Upload carries the Bearer token from cloudToken', call.headers.Authorization === 'Bearer test-token-abc');
    check('Upload body is FormData with docx/site/testDate', typeof call.body.get === 'function' && call.body.get('site') === 'William Jolly Bridge' && call.body.get('testDate') === '2026-03-06' && !!call.body.get('docx'));
    check('Upload body has no jobNumber for a site-scoped report', !call.body.get('jobNumber'));
  }
  check('Combined success status shown after upload', doc.getElementById('reportModalStatus').textContent.toLowerCase().includes('uploaded to the cloud'));

  // ---------- Scenario C: Job Number scope -- report-dates/report/upload all switch params ----------
  doc.getElementById('exportScopeType').value = 'job_number';
  doc.getElementById('jobNumberFilter').value = 'JOB-1042';
  doc.getElementById('reportBtn').click();
  await new Promise((r) => setTimeout(r, 150));

  check('report-dates requested with job_number param when scoped by job', reportDatesCalls.some((u) => u.includes('job_number=JOB-1042')));
  check('Scope label switches to Job Number', doc.getElementById('reportScopeLabel').firstChild.textContent === 'Job Number');

  doc.getElementById('generateReportBtn').click();
  await new Promise((r) => setTimeout(r, 150));

  check('Second upload call made for the job-number-scoped report', uploadCalls.length === 2);
  if (uploadCalls.length === 2) {
    const call = uploadCalls[1];
    check('Job-scoped upload body has jobNumber set', call.body.get('jobNumber') === 'JOB-1042');
    check('Job-scoped upload body has no site', !call.body.get('site'));
  }

  // ---------- Scenario D: Switch User clears the cloud login ----------
  window.confirm = () => true;
  window.alert = () => {};
  doc.getElementById('switchUserBtn').click();
  check('Switch User clears cloudToken', !window.localStorage.getItem('cloudToken'));
  check('Switch User clears cloudTechnicianName', !window.localStorage.getItem('cloudTechnicianName'));
  check('Switch User clears cloudTechnicianLicense', !window.localStorage.getItem('cloudTechnicianLicense'));

  // jsdom doesn't implement real navigation, so the download-trigger pattern used throughout
  // app.js (a.href = blobUrl; a.click()) always logs this specific, benign warning -- it's a
  // jsdom limitation, not an app error. Any OTHER jsdomError is treated as a real failure.
  const realErrors = errors.filter((e) => !e.includes('Not implemented: navigation'));
  console.log('window errors:', errors.length ? errors.join('; ') : 'none');
  if (realErrors.length) failures++;

  server.close();
  process.exit(failures ? 1 : 0);
}

run();
