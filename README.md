# OnePost v0

Snap an item on iPhone, add a quick note and price, AI writes the listing, approve the batch.

## What v0 does

→ **Add**: per item: photos (resized on the phone), quick description, desired price. Save and go straight to the next item while Gemini drafts in the background.
→ **Review**: every draft in the batch as a card: eBay title (80-char counter), Vinted title, description, price, condition, brand, size, colour, material, category. "Please check" flags anything the AI couldn't confirm from the photos. Toggle eBay / Vinted per item. Redraft or delete. One button approves the batch.
→ **Listed**: approved items with per-platform status. For Vinted: **Copy text** and **Photos** (iPhone share sheet, "Save Images") for fast assisted posting. **Mark live**, **Sold here**, and a warning to remove the other listing after a sale.

Phase 2 replaces the manual "Mark live" step with eBay API posting and the Vinted Chrome extension worker; the hook point is `POST /api/batch/:id/approve` in `server.js`.

## Deploy to Railway (about 15 minutes)

1. Push this folder to a new private GitHub repo (e.g. `onepost`).
2. Railway → New Project → Deploy from GitHub repo → pick it. Node is detected automatically.
3. Service → **Volumes** → add a volume mounted at `/data` (stores photos and listings; without it data is wiped on every deploy).
4. Service → **Variables**:
   ↳ `APP_PASSCODE`: what she types to sign in
   ↳ `SESSION_SECRET`: any long random string
   ↳ `GEMINI_API_KEY`: from Google AI Studio (use a paid-tier key)
   ↳ `DATA_DIR` = `/data`
   ↳ optional `LISTING_FOOTER`, `GEMINI_MODEL`
5. Service → **Settings → Networking** → Generate Domain.
6. On her iPhone: open the URL in Safari → Share → **Add to Home Screen**.

Without `GEMINI_API_KEY` the app runs in **Demo mode** with placeholder drafts, so you can test the flow first.

## Run locally

```
npm install
APP_PASSCODE=test npm start   # http://localhost:3000
```

## Swapping the AI model

Change `GEMINI_MODEL` (e.g. a step-up Flash model) in Railway variables. To use another provider entirely, replace `draftListing()` in `lib/gemini.js`; it must return the same JSON fields.

## Files

→ `server.js`: API, auth, drafting queue
→ `lib/gemini.js`: prompt, schema and clean-up (UK English, no em dashes, 80-char eBay titles, her price always wins)
→ `lib/store.js`: JSON file store on the volume
→ `public/`: the iPhone web app
