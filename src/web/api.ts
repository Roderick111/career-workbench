export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return api(path, { method: "PUT", body: JSON.stringify(body) });
}
