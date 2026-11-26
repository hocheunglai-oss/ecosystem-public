importScripts('whatsapp-page.js');

const url = 'https://eco.fcuno.com/api/enquiries/dispatcher';
const whatsAppOrigin = 'https://web.whatsapp.com';
const local = chrome.storage.local;
const securedStorage = local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const active = new Map();
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function credential() {
  await securedStorage;
  const { token, paused } = await local.get(['token', 'paused']);
  return { token: tokenFormat.test(token ?? '') ? token : '', paused: paused === true };
}

async function request(action, token, job) {
  const response = await fetch(url, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...(job ? { id: job.id, claimToken: job.claimToken } : {}) }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Connection code expired.' : 'ECO connection unavailable.');
  return response.json();
}

async function withTab(tabId, action) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== whatsAppOrigin) throw new Error('WhatsApp Web tab required.');
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const command = (method, params) => chrome.debugger.sendCommand(target, method, params);
    const evaluate = async (method, ...args) => {
      const expression = `location.origin === ${JSON.stringify(whatsAppOrigin)}
        ? (${whatsappPage.toString()})()[${JSON.stringify(method)}](...${JSON.stringify(args)}) : null`;
      const result = await command('Runtime.evaluate', { expression, returnByValue: true });
      return result?.result?.value;
    };
    return await action(command, evaluate);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function click(command, point, beforePress) {
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  if (beforePress) await beforePress();
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function clearSelectedText(command) {
  for (const type of ['rawKeyDown','keyUp']) {
    await command('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  }
}

async function send(tabId, token, job) {
  const { groupName, message } = job;
  return withTab(tabId, async (command, evaluate) => {
    if (!await evaluate('focusSearch')) throw new Error('WhatsApp search is unavailable.');
    await command('Input.insertText', { text: groupName });
    let staged = false;
    try {
      let point;
      for (const delay of [450, 600, 900, 1400]) {
        await wait(delay);
        if (await evaluate('groupMatchCount', groupName) > 1) throw new Error('Several WhatsApp groups match.');
        const first = await evaluate('openGroup', groupName);
        if (first) {
          await wait(450);
          point = await evaluate('openGroup', groupName);
          if (point) break;
        }
      }
      if (!point) throw new Error('The exact WhatsApp group could not be opened.');
      await click(command, point, async () => {
        const current = await evaluate('openGroup', groupName);
        if (!current || current.x !== point.x || current.y !== point.y) throw new Error('The WhatsApp search result changed.');
      });
      for (const delay of [300, 500, 900, 1400]) {
        await wait(delay);
        if (await evaluate('groupOpen', groupName)) break;
      }
      if (await evaluate('acknowledged', groupName, message)) throw new Error('An earlier matching message requires review.');
      if (!await evaluate('focusEmptyComposer', groupName)) throw new Error('The exact WhatsApp group has an existing draft or is unavailable.');
      await command('Input.insertText', { text: message });
      staged = true;
      await wait(300);
      if (!await evaluate('submission', groupName, message)) throw new Error('The staged WhatsApp text cannot be verified.');

      const started = performance.now();
      const permit = await request('reserve', token, job);
      if (!permit.accepted || permit.sendWindowMs !== 10000) throw new Error('ECO did not authorize this submission.');
      point = await evaluate('submission', groupName, message);
      if (!point) throw new Error('The WhatsApp send button changed.');
      await click(command, point, async () => {
        const current = await evaluate('submission', groupName, message);
        const latest = await credential();
        if (!current || current.x !== point.x || current.y !== point.y || latest.paused || latest.token !== token
            || performance.now() >= started + permit.sendWindowMs) throw new Error('The WhatsApp submission was interrupted.');
      });
      for (const delay of [300, 500, 900, 1500, 2300, 3500]) {
        await wait(delay);
        if (!await evaluate('groupOpen', groupName)) throw new Error('WhatsApp changed groups.');
        if (await evaluate('acknowledged', groupName, message)) return;
      }
      throw new Error('WhatsApp did not acknowledge delivery.');
    } finally {
      if (staged && await evaluate('clearOwnDraft', groupName, message).catch(() => false)) {
        await clearSelectedText(command).catch(() => {});
      }
      if (await evaluate('clearSearch', groupName).catch(() => false)) {
        await clearSelectedText(command).catch(() => {});
      }
    }
  });
}

async function processQueue(tabId) {
  const { token, paused } = await credential();
  if (!token || paused) return;
  let job;
  let sendConfirmed = false;
  try {
    ({ job } = await request('claim', token));
    if (!job) return;
    await send(tabId, token, job);
    sendConfirmed = true;
    if (!(await request('sent', token, job)).accepted) throw new Error('Delivery requires review.');
  } catch (error) {
    if (job) {
      await request(sendConfirmed ? 'sent' : 'review', token, job).catch(() => {});
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((input, sender, respond) => {
  async function handle() {
    if (sender.url === chrome.runtime.getURL('connect.html')) {
      if (input.type === 'configure' && tokenFormat.test(input.code ?? '')) {
        await securedStorage;
        await request('heartbeat', input.code);
        await local.set({ token: input.code, paused: false });
        return { connected: true };
      }
      if (input.type === 'pause') {
        await securedStorage;
        await local.set({ paused: input.paused === true });
      }
      if (input.type === 'state' || input.type === 'pause') {
        const { token, paused } = await credential();
        return { connected: Boolean(token), paused };
      }
    }
    const id = sender.tab?.id;
    if (input.type !== 'poll' || !Number.isInteger(id) || !sender.url || new URL(sender.url).origin !== whatsAppOrigin ||
        sender.frameId !== 0) throw new Error('Invalid dispatcher request.');
    if (active.has(id)) return {};
    const task = processQueue(id);
    active.set(id, task);
    try { await task; } finally { active.delete(id); }
    return {};
  }
  handle().then(result => respond({ ok: true, ...result })).catch(error => respond({ ok: false, message: error.message }));
  return true;
});
