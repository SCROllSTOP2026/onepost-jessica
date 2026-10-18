// OnePost Vinted Poster: polls the OnePost queue and posts approved items to Vinted
// in this Chrome profile. Event-driven so it survives the service worker being suspended.
importScripts('fill.js');

const VERSION = chrome.runtime.getManifest().version;
const SELL_URL = 'https://www.vinted.co.uk/items/new';
const LIVE_RE = /^https:\/\/www\.vinted\.co\.uk\/items\/(\d+)/;
const DEFAULTS = { server: 'https://onepost-production-66ff.up.railway.app', token: '', mode: 'review', paused: false };
const GAP_MIN_MS = 2 * 60 * 1000; // human pacing between posts
const GAP_MAX_MS = 4 * 60 * 1000;
const AUTO_TIMEOUT_MS = 90 * 1000;
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

// ---------- small helpers ----------
const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
const getCurrent = async () => (await chrome.storage.local.get('current')).current || null;
const setCurrent = (current) => chrome.storage.local.set({ current });

async function log(msg) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift(`${new Date().toLocaleString('en-GB')}  ${msg}`);
  await chrome.storage.local.set({ logs: logs.slice(0, 40) });
}

function badge(text, colour = '#2F5D50') {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: colour });
}

async function call(path, opts = {}) {
  const s = await settings();
  const res = await fetch(s.server.replace(/\/$/, '') + path, {
    ...opts,
    headers: { 'X-Worker-Token': s.token, 'X-Worker-Version': VERSION, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) throw new Error('OnePost rejected the worker token. Check it in the extension settings.');
  if (!res.ok) throw new Error(`OnePost error ${res.status}`);
  return res;
}

async function toDataUrl(path) {
  const buf = await (await call(path)).arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}

async function report(id, body) {
  try {
    await call('/worker/result', { method: 'POST', body: JSON.stringify({ id, ...body }) });
  } catch (e) {
    await log('Could not report result: ' + e.message);
  }
}

function waitForLoad(tabId, ms = 30000) {
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(ok); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    const t = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(l);
  });
}

async function finish(cur, body, closeTab) {
  await setCurrent(null);
  await report(cur.id, body);
  const gap = GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
  await chrome.storage.local.set({ nextAt: Date.now() + gap });
  if (closeTab) setTimeout(() => chrome.tabs.remove(cur.tabId).catch(() => {}), 4000);
  if (body.ok) { badge(''); await log(`Live on Vinted: ${cur.title}`); }
  else { badge('!', '#A63A2B'); await log(`Needs a hand: ${cur.title}: ${body.error}`); }
}

// ---------- success / abandonment detection (top-level listeners) ----------
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const cur = await getCurrent();
  if (!cur || cur.tabId !== tabId || !info.url && !tab.url) return;
  const url = info.url || tab.url;
  const m = url.match(LIVE_RE);
  if (m && m[1] && !/\/items\/new/.test(url)) {
    await finish(cur, { ok: true, url: `https://www.vinted.co.uk/items/${m[1]}` }, cur.mode === 'auto');
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cur = await getCurrent();
  if (cur && cur.tabId === tabId) await finish(cur, { ok: false, manual: true, error: 'The Vinted tab was closed before the item was uploaded.' }, false);
});

// ---------- the poll loop ----------
async function heartbeat(state, title = '') {
  try { await call(`/worker/ping?state=${state}&title=${encodeURIComponent(title)}`); } catch {}
}

async function tick(force = false) {
  const s = await settings();
  if (!s.token) return badge('set');
  const cur = await getCurrent();
  await heartbeat(cur ? (cur.mode === 'review' && !cur.submittedAt ? 'waiting' : 'busy') : s.paused ? 'paused' : 'idle', cur?.title);

  if (cur) {
    const age = Date.now() - cur.startedAt;
    if (cur.mode === 'auto' && cur.submittedAt && Date.now() - cur.submittedAt > AUTO_TIMEOUT_MS) {
      let errs = [];
      try { [{ result: errs }] = await chrome.scripting.executeScript({ target: { tabId: cur.tabId }, world: 'MAIN', func: readVintedErrors }); } catch {}
      return finish(cur, { ok: false, manual: false, error: `Vinted didn't accept the upload. ${(errs || []).join(' ') || 'No reason shown.'}` }, true);
    }
    if (age > REVIEW_TIMEOUT_MS) return finish(cur, { ok: false, manual: true, error: 'Waited 30 minutes for the upload; it was left open on the Mac.' }, false);
    return; // still working on the current item
  }

  if (s.paused) return badge('II', '#6F685E');
  const { nextAt = 0 } = await chrome.storage.local.get('nextAt');
  if (!force && Date.now() < nextAt) return;

  let job;
  try {
    ({ job } = await (await call('/worker/next')).json());
  } catch (e) {
    badge('!', '#A63A2B');
    return log(e.message);
  }
  if (!job) return badge('');
  await runJob(job, s.mode);
}

async function runJob(job, mode) {
  badge('…');
  await log(`Posting: ${job.title}`);
  let photos;
  try {
    photos = await Promise.all(job.photos.map(toDataUrl));
  } catch (e) {
    return report(job.id, { ok: false, error: 'Could not download photos: ' + e.message });
  }

  const tab = await chrome.tabs.create({ url: SELL_URL, active: mode === 'review' });
  const cur = { id: job.id, title: job.title, tabId: tab.id, mode, startedAt: Date.now() };
  await setCurrent(cur);
  await waitForLoad(tab.id);
  const t = await chrome.tabs.get(tab.id).catch(() => null);
  if (!t || !t.url.startsWith(SELL_URL)) {
    return finish(cur, { ok: false, manual: true, error: 'Vinted is not logged in on the Mac. Log in to Vinted in this Chrome profile.' }, false);
  }
  await new Promise((r) => setTimeout(r, 2500)); // let Vinted's form finish rendering

  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fillVinted,
      args: [job, photos, mode === 'auto'],
    });
  } catch (e) {
    return finish(cur, { ok: false, manual: false, error: 'Filling the Vinted form failed: ' + e.message }, mode === 'auto');
  }
  if (result?.notes?.length) await log(result.notes.join(' · '));
  if (!result?.ok) return finish(cur, { ok: false, manual: result?.manual !== false, error: result?.error || 'Unknown problem' }, false);

  if (result.submitted) {
    await setCurrent({ ...cur, submittedAt: Date.now() });
  } else {
    badge('✋', '#9A5B12');
    await log(`Filled and waiting for you to check and press Upload: ${job.title}`);
  }
}

// ---------- wiring ----------
function ensureAlarm() {
  chrome.alarms.get('tick', (a) => { if (!a) chrome.alarms.create('tick', { periodInMinutes: 1 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); });
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg === 'check-now') { tick(true).then(() => reply('ok'), (e) => reply(e.message)); return true; }
  if (msg === 'test-connection') {
    call('/worker/ping').then(() => reply('Connected to OnePost'), (e) => reply(e.message));
    return true;
  }
});
ensureAlarm();
