const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const router = express.Router();
const { pool } = require('../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const TEMPLATE_HEADERS = ['Asset ID', 'Location', 'Appliance', 'Plant No.', 'Brand ', 'Model No.', 'Serial No.', 'Pass/Fail', 'Tag No.', 'Test Date', 'Next Due', 'Notes'];

async function fetchRegisterRows(site, resultFilter) {
  const params = [];
  const clauses = [];
  if (site) { params.push(site); clauses.push(`a.site = $${params.length}`); }
  const { rows } = await pool.query(
    `
    SELECT a.site, a.location, a.appliance, a.plant_no, a.brand, a.model_no, a.serial_no, a.notes,
      t.tag_no AS last_tag_no, t.result AS last_result, t.test_date AS last_test_date, t.next_due AS last_next_due
    FROM assets a
    LEFT JOIN LATERAL (
      SELECT * FROM test_records tr WHERE tr.asset_id = a.id
      ORDER BY tr.test_date DESC NULLS LAST, tr.created_at DESC LIMIT 1
    ) t ON true
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
    ORDER BY a.site ASC, a.location ASC, a.plant_no ASC
    `,
    params
  );
  return resultFilter ? rows.filter((r) => r.last_result === resultFilter) : rows;
}

// GET /api/register/export?site=xxx&result=fail
// With a site given: reproduces the original template exactly (title rows + these headers)
// so it drops straight back into the same-shaped workbook.
// Without a site: a consolidated multi-site view with a Site column added.
// ?result=fail exports only items whose latest test failed - handy for a
// client-facing "these need attention" list.
router.get('/export', async (req, res) => {
  try {
    const site = (req.query.site || '').trim();
    const resultFilter = (req.query.result || '').trim();
    const rows = await fetchRegisterRows(site || null, resultFilter === 'fail' || resultFilter === 'pass' ? resultFilter : null);

    const wb = XLSX.utils.book_new();
    let ws;

    if (site) {
      const aoa = [
        [site.toUpperCase()],
        ['Asset Register - Test and Tag Items'],
        TEMPLATE_HEADERS,
        ...rows.map((r) => [
          '', // Asset ID - not tracked yet, left blank as in the source file
          r.location || '',
          r.appliance || '',
          r.plant_no || '',
          r.brand || '',
          r.model_no || '',
          r.serial_no || '',
          r.last_result || '',
          r.last_tag_no || '',
          r.last_test_date ? new Date(r.last_test_date) : '',
          r.last_next_due ? new Date(r.last_next_due) : '',
          r.notes || '',
        ]),
      ];
      ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 10 }, { wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 30 }];
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } }];
    } else {
      const aoa = [
        ['Site', ...TEMPLATE_HEADERS],
        ...rows.map((r) => [
          r.site,
          '',
          r.location || '',
          r.appliance || '',
          r.plant_no || '',
          r.brand || '',
          r.model_no || '',
          r.serial_no || '',
          r.last_result || '',
          r.last_tag_no || '',
          r.last_test_date ? new Date(r.last_test_date) : '',
          r.last_next_due ? new Date(r.last_next_due) : '',
          r.notes || '',
        ]),
      ];
      ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 30 }];
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Test Tag Items');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filenameSite = site ? site.replace(/[^a-z0-9]+/gi, '_') : 'all-sites';
    const filenameSuffix = resultFilter === 'fail' ? '-fails-only' : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="test-tag-register-${filenameSite}${filenameSuffix}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// POST /api/register/import?site=xxx
