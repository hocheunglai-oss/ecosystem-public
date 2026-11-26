import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { chromium } from '@playwright/test';

const directory = new URL('../tools/eco-whatsapp-dispatcher/', import.meta.url);
const [background, whatsappPage] = await Promise.all(['background.js', 'whatsapp-page.js'].map(name => readFile(new URL(name, directory), 'utf8')));
const group = 'Test Group';
const text = 'Synthetic report\nECO-00000001';
const code = 'a'.repeat(43);
const chromeUrl = 'chrome-extension://synthetic/connect.html';
const waUrl = 'https://web.whatsapp.com/';
const job = { id: 'example-job', claimToken: 'example-claim', groupName: group, message: text };

function fakeWhatsApp({ duplicate, draft, pending }) {
  return `<!doctype html><meta charset="utf-8"><style>
    #side { float:left; width:300px } #main { margin-left:310px } [role=row] { margin:6px; padding:12px }
    [role=textbox] { min-height:26px; padding:4px; border:1px solid; white-space:pre-wrap }
    #toolbar { display:flex } #composer { flex:auto; } #send { width:55px }
  </style>
  <div id="side"><div aria-label="Search or start a new chat" contenteditable="true" role="textbox" id="search"></div>
    <div id="pane-side"><div role="row" id="exact" hidden><span dir="auto" title="${group}">${group}</span></div>
    ${duplicate ? `<div role="row" class="duplicate" hidden><span title="${group}">${group}</span></div>` : ''}
    <div role="row" hidden><span title="${group} 2">${group} 2</span></div></div></div>
  <div id="main"><header></header><div id="messages"></div><div id="toolbar">
    <div aria-label="Unrelated chat" id="composer" contenteditable="true" role="textbox"></div>
    <button id="send" aria-label="Send">Send</button></div></div>
  <script>
    const box=document.querySelector('#composer');
    search.addEventListener('input',()=>{for(const row of document.querySelectorAll('[role=row]'))row.hidden=!search.innerText;});
    exact.addEventListener('click',()=>{box.setAttribute('aria-label','Type a message to group Test Group');box.textContent=${JSON.stringify(draft || '')};});
    window.sends=0;
    send.addEventListener('click',()=>{window.sends++;const row=document.createElement('div');row.className='message-out';row.textContent=box.innerText;
      const receipt=document.createElement('span');receipt.setAttribute('aria-label','${pending ? 'Pending' : 'Sent'}');row.append(receipt);
      document.querySelector('#messages').append(row);box.replaceChildren();});
  </script>`;
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [label, options, expected, extra] of [
    ['exact group and fresh acknowledgement', {}, ['heartbeat','claim','reserve','sent'], { sends: 1 }],
    ['same-name duplicate', { duplicate: true }, ['heartbeat','claim','review'], { sends: 0 }],
    ['existing draft', { draft: 'Existing draft' }, ['heartbeat','claim','review'], { sends: 0, draft: 'Existing draft' }],
    ['pending receipt stays uncertain', { pending: true }, ['heartbeat','claim','reserve','review'], { sends: 1 }],
  ]) {
    const context = await browser.newContext();
    try {
      await context.route(waUrl + '**', route => route.fulfill({ contentType: 'text/html', body: fakeWhatsApp(options) }));
      const page = await context.newPage(); await page.goto(waUrl);
      const cdp = await context.newCDPSession(page);
      const state = {}, actions = [];
      let listener;
      const scope = {
        importScripts: () => {},
        chrome: { storage: { local: { setAccessLevel: async ({accessLevel}) => assert.equal(accessLevel, 'TRUSTED_CONTEXTS'),
          get: async () => state, set: async values => Object.assign(state, values) } },
          debugger: { attach: async () => {}, detach: async () => {}, sendCommand: (_, method, input) => cdp.send(method, input) },
          tabs: { get: async () => ({ url: page.url() }) },
          runtime: { getURL: () => chromeUrl, onMessage: { addListener(callback) { listener = callback; } } } },
        fetch: async (url, request) => {
          assert.equal(url, 'https://eco.fcuno.com/api/enquiries/dispatcher');
          assert.equal(request.credentials, 'omit');
          assert.equal(request.headers.Authorization, 'Bearer '+code);
          const input = JSON.parse(request.body);
          actions.push(input.action);
          return { ok: true, json: async () => input.action === 'claim' ? { job } :
            input.action === 'reserve' ? { accepted: true, sendWindowMs: 10000 } : { accepted: true } };
        },
        setTimeout: (fn, ms) => setTimeout(fn, Math.max(35,ms/12)), AbortSignal, JSON, URL, performance,
      };
      runInNewContext(whatsappPage + '\n' + background, scope);
      const invoke = (input, sender) => new Promise(resolve => listener(input, sender, resolve));
      const popup = { url: chromeUrl }, whatsapp = { url: waUrl, tab: { id: 10 }, frameId: 0 };
      assert.equal((await invoke({ type: 'state' }, whatsapp)).ok, false);
      assert.equal((await invoke({ type: 'poll' }, { ...whatsapp, url: 'https://example.test/' })).ok, false);
      assert.equal((await invoke({ type: 'configure', code }, popup)).ok, true);
      assert.equal((await invoke({ type: 'pause', paused: true }, popup)).ok, true);
      await invoke({ type: 'poll' }, whatsapp);
      assert.deepEqual(actions, ['heartbeat']);
      await invoke({ type: 'pause', paused: false }, popup);
      const result = await invoke({ type: 'poll' }, whatsapp);
      assert.deepEqual(actions, expected, JSON.stringify(result));
      assert.equal(await page.evaluate(() => window.sends), extra.sends);
      assert.equal((await page.locator('#search').innerText()).trim(), '');
      if (extra.draft) assert.equal(await page.locator('#composer').innerText(), extra.draft);
      console.log('PASS dispatcher · ' + label);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
