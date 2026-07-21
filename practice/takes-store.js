/* Local IndexedDB store for audio practice takes.
 *
 * Schema: one object store `takes`, keyPath `id` (auto-incrementing).
 * Each row: { id, exerciseId, durationMs, mime, size, filename, createdAt (ISO), blob }.
 *
 * Used by practice.js — opened lazily on first use, kept open for the session.
 */
(function () {
  'use strict';

  const DB_NAME = 'bob_mover_takes';
  const DB_VERSION = 1;
  const STORE = 'takes';

  let _dbPromise = null;

  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
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

  // Add a new take; returns the assigned id.
  async function addTake(record) {
    const store = await tx('readwrite');
    return _reqToPromise(store.add(record));
  }

  // Return all takes, newest first.
  async function listTakes() {
    const store = await tx('readonly');
    return _reqToPromise(store.getAll());
  }

  // Return takes for a single exercise (newest first).
  async function listTakesForExercise(exerciseId) {
    const all = await listTakes();
    return all
      .filter((t) => t.exerciseId === exerciseId)
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  // Get one take by id; resolves to undefined if not found.
  async function getTake(id) {
    const store = await tx('readonly');
    return _reqToPromise(store.get(id));
  }

  // Delete a take by id.
  async function deleteTake(id) {
    const store = await tx('readwrite');
    return _reqToPromise(store.delete(id));
  }

  // Convenience: count.
  async function countTakes() {
    const store = await tx('readonly');
    return _reqToPromise(store.count());
  }

  window.takesStore = {
    open: open,
    addTake: addTake,
    listTakes: listTakes,
    listTakesForExercise: listTakesForExercise,
    getTake: getTake,
    deleteTake: deleteTake,
    countTakes: countTakes,
  };
})();