// Parses the real template: row 1 = site name (used if ?site= isn't supplied),
// row 2 = subtitle, row 3 = headers matching TEMPLATE_HEADERS, then data rows.
// Falls back to treating row 1 as the header row if that shape isn't detected.
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file).' });

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames.find((n) => /test.*tag/i.test(n)) || wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    if (aoa.length === 0) return res.status(400).json({ error: 'Sheet is empty.' });

    const normHeader = (v) => (v || '').toString().trim().toLowerCase();
    let headerRowIdx = aoa.findIndex((row) => row.some((cell) => normHeader(cell) === 'plant no.' || normHeader(cell) === 'plant no'));
    if (headerRowIdx === -1) headerRowIdx = 0;

    const headerRow = aoa[headerRowIdx].map((h) => normHeader(h));
    const colIdx = (...names) => {
      for (const n of names) {
        const i = headerRow.indexOf(n);
        if (i !== -1) return i;
      }
      return -1;
    };

    const idx = {
      location: colIdx('location'),
      appliance: colIdx('appliance'),
      plant_no: colIdx('plant no.', 'plant no'),
      brand: colIdx('brand', 'brand '.trim()),
      model_no: colIdx('model no.', 'model no'),
      serial_no: colIdx('serial no.', 'serial no'),
      result: colIdx('pass/fail'),
      tag_no: colIdx('tag no.', 'tag no'),
      test_date: colIdx('test date'),
      next_due: colIdx('next due'),
      notes: colIdx('notes'),
    };

    const site = (req.query.site || '').trim() || (aoa[0] && aoa[0][0] ? String(aoa[0][0]).trim() : null);
    if (!site) return res.status(400).json({ error: 'Could not determine site - pass ?site=SiteName or ensure row 1 has the site name.' });
    await pool.query('INSERT INTO sites (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING', [site]);

    const dataRows = aoa.slice(headerRowIdx + 1).filter((row) => row.some((c) => c !== null && c !== ''));

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const row of dataRows) {
      const plant_no = idx.plant_no !== -1 ? row[idx.plant_no] : null;
      const location = idx.location !== -1 ? row[idx.location] : null;
      const appliance = idx.appliance !== -1 ? row[idx.appliance] : null;
      if (!appliance && !plant_no) {
        skipped++;
        continue;
      }
      try {
        const upsert = await pool.query(
          `
          INSERT INTO assets (site, location, appliance, plant_no, brand, model_no, serial_no, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (LOWER(site), LOWER(COALESCE(location, '')), LOWER(plant_no)) WHERE plant_no IS NOT NULL
          DO UPDATE SET
            appliance = COALESCE(EXCLUDED.appliance, assets.appliance),
            brand = COALESCE(EXCLUDED.brand, assets.brand),
            model_no = COALESCE(EXCLUDED.model_no, assets.model_no),
            serial_no = COALESCE(EXCLUDED.serial_no, assets.serial_no),
            notes = COALESCE(EXCLUDED.notes, assets.notes),
            updated_at = now()
          RETURNING id
          `,
          [
            site,
            location ? String(location) : null,
            appliance ? String(appliance) : null,
            plant_no !== null && plant_no !== undefined ? String(plant_no) : null,
            idx.brand !== -1 ? row[idx.brand] : null,
            idx.model_no !== -1 ? row[idx.model_no] : null,
            idx.serial_no !== -1 ? row[idx.serial_no] : null,
            idx.notes !== -1 ? row[idx.notes] : null,
          ]
        );
        const assetId = upsert.rows[0].id;

        const result = idx.result !== -1 ? String(row[idx.result] || '').trim().toLowerCase() : null;
        if (result === 'pass' || result === 'fail') {
          const toDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v || null);
          await pool.query(
            `
            INSERT INTO test_records (asset_id, tag_no, result, test_date, next_due, notes)
            VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [
              assetId,
              idx.tag_no !== -1 ? row[idx.tag_no] : null,
              result,
              idx.test_date !== -1 ? toDate(row[idx.test_date]) : null,
              idx.next_due !== -1 ? toDate(row[idx.next_due]) : null,
              idx.notes !== -1 ? row[idx.notes] : null,
            ]
          );
        }
        imported++;
      } catch (rowErr) {
        errors.push({ row: row.slice(0, 4), error: rowErr.message });
      }
    }

    res.json({ site, imported, skipped, errorCount: errors.length, errors: errors.slice(0, 20) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Import failed - check the file is a valid .xlsx or .csv.' });
  }
});

module.exports = router;
