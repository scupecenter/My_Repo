import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { mapDbError } from './db-errors';
import { ProblemException, problemTitle, ErrorCode } from './problem';
import { SyslogService } from '../auth/syslog.service';

const PROBLEM_BASE = 'https://pmis.aljeel.internal/problems/';

interface BodyParserError { status?: number; statusCode?: number; type?: string }

/** Every error leaves the API as application/problem+json with type, title, status, code and request_id. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');

  constructor(@Optional() private readonly syslog?: SyslogService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { id?: string; auth?: { user: { id: string } } }>();
    const requestId = req.id ?? String(res.getHeader('X-Request-Id') ?? '');

    let problem: ProblemException;
    if (exception instanceof ProblemException) {
      problem = exception;
    } else {
      const mapped = mapDbError(exception);
      if (mapped) {
        problem = mapped;
      } else if (exception instanceof HttpException) {
        problem = this.fromHttp(exception);
      } else if (this.isBodyParserError(exception)) {
        const status = (exception as BodyParserError).status ?? (exception as BodyParserError).statusCode ?? 400;
        problem = status === 413
          ? new ProblemException(413, 'validation_failed', { detail: 'The request body is too large.' })
          : new ProblemException(400, 'validation_failed', { detail: 'The request body is not valid JSON.' });
      } else {
        problem = new ProblemException(500, 'internal_error', { detail: 'Something went wrong. Quote the request id to the administrator.' });
        this.logUnexpected(exception, requestId, req);
      }
    }

    const status = problem.getStatus();
    const body: Record<string, unknown> = {
      type: `${PROBLEM_BASE}${problem.code}`,
      title: problemTitle(problem.code),
      status,
      code: problem.code,
      request_id: requestId,
    };
    if (problem.opts.detail) body.detail = problem.opts.detail;
    body.instance = req.originalUrl?.split('?')[0];
    if (problem.opts.errors && problem.opts.errors.length > 0) body.errors = problem.opts.errors;
    if (problem.opts.step_up_method) body.step_up_method = problem.opts.step_up_method;

    for (const [k, v] of Object.entries(problem.opts.headers ?? {})) res.setHeader(k, v);
    res.status(status).type('application/problem+json').send(JSON.stringify(body));
  }

  private fromHttp(e: HttpException): ProblemException {
    const status = e.getStatus();
    if (status === 404) return new ProblemException(404, 'not_found', { detail: 'No such route.' });
    if (status === 405) return new ProblemException(404, 'not_found', { detail: 'No such route.' });
    if (status === 400) return new ProblemException(400, 'validation_failed', { detail: 'The request is not valid.' });
    if (status === 401) return new ProblemException(401, 'unauthenticated', {});
    if (status === 403) return new ProblemException(403, 'action_forbidden', {});
    if (status === 413) return new ProblemException(413, 'validation_failed', { detail: 'The request body is too large.' });
    if (status === 415) return new ProblemException(415, 'validation_failed', { detail: 'Use Content-Type: application/json.' });
    return new ProblemException(status, (status >= 500 ? 'internal_error' : 'validation_failed') as ErrorCode, {});
  }

  private isBodyParserError(e: unknown): boolean {
    return typeof e === 'object' && e !== null && 'type' in e && typeof (e as BodyParserError).type === 'string' && String((e as BodyParserError).type).startsWith('entity.');
  }

  private logUnexpected(e: unknown, requestId: string, req: Request): void {
    // Never log the request body or headers: they can hold passwords.
    const name = e instanceof Error ? e.name : typeof e;
    const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
    const prismaCode = e instanceof Prisma.PrismaClientKnownRequestError ? ` prisma=${e.code}` : '';
    this.log.error(`${req.method} ${req.originalUrl.split('?')[0]} request_id=${requestId} ${name}${prismaCode}: ${message}`);
    void this.syslog?.write('error', 'unexpected_error', { name, route: `${req.method} ${req.route?.path ?? ''}` }, undefined, requestId);
  }
}
