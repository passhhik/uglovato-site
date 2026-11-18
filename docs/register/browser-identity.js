// The private signing key never leaves WebCrypto. IndexedDB structured-clones the key across documents.
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
const encoder = new TextEncoder();
const storeName = 'identity';
const entry = 'current';
let database;

function failure(code) { return Object.assign(new Error(code), { code }); }
function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function openStore() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('uglovato-browser-v1', 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onerror = request.onblocked = () => { blocked = true; reject(failure('browser_storage')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onclose = () => { database = undefined; };
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
    }).catch(() => { database = undefined; throw failure('browser_storage'); });
  }
  return database;
}

// Read, compare and update within one transaction, including concurrent tabs.
async function transaction(mode, apply) {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const read = store.get(entry);
    let value;
    read.onsuccess = () => {
      try { value = apply(read.result, store); } catch { tx.abort(); }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error);
  }).catch(() => { throw failure('browser_storage'); });
}

export function existingIdentity() { return transaction('readonly', current => current); }

async function getIdentity() {
  const existing = await existingIdentity();
  if (existing) return existing;
  if (!globalThis.crypto?.subtle) throw failure('browser_crypto');
  const pair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  const publicKey = encode(await crypto.subtle.exportKey('spki', pair.publicKey));
  const fresh = { privateKey:pair.privateKey, publicKey, sid:null };
  return transaction('readwrite', (current, store) => {
    if (current) return current;
    store.put(fresh, entry);
    return fresh;
  });
}

export async function prepare(op, exactBody) {
  const identity = await getIdentity();
  const headers = { 'X-Uglovato-Browser':'v1', 'X-Uglovato-Public-Key':identity.publicKey };
  if (identity.sid) {
    const time = String(Math.floor(Date.now() / 1000));
    const nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
    const hash = encode(await crypto.subtle.digest('SHA-256', encoder.encode(exactBody)));
    const message = JSON.stringify(['uglovato-browser-v1', op, identity.sid, time, nonce, hash]);
    const raw = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, identity.privateKey, encoder.encode(message));
    if (raw.byteLength !== 64) throw failure('browser_crypto');
    Object.assign(headers, {'X-Uglovato-Session':identity.sid,'X-Uglovato-Time':time,
      'X-Uglovato-Nonce':nonce,'X-Uglovato-Proof':encode(raw)});
  }
  return { identity, headers };
}

export function replaceSession(old, sid) {
  return transaction('readwrite', (current, store) => {
    if (!current || current.publicKey !== old.publicKey || current.sid !== old.sid) return false;
    if (sid === null) store.delete(entry);
    else store.put({...current, sid}, entry);
    return true;
  });
}
