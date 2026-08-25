const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/assets/sites - distinct site names, for the site picker
router.get('/sites', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT site FROM assets ORDER BY site ASC');
    res.json(rows.map((r) => r.site));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sites.' });
  }
});

// GET /api/assets?site=xxx&search=xxx - list/search register, latest test joined
router.get('/', async (req, res) => {
  try {
    const site = (req.query.site || '').trim();
    const search = (req.query.search || '').trim();
    const params = [];
    const clauses = [];

    if (site) {
      params.push(site);
      clauses.push(`a.site = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      clauses.push(`(a.plant_no ILIKE $${params.length} OR a.appliance ILIKE $${params.length} OR a.location ILIKE $${params.length} OR a.serial_no ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `
      SELECT a.*,
        t.tag_no AS last_tag_no,
        t.test_date AS last_test_date,
        t.result AS last_result,
        t.next_due AS last_next_due,
        t.tester_name AS last_tester_name
      FROM assets a
      LEFT JOIN LATERAL (
        SELECT * FROM test_records tr
        WHERE tr.asset_id = a.id
        ORDER BY tr.test_date DESC NULLS LAST, tr.created_at DESC
        LIMIT 1
      ) t ON true
      ${where}
      ORDER BY a.site ASC, a.location ASC, a.plant_no ASC
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load register.' });
  }
});

// GET /api/assets/by-tag/:tagNo - primary scan lookup: find the asset that a given
// test tag number was most recently attached to.
router.get('/by-tag/:tagNo', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT a.*, t.* , t.id AS test_record_id
      FROM test_records t
      JOIN assets a ON a.id = t.asset_id
      WHERE t.tag_no = $1
      ORDER BY t.test_date DESC NULLS LAST, t.created_at DESC
      LIMIT 1
      `,
      [req.params.tagNo]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const assetId = rows[0].asset_id;
    const history = await pool.query(
      'SELECT * FROM test_records WHERE asset_id = $1 ORDER BY test_date DESC NULLS LAST, created_at DESC',
      [assetId]
    );
    const asset = await pool.query('SELECT * FROM assets WHERE id = $1', [assetId]);
    res.json({ asset: asset.rows[0], history: history.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// GET /api/assets/match?site=&location=&plant_no=&serial_no= - fallback lookup when
// no tag number was read (e.g. first-ever test, or an untagged item), matching on
// site+location+plant number, or serial number as a secondary match.
router.get('/match', async (req, res) => {
  try {
    const { site, location, plant_no, serial_no } = req.query;
    let rows = [];
    if (site && plant_no) {
      const r = await pool.query(
        'SELECT * FROM assets WHERE site = $1 AND COALESCE(location, \'\') = COALESCE($2, \'\') AND plant_no = $3',
        [site, location || null, plant_no]
      );
      rows = r.rows;
    }
    if (rows.length === 0 && serial_no) {
      const r = await pool.query('SELECT * FROM assets WHERE serial_no = $1', [serial_no]);
      rows = r.rows;
    }
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const asset = rows[0];
    const history = await pool.query(
      'SELECT * FROM test_records WHERE asset_id = $1 ORDER BY test_date DESC NULLS LAST, created_at DESC',
      [asset.id]
    );
    res.json({ asset, history: history.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// POST /api/assets - create new asset, or update if site+location+plant_no already exists
router.post('/', async (req, res) => {
  try {
    const { site, location, appliance, plant_no, brand, model_no, serial_no, notes } = req.body;
    if (!site) return res.status(400).json({ error: 'site is required.' });

    let existing = null;
    if (plant_no) {
      const r = await pool.query(
        'SELECT * FROM assets WHERE site = $1 AND COALESCE(location, \'\') = COALESCE($2, \'\') AND plant_no = $3',
        [site, location || null, plant_no]
      );
      existing = r.rows[0] || null;
    }

    let result;
    if (existing) {
      result = await pool.query(
        `
        UPDATE assets SET
          appliance = COALESCE($1, appliance),
          brand = COALESCE($2, brand),
          model_no = COALESCE($3, model_no),
          serial_no = COALESCE($4, serial_no),
          notes = COALESCE($5, notes),
          updated_at = now()
        WHERE id = $6
        RETURNING *
        `,
        [appliance, brand, model_no, serial_no, notes, existing.id]
      );
    } else {
      result = await pool.query(
        `
        INSERT INTO assets (site, location, appliance, plant_no, brand, model_no, serial_no, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        `,
        [site, location || null, appliance, plant_no || null, brand, model_no, serial_no, notes]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save asset.' });
  }
});

// POST /api/assets/:id/tests - log a new test result (a fresh tag is normally applied each cycle)
router.post('/:id/tests', async (req, res) => {
  try {
    const { tag_no, test_date, next_due, tester_name, tester_licence, result, notes } = req.body;
    if (!result || !['pass', 'fail'].includes(result)) {
      return res.status(400).json({ error: 'result must be "pass" or "fail".' });
    }
    const { rows } = await pool.query(
      `
      INSERT INTO test_records (asset_id, tag_no, test_date, next_due, tester_name, tester_licence, result, notes)
      VALUES ($1,$2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [req.params.id, tag_no || null, test_date || null, next_due || null, tester_name, tester_licence, result, notes]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log test.' });
  }
});

module.exports = router;
