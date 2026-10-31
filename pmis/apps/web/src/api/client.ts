import type { Problem } from './types';

export const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiError extends Error {
  constructor(public status: number, public problem: Problem) {
    super(problem.detail ?? problem.title);
  }
  get code() {
    return this.problem.code as string;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null | Array<string | number>>;
  body?: unknown;
  /** Resource version; sent as `If-Match: "<version>"`. */
  version?: number;
  idempotencyKey?: string;
  /** Extra request headers, for example `X-PMIS-Live: 1` on timer-driven polling. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Called with the response headers of a successful call (for example to read the ETag). */
  onHeaders?: (h: Headers) => void;
}

/** Resolves true once the user re-authenticated; false = cancelled. */
export type StepUpHandler = (problem: Problem) => Promise<boolean>;

let csrf = '';
let stepUpHandler: StepUpHandler | null = null;
let pendingStepUp: Promise<boolean> | null = null;

let passwordChangeHandler: (() => void) | null = null;

export const setCsrfToken = (t: string) => { csrf = t; };
/** Called on any 403 `password_change_required`; the app shows the change-password screen. */
export const setPasswordChangeHandler = (h: (() => void) | null) => { passwordChangeHandler = h; };
export const setStepUpHandler = (h: StepUpHandler | null) => { stepUpHandler = h; };

// IDs from the URL or the server are interpolated into paths: refuse anything that could walk to another endpoint.
const SAFE_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
export function assertSafePath(path: string) {
  if (!path.startsWith('/') || !path.slice(1).split('/').every((seg) => SAFE_SEGMENT.test(seg) && seg !== '..'))
    throw new ApiError(400, { type: 'about:blank', status: 400, code: 'validation_failed', title: 'Unsafe request path' });
}

function buildUrl(path: string, query: RequestOptions['query']) {
  assertSafePath(path);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)));
    else q.set(k, String(v));
  }
  const s = q.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

async function toProblem(res: Response): Promise<Problem> {
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      const p = await res.json();
      if (p && typeof p === 'object') return { title: res.statusText, status: res.status, code: 'unknown', type: 'about:blank', ...p } as unknown as Problem;
    } catch { /* fall through */ }
  }
  return { type: 'about:blank', title: res.statusText || 'Error', status: res.status, code: 'unknown' } as unknown as Problem;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData; // browser sets the multipart boundary
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (opts.version !== undefined) headers['If-Match'] = `"${opts.version}"`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  Object.assign(headers, opts.headers);
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    credentials: 'include',
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (res.ok) {
    opts.onHeaders?.(res.headers);
    const text = res.status === 204 ? '' : await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const problem = await toProblem(res);
  if (res.status === 401 && problem.code === 'step_up_required' && stepUpHandler && !retried) {
    // One step-up covers every request waiting on it (and a whole bulk body).
    pendingStepUp ??= stepUpHandler(problem).finally(() => { pendingStepUp = null; });
    if (await pendingStepUp) return request<T>(method, path, opts, true);
  }
  if (res.status === 403 && problem.code === 'password_change_required') passwordChangeHandler?.();
  throw new ApiError(res.status, problem);
}

export const api = {
  get: <T>(p: string, o?: RequestOptions) => request<T>('GET', p, o),
  post: <T>(p: string, o?: RequestOptions) => request<T>('POST', p, o),
  patch: <T>(p: string, o?: RequestOptions) => request<T>('PATCH', p, o),
  put: <T>(p: string, o?: RequestOptions) => request<T>('PUT', p, o),
  del: <T>(p: string, o?: RequestOptions) => request<T>('DELETE', p, o),
};

/** RFC 6266: prefer filename*=UTF-8''..., then filename=, else a safe default. Path separators are stripped. */
export function parseFilename(cd: string | null): string {
  let name: string | undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)'[^']*'([^;]+)/.exec(cd ?? '')?.[1];
  if (star) {
    try {
      name = decodeURIComponent(star.trim().replace(/^"|"$/g, ''));
    } catch {
      name = undefined;
    }
  }
  name ??= /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(cd ?? '')?.[1]?.trim().replace(/^"|"$/g, '');
  name = name?.replace(/[\\/\0]/g, '_').trim();
  return name || 'download';
}

/** Fetch a file with the session cookie and hand it to the browser as a download. Returns the file name. */
export async function downloadFile(path: string, query?: RequestOptions['query']): Promise<string> {
  const res = await fetch(buildUrl(path, query), { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, await toProblem(res));
  const name = parseFilename(res.headers.get('Content-Disposition'));
  const blob = await res.blob();
  if (typeof URL.createObjectURL === 'function') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
  return name;
}
