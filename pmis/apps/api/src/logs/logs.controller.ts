import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { problems } from '../common/problem';
import { oneParam } from '../common/query';
import { attachmentHeader } from '../documents/naming';
import { IntegrityService } from './integrity.service';
import { LogsService } from './logs.service';

type Q = Record<string, unknown>;

/** Audit Log, field changes, integrity and exports (contract tag `audit`, 0.10.0). */
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly logs: LogsService) {}

  @Get()
  list(@Query() q: Q) {
    return this.logs.auditList(q);
  }

  @Get('field-changes')
  fieldChanges(@Query() q: Q) {
    return this.logs.fieldChanges(q);
  }

  @Get('field-history')
  fieldHistory(@Query() q: Q) {
    return this.logs.fieldHistory(q);
  }

  @Get('integrity')
  integrity(@Query() q: Q) {
    return this.logs.integrity('audit', q);
  }

  @Post('exports')
  @HttpCode(202)
  export(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.logs.startExport(auth, 'audit_export', body ?? {}, key, (go) => res.once('finish', go));
  }

  @Get('exports/:id/download')
  async download(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.logs.downloadExport(auth, 'audit_export', id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}

/** Sign-in and security log (contract tag `security`). */
@Controller('security-log')
export class SecurityLogController {
  constructor(private readonly logs: LogsService) {}

  @Get()
  list(@Query() q: Q) {
    return this.logs.securityList(q);
  }

  @Get('integrity')
  integrity(@Query() q: Q) {
    return this.logs.integrity('security', q);
  }

  @Post('exports')
  @HttpCode(202)
  export(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.logs.startExport(auth, 'security_export', body ?? {}, key, (go) => res.once('finish', go));
  }

  @Get('exports/:id/download')
  async download(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.logs.downloadExport(auth, 'security_export', id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}

/** System Log, sessions, admin log screens, log settings and the activity report. */
@Controller()
export class LogsAdminController {
  constructor(private readonly logs: LogsService, private readonly integrityJobs: IntegrityService) {}

  @Get('system-log')
  systemLog(@Query() q: Q) {
    return this.logs.systemList(q);
  }

  @Get('sessions/active')
  active(@Auth() auth: AuthContext, @Query() q: Q) {
    return this.logs.activeSessions(auth, q);
  }

  @Post('sessions/:id/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.logs.endSession(auth, id, body);
  }

  @Post('users/:id/sessions/revoke')
  @HttpCode(200)
  revokeUser(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.logs.endUserSessions(auth, id, body);
  }

  @Get('admin/sessions')
  adminSessions(@Auth() auth: AuthContext, @Query() q: Q) {
    return this.logs.adminSessions(auth, q);
  }

  @Post('admin/sessions/:id/end')
  @HttpCode(200)
  end(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.logs.endSession(auth, id, body);
  }

  @Get('admin/job-runs')
  jobRuns(@Query() q: Q) {
    return this.logs.jobRuns(q);
  }

  @Get('admin/deployments')
  deployments(@Query() q: Q) {
    return this.logs.deployments(q);
  }

  @Get('admin/security-alerts')
  alerts(@Query() q: Q) {
    return this.logs.alerts(q);
  }

  @Post('admin/security-alerts/:id/ack')
  @HttpCode(200)
  ack(@Param('id') id: string, @Body() body: unknown) {
    return this.logs.ack(id, body);
  }

  @Get('settings/log-retention')
  async retention(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.logs.retention(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('settings/log-retention')
  async setRetention(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.logs.setRetention(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Get('settings/security-alerts')
  async alertSettings(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.logs.alertSettings(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('settings/security-alerts')
  async setAlertSettings(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.logs.setAlertSettings(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  /** JSON by default; `format=xlsx` (0.12.3, Q169) answers the workbook. */
  @Get('reports/activity')
  async activity(@Auth() auth: AuthContext, @Query() q: Q, @Res({ passthrough: true }) res: Response) {
    const format = oneParam(q, 'format') ?? 'json';
    if (format !== 'json' && format !== 'xlsx') throw problems.validation([{ path: '/format', code: 'invalid', message: 'format is json or xlsx.' }]);
    if (format === 'json') return this.logs.activity(q);
    const f = await this.logs.activityXlsx(auth, q);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(f.body, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: attachmentHeader(f.filename), length: f.body.length });
  }

  // Q171 (0.12.3): the integrity check as a job with progress
  @Post('admin/log-integrity/runs')
  @HttpCode(202)
  startIntegrity(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.integrityJobs.startManual(auth, body ?? {}, (go) => res.once('finish', go));
  }

  @Get('admin/log-integrity/runs')
  integrityRuns(@Query() q: Q) {
    return this.integrityJobs.list(q);
  }

  @Get('admin/log-integrity/runs/:id')
  integrityRun(@Param('id') id: string) {
    return this.integrityJobs.get(id);
  }
}
