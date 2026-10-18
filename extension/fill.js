// Runs inside the Vinted "Sell an item" page (MAIN world). Must be fully self-contained:
// Chrome serialises this function and injects it, so it cannot use anything outside itself.
// Field hooks were mapped from vinted.co.uk/items/new on 18 Oct 2026 (data-testid / id attributes).
async function fillVinted(job, photoDataUrls, submit) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await wait(200);
    }
    return null;
  };
  const human = (base) => wait(base + Math.round(Math.random() * base * 0.6));
  const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const firstLine = (el) => (el.innerText || '').trim().split('\n')[0];
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Real typing via the browser's own text insertion, so Vinted's form state registers it
  // (setting .value directly can show on screen but leave the field "empty" internally).
  const typeInto = async (el, text) => {
    el.focus();
    el.select?.();
    document.execCommand('selectAll');
    const ok = document.execCommand('insertText', false, String(text));
    if (!ok || el.value.replace(/[£,\s]/g, '') === '' && String(text) !== '') setVal(el, text);
    await wait(150);
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur();
    await wait(250);
  };
  const closeDropdown = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
    await wait(400);
  };
  const open = async (testid) => {
    const inp = $(`[data-testid="${testid}"]`);
    if (!inp) return null;
    inp.click();
    await human(500);
    return $(`[data-testid="${testid.replace(/-input$/, '-content')}"]`);
  };
  const fail = (error, manual = true) => ({ ok: false, manual, error, notes });
  const notes = [];

  // 0. Are we on the sell form and logged in?
  const title = await waitFor(() => $('[data-testid="title--input"]'), 15000);
  if (!title) return fail('The Vinted sell page did not load. Is this Chrome profile still logged in to Vinted?');

  // 0b. Vinted remembers an unfinished form between visits; clear any leftover photos first.
  for (let n = 0; n < 30; n++) {
    const del = $('[data-testid^="media-select-grid-delete-button"]');
    if (!del) break;
    del.click();
    await wait(600);
  }

  // 1. Photos: hand the files to Vinted's own uploader.
  const fileInput = $('[data-testid="add-photos-input"]');
  if (!fileInput) return fail('Could not find the photo uploader on the Vinted page.');
  const dt = new DataTransfer();
  for (let n = 0; n < photoDataUrls.length; n++) {
    const blob = await (await fetch(photoDataUrls[n])).blob();
    dt.items.add(new File([blob], `photo-${n + 1}.jpg`, { type: 'image/jpeg' }));
  }
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  const tiles = () => $$('[data-testid^="media-select-grid-delete-button"]').length;
  if (!(await waitFor(() => tiles() >= photoDataUrls.length, 30000))) {
    return fail(`Only ${tiles()} of ${photoDataUrls.length} photos uploaded to Vinted.`, false);
  }
  await human(1500);

  // 2. Title and description.
  await typeInto(title, job.title);
  await human(400);
  await typeInto($('[data-testid="description--input"]'), job.description);
  await human(600);

  // 3. Category: use Vinted's own category search, then pick the result whose path best matches ours.
  const ROOTS = ['women', 'men', 'kids', 'home', 'electronics', 'books and media', 'hobbies and collectables', 'sports'];
  const targetParts = String(job.category || '').split('>').map(norm).filter(Boolean);
  const root = ROOTS.includes(targetParts[0]) ? targetParts[0] : null;
  const leafTarget = targetParts[targetParts.length - 1] || '';
  const catContent = await open('catalog-select-dropdown-input');
  const search = await waitFor(() => document.getElementById('catalog-search-input'));
  if (!catContent || !search) return fail('Could not open the Vinted category picker.');
  // Words from the listing break ties between sibling categories (e.g. plaque vs print vs sticker).
  const stem = (w) => w.replace(/(ies|es|s)$/, '');
  const itemWords = new Set(norm(`${job.title} ${(job.category_keywords || []).join(' ')}`).split(' ').filter((w) => w.length > 3).map(stem));
  const scored = new Map();
  const tryWords = [...(job.category_keywords || []), leafTarget].filter((w, i, a) => w && a.indexOf(w) === i);
  for (const word of tryWords) {
    setVal(search, word);
    await wait(1600);
    for (const r of $$('[id^="catalog-search-"][id$="-result"]')) {
      const [leaf, pathText = ''] = (r.innerText || '').split('\n');
      const parts = `${pathText} > ${leaf}`.split('>').map(norm).filter(Boolean);
      if (root && parts[0] !== root) continue;
      let score = 0;
      for (const p of targetParts) score += parts.includes(p) ? 2 : parts.some((q) => q.includes(p) || p.includes(q)) ? 1 : 0;
      if (norm(leaf) === leafTarget) score += 3;
      if (norm(leaf) === norm(word)) score += 1;
      const tie = norm(leaf).split(' ').filter((w) => itemWords.has(stem(w))).length * 0.5;
      const label = `${pathText} > ${leaf}`;
      const prev = scored.get(label);
      if (!prev || score + tie > prev.total) scored.set(label, { id: r.id, score, total: score + tie, label });
    }
    const top = [...scored.values()].sort((a, b) => b.total - a.total)[0];
    if (top && top.score >= 7) break;
  }
  const ranked = [...scored.values()].sort((a, b) => b.total - a.total);
  const best = ranked[0];
  if (!best || best.score < 3) {
    await closeDropdown();
    return fail(`Couldn't match the category "${job.category}". Pick it on Vinted, or edit the category and retry.`);
  }
  // A dead heat between different categories means we'd be guessing.
  if (ranked[1] && ranked[1].total === best.total && submit) {
    await closeDropdown();
    return fail(`Category is a toss-up between "${best.label}" and "${ranked[1].label}". Pick it on Vinted, or set the category in OnePost and retry.`);
  }
  // Re-run the search that found the winner so its element is on screen, then click it.
  const leafWord = best.label.split('>').pop().trim();
  let el = document.getElementById(best.id);
  if (!el) { setVal(search, leafWord); await wait(1600); el = document.getElementById(best.id); }
  if (!el) { await closeDropdown(); return fail(`Couldn't select the category "${best.label}".`); }
  el.click();
  notes.push(`Category: ${best.label}${ranked[1] && ranked[1].total === best.total ? ' (close call, please check)' : ''}`);
  await wait(1800); // category-specific fields render now

  // 4. Brand (type into Vinted's brand search; exact match first).
  if ($('[data-testid="brand-select-dropdown-input"]') && job.brand) {
    const content = await open('brand-select-dropdown-input');
    const bs = await waitFor(() => $('[data-testid="brand-search--input"]'));
    if (content && bs) {
      setVal(bs, job.brand);
      await wait(1600);
      const opts = $$('[role="radio"]', content);
      const want = norm(job.brand);
      const o = opts.find((e) => norm(firstLine(e)) === want) || opts.find((e) => norm(firstLine(e)).startsWith(want));
      if (o) { o.click(); notes.push(`Brand: ${firstLine(o)}`); }
      else {
        // Vinted offers "use this as brand" for brands not in its list.
        const custom = $$('[role="button"], button', content).find((e) => norm(e.innerText).includes(want));
        if (custom) { custom.click(); notes.push(`Brand (custom): ${job.brand}`); }
        else notes.push(`Brand "${job.brand}" not found, left blank`);
      }
    }
    await closeDropdown();
  }

  // 5. Size (only for categories that have one).
  if ($('[data-testid="category-size-single-grid-input"]')) {
    if (!job.size) return fail('This category needs a size and the listing has none. Add the size in OnePost and retry.');
    const content = await open('category-size-single-grid-input');
    const opts = content ? $$('[role="checkbox"], [role="radio"]', content) : [];
    const raw = String(job.size);
    const ukNum = (raw.match(/uk\s*(\d+(?:\.\d+)?)/i) || raw.match(/^\s*(\d+(?:\.\d+)?)\s*$/) || [])[1];
    const letter = (raw.match(/\b(\d?X{0,3}[SML]|XXXL|XXL|XL|\dXL)\b/i) || [])[1];
    let pick = null;
    for (const e of opts) {
      const text = firstLine(e);
      const segs = text.split('/').map((s) => s.trim());
      if (norm(text) === norm(raw)) { pick = e; break; }
      if (ukNum) {
        for (const s of segs) {
          const m = s.match(/uk\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i) || s.match(/^(\d+(?:\.\d+)?)$/);
          if (m) {
            const lo = parseFloat(m[1]), hi = parseFloat(m[2] || m[1]), n = parseFloat(ukNum);
            if (n >= lo && n <= hi) { pick = pick || e; if (lo === n) { pick = e; } }
          }
        }
      }
      if (!pick && letter && norm(segs[0]) === norm(letter)) pick = e;
    }
    if (!pick) {
      await closeDropdown();
      return fail(`Couldn't match size "${job.size}" to Vinted's size list. Pick it on Vinted, or edit the size and retry.`);
    }
    // Size options are toggles: clear a different leftover choice, and don't un-tick the right one.
    for (const e of opts) if (e !== pick && e.getAttribute('aria-checked') === 'true') { e.click(); await wait(250); }
    if (pick.getAttribute('aria-checked') !== 'true') pick.click();
    notes.push(`Size: ${firstLine(pick)}`);
    await closeDropdown();
  }

  // 6. Condition.
  const CONDITION_IDS = { 'New with tags': 6, 'New without tags': 1, 'Very good': 2, Good: 3, Satisfactory: 4 };
  if ($('[data-testid="category-condition-single-list-input"]')) {
    await open('category-condition-single-list-input');
    const c = document.getElementById(`condition-${CONDITION_IDS[job.condition] || 2}`);
    if (!c) { await closeDropdown(); return fail('Could not set the condition on Vinted.'); }
    c.click();
    await closeDropdown();
  }

  // 7. Colours and materials (optional fields; skip quietly if not offered).
  const multi = async (testid, values, label) => {
    if (!$(`[data-testid="${testid}"]`)) return;
    const content = await open(testid);
    if (!content) return;
    const wanted = (values || []).map(norm);
    const boxes = () => $$('[role="checkbox"]', content);
    // Untick leftovers from an earlier unfinished form, then tick ours.
    for (const e of boxes()) if (e.getAttribute('aria-checked') === 'true' && !wanted.includes(norm(firstLine(e)))) { e.click(); await wait(250); }
    for (const v of values || []) {
      const o = boxes().find((e) => norm(firstLine(e)) === norm(v));
      if (!o) { notes.push(`${label} "${v}" not offered`); continue; }
      if (o.getAttribute('aria-checked') !== 'true') { o.click(); await human(250); }
    }
    await closeDropdown();
  };
  await multi('color-select-dropdown-input', job.colours, 'Colour');
  await multi('category-material-multi-list-input', job.materials, 'Material');

  // 8. Price and parcel size.
  const price = $('[data-testid="price-input--input"]');
  if (!price) return fail('Could not find the price field.');
  const priceText = String(Number(job.price || 0)).replace(/\.0+$/, '');
  await typeInto(price, priceText);
  await human(400);
  // Vinted shows its own validation message if the price didn't register; fail loudly rather than upload £0.
  const priceError = $$('*').some((e) => !e.children.length && /price must be/i.test(e.textContent || ''));
  if (priceError) return fail(`Vinted didn't accept the price £${priceText}. Type it into the price box on Vinted.`);
  const pkg = document.getElementById(`package_type_selector_${{ small: 1, medium: 2, large: 3 }[job.package_size] || 2}`);
  if (pkg) pkg.click();
  await human(800);

  if (!submit) return { ok: true, filled: true, notes };

  // 9. Upload. The page navigates away on success; the extension watches for that.
  const btn = $('[data-testid="upload-form-save-button"]');
  if (!btn) return fail('Could not find the Upload button.');
  btn.click();
  return { ok: true, submitted: true, notes };
}

// Collects Vinted's validation messages if an upload didn't go through.
function readVintedErrors() {
  const texts = [...document.querySelectorAll('[role="alert"], [class*="validation"], [class*="error"], [data-testid$="--error"], [data-testid*="error"]')]
    .map((e) => (e.innerText || '').trim())
    .filter((t) => t && t.length < 200);
  return [...new Set(texts)].slice(0, 5);
}
