const form = document.querySelector('form');
const code = document.querySelector('input');
const pause = document.querySelector('#pause');
const status = document.querySelector('[role="status"]');
let paused = false;

async function apply(command) {
  try {
    const result = await chrome.runtime.sendMessage(command);
    if (!result?.ok) throw new Error(result?.message || 'ECO CONNECTION UNAVAILABLE.');
    if (result.connected && command.type === 'configure') code.value = '';
    pause.hidden = !result.connected;
    paused = Boolean(result.paused);
    pause.textContent = paused ? 'RESUME' : 'PAUSE';
    status.textContent = result.connected ? (paused ? 'PAUSED' : 'CONNECTED') : '';
  } catch (error) {
    status.textContent = error.message.toUpperCase();
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try { await apply({ type: 'configure', code: code.value.trim() }); }
  finally { button.disabled = false; }
});
pause.addEventListener('click', () => void apply({ type: 'pause', paused: !paused }));
void apply({ type: 'state' });
