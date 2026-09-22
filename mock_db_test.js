// Functional test harness: mocks pg's Pool.query with an in-memory dataset that implements
// just the specific queries routes/assets.js issues, so real route handlers (upsert logic,
// search/due filtering, the new GET/PATCH/DELETE /:id endpoints) can be exercised without a
// live Postgres (no sandbox Postgres/Docker/root available here).
let assets = [];
let tests = [];
let sites = [];
let nextAssetId = 1, nextTestId = 1;

function lastTestFor(assetId) {
  const rows = tests.filter(t => Number(t.asset_id) === Number(assetId));
  rows.sort((a, b) => {
    const ad = a.test_date, bd = b.test_date;
    if (ad !== bd) { if (!ad) return 1; if (!bd) return -1; return ad < bd ? 1 : -1; }
    return b.created_at - a.created_at;
  });
  return rows[0] || null;
}
function assetWithLast(a) {
  const t = lastTestFor(a.id);
  return {
    ...a,
    last_tag_no: t ? t.tag_no : null,
    last_test_date: t ? t.test_date : null,
    last_result: t ? t.result : null,
    last_next_due: t ? (t.next_due ? new Date(t.next_due) : null) : null,
    last_tester_name: t ? t.tester_name : null,
    last_test_id: t ? t.id : null,
    last_test_has_photo: t ? !!t.photo : false,
  };
}

const mockPool = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    // sites is now an array of { name, client_name } -- client_name is the value remembered
    // for that site (from whichever asset save most recently supplied one), mirroring the real
    // sites.client_name column added alongside this test.
    if (s.startsWith('SELECT name, client_name FROM sites')) {
      const bySite = {};
      sites.forEach((site) => { bySite[site.name.toLowerCase()] = { name: site.name, client_name: site.client_name || null }; });
      assets.forEach((a) => { const key = a.site.toLowerCase(); if (!bySite[key]) bySite[key] = { name: a.site, client_name: null }; });
      return { rows: Object.values(bySite).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (s.startsWith('SELECT client_name FROM sites WHERE LOWER(name) = LOWER($1)')) {
      const site = sites.find(x => x.name.toLowerCase() === (params[0] || '').toLowerCase());
      return { rows: site ? [{ client_name: site.client_name || null }] : [] };
    }
    if (s.startsWith("INSERT INTO sites")) {
      // upsertSite(name, clientName): a non-null clientName overwrites what was remembered for
      // that site; a null/omitted one leaves the existing remembered value untouched.
      const [name, clientName] = params;
      const existing = sites.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (existing) { if (clientName != null) existing.client_name = clientName; }
      else sites.push({ name, client_name: clientName != null ? clientName : null });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE assets SET site = $1, updated_at = now() WHERE LOWER(site)')) {
      const [newName, oldName] = params;
      assets.forEach(a => { if (a.site.toLowerCase() === oldName.toLowerCase()) a.site = newName; });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM sites')) {
      sites = sites.filter(x => x.name.toLowerCase() !== params[0].toLowerCase());
      return { rows: [] };
    }

    if (s.startsWith('SELECT a.*,') && s.includes('FROM assets a') && s.includes('LEFT JOIN LATERAL') && !s.includes('WHERE a.id')) {
      let rows = assets;
      let pIdx = 0;
      if (s.includes('LOWER(a.site) = LOWER($')) {
        const site = params[pIdx++];
        rows = rows.filter(a => a.site.toLowerCase() === site.toLowerCase());
      }
      if (s.includes('LOWER(a.job_number) = LOWER($')) {
        const jobNumber = params[pIdx++];
        rows = rows.filter(a => (a.job_number || '').toLowerCase() === jobNumber.toLowerCase());
      }
      return { rows: rows.map(assetWithLast) };
    }

    if (s.startsWith('SELECT a.site,') && s.includes('GROUP BY a.site')) {
      const bySite = {};
      assets.forEach(a => {
        const t = lastTestFor(a.id);
        const site = a.site;
        bySite[site] = bySite[site] || { site, overdue: 0, due_soon: 0, fails: 0, total_assets: 0 };
        bySite[site].total_assets++;
        if (t) {
          const today = new Date().toISOString().slice(0, 10);
          const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
          if (t.next_due && t.next_due < today) bySite[site].overdue++;
          else if (t.next_due && t.next_due >= today && t.next_due <= in30) bySite[site].due_soon++;
          if (t.result === 'fail') bySite[site].fails++;
        }
      });
      return { rows: Object.values(bySite) };
    }

    if (s.startsWith('SELECT * FROM assets WHERE id = $1') && !s.includes('UPDATE')) {
      const a = assets.find(x => x.id === Number(params[0]));
      return { rows: a ? [a] : [] };
    }

    if (s.startsWith("SELECT * FROM assets WHERE LOWER(site) = LOWER($1) AND LOWER(COALESCE(location, '')) = LOWER(COALESCE($2, '')) AND LOWER(plant_no) = LOWER($3)")) {
      const [site, location, plant_no] = params;
      const found = assets.find(a =>
        a.site.toLowerCase() === (site || '').toLowerCase() &&
        (a.location || '').toLowerCase() === (location || '').toLowerCase() &&
        (a.plant_no || '').toLowerCase() === (plant_no || '').toLowerCase()
      );
      return { rows: found ? [found] : [] };
    }

    if (s.startsWith('UPDATE assets SET') && s.includes('appliance = COALESCE($1, appliance)')) {
      const [appliance, brand, model_no, serial_no, environment_category, notes, client_name, job_number, id] = params;
      const a = assets.find(x => x.id === Number(id));
      if (appliance != null) a.appliance = appliance;
      if (brand != null) a.brand = brand;
      if (model_no != null) a.model_no = model_no;
      if (serial_no != null) a.serial_no = serial_no;
      if (environment_category != null) a.environment_category = environment_category;
      if (notes != null) a.notes = notes;
      if (client_name != null) a.client_name = client_name;
      if (job_number != null) a.job_number = job_number;
      a.updated_at = new Date();
      return { rows: [a] };
    }

    if (s.startsWith('INSERT INTO assets (site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number)')) {
      const [site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number] = params;
      const a = { id: nextAssetId++, site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number, created_at: new Date(), updated_at: new Date() };
      assets.push(a);
      return { rows: [a] };
    }

    if (s.startsWith('UPDATE assets SET') && s.includes('site = $1, location = $2, appliance = $3')) {
      const [site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number, id] = params;
      const a = assets.find(x => x.id === Number(id));
      if (!a) return { rows: [] };
      Object.assign(a, { site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number, updated_at: new Date() });
      return { rows: [a] };
    }

    if (s.startsWith('DELETE FROM assets WHERE id = $1')) {
      const before = assets.length;
      const id = Number(params[0]);
      assets = assets.filter(a => a.id !== id);
      tests = tests.filter(t => Number(t.asset_id) !== id);
      return { rowCount: before - assets.length };
    }

    if (s.startsWith('SELECT id, tag_no, result, test_date, next_due, tester_name, tester_licence, notes, (photo IS NOT NULL) AS has_photo, created_at FROM test_records WHERE asset_id = $1')) {
      const id = Number(params[0]);
      const rows = tests.filter(t => Number(t.asset_id) === id).map(t => ({ ...t, has_photo: !!t.photo }));
      return { rows };
    }

    if (s.startsWith('INSERT INTO test_records (asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, photo, photo_media_type)')) {
      const [asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, photo, photo_media_type] = params;
      const t = { id: nextTestId++, asset_id: Number(asset_id), tag_no, test_date: test_date || new Date().toISOString().slice(0, 10), next_due, tester_name, tester_licence, result, notes, photo, photo_media_type, created_at: new Date(), updated_at: new Date() };
      tests.push(t);
      return { rows: [{ ...t, has_photo: !!t.photo }] };
    }

    if (s.startsWith('SELECT environment_category FROM assets WHERE id = $1')) {
      const a = assets.find(x => x.id === Number(params[0]));
      return { rows: a ? [{ environment_category: a.environment_category }] : [] };
    }

    throw new Error('Unhandled mock query: ' + s.slice(0, 120));
  },
};

