import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { credentialFindings } from './check-build-security.mjs';

// Findings deliberately contain only paths and rule names, never matched values.
const root = resolve('.');
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
const privatePaths = /(?:^|\/)(?:output|artifacts|\.vercel|\.aws|\.env(?:\.[^/]+)?)(?:\/|$)|\.private\.|\.(?:pem|key|p12|pfx)$/i;
const privateSnapshots = new Set(['src/data/intelligence-snapshot.json', 'src/data/supplier-fixture-counts.json']);
const privateDocuments = /(?:^docs\/)(?:.*-release-\d|production-access|production-security|nis2-control|backup-recovery-status|intelligence-data|suppliers-release|email-receiver-operations|whatsapp-intake-operations)/;
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.yaml', '.yml', '.md', '.txt', '.sql', '.html', '.svg', '.toml']);
// The already-public privacy contact is intentional. No roster/routing email belongs elsewhere.
const publicContactFiles = new Set(['public/privacy.html', 'tests/privacy-page.test.ts', 'tests/privacy-page.e2e.mjs',
  'public/backup-privacy.html', 'tests/backup-privacy-page.e2e.mjs']);
const publicPrivacyContact = ['otto', 'cosulich.com.hk'].join('@');
for (const path of new Set(paths)) {
  const file = resolve(root, path);
  // Check parent directories as well as the leaf before opening any content.
  // A tracked child could otherwise follow an untracked replacement symlink.
  let current = root, info, linked = false;
  try {
    for (const part of path.split('/')) {
      current = resolve(current, part); info = lstatSync(current);
      if (info.isSymbolicLink()) { linked = true; break; }
    }
  } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (linked) { findings.push({ path, rule: 'source-symlink' }); continue; }
  if (!info?.isFile()) { findings.push({ path, rule: 'nonregular-source-file' }); continue; }
  if ((path !== '.env.example' && privatePaths.test(path)) || privateSnapshots.has(path) || privateDocuments.test(path)) findings.push({ path, rule: 'private-source-path' });
  if (path !== '.env.example' && !textExtensions.has(extname(path))) continue;
  const content = readFileSync(file, 'utf8');
  for (const rule of credentialFindings(content, process.env)) findings.push({ path, rule });
  const contacts = content.match(/[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)*cosulich\.com(?:\.hk)?\b/gi) ?? [];
  if (contacts.some(contact => !publicContactFiles.has(path) || contact.toLowerCase() !== publicPrivacyContact)) findings.push({ path, rule: 'private-directory-contact' });
}
console.log(JSON.stringify({ checkedFiles: new Set(paths).size, findings }));
if (findings.length) process.exitCode = 1;
