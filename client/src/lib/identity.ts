// Per-tab identity. sessionStorage survives refreshes (so the host keeps the host role) but is separate
// per tab, so two tabs in the same browser act as two different people.

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

let cachedClientId: string | null = null;

export function getClientId(): string {
  if (cachedClientId) return cachedClientId;
  cachedClientId = safeGet(sessionStorage, 'wt:clientId') ?? randomId();
  safeSet(sessionStorage, 'wt:clientId', cachedClientId);
  return cachedClientId;
}

export function getSavedName(): string {
  return safeGet(localStorage, 'wt:name') ?? '';
}

export function saveName(name: string) {
  safeSet(localStorage, 'wt:name', name);
}
