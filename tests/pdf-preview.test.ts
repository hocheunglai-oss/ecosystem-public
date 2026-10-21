import test from 'node:test';
import assert from 'node:assert/strict';
import { isPdfAttachment, pdfRenderSize, PDF_MAX_PIXELS } from '../src/lib/pdfPreview';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Plain JavaScript build checker is also used by Node CI.
import { inspectBuild } from '../scripts/check-build-security.mjs';
import config from '../config/pdf-preview.json';

test('PDF identification handles missing browser MIME without treating arbitrary extensions as PDFs', () => {
  assert.equal(isPdfAttachment('application/pdf', 'report'), true);
  assert.equal(isPdfAttachment('APPLICATION/PDF; x=1', 'report'), true);
  assert.equal(isPdfAttachment('application/octet-stream', 'report.PDF'), true);
  assert.equal(isPdfAttachment('text/plain', 'report.pdf.txt'), false);
  assert.equal(isPdfAttachment('application/x-pdf', 'notes'), false);
});
test('PDF fits narrow widths and keeps high zoom render memory bounded', () => {
  const phone = pdfRenderSize(612, 792, 270, 1, 3);
  assert.equal(phone.width, 270);
  assert.equal(phone.pixelRatio, 2);
  const large = pdfRenderSize(612, 792, 5000, 3, 3);
  assert.ok(large.width * large.height * large.pixelRatio ** 2 <= PDF_MAX_PIXELS + 1);
  assert.equal(pdfRenderSize(612, 792, 270, 99, 2).width, 810);
  assert.ok(pdfRenderSize(612, 792, 0, .5, 1).width > 0);
});
test('optional PDF budget remains scanned and cannot exclude arbitrary JavaScript or change core ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-pdf-budget-'));
  const budgets = { maxJavaScriptGzipBytes: 1000, maxOptionalPdfJavaScriptGzipBytes: 1000, maxOptionalPdfAssetBytes: 1000, maxCssGzipBytes: 1000, maxTotalBuildBytes: 10000 };
  try {
    await writeFile(join(root, 'index.html'), '<html></html>');
    await mkdir(join(root, config.assetPath), { recursive: true });
    await writeFile(join(root, config.assetPath, 'pdf.min.mjs'), 'export const document=true;');
    let report = await inspectBuild(root, budgets);
    assert.equal(report.metrics.coreJavaScriptGzipBytes, 0);
    assert.ok(report.metrics.optionalPdfJavaScriptGzipBytes > 0);
    report = await inspectBuild(root, { ...budgets, maxOptionalPdfJavaScriptGzipBytes: 1 });
    assert.ok(report.findings.some((item: { rule: string }) => item.rule === 'budget:optionalPdfJavaScriptGzipBytes'));
    report = await inspectBuild(root, { ...budgets, maxOptionalPdfAssetBytes: 1 });
    assert.ok(report.findings.some((item: { rule: string }) => item.rule === 'budget:optionalPdfAssetBytes'));
    await writeFile(join(root, config.assetPath, 'unrelated.js'), 'export const application=true;');
    report = await inspectBuild(root, { ...budgets, maxJavaScriptGzipBytes: 1 });
    assert.ok(report.findings.some((item: { rule: string }) => item.rule === 'budget:javaScriptGzipBytes'));
    await writeFile(join(root, config.assetPath, 'pdf.min.mjs'), `const secret='sb_secret_${'fixture'.repeat(6)}';`);
    report = await inspectBuild(root, budgets);
    assert.ok(report.findings.some((item: { rule: string }) => item.rule === 'supabase-secret-key'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
