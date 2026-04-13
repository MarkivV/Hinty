import { shell } from 'electron';
import http from 'http';
import { saveToken, getToken, getStoredUser, clearAuth, isAuthenticated } from './tokenStore';
import { getGeneralWindow } from '../windows/general';
import crypto from 'crypto';
import { syncSessionList, wipeLocalCache } from '../db/repository';

const API_BASE = 'https://hinty-web.vercel.app';

export { isAuthenticated, getToken, getStoredUser, clearAuth };

// ── Auth state for deep link verification ──
let pendingAuthState: string | null = null;

// ── Local HTTP server (only for Stripe upgrade callback) ──
let callbackServer: http.Server | null = null;
let callbackPort: number | null = null;

function ensureCallbackServer(): Promise<number> {
  if (callbackServer && callbackPort) return Promise.resolve(callbackPort);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      if (url.pathname === '/upgrade/callback') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Hinty</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0a0a0b; color: white; margin: 0;">
  <div style="text-align: center;">
    <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">Upgrade successful!</h2>
    <p style="color: #666; font-size: 14px;">You can close this tab and return to Hinty.</p>
  </div>
</body>
</html>`);

        const general = getGeneralWindow();
        if (general && !general.isDestroyed()) {
          general.show();
          general.focus();
        }

        // Poll for tier change
        const prevUser = getStoredUser();
        const prevTier = prevUser?.tier || 'free';
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise(r => setTimeout(r, 2500));
          await refreshProfile();
          notifyRenderer();
          const updated = getStoredUser();
          if (updated?.tier && updated.tier !== prevTier) {
            console.log('[stripe] Tier updated to', updated.tier);
            break;
          }
          console.log('[stripe] Waiting for tier update... attempt', attempt + 1);
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        callbackPort = addr.port;
        callbackServer = server;
        console.log('[auth] Callback server listening on port', callbackPort);
        resolve(callbackPort);
      } else {
        reject(new Error('Failed to start callback server'));
      }
    });

    server.on('error', reject);
  });
}

// ── Deep link handler (called from index.ts) ──
export async function handleDeepLink(url: string): Promise<void> {
  console.log('[auth] Deep link received:', url);
  try {
    const parsed = new URL(url);

    if (parsed.host === 'auth' || parsed.pathname === '/auth') {
      const sessionToken = parsed.searchParams.get('token');
      const state = parsed.searchParams.get('state');
      await handleAuthCallback(sessionToken, state);
    } else if (parsed.host === 'upgrade' || parsed.pathname === '/upgrade') {
      // Focus app and refresh profile
      const general = getGeneralWindow();
      if (general && !general.isDestroyed()) {
        general.show();
        general.focus();
      }
      const prevUser = getStoredUser();
      const prevTier = prevUser?.tier || 'free';
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise(r => setTimeout(r, 2500));
        await refreshProfile();
        notifyRenderer();
        const updated = getStoredUser();
        if (updated?.tier && updated.tier !== prevTier) {
          console.log('[stripe] Tier updated to', updated.tier);
          break;
        }
      }
    }
  } catch (err) {
    console.error('[auth] Deep link error:', err);
  }
}

// Open the sign-in page in the system browser
// Uses /api/auth/desktop-login (server-side redirect) to:
// 1. Clear Clerk session cookies (forces fresh sign-in / account picker)
// 2. Redirect to /sign-in — no JavaScript needed, works on any browser
export async function login(): Promise<void> {
  pendingAuthState = crypto.randomBytes(16).toString('hex');
  const url = `${API_BASE}/api/auth/desktop-login?state=${pendingAuthState}&mode=sign-in`;
  shell.openExternal(url);
  console.log('[auth] Opened sign-in in browser');
}

// Open the sign-up page in the system browser
export async function register(): Promise<void> {
  pendingAuthState = crypto.randomBytes(16).toString('hex');
  const url = `${API_BASE}/api/auth/desktop-login?state=${pendingAuthState}&mode=sign-up`;
  shell.openExternal(url);
  console.log('[auth] Opened sign-up in browser');
}

export function logout(): void {
  clearAuth();
  notifyRenderer();
  console.log('[auth] Logged out');
}

async function handleAuthCallback(sessionToken: string | null, state: string | null): Promise<void> {
  try {
    if (!sessionToken) {
      console.error('[auth] Callback missing token');
      return;
    }

    if (pendingAuthState && state !== pendingAuthState) {
      console.error('[auth] State mismatch — possible interception');
      return;
    }
    pendingAuthState = null;

    // Exchange Clerk session token for our JWT
    const response = await fetch(`${API_BASE}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[auth] Token exchange failed:', response.status, text);
      return;
    }

    const { token, user } = await response.json();

    // If switching to a different user, wipe local cache first
    const previousUser = getStoredUser();
    if (previousUser && String(previousUser.id) !== String(user.id)) {
      console.log('[auth] User changed, wiping local cache');
      wipeLocalCache();
    }

    saveToken(token, user);
    notifyRenderer();

    // Sync session history from cloud, then notify renderer to refresh
    syncSessionList(String(user.id))
      .then(() => {
        const win = getGeneralWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('history:updated');
        }
      })
      .catch(err => console.warn('[auth] Session sync failed:', err));

    // Focus the app window
    const general = getGeneralWindow();
    if (general && !general.isDestroyed()) {
      general.show();
      general.focus();
    }

    console.log('[auth] Authenticated as', user.email, '(tier:', user.tier + ')');
  } catch (err) {
    console.error('[auth] Callback error:', err);
  }
}

// Refresh user profile from backend
export async function refreshProfile(): Promise<void> {
  const token = getToken();
  if (!token) return;

  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const user = await response.json();
      saveToken(token, { id: user.id, email: user.email, tier: user.tier });
      notifyRenderer();
    } else if (response.status === 401) {
      clearAuth();
      notifyRenderer();
    }
  } catch (err) {
    console.warn('[auth] Profile refresh failed:', err);
  }
}

export function getAuthState() {
  const user = getStoredUser();
  return {
    authenticated: isAuthenticated(),
    user,
  };
}

function notifyRenderer(): void {
  const general = getGeneralWindow();
  if (general && !general.isDestroyed()) {
    general.webContents.send('auth:state-changed', getAuthState());
  }
}

export function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    callbackPort = null;
  }
}

// Stripe: open checkout page in browser
export async function openUpgradeCheckout(): Promise<void> {
  const token = getToken();
  if (!token) {
    console.error('[stripe] Not authenticated');
    return;
  }

  const port = await ensureCallbackServer();
  const callbackUrl = `http://127.0.0.1:${port}/upgrade/callback`;

  try {
    const response = await fetch(`${API_BASE}/api/stripe/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ successUrl: callbackUrl }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[stripe] Checkout creation failed:', response.status, text);
      return;
    }

    const { url } = await response.json();
    if (url) {
      shell.openExternal(url);
      console.log('[stripe] Opened checkout in browser');
    }
  } catch (err) {
    console.error('[stripe] Checkout error:', err);
  }
}

// Stripe: open billing portal in browser
export async function openBillingPortal(): Promise<void> {
  const token = getToken();
  if (!token) {
    console.error('[stripe] Not authenticated');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/stripe/portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[stripe] Portal creation failed:', response.status, text);
      return;
    }

    const { url } = await response.json();
    if (url) {
      shell.openExternal(url);
      console.log('[stripe] Opened billing portal in browser');
    }
  } catch (err) {
    console.error('[stripe] Portal error:', err);
  }
}
