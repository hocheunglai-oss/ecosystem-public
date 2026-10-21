import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pdfPreviewAssetPath } from './pdf-preview-assets.mjs';

// Reports contain locations and rule identifiers, never matched text or secret values.
const credentialPatterns = [
  ['supabase-secret-key', /\bsb_secret_[A-Za-z0-9_-]{15,}/],
  ['supabase-access-token', /\bsbp_[A-Za-z0-9]{20,}/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['openai-key', /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}/],
];
const secretEnvironmentNames = [
  'ECO_SUPABASE_SECRET_KEY', 'ECO_RATE_LIMIT_SECRET', 'ECO_MONITOR_INGEST_SECRET', 'ECO_DATABASE_PASSWORD', 'ECO_NEW_USER_PASSWORD',
  'SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN', 'OPENAI_API_KEY',
];
const textExtensions = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.svg', '.map']);
const forbiddenParts = new Set(['.git', '.vercel', 'server', 'supabase', 'output', 'node_modules']);

export function credentialFindings(content, environment = {}) {
  const rules = credentialPatterns.filter(([, pattern]) => pattern.test(content)).map(([rule]) => rule);
  for (const name of secretEnvironmentNames) {
    const value = environment[name];
    if (typeof value === 'string' && value.length >= (name === 'ECO_NEW_USER_PASSWORD' ? 8 : 12) && content.includes(value)) rules.push(`environment:${name}`);
  }
  for (const token of content.match(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
    try {
      if (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role === 'service_role') {
        rules.push('legacy-service-role-token');
        break;
      }
    } catch { /* Not a JWT; no content is printed. */ }
  }
  return [...new Set(rules)];
}

export async function inspectBuild(directory, budgets, environment = {}) {
  const metrics = { fileCount: 0, totalBuildBytes: 0, javaScriptGzipBytes: 0, coreJavaScriptGzipBytes: 0, optionalPdfJavaScriptGzipBytes: 0, optionalPdfAssetBytes: 0, cssGzipBytes: 0 };
  const findings = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = join(current, entry.name), name = relative(directory, file).split('\\').join('/');
      if (entry.isSymbolicLink()) { findings.push({ file: name, rule: 'build-symlink' }); continue; }
      if (forbiddenParts.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) || /\.private\./.test(entry.name)) {
        findings.push({ file: name, rule: 'private-build-path' });
      }
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      metrics.fileCount++;
      const fileBytes = (await stat(file)).size;
      metrics.totalBuildBytes += fileBytes;
      if (name.startsWith(pdfPreviewAssetPath)) metrics.optionalPdfAssetBytes += fileBytes;
      const extension = extname(entry.name);
      if (extension === '.map') findings.push({ file: name, rule: 'public-source-map' });
      if (!textExtensions.has(extension)) continue;
      const bytes = await readFile(file);
      for (const rule of credentialFindings(bytes.toString('utf8'), environment)) findings.push({ file: name, rule });
      if (extension === '.js' || extension === '.mjs') {
        const size = gzipSync(bytes, { level: 9 }).length;
        metrics.javaScriptGzipBytes += size;
        // The pinned PDF renderer/worker/decoders are requested only on preview.
        // They remain scanned above and counted in total bytes; the core ceiling
        // stays unchanged instead of being increased for an optional reader.
        if (name.startsWith(pdfPreviewAssetPath) && /^(?:pdf(?:\.worker)?\.min\.mjs|wasm\/(?:jbig2|openjpeg)_nowasm_fallback\.js)$/.test(name.slice(pdfPreviewAssetPath.length))) metrics.optionalPdfJavaScriptGzipBytes += size;
        else metrics.coreJavaScriptGzipBytes += size;
      }
      if (extension === '.css') metrics.cssGzipBytes += gzipSync(bytes, { level: 9 }).length;
    }
  }
  await walk(directory);
  if (!(await stat(join(directory, 'index.html'))).isFile()) throw new Error('Missing build entry');
  for (const [metric, limit] of [
    ['coreJavaScriptGzipBytes', 'maxJavaScriptGzipBytes'], ['cssGzipBytes', 'maxCssGzipBytes'], ['totalBuildBytes', 'maxTotalBuildBytes'],
  ]) {
    if (!Number.isSafeInteger(budgets[limit]) || budgets[limit] <= 0) throw new Error('Invalid build budget');
    if (metrics[metric] > budgets[limit]) findings.push({ file: 'dist', rule: `budget:${metric === 'coreJavaScriptGzipBytes' ? 'javaScriptGzipBytes' : metric}` });
  }
  const optionalLimit = budgets.maxOptionalPdfJavaScriptGzipBytes ?? 0;
  if (!Number.isSafeInteger(optionalLimit) || optionalLimit < 0) throw new Error('Invalid optional PDF budget');
  if (metrics.optionalPdfJavaScriptGzipBytes > optionalLimit) findings.push({ file: 'dist', rule: 'budget:optionalPdfJavaScriptGzipBytes' });
  const optionalAssetsLimit = budgets.maxOptionalPdfAssetBytes ?? 0;
  if (!Number.isSafeInteger(optionalAssetsLimit) || optionalAssetsLimit < 0) throw new Error('Invalid optional PDF assets budget');
  if (metrics.optionalPdfAssetBytes > optionalAssetsLimit) findings.push({ file: 'dist', rule: 'budget:optionalPdfAssetBytes' });
  return { metrics, findings };
}

async function main() {
  const budgets = JSON.parse(await readFile(new URL('../config/build-budgets.json', import.meta.url), 'utf8'));
  const report = await inspectBuild(resolve('dist'), budgets, process.env);
  await mkdir('output/security', { recursive: true, mode: 0o700 });
  await writeFile('output/security/build-check.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (report.findings.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Build verification could not complete. No passing result was recorded.'); process.exitCode = 1; });
}
