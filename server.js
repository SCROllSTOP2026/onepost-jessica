// OnePost v0: phone uploads -> Gemini drafts -> batch approval.
// eBay and Vinted posting plug into /api/batch/:id/approve in Phase 2.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Store = require('./lib/store');
const { draftListing, MODEL } = require('./lib/gemini');

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
    platforms: { ebay: true, vinted: true },
    status: 'queued',
    draft: null,
    createdAt: new Date().toISOString(),
  });
  enqueue(item.id);
  res.status(201).json(item);
});

const EDITABLE = ['ebay_title', 'vinted_title', 'description', 'brand', 'item_type', 'department', 'category', 'size', 'colour', 'material', 'condition', 'price'];
api.patch('/items/:id', (req, res) => {
  const item = store.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if (req.body.draft && item.draft) {
    const draft = { ...item.draft };
    for (const k of EDITABLE) if (k in req.body.draft) draft[k] = k === 'price' ? Number(req.body.draft[k]) || 0 : String(req.body.draft[k]);
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
  const channels = { ...item.channels, [channel]: { ...(item.channels[channel] || {}), state, at: new Date().toISOString() } };
  res.json(store.updateItem(item.id, { channels }));
});

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
