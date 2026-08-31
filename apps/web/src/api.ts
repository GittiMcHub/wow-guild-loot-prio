const BASE = '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    throw new ApiError(res.status, body.error?.code ?? 'UNKNOWN', body.error?.message ?? res.statusText, body.error?.details);
  }
  return res.json() as Promise<T>;
}

function withAuth(token?: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { ...init?.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
}

export const api = {
  get: <T>(path: string, token?: string) => request<T>(path, withAuth(token)),
  post: <T>(path: string, body: unknown, token?: string) =>
    request<T>(path, withAuth(token, { method: 'POST', body: JSON.stringify(body) })),
  put: <T>(path: string, body: unknown, token?: string) =>
    request<T>(path, withAuth(token, { method: 'PUT', body: JSON.stringify(body) })),
};
