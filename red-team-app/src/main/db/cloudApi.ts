import { getToken } from '../auth/tokenStore';

const API_BASE = 'https://hinty-web.vercel.app';

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

export async function fetchSessionList(limit = 50): Promise<any[]> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions?limit=${limit}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cloud] fetchSessionList failed: ${res.status} ${text}`);
      return [];
    }
    const data = await res.json();
    console.log(`[cloud] Fetched ${data.length} sessions from cloud`);
    return data;
  } catch (err) {
    console.warn('[cloud] fetchSessionList error:', err);
    return [];
  }
}

export async function fetchSessionMessages(sessionId: string): Promise<any[]> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages?include=screenshots`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cloud] fetchSessionMessages failed: ${res.status} ${text}`);
      return [];
    }
    const data = await res.json();
    console.log(`[cloud] Fetched ${data.length} messages for session ${sessionId}`);
    return data;
  } catch (err) {
    console.warn('[cloud] fetchSessionMessages error:', err);
    return [];
  }
}

export async function createCloudSession(id: string, aiModel: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id, aiModel }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cloud] createCloudSession failed: ${res.status} ${text}`);
    } else {
      console.log(`[cloud] Session ${id} created in cloud`);
    }
  } catch (err) {
    console.warn('[cloud] createCloudSession error:', err);
  }
}

export async function updateCloudSession(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cloud] updateCloudSession failed: ${res.status} ${text}`);
    } else {
      console.log(`[cloud] Session ${id} updated in cloud`);
    }
  } catch (err) {
    console.warn('[cloud] updateCloudSession error:', err);
  }
}

export async function saveCloudMessages(
  sessionId: string,
  messages: { role: string; contentText: string | null; screenshot?: string | null; seq: number }[],
): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cloud] saveCloudMessages failed: ${res.status} ${text}`);
    } else {
      console.log(`[cloud] Saved ${messages.length} messages for session ${sessionId}`);
    }
  } catch (err) {
    console.warn('[cloud] saveCloudMessages error:', err);
  }
}

export async function deleteCloudSession(id: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cloud] deleteCloudSession failed: ${res.status} ${text}`);
    } else {
      console.log(`[cloud] Session ${id} deleted from cloud`);
    }
  } catch (err) {
    console.warn('[cloud] deleteCloudSession error:', err);
  }
}
