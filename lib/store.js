// Tiny JSON-file store. One user, low volume, so a file on a Railway volume is plenty.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = { batches: [], items: [] };
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        const backup = this.file + '.corrupt-' + Date.now();
        fs.copyFileSync(this.file, backup);
        console.error('db.json unreadable, backed up to', backup);
      }
    }
    this.data.batches ||= [];
    this.data.items ||= [];
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  id() {
    return crypto.randomUUID();
  }

  // The open batch is where new items land until she approves it.
  currentBatch() {
    let batch = this.data.batches.find((b) => b.status === 'open');
    if (!batch) {
      batch = { id: this.id(), status: 'open', createdAt: new Date().toISOString() };
      this.data.batches.push(batch);
      this.save();
    }
    return batch;
  }

  itemsIn(batchId) {
    return this.data.items
      .filter((i) => i.batchId === batchId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getItem(id) {
    return this.data.items.find((i) => i.id === id);
  }

  addItem(item) {
    this.data.items.push(item);
    this.save();
    return item;
  }

  updateItem(id, patch) {
    const item = this.getItem(id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return item;
  }

  removeItem(id) {
    const idx = this.data.items.findIndex((i) => i.id === id);
    if (idx === -1) return null;
    const [item] = this.data.items.splice(idx, 1);
    this.save();
    return item;
  }

  closeBatch(id) {
    const batch = this.data.batches.find((b) => b.id === id);
    if (batch) {
      batch.status = 'approved';
      batch.approvedAt = new Date().toISOString();
      this.save();
    }
    return batch;
  }
}

module.exports = Store;
