import { shell, app } from 'electron';
import http from 'http';
import { saveToken, getToken, getStoredUser, clearAuth, isAuthenticated } from './tokenStore';
import { getGeneralWindow } from '../windows/general';
import crypto from 'crypto';
import { syncSessionList, wipeLocalCache } from '../db/repository';

const API_BASE = 'https://hinty-web.vercel.app';

export { isAuthenticated, getToken, getStoredUser, clearAuth };

// ── Auth state for deep link verification ──
let pendingAuthState: string | null = null;

// ── Local HTTP server (dev auth callback + Stripe upgrade callback) ──
// In dev mode on macOS, LaunchServices registers the raw Electron binary as
// the hinty:// handler rather than our app, so clicking "Open Hinty" in the
// browser launches a new Electron with no app path (shows the default
// starter window). The local HTTP callback sidesteps LaunchServices
// entirely — the browser redirect hits this server directly, the app
// stays focused, and the token is delivered in-process.
let callbackServer: http.Server | null = null;
let callbackPort: number | null = null;

function ensureCallbackServer(): Promise<number> {
  if (callbackServer && callbackPort) return Promise.resolve(callbackPort);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      if (url.pathname === '/auth/callback') {
        const token = url.searchParams.get('token');
        const state = url.searchParams.get('state');

        // Render the same "You're signed in" chrome before we touch the
        // callback so the browser has something to show if the handler
        // takes a moment (token exchange, session sync).
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Hinty</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0a0a0b; color: white; margin: 0;">
  <div style="text-align: center;">
    <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're signed in</h2>
    <p style="color: #666; font-size: 14px;">You can close this tab — Hinty is ready.</p>
  </div>
</body>
</html>`);

        // Defer handleAuthCallback until AFTER we've written the response
        // so the browser never sees a hanging request.
        try {
          await handleAuthCallback(token, state);
        } catch (err) {
          console.error('[auth] Local callback handler error:', err);
        }

        // Focus the app — dev mode doesn't get the LaunchServices focus we
        // used to rely on from the hinty:// protocol handoff.
        const general = getGeneralWindow();
        if (general && !general.isDestroyed()) {
          general.show();
          general.focus();
          if (process.platform === 'darwin') app.focus({ steal: true });
        }
        return;
      }

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

/**
 * Build the auth-start URL.
 *
 * In dev mode (not packaged) we can't rely on macOS LaunchServices to route
 * hinty:// back to the running app — so we spin up a loopback HTTP server
 * and pass its URL as `callback_url`. The web redirects directly to the
 * local server, skipping the deep-link entirely.
 *
 * In production (packaged app), Info.plist registers the protocol
 * correctly, so we let the flow use the hinty:// path via /auth/success.
 */
async function buildLoginUrl(mode: 'sign-in' | 'sign-up'): Promise<string> {
  pendingAuthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams();
  params.set('state', pendingAuthState);
  params.set('mode', mode);

  if (!app.isPackaged) {
    try {
      const port = await ensureCallbackServer();
      params.set('callback_url', `http://127.0.0.1:${port}/auth/callback`);
      console.log(`[auth] Dev mode — using loopback callback on port ${port}`);
    } catch (err) {
      console.warn('[auth] Failed to start callback server, falling back to deep link:', err);
    }
  }

  return `${API_BASE}/api/auth/desktop-login?${params.toString()}`;
}

// Open the sign-in page in the system browser
// Uses /api/auth/desktop-login (server-side redirect) to:
// 1. Clear Clerk session cookies (forces fresh sign-in / account picker)
// 2. Redirect to /sign-in — no JavaScript needed, works on any browser
export async function login(): Promise<void> {
  const url = await buildLoginUrl('sign-in');
  shell.openExternal(url);
  console.log('[auth] Opened sign-in in browser');
}

// Open the sign-up page in the system browser
export async function register(): Promise<void> {
  const url = await buildLoginUrl('sign-up');
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
  const state = getAuthState();
  const general = getGeneralWindow();
  if (general && !general.isDestroyed()) {
    general.webContents.send('auth:state-changed', state);
  }
  // Also broadcast to the sidepanel so its cached tier + gate UI refresh.
  // Without this, a tier change (Stripe webhook → profile refresh) would
  // update the general window but leave the panel's currentTier stale.
  try {
    const { getSidePanelWindow } = require('../windows/sidepanel');
    const panel = getSidePanelWindow();
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send('auth:state-changed', state);
    }
  } catch {
    // sidepanel may not exist yet — safe to ignore
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
export async function openUpgradeCheckout(plan?: 'pro' | 'max'): Promise<void> {
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
      body: JSON.stringify({ successUrl: callbackUrl, plan: plan || 'pro' }),
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
