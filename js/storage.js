// REA Studio — browser autosave (IndexedDB) for the session and its audio.
REA.storage = (() => {
  const DB = 'rea-studio';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('audio');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  return {
    saveSession: (project) => tx('kv', 'readwrite', (s) => s.put(JSON.stringify(project), 'session')),
    loadSession: async () => {
      const raw = await tx('kv', 'readonly', (s) => s.get('session'));
      return raw ? JSON.parse(raw) : null;
    },
    saveAudio: (id, name, buffer) => {
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
      return tx('audio', 'readwrite', (s) => s.put({ name, sampleRate: buffer.sampleRate, channels }, id));
    },
    loadAudio: async (id) => {
      const rec = await tx('audio', 'readonly', (s) => s.get(id));
      if (!rec) return null;
      const buffer = new AudioBuffer({ length: rec.channels[0].length, numberOfChannels: rec.channels.length, sampleRate: rec.sampleRate });
      rec.channels.forEach((d, c) => buffer.copyToChannel(d, c));
      return { name: rec.name, buffer };
    },
    pruneAudio: async (keep) => {
      const keys = await tx('audio', 'readonly', (s) => s.getAllKeys());
      const stale = (keys || []).filter((k) => !keep.has(k));
      if (stale.length) await tx('audio', 'readwrite', (s) => { stale.forEach((k) => s.delete(k)); });
    },
    clear: () => Promise.all([tx('kv', 'readwrite', (s) => s.clear()), tx('audio', 'readwrite', (s) => s.clear())]),
  };
})();
