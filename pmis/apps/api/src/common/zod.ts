import { z, ZodError, ZodTypeAny } from 'zod';
import { FieldError, ProblemException } from './problem';

/** The error codes of the API stay those of zod 3 (clients and tests read them); zod 4 renamed two of them. */
function errorCode(i: ZodError['issues'][number]): string {
  switch (i.code as string) {
    case 'unrecognized_keys': return 'unknown_field';
    case 'invalid_format': return 'invalid_string';
    case 'invalid_value': return ((i as unknown as { values?: unknown[] }).values?.length ?? 2) === 1 ? 'invalid_literal' : 'invalid_enum_value';
    default: return i.code;
  }
}

export function zodErrors(e: ZodError): FieldError[] {
  return e.issues.map((i) => {
    const path = '/' + i.path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
    const extra = i.code === 'unrecognized_keys' ? ` (${(i as unknown as { keys: string[] }).keys.join(', ')})` : '';
    return { path: path === '/' ? '/' : path, code: errorCode(i), message: i.message + extra };
  });
}

/** Parses with a zod schema; a failure is 422 validation_failed with field-level errors[]. */
export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ProblemException(422, 'validation_failed', { detail: 'The request is not valid.', errors: zodErrors(r.error) });
  return r.data;
}

export const uuidSchema = z.guid();
