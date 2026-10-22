import { config } from 'dotenv';
import { createDatabase } from './database.js';
import { migrate } from './migrate.js';
config({ quiet: true });
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const db = createDatabase(url);
try {
  await migrate(db);
  const exists = await db.query("SELECT 1 FROM pg_roles WHERE rolname='hf_v2_app'");
  if (exists.rowCount) {
    await db.query('GRANT USAGE ON SCHEMA public TO hf_v2_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO hf_v2_app');
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO hf_v2_app');
  }
  console.log('Database migrations applied.');
} finally { await db.close(); }
