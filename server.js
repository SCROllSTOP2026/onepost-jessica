// OnePost v0: phone uploads -> Gemini drafts -> batch approval.
// eBay and Vinted posting plug into /api/batch/:id/approve in Phase 2.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Store = require('./lib/store');
const { draftListing, MODEL, VINTED_COLOURS, VINTED_MATERIALS } = require('./lib/gemini');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PASSCODE = process.env.APP_PASSCODE || '';
const LOGIN_EMAIL = (process.env.APP_EMAIL || '').trim().toLowerCase();
const SECRET = process.env.SESSION_SECRET || PASSCODE || 'dev';
const FOOTER = (process.env.LISTING_FOOTER || '').replace(/\\n/g, '\n');

fs.mkdirSync(PHOTO_DIR, { recursive: true });
const store = new Store(DATA_DIR);
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// ---------- auth: one shared passcode, long-lived cookie ----------
const token = crypto.createHmac('sha256', SECRET).update('onepost:' + LOGIN_EMAIL + ':' + PASSCODE).digest('hex');
const attempts = new Map();

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}
function authed(req) {
  if (!PASSCODE) return true;
  const t = cookies(req).op_session || '';
  return t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
}
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) Object.assign(rec, { n: 0, t: now });
  if (rec.n >= 10) return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' });
  rec.n++;
  attempts.set(ip, rec);

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (LOGIN_EMAIL && email !== LOGIN_EMAIL) return res.status(401).json({ error: 'Wrong email or passcode' });
  if (PASSCODE && String(req.body?.passcode || '') !== PASSCODE) return res.status(401).json({ error: 'Wrong email or passcode' });
  attempts.delete(ip);
  res.cookie('op_session', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 180 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ signedIn: authed(req), needsEmail: !!LOGIN_EMAIL, model: MODEL, demo: !process.env.GEMINI_API_KEY }));

// ---------- drafting queue ----------
const queue = [];
let running = 0;
const CONCURRENCY = 2;

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running++;
    runDraft(id).finally(() => {
      running--;
      pump();
    });
  }
}
async function runDraft(id, attempt = 1) {
  const item = store.getItem(id);
  if (!item) return;
  store.updateItem(id, { status: 'drafting', error: null });
  try {
    const draft = await draftListing({
      photoPaths: item.photos.map((f) => path.join(PHOTO_DIR, f)),
      note: item.note,
      price: item.price,
    });
    if (FOOTER) draft.description = `${draft.description}\n\n${FOOTER}`;
    if (store.getItem(id)) store.updateItem(id, { status: 'ready', draft });
  } catch (e) {
    const retryable = !e.status || e.status === 429 || e.status >= 500;
    if (retryable && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 4000));
      return runDraft(id, attempt + 1);
    }
    console.error('Draft failed', id, e.message);
    if (store.getItem(id)) store.updateItem(id, { status: 'failed', error: e.message });
  }
}
// Resume anything interrupted by a restart or redeploy.
store.data.items.filter((i) => i.status === 'drafting' || i.status === 'queued').forEach((i) => enqueue(i.id));

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.jpg'),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- API ----------
const api = express.Router();
api.use(requireAuth);

function batchPayload(batch) {
  return { batch, items: store.itemsIn(batch.id) };
}

api.get('/batch/current', (req, res) => res.json(batchPayload(store.currentBatch())));

api.post('/items', upload.array('photos', 12), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Add at least one photo' });
  const priceRaw = String(req.body.price || '').replace(/[^0-9.]/g, '');
  const price = priceRaw ? Math.round(parseFloat(priceRaw) * 100) / 100 : null;
  const batch = store.currentBatch();
  const item = store.addItem({
    id: store.id(),
    batchId: batch.id,
    photos: files.map((f) => f.filename),
    note: String(req.body.note || '').slice(0, 1000),
    price,
    platforms: { ebay: false, vinted: true },
    status: 'queued',
    draft: null,
    createdAt: new Date().toISOString(),
  });
  enqueue(item.id);
  res.status(201).json(item);
});

