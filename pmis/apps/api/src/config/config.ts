import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  LOG_HMAC_KEY: z.string().min(16, 'LOG_HMAC_KEY must be at least 16 characters'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  port: number;
  host: string;
  cookieSecure: boolean;
  logHmacKey: string;
}

/** Reads the settings from the environment only. Throws one readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const v = parsed.data;
  return {
    nodeEnv: v.NODE_ENV,
    databaseUrl: v.DATABASE_URL,
    port: v.PORT,
    host: v.HOST,
    cookieSecure: v.COOKIE_SECURE,
    logHmacKey: v.LOG_HMAC_KEY,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
