import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

export function inventoryComponents(roots) {
  const components = new Map();
  function visit(node, development = false) {
    for (const group of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, detail] of Object.entries(node[group] ?? {})) {
        if (typeof detail.version !== 'string' || !detail.version) throw new Error('Unresolved dependency');
        const version = detail.version, id = `pkg:npm/${name.replace(/^@/, '%40')}@${encodeURIComponent(version)}`;
        const dev = development || group === 'devDependencies';
        const existing = components.get(id);
        if (!existing || !dev) components.set(id, {
          type: 'library', name, version, 'bom-ref': id, purl: id,
          properties: [{ name: 'eco:dependency-scope', value: dev ? 'development' : 'runtime' }],
        });
        visit(detail, dev);
      }
    }
  }
  for (const root of roots) visit(root);
  return [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
}

async function main() {
  const { stdout } = await exec('pnpm', ['list', '--json', '--depth', 'Infinity'], { maxBuffer: 32 * 1024 * 1024 });
  const components = inventoryComponents(JSON.parse(stdout));
  if (!components.length) throw new Error('No resolved dependencies');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lockHash = createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex');
  const inventory = {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json', bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', name: manifest.name, version: manifest.version },
      properties: [{ name: 'eco:pnpm-lock-sha256', value: lockHash }, { name: 'eco:coverage', value: 'Resolved npm dependency graph reported by pnpm, including optional packages. Excludes managed infrastructure and operating-system images; not proof that every component is loaded at runtime.' }],
    },
    components,
  };
  await mkdir('output/security', { recursive: true, mode: 0o700 });
  await writeFile('output/security/dependencies.cdx.json', `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  console.log(`Recorded ${components.length} resolved dependency versions; lockfile SHA-256 ${lockHash}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Dependency inventory could not complete. No passing result was recorded.'); process.exitCode = 1; });
}
