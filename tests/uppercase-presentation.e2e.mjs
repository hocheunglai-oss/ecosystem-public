import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, webkit } from '@playwright/test';
import TextWithLinks from '../src/TextWithLinks.tsx';

// Run with `node --import tsx tests/uppercase-presentation.e2e.mjs`.
// The real stylesheet and content renderer must distinguish values from actions.
const stylesheet = await readFile(new URL('../src/uppercase.css', import.meta.url), 'utf8');
const url = 'https://Example.test/PortData?Key=AbC#Latest';
const email = 'Desk.Case@Example.test';
const prose = renderToStaticMarkup(createElement(TextWithLinks, { text: `Read ${url}.` }));
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme });
      try {
        const page = await context.newPage();
        await page.setContent(`<style>${stylesheet}</style><main id="root">
          <p id="prose">${prose}</p>
          <a id="open" href="${url}">Open link</a>
          <a id="download" href="blob:fixture"><span>Download</span></a>
          <a id="signin" href="/signin"><span>Sign in to FC UNO / SPC</span></a>
          <p data-preserve-case><span id="value">${url}</span></p>
          <p id="email" data-email-value>${email}</p>
          <input type="url" value="${url}"><input type="email" value="${email}">
        </main>`);
        const transform = selector => page.locator(selector).evaluate(node => getComputedStyle(node).textTransform);
        for (const selector of ['#open', '#download', '#download span', '#signin', '#signin span', '#prose']) {
          assert.equal(await transform(selector), 'uppercase', `${name}/${width}/${colorScheme}: action/prose ${selector}`);
        }
        for (const selector of ['#prose a', '#value', '#email', 'input']) {
          assert.ok((await page.locator(selector).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textTransform))).every(value => value === 'none'), `${name}/${width}/${colorScheme}: values ${selector}`);
        }
        assert.equal(await page.locator('#prose a').first().textContent(), url);
        assert.equal(await page.locator('#prose a').first().getAttribute('href'), url);
        assert.equal(await page.locator('#email').textContent(), email);
        console.log(`PASS ${name} ${width} ${colorScheme}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
