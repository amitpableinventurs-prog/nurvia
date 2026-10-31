const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api/v1';

// Tokens live in sessionStorage so a closed tab ends the admin session.
const store = {
  get: (k) => sessionStorage.getItem(k),
  set: (k, v) => (v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k)),
};

export const tokens = {
  get access() {
    return store.get('nurvia.access');
  },
  get refresh() {
    return store.get('nurvia.refresh');
  },
  save({ accessToken, refreshToken }) {
    store.set('nurvia.access', accessToken);
    store.set('nurvia.refresh', refreshToken);
  },
  clear() {
    store.set('nurvia.access', null);
    store.set('nurvia.refresh', null);
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.details = body?.error?.details;
  }
}

let refreshing;
async function refreshTokens() {
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refresh }),
  })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      tokens.save(await res.json());
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

export const onSessionExpired = { handler: () => {} };

async function send(method, path, body, { raw = false, retry = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(tokens.access && { Authorization: `Bearer ${tokens.access}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry && tokens.refresh) {
    try {
      await refreshTokens();
    } catch {
      tokens.clear();
      onSessionExpired.handler();
      throw new ApiError(401, { error: { message: 'Your session has expired' } });
    }
    return send(method, path, body, { raw, retry: false });
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const qs = (params = {}) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

export const api = {
  get: (path, params) => send('GET', path + qs(params)),
  post: (path, body = {}) => send('POST', path, body),
  patch: (path, body) => send('PATCH', path, body),
  put: (path, body) => send('PUT', path, body),
  // Saves an authenticated download (e.g. a CSV export) under the server's suggested file name.
  async download(path, params, fallbackName = 'download') {
    const res = await send('GET', path + qs(params), undefined, { raw: true });
    const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return res;
  },
  // Private files need the bearer token, so they are fetched and opened as a blob URL.
  async openFile(fileId) {
    const res = await send('GET', `/files/${fileId}`, undefined, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
