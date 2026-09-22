const dbPath = require.resolve('./db');
let assets = [{ id: 1, site: 'X', location: 'Y', appliance: 'M', plant_no: '1', brand: 'Sharp', model_no: 'R', serial_no: 'S', environment_category: 'commercial_kitchen', notes: null, created_at: new Date(), updated_at: new Date() }];
let tests = [{ id: 1, asset_id: 1, tag_no: 'TAG-1', result: 'pass', test_date: '2020-01-01', next_due: '2020-07-01', tester_name: null, tester_licence: null, notes: null, photo: null, photo_media_type: null, created_at: new Date(), updated_at: new Date() }];

function lastTestFor(assetId) {
  const rows = tests.filter(t => t.asset_id === assetId);
  return rows[0] || null;
}
function assetWithLast(a) {
  const t = lastTestFor(a.id);
  return { ...a, last_tag_no: t ? t.tag_no : null, last_result: t ? t.result : null, last_next_due: t ? (t.next_due ? new Date(t.next_due) : null) : null };
}
const row = assetWithLast(assets[0]);
console.log('row:', row);
console.log('last_next_due instanceof Date:', row.last_next_due instanceof Date);
console.log('iso:', row.last_next_due.toISOString().slice(0,10));
console.log('today:', new Date().toISOString().slice(0,10));
console.log('overdue?', row.last_next_due.toISOString().slice(0,10) < new Date().toISOString().slice(0,10));