const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    pool: mockPool,
    initDb: async () => {},
    RETEST_INTERVALS_MONTHS: { construction: 3, hostile: 3, commercial_kitchen: 6, factory_workshop: 6, office_low_risk: 60, other: 12 },
  },
};

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/assets', require('./routes/assets'));
const server = app.listen(4324, run);

const http = require('http');
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 4324, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.log(`FAIL ${label}: expected ${e}, got ${a}`); process.exitCode = 1; }
  else console.log(`PASS ${label}`);
}
function assertTrue(cond, label) {
  if (!cond) { console.log(`FAIL ${label}`); process.exitCode = 1; } else console.log(`PASS ${label}`);
}

async function run() {
  try {
    let r = await req('POST', '/api/assets', { site: 'Holy Spirit Primary', location: 'Tuckshop', appliance: 'Microwave', plant_no: '12', brand: 'Sharp', model_no: 'R-21', serial_no: 'SN1', environment_category: 'commercial_kitchen', client_name: 'Holy Spirit Catholic Primary School', job_number: 'JOB-500' });
    assertEqual(r.status, 200, 'POST /assets creates');
    const assetId = r.body.id;
    assertTrue(typeof assetId === 'number', 'POST /assets returns numeric id');
    assertEqual(r.body.client_name, 'Holy Spirit Catholic Primary School', 'POST /assets persists client_name');
    assertEqual(r.body.job_number, 'JOB-500', 'POST /assets persists job_number');

    r = await req('GET', `/api/assets/${assetId}`);
    assertEqual(r.status, 200, 'GET /assets/:id status');
    assertEqual(r.body.appliance, 'Microwave', 'GET /assets/:id returns correct appliance');

    r = await req('GET', '/api/assets/999999');
    assertEqual(r.status, 404, 'GET /assets/:id 404 for missing');

    r = await req('GET', '/api/assets?job_number=JOB-500');
    assertTrue(r.body.some(a => a.id === assetId), 'GET /assets?job_number filters by job number');

    r = await req('PATCH', `/api/assets/${assetId}`, { site: 'Holy Spirit Primary', location: 'Tuckshop', appliance: 'Microwave Oven', plant_no: '12', brand: 'Sharp', model_no: 'R-21', serial_no: 'SN1', environment_category: 'commercial_kitchen', notes: null, client_name: 'Holy Spirit Catholic Primary School', job_number: 'JOB-500' });
    assertEqual(r.status, 200, 'PATCH /assets/:id status');
    assertEqual(r.body.appliance, 'Microwave Oven', 'PATCH /assets/:id updated appliance');

    r = await req('PATCH', `/api/assets/${assetId}`, { site: '' });
    assertEqual(r.status, 400, 'PATCH /assets/:id rejects blank site');

    r = await req('POST', `/api/assets/${assetId}/tests`, { tag_no: 'TAG-1', result: 'pass', test_date: '2020-01-01' });
    assertEqual(r.status, 200, 'POST /assets/:id/tests logs test');
    assertEqual(r.body.next_due, '2020-07-01', 'auto-calculated next_due (6 months for commercial_kitchen)');

    r = await req('GET', '/api/assets?due=overdue');
    assertTrue(r.body.some(a => a.id === assetId), 'GET /assets?due=overdue includes the overdue item');

    r = await req('GET', '/api/assets?search=sharp');
    assertTrue(r.body.some(a => a.id === assetId), 'GET /assets?search matches brand field');

    r = await req('GET', '/api/assets?search=TAG-1');
    assertTrue(r.body.some(a => a.id === assetId), 'GET /assets?search matches last test tag_no');

    r = await req('GET', '/api/assets?search=zzz_no_match_zzz');
    assertEqual(r.body.length, 0, 'GET /assets?search excludes non-matches');

    r = await req('GET', '/api/assets?result=fail');
    assertEqual(r.body.length, 0, 'GET /assets?result=fail excludes a passing item');

    r = await req('POST', '/api/assets', { site: 'Holy Spirit Primary', location: 'Staff Room', appliance: 'Kettle', plant_no: '99' });
    const asset2 = r.body.id;
    const soonDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await req('POST', `/api/assets/${asset2}/tests`, { result: 'pass', test_date: '2024-01-01', next_due: soonDate });
    r = await req('GET', '/api/assets?due=soon');
    assertTrue(r.body.some(a => a.id === asset2) && !r.body.some(a => a.id === assetId), 'GET /assets?due=soon isolates the due-soon item only');

    r = await req('DELETE', `/api/assets/${assetId}`);
    assertEqual(r.status, 200, 'DELETE /assets/:id status');
    r = await req('GET', `/api/assets/${assetId}`);
    assertEqual(r.status, 404, 'GET /assets/:id 404 after delete');
    r = await req('GET', `/api/assets/${assetId}/history`);
    assertEqual(r.body.length, 0, 'test history empty after cascade delete');

    r = await req('DELETE', '/api/assets/999999');
    assertEqual(r.status, 404, 'DELETE /assets/:id 404 for missing');

    // ---------- Site remembers Client Name across saves ----------
    r = await req('POST', '/api/assets', { site: 'Riverside Park', location: 'Kiosk', appliance: 'Fridge', plant_no: '1', client_name: 'Riverside Community Centre' });
    assertEqual(r.status, 200, 'POST /assets (new site with client_name) status');

    r = await req('GET', '/api/assets/sites');
    let site = r.body.find(s => s.name === 'Riverside Park');
    assertTrue(!!site, 'GET /assets/sites includes the new site');
    assertEqual(site && site.client_name, 'Riverside Community Centre', 'GET /assets/sites remembers the client_name given on first save');

    // A second asset saved for the same site with NO client_name shouldn't wipe out what's remembered.
    r = await req('POST', '/api/assets', { site: 'Riverside Park', location: 'Clubhouse', appliance: 'Fan', plant_no: '2' });
    assertEqual(r.status, 200, 'POST /assets (same site, no client_name) status');
    r = await req('GET', '/api/assets/sites');
    site = r.body.find(s => s.name === 'Riverside Park');
    assertEqual(site && site.client_name, 'Riverside Community Centre', 'A blank client_name on a later save does not clear the remembered one');

    // A later save WITH a client_name updates what's remembered (technician correcting it).
    r = await req('POST', '/api/assets', { site: 'Riverside Park', location: 'Kiosk', appliance: 'Fridge', plant_no: '1', client_name: 'Riverside Community Centre Inc.' });
    r = await req('GET', '/api/assets/sites');
    site = r.body.find(s => s.name === 'Riverside Park');
    assertEqual(site && site.client_name, 'Riverside Community Centre Inc.', 'A later non-empty client_name overwrites the remembered one');

  } catch (e) {
    console.log('ERROR during test run:', e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}
