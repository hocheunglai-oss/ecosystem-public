import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('backup privacy route stays public without opening similarly named application routes', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const fallback = config.rewrites.find((rule: any) => rule.destination === '/index.html');
  assert.ok(fallback);
  const route = new RegExp(`^${fallback.source}$`);
  for (const path of ['/backup-privacy.html', '/privacy.html', '/api/backup/storage-downloads']) {
    assert.equal(route.test(path), false, path);
  }
  for (const path of ['/backup-privacy.html-extra', '/backup-privacy', '/backup-privacy.html/extra', '/workspace/enquiries']) {
    assert.equal(route.test(path), true, path);
  }
});

test('backup notice remains a passive standalone document without private deployment configuration', async () => {
  const html = await readFile(new URL('../public/backup-privacy.html', import.meta.url), 'utf8');
  assert.match(html, /<h1>ECO Nightly Backups<\/h1>/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|\bon\w+=|https?:\/\/|\/api\//i);
  assert.doesNotMatch(html, /cosulichuno@gmail|cucfyycoklddufdluahi|age1[a-z0-9]{20}|BEGIN .* KEY|client_secret/i);
  assert.match(html, /href="mailto:otto@cosulich\.com\.hk"/);
  assert.match(html, /does not confirm that scheduled backups are active/);
  const original = await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8');
  assert.equal(html.match(/<style>([\s\S]*?)<\/style>/)?.[1], original.match(/<style>([\s\S]*?)<\/style>/)?.[1]);
});
