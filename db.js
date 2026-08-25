const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// Creates all tables if they don't exist yet. Safe to call on every boot.
// Schema matches the real Test & Tag Items sheet structure (Holy Spirit Primary register):
// Site > Location > Appliance, with a Plant No. that repeats across locations (NOT globally
// unique) and a Tag No. that is the physical sticker attached at each test cycle.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      site TEXT NOT NULL,
      location TEXT,
      appliance TEXT,
      plant_no TEXT,
      brand TEXT,
      model_no TEXT,
      serial_no TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // A given plant number only needs to be unique within the same site+location
  // (e.g. Plant No. 3 can be "Fridge 1" in the Tuckshop AND "Microwave" in the
  // Staff kitchen - both are valid, distinct assets).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_site_location_plant
    ON assets (site, COALESCE(location, ''), plant_no)
    WHERE plant_no IS NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_records (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      tag_no TEXT,
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
      test_date DATE,
      next_due DATE,
      tester_name TEXT,
      tester_licence TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_records_asset_id ON test_records(asset_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_records_tag_no ON test_records(tag_no);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_site ON assets(site);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_serial_no ON assets(serial_no);`);

  console.log('Database schema ready (assets, test_records).');
}

module.exports = { pool, initDb };
