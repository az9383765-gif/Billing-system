// API client — works in dev (vite proxy) and production (same origin as Express)
// Offline-first: reads fall back to the last data saved on this device, and a
// bill taken with no internet is queued and synced automatically on reconnect.
import { cacheGet, cachePut, queueWrite, cacheable } from './localdb.js';

const TOKEN_KEY = 'shopbill_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function parse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function api(path, options = {}) {
  const { method = 'GET', body, signal } = options;
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    // ---- the server cannot be reached (internet down / hosted server away) ----
    if (method === 'GET') {
      const cached = await cacheGet(path);
      if (cached !== undefined) return cached; // last known data keeps the shop running
      throw new ApiError('Offline and this screen has no saved copy yet.', 0);
    }
    // a sale is money — it is queued durably and replayed with a unique ref the
    // server dedupes on, so a replay can never bill the customer twice
    if (method === 'POST' && path === '/invoices') {
      const ref = `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const queued = await queueWrite({
        path, method,
        body: { ...body, client_ref: ref },
        label: `Bill ${(body?.items || []).length} item(s) · Rs ${body?.paid ?? ''}`
      });
      if (queued) {
        return { __queued: true, ref, invoice: { id: null, invoice_no: `OFF-${ref.slice(-6).toUpperCase()}` } };
      }
    }
    throw new ApiError('Cannot reach the server. Make sure MartBill is running.', 0);
  }
  if (res.status === 401) {
    // a wrong password on the login form must surface the server's own message
    // ("Invalid username or password"), not the expired-session notice
    if (!path.startsWith('/auth/login')) {
      window.dispatchEvent(new CustomEvent('shopbill:unauthorized'));
      throw new ApiError('Session expired. Please login again.', 401);
    }
  }
  const data = await parse(res);
  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  // remember what the server said so the same screens still open with no internet
  if (method === 'GET' && data !== null && data !== undefined && cacheable(path)) {
    await cachePut(path, data);
  }
  return data;
}

// Download a CSV built in the browser
export function downloadCSV(filename, headers, rows) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function downloadFile(path, filename) {
  const res = await fetch('/api' + path, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {}
  });
  if (!res.ok) {
    const data = await parse(res);
    throw new ApiError((data && data.error) || 'Download failed', res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
