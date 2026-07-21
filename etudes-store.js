/* Local IndexedDB store for generated etudes.
 *
 * Schema: one object store `etudes`, keyPath `id` (string, e.g. "etude_<uuid>").
 * Each row: {
 *   id          : string   // unique etude id, prefixed "etude_"
 *   name        : string   // user-given or auto-assigned
 *   exerciseIds : number[] // canonical exercise ids from /exercises.json, in order
 *   semitones   : number[] // per-exercise transpose semitones, parallel to exerciseIds
 *   mode        : string   // 'composer' or 'random' for display hint
 *   source      : string   // 'composer' | 'random'
 *   musicxml    : string   // precomputed stitched MusicXML (cache so we don't recompute)
 *   noteCount   : number   // precomputed note count (for the saved-etudes list)
 *   createdAt   : string   // ISO timestamp
 * }.
 *
 * The stitched MusicXML is cached so the Practice page can render it without
 * re-fetching the 2-12 source exercises. Future renders can also re-stitch
 * on demand (e.g. to apply new range-clamp semantics) — the cache is an
 * optimisation, not a contract.
 *
 * Used by etudes.html (composer / generator UI) and by practice.js (when the
 * URL has ?id=etude_<uuid>, the practice page reads musicxml from here
 * instead of from /api/musicxml/<id>).
 */
(function () {
  'use strict';

  const DB_NAME = 'bob_mover_etudes';
  const DB_VERSION = 1;
  const STORE = 'etudes';

  let _dbPromise = null;

  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }

  function tx(mode) {
    return open().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function _reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // Generate a fresh etude id ("etude_<uuid>"). crypto.randomUUID is widely
  // available in modern browsers; the fallback uses Math.random for older
  // browsers (good enough as a local-only key).
  function newId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'etude_' + crypto.randomUUID();
    }
    return 'etude_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  // Save (or overwrite) an etude. `record.id` is assigned if missing.
  // Returns the assigned id.
  async function saveEtude(record) {
    if (!record) throw new Error('saveEtude: record is required');
    if (!record.exerciseIds || !record.exerciseIds.length) {
      throw new Error('saveEtude: exerciseIds is required and non-empty');
    }
    if (!record.musicxml) {
      throw new Error('saveEtude: musicxml is required');
    }
    if (!record.id) record.id = newId();
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    if (!record.semitones || record.semitones.length !== record.exerciseIds.length) {
      // Default: 0 semitones per exercise if the caller didn't supply them
      const out = [];
      for (let i = 0; i < record.exerciseIds.length; i++) out.push(0);
      record.semitones = out;
    }
    if (!record.source) record.source = 'composer';
    if (!record.name) record.name = 'Untitled Etude';
    const store = await tx('readwrite');
    await _reqToPromise(store.put(record));
    return record.id;
  }

  // Return all etudes, newest first.
  async function listEtudes() {
    const store = await tx('readonly');
    const all = await _reqToPromise(store.getAll());
    all.sort(function (a, b) {
      return (b.createdAt > a.createdAt) ? 1 : (b.createdAt < a.createdAt ? -1 : 0);
    });
    return all;
  }

  // Return one etude by id; resolves to undefined if not found.
  async function getEtude(id) {
    if (!id) return undefined;
    const store = await tx('readonly');
    return _reqToPromise(store.get(id));
  }

  // Delete an etude by id.
  async function deleteEtude(id) {
    if (!id) return;
    const store = await tx('readwrite');
    return _reqToPromise(store.delete(id));
  }

  // Convenience: count.
  async function countEtudes() {
    const store = await tx('readonly');
    return _reqToPromise(store.count());
  }

  // Update an etude's name in place.
  async function renameEtude(id, newName) {
    if (!id || !newName) return;
    const store = await tx('readwrite');
    const e = await _reqToPromise(store.get(id));
    if (!e) return;
    e.name = newName;
    return _reqToPromise(store.put(e));
  }

  window.etudesStore = {
    open: open,
    newId: newId,
    saveEtude: saveEtude,
    listEtudes: listEtudes,
    getEtude: getEtude,
    deleteEtude: deleteEtude,
    renameEtude: renameEtude,
    countEtudes: countEtudes,
  };
})();
