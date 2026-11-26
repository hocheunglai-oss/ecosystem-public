// Shared between the isolated content script and the fixed debugger expressions.
function whatsappPage() {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const groupKey = value => clean(String(value ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')).normalize('NFC').toLowerCase();
  const messageKey = value => clean(String(value ?? '').replace(/\*/g, ''));
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility === 'visible';
  };
  const point = element => {
    if (!visible(element)) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return element.contains(hit) ? { x, y } : null;
  };
  const main = () => document.querySelector('#main') || document.querySelector('[role="main"]');
  const search = () => {
    const candidates = [...document.querySelectorAll('#side [role="textbox"][contenteditable="true"], #side input[aria-label]')]
      .filter(element => visible(element) && /^(?:search\b|$)/i.test(element.getAttribute('aria-label') || ''));
    return candidates.length === 1 ? candidates[0] : null;
  };
  function composer(group) {
    const expected = groupKey('Type a message to group ' + group);
    const candidates = [...main()?.querySelectorAll('[contenteditable="true"][aria-label]') ?? []]
      .filter(element => groupKey(element.getAttribute('aria-label')) === expected && visible(element));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function groupRows(name) {
    const pane = document.querySelector('#pane-side') || document.querySelector('#side');
    if (!pane) return [];
    const expected = groupKey(name);
    const rows = [...pane.querySelectorAll('span[title], div[title], [dir="auto"]')]
      .filter(element => visible(element) && !element.closest('[role="textbox"],[role="search"],[contenteditable="true"]') &&
        groupKey(element.getAttribute('title') || element.textContent) === expected)
      .map(element => element.closest('[role="row"],[role="listitem"],[data-testid="cell-frame-container"],[role="gridcell"][tabindex]'))
      .filter(row => row && pane.contains(row) && visible(row));
    return [...new Set(rows)].filter(row => !rows.some(other => other !== row && other.contains(row)));
  }
  function outgoing(group, message) {
    if (!composer(group)) return [];
    const rows = [...main().querySelectorAll('[data-testid="msg-container"], .message-out, [data-id^="true_"]')];
    return rows.filter(row => {
      const labels = [...row.querySelectorAll('[aria-label]')].map(element => clean(element.getAttribute('aria-label')).toLowerCase());
      const owns = row.closest('.message-out,[data-id^="true_"]') || labels.some(label => /^(you|你|您):?$/.test(label));
      const acknowledged = labels.some(label => /^(?:\d{1,2}:\d{2}\s*(?:[ap]m)?\s*)?(sent|delivered|read|已发送|已傳送|已送达|已送達|已读|已讀)$/.test(label)) ||
        row.querySelector('[data-icon="msg-check"],[data-icon="msg-dblcheck"],[data-icon="msg-dblcheck-ack"],[data-icon="wds-ic-read"],[data-testid="msg-check"],[aria-label="wds-ic-read"]');
      return visible(row) && owns && acknowledged && messageKey(row.innerText).includes(messageKey(message));
    });
  }
  function selectText(element) {
    element.focus();
    if (document.activeElement !== element) return false;
    if (element instanceof HTMLInputElement) element.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }
  return {
    ready: () => { const element = search(); return Boolean(element && !clean(element.innerText || element.value)); },
    groupMatchCount: name => groupRows(name).length,
    groupOpen: name => Boolean(composer(name)),
    acknowledged: (group, message) => outgoing(group, message).length > 0,
    focusSearch: () => {
      const element = search();
      return Boolean(element && !clean(element.innerText || element.value) && selectText(element));
    },
    clearSearch: group => {
      const element = search();
      return Boolean(element && groupKey(element.innerText || element.value) === groupKey(group) && selectText(element));
    },
    openGroup: name => {
      const rows = groupRows(name);
      if (rows.length !== 1) return null;
      rows[0].scrollIntoView({ block: 'nearest' });
      return point(rows[0]);
    },
    focusEmptyComposer: name => {
      const element = composer(name);
      return Boolean(element && !clean(element.innerText || element.textContent) && selectText(element));
    },
    clearOwnDraft: (name, message) => {
      const element = composer(name);
      return Boolean(element && clean(element.innerText || element.textContent) === clean(message) && selectText(element));
    },
    submission: (name, message) => {
      const element = composer(name);
      if (!element || messageKey(element.innerText || element.textContent) !== messageKey(message) || outgoing(name, message).length) return null;
      const rect = element.getBoundingClientRect();
      const buttons = [...main().querySelectorAll('button[aria-label="Send"],[role="button"][aria-label="Send"],[data-icon="wds-ic-send-filled"],[data-icon="send"]')]
        .map(icon => icon.closest('button,[role="button"]')).filter(button => button && !button.disabled &&
          button.getAttribute('aria-disabled') !== 'true' && visible(button));
      const targets = [...new Set(buttons)].filter(button => {
        const bounds = button.getBoundingClientRect();
        return bounds.bottom >= rect.top - 20 && bounds.top <= rect.bottom + 40 && bounds.left >= rect.right - 180;
      });
      if (targets.length !== 1) return null;
      return point(targets[0]);
    },
  };
}
