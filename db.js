const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// AS/NZS 3760 retest intervals by environment category, in months. These are
// commonly-used defaults - always editable per-test, never enforced as a hard rule.
const RETEST_INTERVALS_MONTHS = {
  construction: 3,
  hostile: 3,
  commercial_kitchen: 6,
  factory_workshop: 6,
  office_low_risk: 60,
  other: 12,
};

// Creates all tables if they don't exist yet. Safe to call on every boot.
// Schema matches the real Test & Tag Items sheet structure (Holy Spirit Primary register):
// Site > Location > Appliance, with a Plant No. that repeats across locations (NOT globally
// unique) and a Tag No. that is the physical sticker attached at each test cycle.
async function initDb() {
  // Lightweight sites registry - kept alongside assets.site (a plain text column,
  // still the source of truth for now) so the app has a clean list to autocomplete
  // and rename from. If/when this merges into TouchTrace's upcoming Sites feature,
  // this table is the natural handoff point rather than a fresh migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_name_lower ON sites (LOWER(name));`);
  // Client Name remembered per site (e.g. "Holy Spirit Catholic Primary School" for whichever
  // site that school is), so a technician only has to type it once per site -- the Scan tab
  // auto-fills it from here on later visits. Older deployments won't have this column yet.
  await pool.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS client_name TEXT;`);

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
      environment_category TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Older deployments won't have this column yet - add it if missing.
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS environment_category TEXT;`);
  // Client Name (who the report is for, e.g. school/business) and Job Number (a per-visit
  // job reference, used exactly like Site as an alternate grouping for reports/exports) -
  // both entered on the Scan tab alongside Site/Location.
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS client_name TEXT;`);
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS job_number TEXT;`);

  // A given plant number only needs to be unique within the same site+location
  // (e.g. Plant No. 3 can be "Fridge 1" in the Tuckshop AND "Microwave" in the
  // Staff kitchen - both are valid, distinct assets). Matched case-insensitively.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_site_location_plant
    ON assets (LOWER(site), LOWER(COALESCE(location, '')), LOWER(plant_no))
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
      photo BYTEA,
      photo_media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE test_records ADD COLUMN IF NOT EXISTS photo BYTEA;`);
  await pool.query(`ALTER TABLE test_records ADD COLUMN IF NOT EXISTS photo_media_type TEXT;`);
  await pool.query(`ALTER TABLE test_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_records_asset_id ON test_records(asset_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_records_tag_no ON test_records(tag_no);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_site ON assets(site);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_serial_no ON assets(serial_no);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_job_number ON assets(job_number);`);

  console.log('Database schema ready (sites, assets, test_records).');
}

module.exports = { pool, initDb, RETEST_INTERVALS_MONTHS };
