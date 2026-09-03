// Simple typed fetch wrapper used by all components.
// `X-Requested-With` doubles as the server's CSRF marker: cross-site requests
// cannot set custom headers on simple form submissions.
export async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data as Record<string, string>)?.error || (data as Record<string, string>)?.msg || (typeof data === 'string' ? data : '') || `HTTP ${res.status}`;
    const err = new Error(String(msg).slice(0, 600)) as Error & { status: number; data: unknown };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const get = (p: string) => api(p) as Promise<unknown>;
export const post = (p: string, body?: unknown) => api(p, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }) as Promise<unknown>;
export const put = (p: string, body?: unknown) => api(p, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }) as Promise<unknown>;
export const del = (p: string) => api(p, { method: 'DELETE' }) as Promise<unknown>;
