import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ecoConnections } from '../config/ecoConnections.ts';

test('public privacy notice bypasses the SPA only on its exact static path', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const fallback = config.rewrites.find((rule: any) => rule.destination === '/index.html');
  assert.ok(fallback);
  const route = new RegExp(`^${fallback.source}$`);
  assert.equal(route.test('/privacy.html'), false);
  for (const path of ['/privacy.html-extra', '/private-profile', '/privacy', '/workspace/enquiries']) {
    assert.equal(route.test(path), true, path);
  }
  assert.equal(route.test('/api/enquiries/inbox'), false);
});

test('public privacy notice provides individual rights and contact without internal operational details', async () => {
  const html = await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8');
  assert.ok(!html.includes(ecoConnections.whatsappReceiver.displayPhoneNumber));
  assert.match(html, /href="mailto:otto@cosulich\.com\.hk"/);
  assert.match(html, /does not automatically send it to AI/);
  assert.doesNotMatch(html, /Vercel|Supabase|Singapore|fingerprint|eligible ECO account|parser report|routing/i);
  assert.match(html, /personal data access or correction requests/i);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|\bon\w+=|https?:\/\/|\/api\//i);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /text-transform:none/);
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /!session && <a[^>]*href="\/privacy\.html">Privacy<\/a>/);
});
