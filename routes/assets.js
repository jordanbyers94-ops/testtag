const express = require('express');
const router = express.Router();
const { pool, RETEST_INTERVALS_MONTHS } = require('../db');

function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ---------- Sites ----------

// GET /api/assets/sites - list of known sites (from the sites registry, falling
// back to distinct values already on assets for older rows created before a
// site was formally registered).
router.get('/sites', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT name FROM sites
      UNION
      SELECT DISTINCT site AS name FROM assets
      ORDER BY name ASC
    `);
    res.json(rows.map((r) => r.name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sites.' });
  }
});

// POST /api/assets/sites - register a new site explicitly (also happens implicitly
// whenever an asset is saved with a new site name).
router.post('/sites', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required.' });
    await pool.query('INSERT INTO sites (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING', [name.trim()]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save site.' });
  }
});

// PATCH /api/assets/sites/:oldName - rename/merge a site. Updates every asset
// under the old name (case-insensitive match) to the new name. Use this to fix
// spelling variants that crept in before the case-insensitive matching landed.
router.patch('/sites/:oldName', async (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName || !newName.trim()) return res.status(400).json({ error: 'newName is required.' });
    const oldName = req.params.oldName;

    await pool.query('UPDATE assets SET site = $1, updated_at = now() WHERE LOWER(site) = LOWER($2)', [newName.trim(), oldName]);
    await pool.query('DELETE FROM sites WHERE LOWER(name) = LOWER($1)', [oldName]);
    await pool.query('INSERT INTO sites (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING', [newName.trim()]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to rename site.' });
  }
});

// ---------- Register / list ----------

// GET /api/assets?site=&search=&result=fail&due=overdue|soon
router.get('/', async (req, res) => {
  try {
    const site = (req.query.site || '').trim();
    const search = (req.query.search || '').trim();
    const result = (req.query.result || '').trim(); // 'pass' | 'fail'
    const due = (req.query.due || '').trim(); // 'overdue' | 'soon'
    const params = [];
    const clauses = [];

    if (site) { params.push(site); clauses.push(`LOWER(a.site) = LOWER($${params.length})`); }
    if (search) {
      params.push(`%${search}%`);
      clauses.push(`(a.plant_no ILIKE $${params.length} OR a.appliance ILIKE $${params.length} OR a.location ILIKE $${params.length} OR a.serial_no ILIKE $${params.length})`);
    }

    const { rows } = await pool.query(
      `
      SELECT a.*,
        t.tag_no AS last_tag_no, t.test_date AS last_test_date, t.result AS last_result,
        t.next_due AS last_next_due, t.tester_name AS last_tester_name, t.id AS last_test_id,
        (t.photo IS NOT NULL) AS last_test_has_photo
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

    let filtered = rows;
    if (result === 'pass' || result === 'fail') filtered = filtered.filter((r) => r.last_result === result);
    if (due === 'overdue') {
      const today = new Date().toISOString().slice(0, 10);
      filtered = filtered.filter((r) => r.last_next_due && r.last_next_due.toISOString().slice(0, 10) < today);
    } else if (due === 'soon') {
      const today = new Date();
      const in30 = new Date(today.getTime() + 30 * 86400000);
      filtered = filtered.filter((r) => r.last_next_due && r.last_next_due >= today && r.last_next_due <= in30);
    }

    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load register.' });
  }
});

// GET /api/assets/due-summary - overdue/due-soon counts per site, for a quick
// "which sites need a visit" view.
router.get('/due-summary', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.site,
        COUNT(*) FILTER (WHERE t.next_due IS NOT NULL AND t.next_due < CURRENT_DATE) AS overdue,
        COUNT(*) FILTER (WHERE t.next_due IS NOT NULL AND t.next_due >= CURRENT_DATE AND t.next_due <= CURRENT_DATE + INTERVAL '30 days') AS due_soon,
        COUNT(*) FILTER (WHERE t.result = 'fail') AS fails,
        COUNT(*) AS total_assets
      FROM assets a
      LEFT JOIN LATERAL (
        SELECT * FROM test_records tr WHERE tr.asset_id = a.id
        ORDER BY tr.test_date DESC NULLS LAST, tr.created_at DESC LIMIT 1
      ) t ON true
      GROUP BY a.site
      ORDER BY overdue DESC, due_soon DESC, a.site ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load due summary.' });
  }
});

