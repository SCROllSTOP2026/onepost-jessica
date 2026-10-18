const DEFAULTS = { server: 'https://onepost-production-66ff.up.railway.app', token: '', mode: 'review', paused: false };
const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('server').value = s.server;
  $('token').value = s.token;
  $('mode').value = s.mode;
  $('paused').checked = s.paused;
  const { logs = [] } = await chrome.storage.local.get('logs');
  $('logs').textContent = logs.length ? logs.join('\n') : 'No activity yet.';
}

$('save').onclick = async () => {
  await chrome.storage.local.set({
    server: $('server').value.trim().replace(/\/$/, ''),
    token: $('token').value.trim(),
    mode: $('mode').value,
    paused: $('paused').checked,
  });
  status('Saved');
};
$('test').onclick = async () => { await $('save').onclick(); status('Testing…'); status(await chrome.runtime.sendMessage('test-connection')); };
$('now').onclick = async () => { await $('save').onclick(); status('Checking the queue…'); await chrome.runtime.sendMessage('check-now'); status('Checked'); load(); };

chrome.storage.onChanged.addListener((c) => { if (c.logs) load(); });
load();
