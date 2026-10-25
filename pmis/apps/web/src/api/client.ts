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
  signal?: AbortSignal;
}

/** Resolves true once the user re-authenticated; false = cancelled. */
export type StepUpHandler = (problem: Problem) => Promise<boolean>;

let csrf = '';
let stepUpHandler: StepUpHandler | null = null;
let pendingStepUp: Promise<boolean> | null = null;

export const setCsrfToken = (t: string) => { csrf = t; };
export const setStepUpHandler = (h: StepUpHandler | null) => { stepUpHandler = h; };

function buildUrl(path: string, query: RequestOptions['query']) {
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
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.version !== undefined) headers['If-Match'] = `"${opts.version}"`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    credentials: 'include',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (res.ok) {
    const text = res.status === 204 ? '' : await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const problem = await toProblem(res);
  if (res.status === 401 && problem.code === 'step_up_required' && stepUpHandler && !retried) {
    // One step-up covers every request waiting on it (and a whole bulk body).
    pendingStepUp ??= stepUpHandler(problem).finally(() => { pendingStepUp = null; });
    if (await pendingStepUp) return request<T>(method, path, opts, true);
  }
  throw new ApiError(res.status, problem);
}

export const api = {
  get: <T>(p: string, o?: RequestOptions) => request<T>('GET', p, o),
  post: <T>(p: string, o?: RequestOptions) => request<T>('POST', p, o),
  patch: <T>(p: string, o?: RequestOptions) => request<T>('PATCH', p, o),
};