const EDITABLE = ['ebay_title', 'vinted_title', 'description', 'brand', 'item_type', 'department', 'category', 'size', 'colour', 'material', 'condition', 'price', 'package_size'];
// Free-text colour/material edits are mapped back onto Vinted's fixed option lists.
function toVintedList(text, allowed, max) {
  const lower = allowed.map((a) => a.toLowerCase());
  return String(text || '')
    .split(/[,/&+]|\band\b/i)
    .map((s) => allowed[lower.indexOf(s.trim().toLowerCase())])
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, max);
}
api.patch('/items/:id', (req, res) => {
  const item = store.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if (req.body.draft && item.draft) {
    const draft = { ...item.draft };
    for (const k of EDITABLE) if (k in req.body.draft) draft[k] = k === 'price' ? Number(req.body.draft[k]) || 0 : String(req.body.draft[k]);
    if ('colour' in req.body.draft) draft.colours = toVintedList(draft.colour, VINTED_COLOURS, 2);
    if ('material' in req.body.draft) draft.materials = toVintedList(draft.material, VINTED_MATERIALS, 3);
    if ('category' in req.body.draft) {
      const leaf = draft.category.split('>').pop().trim();
      if (leaf) draft.category_keywords = [leaf, ...(draft.category_keywords || []).filter((k) => k !== leaf)].slice(0, 3);
    }
    if (!['small', 'medium', 'large'].includes(draft.package_size)) draft.package_size = 'medium';
    if (draft.ebay_title.length > 80) return res.status(400).json({ error: 'eBay title must be 80 characters or fewer' });
    patch.draft = draft;
  }
  if (req.body.platforms) patch.platforms = { ebay: !!req.body.platforms.ebay, vinted: !!req.body.platforms.vinted };
  res.json(store.updateItem(item.id, patch));
});

api.post('/items/:id/redraft', (req, res) => {
  const item = store.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (typeof req.body?.note === 'string') store.updateItem(item.id, { note: req.body.note.slice(0, 1000) });
  store.updateItem(item.id, { status: 'queued' });
  enqueue(item.id);
  res.json(store.getItem(item.id));
});

api.delete('/items/:id', (req, res) => {
  const item = store.removeItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  for (const f of item.photos) fs.rm(path.join(PHOTO_DIR, f), { force: true }, () => {});
  res.json({ ok: true });
});

// Approve the batch. Phase 2 hooks eBay API posting and the Vinted queue in here.
api.post('/batch/:id/approve', (req, res) => {
  const items = store.itemsIn(req.params.id);
  if (!items.length) return res.status(400).json({ error: 'Nothing in this batch' });
  const notReady = items.filter((i) => i.status !== 'ready');
  if (notReady.length) return res.status(400).json({ error: `${notReady.length} item(s) still drafting or failed` });
  const none = items.filter((i) => !i.platforms.ebay && !i.platforms.vinted);
  if (none.length) return res.status(400).json({ error: `${none.length} item(s) have no platform selected` });

  const now = new Date().toISOString();
  for (const i of items) {
    store.updateItem(i.id, {
      status: 'approved',
      approvedAt: now,
      channels: {
        ebay: i.platforms.ebay ? { state: 'pending' } : null,
        vinted: i.platforms.vinted ? { state: 'pending' } : null,
      },
    });
  }
  store.closeBatch(req.params.id);
  res.json({ ok: true, approved: items.length });
});

api.get('/listings', (req, res) => {
  expireStaleLeases();
  const items = store.data.items
    .filter((i) => ['approved', 'live', 'sold'].includes(i.status))
    .sort((a, b) => (b.approvedAt || '').localeCompare(a.approvedAt || ''));
  res.json({ items });
});

// Manual channel controls until Phase 2 automates them.
api.post('/items/:id/channel', (req, res) => {
  const item = store.getItem(req.params.id);
  if (!item || !item.channels) return res.status(404).json({ error: 'Not found' });
  const { channel, state } = req.body || {};
  if (!['ebay', 'vinted'].includes(channel) || !['pending', 'live', 'removed'].includes(state)) return res.status(400).json({ error: 'Bad request' });
  const prev = item.channels[channel] || {};
  // Re-queuing resets attempts so the worker tries again.
  const next = state === 'pending' ? { state, attempts: 0, at: new Date().toISOString() } : { ...prev, state, error: null, at: new Date().toISOString() };
  const channels = { ...item.channels, [channel]: next };
  res.json(store.updateItem(item.id, { channels }));
});

// ---------- Vinted worker (Chrome extension on the Mac) ----------
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const LEASE_MS = 40 * 60 * 1000; // review mode can sit open for a while
const MAX_ATTEMPTS = 2;
let workerSeen = null;

