import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import type { AuthContext } from '../auth/auth.types';
import { SyslogService } from '../auth/syslog.service';
import { ProblemException } from '../common/problem';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Largest accepted template file, and the most data rows (environment overrides are for tests and the installer). */
export const importMaxBytes = (): number => Number(process.env.PMIS_IMPORT_MAX_BYTES ?? 5 * 1024 * 1024);
export const importMaxRows = (): number => Number(process.env.PMIS_IMPORT_MAX_ROWS ?? 2000);

/**
 * Reads one multipart file into memory with a size limit. It runs inside the request transaction (after the session guard), so a refused file is
 * written to the System Log and the log row is kept (the problem commits the transaction first).
 */
@Injectable()
export class UploadInterceptor implements NestInterceptor {
  constructor(private readonly syslog: SyslogService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { file?: UploadedFile; auth?: AuthContext; id?: string }>();
    const res = http.getResponse<Response>();
    const max = importMaxBytes();
    const handler = multer({ storage: multer.memoryStorage(), limits: { fileSize: max, files: 1, fields: 10, parts: 12, fieldSize: 4096, headerPairs: 40 } }).single('file');
    try {
      await new Promise<void>((resolve, reject) => handler(req, res, (err: unknown) => (err ? reject(err as Error) : resolve())));
    } catch (e) {
      const code = (e as { code?: string }).code;
      const detail = code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${Math.round(max / 1024 / 1024)} MB.` : 'The upload is not a valid single-file form.';
      if (req.auth) {
        await this.syslog.write('warn', `template upload rejected: ${code === 'LIMIT_FILE_SIZE' ? 'size_or_rows_exceeded' : 'not_xlsx'}`,
          { reason: code === 'LIMIT_FILE_SIZE' ? 'size_or_rows_exceeded' : 'not_xlsx', multer: code ?? null, max_bytes: max }, req.auth.user.id, req.id, 'template-check');
      }
      throw new ProblemException(code === 'LIMIT_FILE_SIZE' ? 413 : 422, code === 'LIMIT_FILE_SIZE' ? 'validation_failed' : 'template_rejected', {
        detail,
        extra: { reason: code === 'LIMIT_FILE_SIZE' ? 'size_or_rows_exceeded' : 'not_xlsx' },
        commit: true,
      });
    }
    return next.handle();
  }
}
