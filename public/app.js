/* OnePost phone app. Vanilla JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n || n === 0 ? '£' + Number(n).toFixed(Number(n) % 1 ? 2 : 0) : '');
  const CONDITIONS = ['New with tags', 'New without tags', 'Very good', 'Good', 'Satisfactory'];

  let state = { batch: null, items: [], openId: null, pollTimer: null };
  let pending = []; // { file, blob, url } for the item being added

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { renderLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // Shrink to max 1600px JPEG on the phone: faster uploads, cheaper AI, and HEIC becomes JPEG.
  function compress(file, max = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('Could not read photo')); }, 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read photo')); };
      img.src = url;
    });
  }

  function setTab(name) {
    $('#tabs').hidden = false;
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));
  }

  function updateBadge() {
    const n = state.items.length;
    const b = $('#reviewCount');
    b.hidden = !n;
    b.textContent = n;
  }

  async function loadBatch() {
    const data = await api('/batch/current');
    state.batch = data.batch;
    state.items = data.items;
    updateBadge();
    return data;
  }

  function schedulePoll(render) {
    clearTimeout(state.pollTimer);
    if (state.items.some((i) => i.status === 'queued' || i.status === 'drafting')) {
      state.pollTimer = setTimeout(async () => {
        try { await loadBatch(); render(); } catch {}
      }, 3000);
    }
  }

  // ---------- login ----------
  function renderLogin() {
    $('#tabs').hidden = true;
    view.innerHTML = `
      <div class="login">
        <span class="mark">1</span>
        <h1>OnePost</h1>
        <p class="sub">Sign in to start listing.</p>
        <form id="lf">
          <input type="email" id="em" placeholder="Email" autocomplete="username" inputmode="email" autocapitalize="off" />
          <input type="password" id="pc" placeholder="Passcode" autocomplete="current-password" inputmode="numeric" />
          <button class="btn" type="submit">Sign in</button>
          <div class="err" id="le"></div>
        </form>
      </div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/login', { method: 'POST', body: { email: $('#em').value, passcode: $('#pc').value } });
        location.hash = '#/add';
        route();
      } catch (err) { $('#le').textContent = err.message; }
    };
  }

  // ---------- add item ----------
  function renderAdd() {
    setTab('add');
    const n = state.items.length;
    const ready = state.items.filter((i) => i.status === 'ready').length;
    view.innerHTML = `
      <h1>Item ${n + 1}</h1>
      <p class="sub">Photos, a quick note and your price. AI writes the rest.</p>

      <div class="card">
        <span class="label">Photos <span class="count">${pending.length ? pending.length + ' added' : 'First photo is the cover'}</span></span>
        <div class="photos ${pending.length ? '' : 'empty'}" id="phs">
          ${pending.map((p, i) => `
            <div class="ph"><img src="${p.url}" alt="" />
              ${i === 0 ? '<span class="cover">Cover</span>' : ''}
              <button type="button" data-rm="${i}" aria-label="Remove photo">×</button>
            </div>`).join('')}
          <label class="addph"><span class="plus">+</span>${pending.length ? 'More' : 'Add photos'}
            <input type="file" id="file" accept="image/*" multiple hidden />
          </label>
        </div>
      </div>

      <div class="card">
        <div class="field">
          <label class="label" for="note">Quick description</label>
          <textarea id="note" rows="3" placeholder="e.g. Zara wool coat, size 12, small mark on left cuff, RRP £89">${esc(sessionStorage.getItem('op_note') || '')}</textarea>
        </div>
        <div class="field">
          <label class="label" for="price">Your price</label>
          <div class="price"><span>£</span><input id="price" inputmode="decimal" placeholder="Leave blank for a suggestion" value="${esc(sessionStorage.getItem('op_price') || '')}" /></div>
        </div>
      </div>

      <div class="dock">
        <div>
          <button class="btn" id="save" ${pending.length ? '' : 'disabled'}>Save &amp; next item</button>
          <div class="progress" id="prog" hidden><i></i></div>
          <div class="meta">${n ? `${n} in this batch, ${ready} ready · <a href="#/review">Review batch</a>` : 'Add as many items as you like, then review them together'}</div>
        </div>
      </div>`;

    $('#note').oninput = (e) => sessionStorage.setItem('op_note', e.target.value);
    $('#price').oninput = (e) => sessionStorage.setItem('op_price', e.target.value);

    $('#file').onchange = async (e) => {
      const files = [...e.target.files].slice(0, 12 - pending.length);
      if (!files.length) return;
      toast('Preparing photos…');
      for (const f of files) {
        try {
          const blob = await compress(f);
          pending.push({ blob, url: URL.createObjectURL(blob) });
        } catch (err) { toast(err.message); }
      }
      renderAdd();
    };
    view.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
      const [p] = pending.splice(Number(b.dataset.rm), 1);
      URL.revokeObjectURL(p.url);
      renderAdd();
    }));

    $('#save').onclick = () => saveItem();
  }

  function saveItem() {
    const btn = $('#save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading';
    const prog = $('#prog');
    prog.hidden = false;

    const fd = new FormData();
    pending.forEach((p, i) => fd.append('photos', p.blob, `photo-${i + 1}.jpg`));
    fd.append('note', $('#note').value.trim());
    fd.append('price', $('#price').value.trim());

    // XHR for upload progress on slower mobile connections.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/items');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) prog.firstElementChild.style.width = (e.loaded / e.total) * 100 + '%'; };
    xhr.onload = async () => {
      if (xhr.status === 401) return renderLogin();
      if (xhr.status >= 300) {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        toast(msg);
        btn.disabled = false;
        btn.textContent = 'Try again';
        return;
      }
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      pending = [];
      sessionStorage.removeItem('op_note');
      sessionStorage.removeItem('op_price');
      await loadBatch().catch(() => {});
      toast(`Item ${state.items.length} saved, AI is drafting it`);
      window.scrollTo(0, 0);
      renderAdd();
    };
    xhr.onerror = () => { toast('No connection, try again'); btn.disabled = false; btn.textContent = 'Try again'; };
    xhr.send(fd);
  }

  // ---------- review ----------
  function itemTitle(i) {
    return i.draft?.vinted_title || i.draft?.ebay_title || i.note || 'Untitled item';
  }

  function renderReview() {
    setTab('review');
    const items = state.items;
    const ready = items.filter((i) => i.status === 'ready').length;
    const busy = items.filter((i) => i.status === 'queued' || i.status === 'drafting').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const checks = items.filter((i) => i.draft?.checks?.length).length;

    if (!items.length) {
      view.innerHTML = `
        <h1>Review</h1>
        <div class="empty-state"><div class="big">📸</div>Nothing to review yet.<br/>Add some items first.</div>
        <a class="btn ghost" href="#/add">Add an item</a>`;
      return;
    }

    view.innerHTML = `
      <h1>Review batch</h1>
      <p class="sub">${items.length} item${items.length > 1 ? 's' : ''} · ${ready} ready${busy ? ` · ${busy} drafting` : ''}${failed ? ` · ${failed} failed` : ''}${checks ? ` · ${checks} to check` : ''}</p>
      <div id="list">${items.map(itemCard).join('')}</div>
      <div class="dock"><div>
        <button class="btn" id="approve" ${ready === items.length ? '' : 'disabled'}>
          ${busy ? '<span class="spinner"></span> Drafting ' + busy + ' more' : `Approve ${items.length} listing${items.length > 1 ? 's' : ''}`}
        </button>
        <div class="meta"><a href="#/add">+ Add another item</a></div>
      </div></div>`;

    bindReview();
    schedulePoll(() => { if (location.hash.startsWith('#/review') && !document.activeElement?.matches('input,textarea,select')) renderReview(); });
  }

  function itemCard(i) {
    const d = i.draft || {};
    const open = state.openId === i.id;
    const cover = i.photos[0] ? `/photos/${i.photos[0]}` : '';
    const status = i.status === 'queued' ? 'drafting' : i.status;
    const titleLen = (d.ebay_title || '').length;
    return `
      <div class="card item ${open ? 'open' : ''}" data-id="${i.id}">
        <div class="head" data-toggle>
          <img class="thumb" src="${cover}" alt="" loading="lazy" />
          <div class="info">
            <div class="t">${esc(itemTitle(i))}</div>
            <div class="m"><span class="pill ${status}">${status === 'drafting' ? 'Drafting' : status === 'ready' ? (d.checks?.length ? 'Check' : 'Ready') : 'Failed'}</span>
              ${d.condition ? ' · ' + esc(d.condition) : ''}${d.size ? ' · ' + esc(d.size) : ''}</div>
          </div>
          <div class="p">${money(d.price ?? i.price)}</div>
        </div>
        <div class="body">
          <div class="strip">${i.photos.map((p) => `<img src="/photos/${p}" alt="" loading="lazy" />`).join('')}</div>
          ${i.note ? `<p class="note">Your note: ${esc(i.note)}</p>` : ''}
          ${i.status === 'failed' ? `<div class="checks"><b>AI couldn't draft this one</b>${esc(i.error || '')}</div>
            <div class="btnrow"><button class="btn small" data-redraft>Try again</button><button class="btn small danger" data-del>Delete</button></div>` : ''}
          ${i.status === 'ready' ? `
            ${d.checks?.length ? `<div class="checks"><b>Please check</b><ul>${d.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
            <div class="toggles">
              <button type="button" class="tg ${i.platforms.ebay ? 'on' : ''}" data-plat="ebay"><span class="box">${i.platforms.ebay ? '✓' : ''}</span>eBay</button>
              <button type="button" class="tg ${i.platforms.vinted ? 'on' : ''}" data-plat="vinted"><span class="box">${i.platforms.vinted ? '✓' : ''}</span>Vinted</button>
            </div>
            <div class="field"><label class="label">eBay title <span class="count ${titleLen > 80 ? 'over' : ''}" data-cnt>${titleLen}/80</span></label>
              <input type="text" data-f="ebay_title" value="${esc(d.ebay_title)}" maxlength="80" /></div>
            <div class="field"><label class="label">Vinted title</label><input type="text" data-f="vinted_title" value="${esc(d.vinted_title)}" /></div>
            <div class="field"><label class="label">Description</label><textarea data-f="description" rows="6">${esc(d.description)}</textarea></div>
            <div class="row2">
              <div class="field"><label class="label">Price</label><div class="price"><span>£</span><input inputmode="decimal" data-f="price" value="${esc(d.price)}" /></div></div>
              <div class="field"><label class="label">Condition</label><select data-f="condition">${CONDITIONS.map((c) => `<option ${c === d.condition ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
            </div>
            <div class="row2">
              <div class="field"><label class="label">Brand</label><input type="text" data-f="brand" value="${esc(d.brand)}" /></div>
              <div class="field"><label class="label">Size</label><input type="text" data-f="size" value="${esc(d.size)}" /></div>
            </div>
            <div class="row2">
              <div class="field"><label class="label">Colour</label><input type="text" data-f="colour" value="${esc(d.colour)}" /></div>
              <div class="field"><label class="label">Material</label><input type="text" data-f="material" value="${esc(d.material)}" /></div>
            </div>
            <div class="field"><label class="label">Category</label><input type="text" data-f="category" value="${esc(d.category)}" /></div>
            <div class="field"><label class="label">Parcel size</label><select data-f="package_size">${[['small', 'Small (large envelope)'], ['medium', 'Medium (shoebox)'], ['large', 'Large (moving box)']].map(([v, l]) => `<option value="${v}" ${v === (d.package_size || 'medium') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <div class="btnrow"><button class="btn small ghost" data-redraft>Redraft with AI</button><button class="btn small danger" data-del>Delete item</button></div>
          ` : ''}
          ${status === 'drafting' ? '<p class="note"><span class="spinner"></span> AI is writing this listing…</p>' : ''}
        </div>
      </div>`;
  }

  function bindReview() {
    view.querySelectorAll('.item').forEach((card) => {
      const id = card.dataset.id;
      const item = () => state.items.find((x) => x.id === id);

      $('[data-toggle]', card).onclick = () => {
        state.openId = state.openId === id ? null : id;
        card.classList.toggle('open', state.openId === id);
        view.querySelectorAll('.item').forEach((c) => c !== card && c.classList.remove('open'));
      };

      // Save edits on blur so nothing is lost if she closes the app.
      card.querySelectorAll('[data-f]').forEach((el) => {
        if (el.dataset.f === 'ebay_title') el.oninput = () => {
          const c = $('[data-cnt]', card);
          c.textContent = el.value.length + '/80';
          c.classList.toggle('over', el.value.length > 80);
        };
        el.onchange = async () => {
          try {
            const updated = await api('/items/' + id, { method: 'PATCH', body: { draft: { [el.dataset.f]: el.value } } });
            Object.assign(item(), updated);
            const t = $('.t', card); if (t) t.textContent = itemTitle(updated);
            const p = $('.p', card); if (p) p.textContent = money(updated.draft.price);
          } catch (err) { toast(err.message); }
        };
      });

      card.querySelectorAll('[data-plat]').forEach((b) => (b.onclick = async () => {
        const plat = { ...item().platforms, [b.dataset.plat]: !item().platforms[b.dataset.plat] };
        try {
          const updated = await api('/items/' + id, { method: 'PATCH', body: { platforms: plat } });
          Object.assign(item(), updated);
          b.classList.toggle('on', updated.platforms[b.dataset.plat]);
          $('.box', b).textContent = updated.platforms[b.dataset.plat] ? '✓' : '';
        } catch (err) { toast(err.message); }
      }));

      const rd = $('[data-redraft]', card);
      if (rd) rd.onclick = async () => {
        const note = prompt('Anything to add for the AI? (optional)', item().note || '');
        if (note === null) return;
        await api(`/items/${id}/redraft`, { method: 'POST', body: { note } });
        await loadBatch();
        renderReview();
      };

      const del = $('[data-del]', card);
      if (del) del.onclick = async () => {
        if (!confirm('Delete this item and its photos?')) return;
        await api('/items/' + id, { method: 'DELETE' });
        state.openId = null;
        await loadBatch();
        renderReview();
        toast('Item deleted');
      };
    });

    $('#approve').onclick = async () => {
      const ebay = state.items.filter((i) => i.platforms.ebay).length;
      const vinted = state.items.filter((i) => i.platforms.vinted).length;
      if (!confirm(`Approve ${state.items.length} listings?\n\neBay: ${ebay}\nVinted: ${vinted}`)) return;
      try {
        await api(`/batch/${state.batch.id}/approve`, { method: 'POST' });
        await loadBatch();
        toast('Batch approved');
        location.hash = '#/listed';
      } catch (err) { toast(err.message); }
    };
  }

  // ---------- listed ----------
  async function renderListed() {
    setTab('listed');
    view.innerHTML = '<h1>Listed</h1><p class="sub"><span class="spinner"></span></p>';
    const [{ items }, ws] = await Promise.all([api('/listings'), api('/worker-status').catch(() => ({}))]);
    if (!items.length) {
      view.innerHTML = `<h1>Listed</h1><div class="empty-state"><div class="big">🏷️</div>Approved listings will appear here.</div>`;
      return;
    }
    const active = items.filter((i) => i.status !== 'sold');
    const sold = items.filter((i) => i.status === 'sold');
    const waiting = active.filter((i) => ['pending', 'posting'].includes(chState(i, 'vinted'))).length;
    view.innerHTML = `
      <h1>Listed</h1>
      <p class="sub">${active.length} active · ${sold.length} sold</p>
      ${workerBanner(ws, waiting)}
      ${active.map(listedCard).join('')}
      ${sold.length ? `<h2 class="label" style="margin:22px 0 10px">Sold</h2>${sold.map(listedCard).join('')}` : ''}`;
    bindListed(items);
    clearTimeout(state.pollTimer);
    if (waiting) state.pollTimer = setTimeout(() => { if (location.hash.startsWith('#/listed')) renderListed().catch(() => {}); }, 15000);
  }

  function workerBanner(ws, waiting) {
    if (!ws || !ws.configured) return '';
    const age = ws.seen ? (Date.now() - Date.parse(ws.seen.at)) / 60000 : Infinity;
    const online = age < 3;
    if (online && !waiting) return '';
    return `<div class="${online ? 'card' : 'checks'}" style="${online ? 'padding:12px 14px;font-size:14px' : ''}">
      ${online ? `<span class="spinner"></span> Posting to Vinted: ${waiting} to go, a couple of minutes apart`
        : `<b>Vinted poster is offline</b>${waiting ? `${waiting} item${waiting > 1 ? 's are' : ' is'} waiting. ` : ''}Open the MacBook with Chrome running and they'll post automatically.`}
    </div>`;
  }

  function chState(i, ch) {
    const s = i.channels?.[ch];
    if (!s) return null;
    return s.state;
  }

  function listedCard(i) {
    const d = i.draft || {};
    const chRow = (ch, name) => {
      const c = i.channels?.[ch];
      const s = chState(i, ch);
      if (!s) return '';
      const labels = { pending: ch === 'vinted' ? 'Queued' : 'To post', posting: 'Posting…', live: 'Live', removed: 'Removed', attention: 'Needs a hand' };
      const cls = { pending: 'pending', posting: 'drafting', live: 'live', removed: 'removed', attention: 'failed' }[s] || s;
      const assist = ch === 'vinted' ? '<button class="btn small ghost" data-copy>Copy text</button><button class="btn small ghost" data-save>Photos</button>' : '';
      let actions = '';
      if (i.status !== 'sold') {
        if (s === 'pending' && ch !== 'vinted') actions = `<button class="btn small" data-mark="${ch}:live">Mark live</button>`;
        if (s === 'attention') actions = `<button class="btn small ghost" data-mark="${ch}:pending">Retry</button>${assist}<button class="btn small" data-mark="${ch}:live">Mark live</button>`;
        if (s === 'live') actions = `${c.url ? `<a class="btn small ghost" href="${esc(c.url)}" target="_blank" rel="noopener">View</a>` : ''}<button class="btn small ghost" data-sold="${ch}">Sold here</button>`;
      } else if (s === 'live' && i.soldOn !== ch) {
        actions = `<button class="btn small" data-mark="${ch}:removed">Mark removed</button>`;
      }
      const err = s === 'attention' && c.error ? `<div class="note" style="margin:6px 0 0">${esc(c.error)}</div>` : '';
      return `<div class="ch" style="flex-wrap:wrap"><div><span class="n">${name}</span> <span class="pill ${cls}">${labels[s] || s}</span>${err}</div><div class="btnrow">${actions}</div></div>`;
    };
    const needsRemoval = i.status === 'sold' && ['ebay', 'vinted'].some((c) => c !== i.soldOn && chState(i, c) === 'live');
    return `
      <div class="card item open" data-id="${i.id}">
        <div class="head">
          <img class="thumb" src="/photos/${i.photos[0]}" alt="" loading="lazy" />
          <div class="info"><div class="t">${esc(itemTitle(i))}</div>
            <div class="m">${i.status === 'sold' ? `<span class="pill sold">Sold${i.soldOn ? ' on ' + (i.soldOn === 'ebay' ? 'eBay' : 'Vinted') : ''}</span>` : esc(d.condition || '')}</div></div>
          <div class="p">${money(d.price)}</div>
        </div>
        <div class="body" style="padding-top:4px">
          ${needsRemoval ? `<div class="checks"><b>Remove the other listing</b>This sold, so take it down on ${i.soldOn === 'ebay' ? 'Vinted' : 'eBay'} now to avoid a double sale.</div>` : ''}
          <div class="channels">${chRow('ebay', 'eBay')}${chRow('vinted', 'Vinted')}</div>
        </div>
      </div>`;
  }

  function bindListed(items) {
    view.querySelectorAll('.item').forEach((card) => {
      const i = items.find((x) => x.id === card.dataset.id);
      const d = i.draft || {};

      const copy = $('[data-copy]', card);
      if (copy) copy.onclick = async () => {
        const text = `${d.vinted_title}\n\n${d.description}`;
        try { await navigator.clipboard.writeText(text); toast('Title and description copied'); }
        catch { prompt('Copy this text', text); }
      };

      const save = $('[data-save]', card);
      if (save) save.onclick = async () => {
        try {
          const files = await Promise.all(i.photos.map(async (p, n) => {
            const b = await (await fetch('/photos/' + p)).blob();
            return new File([b], `item-${n + 1}.jpg`, { type: 'image/jpeg' });
          }));
          if (navigator.canShare && navigator.canShare({ files })) {
            await navigator.share({ files }); // iPhone: choose "Save Images"
          } else {
            i.photos.forEach((p) => window.open('/photos/' + p, '_blank'));
          }
        } catch (err) { if (err.name !== 'AbortError') toast('Could not share photos'); }
      };

      card.querySelectorAll('[data-mark]').forEach((b) => (b.onclick = async () => {
        const [channel, st] = b.dataset.mark.split(':');
        await api(`/items/${i.id}/channel`, { method: 'POST', body: { channel, state: st } });
        renderListed();
      }));

      card.querySelectorAll('[data-sold]').forEach((b) => (b.onclick = async () => {
        const on = b.dataset.sold;
        if (!confirm(`Mark as sold on ${on === 'ebay' ? 'eBay' : 'Vinted'}?`)) return;
        await api(`/items/${i.id}/sold`, { method: 'POST', body: { on } });
        renderListed();
      }));
    });
  }

  // ---------- router ----------
  async function route() {
    clearTimeout(state.pollTimer);
    try {
      const me = await api('/me');
      $('#demo').hidden = !me.demo;
      if (!me.signedIn) return renderLogin();
      await loadBatch();
    } catch { return; }
    const h = location.hash || '#/add';
    if (h.startsWith('#/review')) renderReview();
    else if (h.startsWith('#/listed')) renderListed().catch((e) => toast(e.message));
    else renderAdd();
  }

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !location.hash.startsWith('#/add')) route(); });
  route();
})();