function workerAuth(req, res, next) {
  const t = String(req.headers['x-worker-token'] || '');
  if (!WORKER_TOKEN || t.length !== WORKER_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(WORKER_TOKEN))) {
    return res.status(401).json({ error: 'Bad worker token' });
  }
  workerSeen = { at: new Date().toISOString(), version: String(req.headers['x-worker-version'] || '') };
  next();
}

function vintedJob(i) {
  const d = i.draft || {};
  return {
    id: i.id,
    title: d.vinted_title || d.ebay_title,
    description: d.description,
    price: d.price,
    condition: d.condition,
    brand: d.brand,
    size: d.size,
    department: d.department,
    category: d.category,
    category_keywords: d.category_keywords || [],
    colours: d.colours || [],
    materials: d.materials || [],
    package_size: d.package_size || 'medium',
    photos: i.photos.map((f) => `/worker/photo/${f}`),
  };
}

const worker = express.Router();
worker.use(workerAuth);

// A job the worker started but never reported on might already be live on Vinted.
// Never re-post it automatically (duplicate risk); ask a human to check instead.
function expireStaleLeases() {
  const now = Date.now();
  for (const i of store.data.items) {
    const v = i.channels?.vinted;
    if (i.status === 'approved' && v?.state === 'posting' && now - Date.parse(v.leasedAt || 0) > LEASE_MS) {
      store.updateItem(i.id, {
        channels: { ...i.channels, vinted: { ...v, state: 'attention', error: "Didn't hear back from the Mac. Check Vinted: if it's there, tap Mark live; if not, tap Retry.", at: new Date().toISOString() } },
      });
    }
  }
}

worker.get('/next', (req, res) => {
  res.set('Cache-Control', 'no-store');
  expireStaleLeases();
  const candidates = store.data.items
    .filter((i) => i.status === 'approved' && i.channels?.vinted?.state === 'pending')
    .sort((a, b) => (a.approvedAt || '').localeCompare(b.approvedAt || '') || a.createdAt.localeCompare(b.createdAt));
  const item = candidates[0];
  if (!item) return res.json({ job: null });
  const v = item.channels.vinted;
  store.updateItem(item.id, { channels: { ...item.channels, vinted: { ...v, state: 'posting', leasedAt: new Date().toISOString(), attempts: (v.attempts || 0) + 1 } } });
  res.json({ job: vintedJob(item), queued: candidates.length - 1 });
});

worker.post('/result', (req, res) => {
  const { id, ok, url, error, manual } = req.body || {};
  const item = store.getItem(id);
  if (!item || !item.channels?.vinted) return res.status(404).json({ error: 'Not found' });
  const v = item.channels.vinted;
  const at = new Date().toISOString();
  let next;
  if (ok) next = { ...v, state: 'live', url: String(url || ''), error: null, at };
  else if (manual || (v.attempts || 0) >= MAX_ATTEMPTS) next = { ...v, state: 'attention', error: String(error || 'Unknown problem').slice(0, 300), at };
  else next = { ...v, state: 'pending', error: String(error || '').slice(0, 300), at };
  res.json(store.updateItem(item.id, { channels: { ...item.channels, vinted: next } }).channels.vinted);
});

// Heartbeat: the extension reports what it's doing every minute, even mid-job.
worker.get('/ping', (req, res) => {
  const state = ['idle', 'busy', 'waiting', 'paused'].includes(req.query.state) ? req.query.state : 'idle';
  workerSeen = { ...workerSeen, state, title: String(req.query.title || '').slice(0, 120) };
  res.set('Cache-Control', 'no-store').json({ ok: true });
});
worker.use('/photo', express.static(PHOTO_DIR, { maxAge: '1d' }));

app.use('/worker', worker);
api.get('/worker-status', (req, res) => res.json({ configured: !!WORKER_TOKEN, seen: workerSeen }));

api.post('/items/:id/sold', (req, res) => {
  const item = store.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const soldOn = ['ebay', 'vinted'].includes(req.body?.on) ? req.body.on : null;
  res.json(store.updateItem(item.id, { status: 'sold', soldOn, soldAt: new Date().toISOString() }));
});

app.use('/api', api);

// Photos only for signed-in users.
app.use('/photos', requireAuth, express.static(PHOTO_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A photo is too large' : 'Upload problem: ' + err.code });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`OnePost on :${PORT} | data ${DATA_DIR} | model ${MODEL}${process.env.GEMINI_API_KEY ? '' : ' (DEMO MODE: no GEMINI_API_KEY)'}`);
  if (!PASSCODE) console.warn('APP_PASSCODE not set: app is open to anyone with the URL');
});
