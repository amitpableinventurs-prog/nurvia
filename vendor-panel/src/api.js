const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api/v1';

// Vendors run the panel on a shop counter all day, so the session persists across tabs and
// restarts. Access tokens last 15 minutes and refresh tokens rotate on every use.
const KEY = 'nurvia.vendor.session';

// Tokens are read from storage on every request, never cached, so a tab picks up the tokens another
// tab refreshed instead of presenting a rotated one (which would end the session).
export const tokens = {
  read() {
    if (memory) return memory;
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? {};
    } catch {
      return {};
    }
  },
  save({ accessToken, refreshToken }) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ accessToken, refreshToken }));
      memory = null;
    } catch {
      // Storage unavailable: the session lasts until the tab closes.
      memory = { accessToken, refreshToken };
    }
  },
  clear() {
    memory = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing stored */
    }
  },
  get current() {
    return this.read();
  },
};
let memory = null;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Something went wrong (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

export const sessionEvents = { onExpired: () => {} };

let refreshing;
function refresh() {
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.current.refreshToken }),
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

async function send(method, path, body, { raw = false, retry = true } = {}) {
  const isForm = body instanceof FormData;
  const { accessToken, refreshToken } = tokens.current;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !isForm && { 'Content-Type': 'application/json' }),
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });

  if (res.status === 401 && retry && refreshToken) {
    try {
      await refresh();
    } catch {
      tokens.clear();
      sessionEvents.onExpired();
      throw new ApiError(401, { error: { message: 'Your session has expired. Please sign in again.' } });
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
  del: (path) => send('DELETE', path),
  // Uploads one file for a purpose (vendor_kyc, vendor_photo) and returns the stored file record.
  upload(file, purpose) {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', file);
    return send('POST', '/files', form);
  },
  // Private files (KYC documents) need the bearer token, so they open as a blob URL.
  async openFile(fileId) {
    const res = await send('GET', `/files/${fileId}`, undefined, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
