import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE = /^[A-Za-z0-9._-]{8,64}$/;

/** Gives every request an id (a safe client value or a fresh uuid) and echoes it in X-Request-Id. */
export function requestIdMiddleware(req: Request & { id?: string }, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && SAFE.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Plain security headers for a JSON API behind nginx. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}
