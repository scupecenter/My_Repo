import { z, ZodError, ZodTypeAny } from 'zod';
import { FieldError, ProblemException } from './problem';

export function zodErrors(e: ZodError): FieldError[] {
  return e.issues.map((i) => {
    const path = '/' + i.path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
    const extra = i.code === 'unrecognized_keys' ? ` (${(i as z.ZodUnrecognizedKeysIssue).keys.join(', ')})` : '';
    return { path: path === '/' ? '/' : path, code: i.code === 'unrecognized_keys' ? 'unknown_field' : i.code, message: i.message + extra };
  });
}

/** Parses with a zod schema; a failure is 422 validation_failed with field-level errors[]. */
export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ProblemException(422, 'validation_failed', { detail: 'The request is not valid.', errors: zodErrors(r.error) });
  return r.data;
}

export const uuidSchema = z.string().uuid();
