import { readFile, readdir } from 'node:fs/promises';

/** Fresh isolated test databases use the clean bootstrap, then append-only migrations. */
export async function readSchemaMigrations() {
  const entries = [];
  const baseline = new URL('../../supabase/baseline/schema.sql', import.meta.url);
  try {
    const sections = (await readFile(baseline, 'utf8')).split(/^-- BOOTSTRAP SECTION [^\n]+\.sql\n/m);
    for (const [index, sql] of sections.entries()) {
      if (sql.trim()) entries.push({ name: `bootstrap-${index}.sql`, sql });
    }
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const migrations = new URL('../../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    entries.push({ name, sql: await readFile(new URL(name, migrations), 'utf8') });
  }
  return entries;
}

export async function applySchemaMigrations(query) {
  const entries = await readSchemaMigrations();
  for (const entry of entries) await query(entry.sql);
  return entries.filter(entry => /^\d{14}_/.test(entry.name)).map(entry => entry.name);
}
