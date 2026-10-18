// Listing drafting via the Gemini REST API. Model-agnostic by design:
// swap GEMINI_MODEL in Railway variables, or replace draftListing() with another provider.
const fs = require('fs');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

const CONDITIONS = ['New with tags', 'New without tags', 'Very good', 'Good', 'Satisfactory'];

function buildPrompt(note, price) {
  return `You write second-hand resale listings for a UK reseller who sells on eBay UK and Vinted UK.
Look at the photos and the seller's notes, then return one JSON object for this single item.

Seller's notes: ${note ? note : '(none)'}
Seller's price: ${price ? '£' + price : '(not given)'}

Rules:
- UK English, UK sizing, prices in GBP.
- Only state facts you can see in the photos (labels, tags, logos, care labels) or that the seller wrote. Never invent sizes, materials, measurements, model names or flaws.
- If something is unclear, leave that field as an empty string and add a short note to "checks", e.g. "Size label not visible".
- Any flaw the seller mentions must appear in the description.
- ebay_title: maximum 80 characters. Front-load brand, then item type, key attributes (colour, style, material), then size. No emojis, no "L@@K", "WOW" or punctuation spam.
- vinted_title: short and natural, roughly 6 to 10 words: brand, item, key detail, size.
- description: 3 to 6 short lines. One natural opening sentence, then plain details (brand, size, colour, material, condition, any flaws). Use the search terms a buyer would type, naturally. No keyword stuffing, no hashtags, no em dashes.
- condition: exactly one of ${CONDITIONS.map((c) => `"${c}"`).join(', ')}.
- department: one of "Women", "Men", "Kids", "Unisex", "Home", "Other".
- category: best-guess category path, e.g. "Women > Clothing > Jumpers & sweaters".
- keywords: 5 to 10 search terms buyers would use.
- price: use the seller's price exactly if given. If not given, suggest a realistic UK resale price and set price_suggested to true.`;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    ebay_title: { type: 'STRING' },
    vinted_title: { type: 'STRING' },
    description: { type: 'STRING' },
    brand: { type: 'STRING' },
    item_type: { type: 'STRING' },
    department: { type: 'STRING' },
    category: { type: 'STRING' },
    size: { type: 'STRING' },
    colour: { type: 'STRING' },
    material: { type: 'STRING' },
    condition: { type: 'STRING' },
    keywords: { type: 'ARRAY', items: { type: 'STRING' } },
    price: { type: 'NUMBER' },
    price_suggested: { type: 'BOOLEAN' },
    checks: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['ebay_title', 'vinted_title', 'description', 'condition', 'price', 'checks'],
};

function clean(s) {
  return String(s || '')
    .replace(/\s*[—–]\s*/g, ', ') // no em or en dashes in her listings
    .replace(/,\s*,/g, ',')
    .trim();
}

function normalise(raw, price) {
  const d = { ...raw };
  for (const k of ['ebay_title', 'vinted_title', 'description', 'brand', 'item_type', 'department', 'category', 'size', 'colour', 'material']) {
    d[k] = clean(d[k]);
  }
  if (d.ebay_title.length > 80) d.ebay_title = d.ebay_title.slice(0, 80).replace(/\s+\S*$/, '');
  if (!CONDITIONS.includes(d.condition)) {
    d.checks = [...(d.checks || []), 'Confirm condition'];
    d.condition = 'Very good';
  }
  d.keywords = Array.isArray(d.keywords) ? d.keywords.map(clean).filter(Boolean).slice(0, 10) : [];
  d.checks = Array.isArray(d.checks) ? d.checks.map(clean).filter(Boolean) : [];
  if (price) {
    d.price = Number(price);
    d.price_suggested = false;
  } else {
    d.price = Math.round(Number(d.price) || 0);
    d.price_suggested = true;
    d.checks.push('Price suggested by AI, please confirm');
  }
  return d;
}

function mockDraft(note, price) {
  return normalise(
    {
      ebay_title: 'Demo Brand Item Title Size M',
      vinted_title: 'Demo brand item, size M',
      description: `Demo listing. Add GEMINI_API_KEY to generate real listings.\n${note ? 'Notes: ' + note : ''}`.trim(),
      brand: '',
      item_type: '',
      department: 'Women',
      category: '',
      size: '',
      colour: '',
      material: '',
      condition: 'Very good',
      keywords: ['demo'],
      price: price || 10,
      checks: ['Demo mode: no Gemini key set'],
    },
    price
  );
}

async function callGemini(parts, withSchema) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
  };
  if (withSchema) body.generationConfig.responseSchema = SCHEMA;

  const res = await fetch(`${API}/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no text (possibly blocked)');
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
}

async function draftListing({ photoPaths, note, price }) {
  if (!process.env.GEMINI_API_KEY) return mockDraft(note, price);

  const parts = [{ text: buildPrompt(note, price) }];
  for (const p of photoPaths.slice(0, 8)) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: fs.readFileSync(p).toString('base64') } });
  }

  try {
    return normalise(await callGemini(parts, true), price);
  } catch (e) {
    // If the structured-output schema is ever rejected, fall back to plain JSON mode.
    if (e.status === 400 && /schema/i.test(e.message)) {
      return normalise(await callGemini(parts, false), price);
    }
    throw e;
  }
}

module.exports = { draftListing, MODEL, CONDITIONS };
