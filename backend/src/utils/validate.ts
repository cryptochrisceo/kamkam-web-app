import { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path?.join('.');
    throw badRequest(first ? (field ? `${field}: ${first.message}` : first.message) : 'Invalid input', 'VALIDATION', r.error.flatten());
  }
  return r.data;
}

export { z };
