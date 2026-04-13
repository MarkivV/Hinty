import { safeStorage } from 'electron';
import Store from 'electron-store';

interface StoredAuth {
  encryptedToken: string; // base64-encoded encrypted JWT
  user: {
    id: number;
    email: string;
    tier: string;
  } | null;
}

const store = new Store<{ auth: StoredAuth }>({
  name: 'hinty-auth',
  defaults: {
    auth: {
      encryptedToken: '',
      user: null,
    },
  },
});

export function saveToken(token: string, user: StoredAuth['user']): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token);
    store.set('auth', {
      encryptedToken: encrypted.toString('base64'),
      user,
    });
  } else {
    // Fallback: store unencrypted (dev only)
    store.set('auth', { encryptedToken: token, user });
  }
  console.log('[auth] Token saved for', user?.email);
}

export function getToken(): string | null {
  const { encryptedToken } = store.get('auth');
  if (!encryptedToken) return null;

  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buffer = Buffer.from(encryptedToken, 'base64');
      return safeStorage.decryptString(buffer);
    }
    return encryptedToken;
  } catch {
    console.warn('[auth] Failed to decrypt token, clearing');
    clearAuth();
    return null;
  }
}

export function getStoredUser(): StoredAuth['user'] {
  return store.get('auth').user;
}

export function clearAuth(): void {
  store.set('auth', { encryptedToken: '', user: null });
  console.log('[auth] Cleared stored auth');
}

export function isAuthenticated(): boolean {
  return !!getToken() && !!getStoredUser();
}