// GET /api/assets/by-tag/:tagNo
router.get('/by-tag/:tagNo', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT a.*, t.id AS test_record_id
      FROM test_records t
      JOIN assets a ON a.id = t.asset_id
      WHERE LOWER(t.tag_no) = LOWER($1)
      ORDER BY t.test_date DESC NULLS LAST, t.created_at DESC
      LIMIT 1
      `,
      [req.params.tagNo]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const assetId = rows[0].id;
    const history = await pool.query(
      'SELECT id, tag_no, result, test_date, next_due, tester_name, tester_licence, notes, (photo IS NOT NULL) AS has_photo, created_at FROM test_records WHERE asset_id = $1 ORDER BY test_date DESC NULLS LAST, created_at DESC',
      [assetId]
    );
    const asset = await pool.query('SELECT * FROM assets WHERE id = $1', [assetId]);
    res.json({ asset: asset.rows[0], history: history.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// GET /api/assets/match?site=&location=&plant_no=&serial_no=
router.get('/match', async (req, res) => {
  try {
    const { site, location, plant_no, serial_no } = req.query;
    let rows = [];
    if (site && plant_no) {
      const r = await pool.query(
        'SELECT * FROM assets WHERE LOWER(site) = LOWER($1) AND LOWER(COALESCE(location, \'\')) = LOWER(COALESCE($2, \'\')) AND LOWER(plant_no) = LOWER($3)',
        [site, location || null, plant_no]
      );
      rows = r.rows;
    }
    if (rows.length === 0 && serial_no) {
      const r = await pool.query('SELECT * FROM assets WHERE LOWER(serial_no) = LOWER($1)', [serial_no]);
      rows = r.rows;
    }
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const asset = rows[0];
    const history = await pool.query(
      'SELECT id, tag_no, result, test_date, next_due, tester_name, tester_licence, notes, (photo IS NOT NULL) AS has_photo, created_at FROM test_records WHERE asset_id = $1 ORDER BY test_date DESC NULLS LAST, created_at DESC',
      [asset.id]
    );
    res.json({ asset, history: history.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// GET /api/assets/:id/history - full test history for one asset (used by the
// register view's expand-to-edit UI)
router.get('/:id/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, tag_no, result, test_date, next_due, tester_name, tester_licence, notes, (photo IS NOT NULL) AS has_photo, created_at FROM test_records WHERE asset_id = $1 ORDER BY test_date DESC NULLS LAST, created_at DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load history.' });
  }
});

// POST /api/assets - create, or update if site+location+plant_no already exists
router.post('/', async (req, res) => {
  try {
    const { site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes } = req.body;
    if (!site) return res.status(400).json({ error: 'site is required.' });

    await pool.query('INSERT INTO sites (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING', [site]);

    let existing = null;
    if (plant_no) {
      const r = await pool.query(
        'SELECT * FROM assets WHERE LOWER(site) = LOWER($1) AND LOWER(COALESCE(location, \'\')) = LOWER(COALESCE($2, \'\')) AND LOWER(plant_no) = LOWER($3)',
        [site, location || null, plant_no]
      );
      existing = r.rows[0] || null;
    }

    let result;
    if (existing) {
      result = await pool.query(
        `
        UPDATE assets SET
          appliance = COALESCE($1, appliance), brand = COALESCE($2, brand), model_no = COALESCE($3, model_no),
          serial_no = COALESCE($4, serial_no), environment_category = COALESCE($5, environment_category),
          notes = COALESCE($6, notes), updated_at = now()
        WHERE id = $7 RETURNING *
        `,
        [appliance, brand, model_no, serial_no, environment_category, notes, existing.id]
      );
    } else {
      result = await pool.query(
        `
        INSERT INTO assets (site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `,
        [site, location || null, appliance, plant_no || null, brand, model_no, serial_no, environment_category || null, notes]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save asset.' });
  }
});

// POST /api/assets/:id/tests - log a new test result. Auto-fills next_due from the
// asset's environment_category if next_due isn't explicitly supplied. Accepts an
// optional base64 photo (same photo used for extraction) to archive against the record.
router.post('/:id/tests', async (req, res) => {
  try {
    const { tag_no, test_date, next_due, tester_name, tester_licence, result, notes, photo_base64, photo_media_type } = req.body;
    if (!result || !['pass', 'fail'].includes(result)) {
      return res.status(400).json({ error: 'result must be "pass" or "fail".' });
    }

    let finalNextDue = next_due || null;
    if (!finalNextDue) {
      const asset = await pool.query('SELECT environment_category FROM assets WHERE id = $1', [req.params.id]);
      const category = asset.rows[0] && asset.rows[0].environment_category;
      const months = RETEST_INTERVALS_MONTHS[category] || RETEST_INTERVALS_MONTHS.other;
      finalNextDue = addMonths(test_date || new Date().toISOString().slice(0, 10), months);
    }

    const photoBuffer = photo_base64 ? Buffer.from(photo_base64, 'base64') : null;

    const { rows } = await pool.query(
      `
      INSERT INTO test_records (asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, photo, photo_media_type)
      VALUES ($1,$2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, (photo IS NOT NULL) AS has_photo, created_at
      `,
      [req.params.id, tag_no || null, test_date || null, finalNextDue, tester_name, tester_licence, result, notes, photoBuffer, photo_media_type || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log test.' });
  }
});

// PATCH /api/assets/:id/tests/:testId - correct a test record
router.patch('/:id/tests/:testId', async (req, res) => {
  try {
    const { tag_no, test_date, next_due, tester_name, tester_licence, result, notes } = req.body;
    if (result && !['pass', 'fail'].includes(result)) {
      return res.status(400).json({ error: 'result must be "pass" or "fail".' });
    }
    const { rows } = await pool.query(
      `
      UPDATE test_records SET
        tag_no = COALESCE($1, tag_no), test_date = COALESCE($2, test_date), next_due = COALESCE($3, next_due),
        tester_name = COALESCE($4, tester_name), tester_licence = COALESCE($5, tester_licence),
        result = COALESCE($6, result), notes = COALESCE($7, notes), updated_at = now()
      WHERE id = $8 AND asset_id = $9
      RETURNING id, asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes, (photo IS NOT NULL) AS has_photo, created_at
      `,
      [tag_no, test_date, next_due, tester_name, tester_licence, result, notes, req.params.testId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Test record not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update test.' });
  }
});

// DELETE /api/assets/:id/tests/:testId
router.delete('/:id/tests/:testId', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM test_records WHERE id = $1 AND asset_id = $2', [req.params.testId, req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Test record not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete test.' });
  }
});

// GET /api/assets/tests/:testId/photo - serve the archived photo for a test record
router.get('/tests/:testId/photo', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT photo, photo_media_type FROM test_records WHERE id = $1', [req.params.testId]);
    if (rows.length === 0 || !rows[0].photo) return res.status(404).send('No photo');
    res.setHeader('Content-Type', rows[0].photo_media_type || 'image/jpeg');
    res.send(rows[0].photo);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load photo');
  }
});

module.exports = router;
