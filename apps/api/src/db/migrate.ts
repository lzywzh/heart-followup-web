import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';

export async function migrate(db: Database) {
  const directory = new URL('../../../../database/migrations/', import.meta.url);
  const files = (await readdir(fileURLToPath(directory))).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || current_schema() || ':heart_v2_migration'))");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const version = file.slice(0,4);
      if (!(await tx.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version])).rowCount) {
        await tx.query(await readFile(new URL(file, directory),'utf8'));
        await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
      }
    }
  });
}
