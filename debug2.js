let assets = [];
let tests = [];
let sites = [];
let nextAssetId = 1, nextTestId = 1;

function lastTestFor(assetId) {
  const rows = tests.filter(t => t.asset_id === assetId);
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
    console.log('QUERY:', s.slice(0, 90), '| params:', JSON.stringify(params));
    if (s.startsWith('SELECT name FROM sites')) {
      const names = new Set([...sites, ...assets.map(a => a.site)]);
      return { rows: [...names].sort().map(name => ({ name })) };
    }
    if (s.startsWith("INSERT INTO sites")) {
      const name = params[0];
      if (!sites.some(x => x.toLowerCase() === name.toLowerCase())) sites.push(name);
      return { rows: [] };
    }
    if (s.startsWith('SELECT a.*,') && s.includes('FROM assets a') && s.includes('LEFT JOIN LATERAL') && !s.includes('WHERE a.id')) {
      let rows = assets;
      if (s.includes('WHERE LOWER(a.site) = LOWER($1)')) {
        rows = rows.filter(a => a.site.toLowerCase() === params[0].toLowerCase());
      }
      const result = rows.map(assetWithLast);
      console.log('  -> list query returning', JSON.stringify(result));
      return { rows: result };
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
    if (s.startsWith('INSERT INTO assets (site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes)')) {
      const [site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes] = params;
      const a = { id: nextAssetId++, site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, created_at: new Date(), updated_at: new Date() };
      assets.push(a);
      return { rows: [a] };
    }
    if (s.startsWith('SELECT environment_category FROM assets WHERE id = $1')) {
      const a = assets.find(x => x.id === Number(params[0]));
      return { rows: a ? [{ environment_category: a.environment_category }] : [] };
    }
    if (s.startsWith('INSERT INTO test_records (asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, photo, photo_media_type)')) {
      const [asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, photo, photo_media_type] = params;
      const t = { id: nextTestId++, asset_id, tag_no, test_date: test_date || new Date().toISOString().slice(0, 10), next_due, tester_name, tester_licence, result, notes, photo, photo_media_type, created_at: new Date(), updated_at: new Date() };
      tests.push(t);
      return { rows: [{ ...t, has_photo: !!t.photo }] };
    }
    throw new Error('Unhandled mock query: ' + s.slice(0, 150));
  },
};

const dbPath = require.resolve('/sessions/youthful-focused-ptolemy/mnt/outputs/test_tag_app/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    pool: mockPool, initDb: async () => {},
    RETEST_INTERVALS_MONTHS: { construction: 3, hostile: 3, commercial_kitchen: 6, factory_workshop: 6, office_low_risk: 60, other: 12 },
  },
};

const express = require('/sessions/youthful-focused-ptolemy/mnt/outputs/test_tag_app/node_modules/express');
const app = express();
app.use(express.json());
app.use('/api/assets', require('/sessions/youthful-focused-ptolemy/mnt/outputs/test_tag_app/routes/assets'));
const server = app.listen(4323, run);
const http = require('http');
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 4323, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function run() {
  let r = await req('POST', '/api/assets', { site: 'X', location: 'Y', appliance: 'Microwave', plant_no: '1', brand: 'Sharp', environment_category: 'commercial_kitchen' });
  const id = r.body.id;
  await req('POST', `/api/assets/${id}/tests`, { tag_no: 'TAG-1', result: 'pass', test_date: '2020-01-01' });
  r = await req('GET', '/api/assets');
  console.log('FULL LIST RESPONSE:', JSON.stringify(r.body, null, 2));
  server.close();
}
