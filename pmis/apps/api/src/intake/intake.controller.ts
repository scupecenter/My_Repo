import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { IntakeFormsService, PublicIntakeService } from './intake.service';

type Json = Record<string, unknown>;

/** Migration 0730 (contract tag `intake`): the managers' side of the public intake forms. The columns of a form come from GET /registers/{key}/fields. */
@Controller('intake-forms')
export class IntakeFormsController {
  constructor(private readonly svc: IntakeFormsService) {}

  private tag(res: Response, r: Json): Json {
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    res.setHeader('Cache-Control', 'no-store');
    return r;
  }

  @Get() list(): Promise<Json> { return this.svc.list(); }

  @Post() @HttpCode(201)
  async create(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> { return this.tag(res, await this.svc.create(body)); }

  @Get(':id/submissions') submissions(@Param('id') id: string): Promise<Json> { return this.svc.submissions(id); }

  @Patch(':id')
  async update(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.update(id, ifMatch, body));
  }

  @Post(':id/replace-link') @HttpCode(200)
  async replace(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.replaceLink(id, ifMatch));
  }

  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> { await this.svc.remove(id); }
}

/** The page of the shared link: no session, no cookie is read or set, nothing is cached. */
@Controller('public/intake')
export class PublicIntakeController {
  constructor(private readonly svc: PublicIntakeService) {}

  @Public() @Get(':token')
  form(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('token') token: string): Promise<Json> {
    res.setHeader('Cache-Control', 'no-store');
    return this.svc.form(token, req.ip ?? null);
  }

  @Public() @Post(':token') @HttpCode(201)
  submit(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('token') token: string, @Body() body: unknown): Promise<Json> {
    res.setHeader('Cache-Control', 'no-store');
    return this.svc.submit(token, req.ip ?? null, req.get('user-agent') ?? null, body);
  }
}
