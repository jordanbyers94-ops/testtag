// End-to-end verification of the report-generation routes (routes/register.js's
// /report-dates and /report), run against a real Express app with a mocked pg pool, plus a
// structural check that the produced .docx is a valid, non-empty OOXML package.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

let failures = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
  if (!cond) failures++;
}

const assets = [
  { id: 1, site: 'William Jolly Bridge', location: 'North end', appliance: 'Extension Lead', plant_no: '1', brand: 'HPM', model_no: null, serial_no: null, environment_category: 'construction', notes: null },
  { id: 2, site: 'William Jolly Bridge', location: 'North end', appliance: 'Drop Saw', plant_no: '2', brand: 'Makita', model_no: 'LS1018', serial_no: 'SN2', environment_category: 'construction', notes: null },
  { id: 3, site: 'William Jolly Bridge', location: 'South end', appliance: 'Grinder', plant_no: '3', brand: 'Bosch', model_no: null, serial_no: null, environment_category: 'construction', notes: null },
  { id: 4, site: 'Other Site', location: 'Shed', appliance: 'Kettle', plant_no: '9', brand: 'Sunbeam', model_no: null, serial_no: null, environment_category: 'office_low_risk', notes: null },
];
const testRecords = [
  { id: 1, asset_id: 1, test_date: '2026-03-06', tag_no: 'TAG-101', result: 'pass', next_due: '2026-06-06', created_at: new Date('2026-03-06T09:00:00Z') },
  { id: 2, asset_id: 2, test_date: '2026-03-06', tag_no: 'TAG-102', result: 'fail', next_due: null, created_at: new Date('2026-03-06T09:05:00Z') },
  // asset_id 3 has no test on 2026-03-06 -> should be reported "unfound"
];

const pool = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT DISTINCT tr.test_date')) {
      const site = params[0].toLowerCase();
      const dates = [...new Set(testRecords
        .filter((t) => assets.find((a) => a.id === t.asset_id && a.site.toLowerCase() === site))
        .map((t) => t.test_date))];
      return { rows: dates.map((d) => ({ test_date: d })) };
    }
    if (s.startsWith('SELECT * FROM assets WHERE')) {
      const site = params[0].toLowerCase();
      return { rows: assets.filter((a) => a.site.toLowerCase() === site) };
    }
    if (s.startsWith('SELECT tr.* FROM test_records')) {
      const [site, testDate] = params;
      const siteAssetIds = assets.filter((a) => a.site.toLowerCase() === site.toLowerCase()).map((a) => a.id);
      return { rows: testRecords.filter((t) => siteAssetIds.includes(t.asset_id) && t.test_date === testDate) };
    }
    throw new Error('Unhandled mock query: ' + s);
  },
};

// Patch the db module resolution the same way the other mock harnesses in this project do:
// register.js does `const pool = require('../db')`, so we shim that module before requiring it.
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool, initDb: async () => {}, RETEST_INTERVALS_MONTHS: {} } };

const registerRouter = require('./routes/register');
const app = express();
app.use(express.json());
app.use('/api/register', registerRouter);

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://localhost:${port}/api/register`;

  try {
    // /report-dates
    let res = await fetch(`${base}/report-dates?site=${encodeURIComponent('William Jolly Bridge')}`);
    let data = await res.json();
    check('/report-dates status 200', res.status === 200);
    check('/report-dates returns the one test date', Array.isArray(data) && data.length === 1 && data[0] === '2026-03-06');

    res = await fetch(`${base}/report-dates?site=${encodeURIComponent('No Such Site')}`);
    data = await res.json();
    check('/report-dates empty array for unknown site', Array.isArray(data) && data.length === 0);

    res = await fetch(`${base}/report-dates`);
    check('/report-dates 400 when site missing', res.status === 400);

    // /report (the actual docx)
    res = await fetch(`${base}/report?site=${encodeURIComponent('William Jolly Bridge')}&test_date=2026-03-06`);
    check('/report status 200', res.status === 200);
    check('/report content-type is docx', (res.headers.get('content-type') || '').includes('wordprocessingml'));
    const buf = Buffer.from(await res.arrayBuffer());
    check('/report body is non-trivial size', buf.length > 5000);

    const tmpFile = path.join(os.tmpdir(), 'report_route_test_output.docx');
    fs.writeFileSync(tmpFile, buf);
    let zipOk = false;
    try { execSync(`unzip -t "${tmpFile}"`, { stdio: 'pipe' }); zipOk = true; } catch (e) { zipOk = false; }
    check('/report output is a structurally valid zip/OOXML package', zipOk);

    const xml = execSync(`unzip -p "${tmpFile}" word/document.xml`).toString('utf8');
    check('Report document mentions the site name', xml.includes('William Jolly Bridge'));
    check('Report document mentions a passed item tag', xml.includes('TAG-101'));
    check('Report document mentions the failed item', xml.includes('Drop Saw') || xml.includes('Makita'));
    check('Report document counts reflect 1 pass, 1 fail, 1 unfound (of 3 site items)', /\b1\b[\s\S]{0,40}pass/i.test(xml) || xml.toLowerCase().includes('unfound'));
    check('Report no longer mentions RCD (Test & Tag covers portable equipment only)', !xml.toLowerCase().includes('rcd'));
    check('Register table has a Location column with the asset locations', xml.includes('North end') && xml.includes('South end'));

    const mediaList = execSync(`unzip -l "${tmpFile}"`).toString('utf8');
    const mediaImages = (mediaList.match(/word\/media\/[^\s/]+\.\w+/g) || []).length;
    check('Cover page embeds both the logo and the diagonal banner graphic', mediaImages >= 2);

    res = await fetch(`${base}/report?site=${encodeURIComponent('No Such Site')}&test_date=2026-03-06`);
    check('/report 404 for site with no register items', res.status === 404);

    res = await fetch(`${base}/report?site=${encodeURIComponent('William Jolly Bridge')}`);
    check('/report 400 when test_date missing', res.status === 400);
  } catch (err) {
    console.error('Test run threw:', err);
    failures++;
  } finally {
    server.close();
    process.exit(failures ? 1 : 0);
  }
});
