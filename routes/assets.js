const express = require('express');
const router = express.Router();
const { pool, RETEST_INTERVALS_MONTHS } = require('../db');

function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Registers a site (if it isn't already known) and, when a client name is given, remembers it
// against that site -- overwriting whatever was remembered before, since a non-empty value here
// means the technician just typed/confirmed it for this visit. A blank/missing clientName never
// clears an already-remembered one (COALESCE keeps the existing value), so this is safe to call
// on every asset save without a client name field wiping out what's on file.
async function upsertSite(name, clientName) {
  await pool.query(
    `
    INSERT INTO sites (name, client_name) VALUES ($1, $2)
    ON CONFLICT (LOWER(name)) DO UPDATE SET client_name = COALESCE(EXCLUDED.client_name, sites.client_name)
    `,
    [name, clientName || null]
  );
}

// ---------- Sites ----------

// GET /api/assets/sites - known sites, each with whatever client name is remembered for it (the
// Scan tab uses this to auto-fill Client Name once a known Site is picked/typed). Falls back to
// distinct site values already on assets, for older rows created before a site was formally
// registered -- those just won't have a remembered client name yet, which is fine.
router.get('/sites', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT name, client_name FROM sites
      UNION
      SELECT DISTINCT site AS name, NULL AS client_name FROM assets
        WHERE LOWER(site) NOT IN (SELECT LOWER(name) FROM sites)
      ORDER BY name ASC
    `);
    res.json(rows.map((r) => ({ name: r.name, client_name: r.client_name || null })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sites.' });
  }
});

// POST /api/assets/sites - register a new site explicitly (also happens implicitly
// whenever an asset is saved with a new site name), optionally remembering its client name.
router.post('/sites', async (req, res) => {
  try {
    const { name, client_name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required.' });
    await upsertSite(name.trim(), client_name ? client_name.trim() : null);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save site.' });
  }
});

// PATCH /api/assets/sites/:oldName - rename/merge a site. Updates every asset
// under the old name (case-insensitive match) to the new name. Use this to fix
// spelling variants that crept in before the case-insensitive matching landed.
// Carries over whatever client name was remembered under the old name.
router.patch('/sites/:oldName', async (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName || !newName.trim()) return res.status(400).json({ error: 'newName is required.' });
    const oldName = req.params.oldName;

    const existing = await pool.query('SELECT client_name FROM sites WHERE LOWER(name) = LOWER($1)', [oldName]);
    const carriedClientName = existing.rows[0] ? existing.rows[0].client_name : null;

    await pool.query('UPDATE assets SET site = $1, updated_at = now() WHERE LOWER(site) = LOWER($2)', [newName.trim(), oldName]);
    await pool.query('DELETE FROM sites WHERE LOWER(name) = LOWER($1)', [oldName]);
    await upsertSite(newName.trim(), carriedClientName);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to rename site.' });
  }
});

// ---------- Register / list ----------

// GET /api/assets?site=&search=&result=fail&due=overdue|soon
// "search" is matched in JS after the query (not in SQL) so it can span both the asset's own
// fields AND its latest test's tag number (last_tag_no only exists after the lateral join,
// so it can't be filtered directly in the WHERE clause without a slower correlated subquery) --
// fine at this app's scale (a single business's register, not a multi-tenant one).
router.get('/', async (req, res) => {
  try {
    const site = (req.query.site || '').trim();
    const jobNumber = (req.query.job_number || '').trim();
    const search = (req.query.search || '').trim().toLowerCase();
    const result = (req.query.result || '').trim(); // 'pass' | 'fail'
    const due = (req.query.due || '').trim(); // 'overdue' | 'soon'
    const params = [];
    const clauses = [];

    if (site) { params.push(site); clauses.push(`LOWER(a.site) = LOWER($${params.length})`); }
    if (jobNumber) { params.push(jobNumber); clauses.push(`LOWER(a.job_number) = LOWER($${params.length})`); }

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
    if (search) {
      filtered = filtered.filter((r) => {
        const haystack = [r.appliance, r.plant_no, r.location, r.serial_no, r.brand, r.last_tag_no, r.job_number, r.client_name]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(search);
      });
    }
    if (['pass', 'fail', 'repairable'].includes(result)) filtered = filtered.filter((r) => r.last_result === result);
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
        COUNT(*) FILTER (WHERE t.result = 'repairable') AS repairable,
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

// GET /api/assets/:id - one asset's own details (used by the register's "Log New Test"
// quick action to prefill a retest without re-entering site/location/appliance).
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load asset.' });
  }
});

// PATCH /api/assets/:id - edit an existing asset's own details directly. Unlike POST /
// (which upserts by site+location+plant_no during the photo-scan flow), this only ever
// touches the one asset given by :id -- used by the register's "Edit Item" action to fix
// a mistaken entry (wrong plant no., misspelled site, etc.) after the fact.
router.patch('/:id', async (req, res) => {
  try {
    const { site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number } = req.body;
    if (!site || !site.trim()) return res.status(400).json({ error: 'site is required.' });

    await upsertSite(site.trim(), client_name ? client_name.trim() : null);

    const { rows } = await pool.query(
      `
      UPDATE assets SET
        site = $1, location = $2, appliance = $3, plant_no = $4,
        brand = $5, model_no = $6, serial_no = $7, environment_category = $8, notes = $9,
        client_name = $10, job_number = $11,
        updated_at = now()
      WHERE id = $12 RETURNING *
      `,
      [site.trim(), location || null, appliance || null, plant_no || null, brand || null,
        model_no || null, serial_no || null, environment_category || null, notes || null,
        client_name || null, job_number || null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Asset not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'Another item at that site/location already has that plant no.' });
    res.status(500).json({ error: 'Failed to update asset.' });
  }
});

// DELETE /api/assets/:id - permanently remove an asset AND its whole test history/photos
// (test_records cascades via its foreign key). For fixing a mistaken entry (duplicate,
// wrong site, entered in error) -- for undoing a single bad test result, use
// DELETE /:id/tests/:testId instead, which keeps the asset and its other tests.
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Asset not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete asset.' });
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
    const { site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number } = req.body;
    if (!site) return res.status(400).json({ error: 'site is required.' });

    await upsertSite(site, client_name ? String(client_name).trim() : null);

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
          notes = COALESCE($6, notes), client_name = COALESCE($7, client_name), job_number = COALESCE($8, job_number),
          updated_at = now()
        WHERE id = $9 RETURNING *
        `,
        [appliance, brand, model_no, serial_no, environment_category, notes, client_name || null, job_number || null, existing.id]
      );
    } else {
      result = await pool.query(
        `
        INSERT INTO assets (site, location, appliance, plant_no, brand, model_no, serial_no, environment_category, notes, client_name, job_number)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `,
        [site, location || null, appliance, plant_no || null, brand, model_no, serial_no, environment_category || null, notes, client_name || null, job_number || null]
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
    if (!result || !['pass', 'fail', 'repairable'].includes(result)) {
      return res.status(400).json({ error: 'result must be "pass", "fail", or "repairable".' });
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
    if (result && !['pass', 'fail', 'repairable'].includes(result)) {
      return res.status(400).json({ error: 'result must be "pass", "fail", or "repairable".' });
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
