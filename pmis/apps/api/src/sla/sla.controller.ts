import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SlaService } from './sla.service';

/** SLA rules and rule-set versions (contract tag `settings`, 0.2.6). */
@Controller('settings')
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get('sla-rules')
  rules(@Query() q: Record<string, unknown>) {
    return this.sla.rules(q);
  }

  @Get('sla-rule-sets')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.sla.list(auth, q);
  }

  @Post('sla-rule-sets')
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.sla.createDraft(auth, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Get('sla-rule-sets/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.sla.get(auth, id);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Patch('sla-rule-sets/:id')
  async patch(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.sla.patch(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Post('sla-rule-sets/:id/preview')
  @HttpCode(200)
  preview(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.sla.preview(auth, id, body);
  }

  @Post('sla-rule-sets/:id/publish')
  @HttpCode(200)
  publish(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.sla.publish(auth, id, ifMatch, key, body);
  }
}
