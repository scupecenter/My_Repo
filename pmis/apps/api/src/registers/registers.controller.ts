import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { RegisterTransition, RegistersService } from './registers.service';

/** The register framework: Procurement, GECOL, HLC and Permits & HSE through the generic contract paths (tag registers). */
@Controller('registers')
export class RegistersController {
  constructor(private readonly registers: RegistersService) {}

  private tag(res: Response, r: Record<string, unknown>): Record<string, unknown> {
    res.setHeader('ETag', etagHeader(r.version as number));
    return r;
  }

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.registers.list(auth);
  }

  @Get(':key/records')
  records(@Auth() auth: AuthContext, @Param('key') key: string, @Query() q: Record<string, unknown>) {
    return this.registers.listRecords(auth, key, q);
  }

  @Post(':key/records')
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Param('key') key: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.registers.create(auth, key, body));
  }

  @Get(':key/records/:id')
  async get(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.registers.get(auth, key, id));
  }

  @Patch(':key/records/:id')
  async patch(
    @Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.tag(res, await this.registers.update(auth, key, id, ifMatch, body));
  }

  private act(action: RegisterTransition, auth: AuthContext, key: string, id: string, ifMatch: string | undefined, body: unknown, res: Response) {
    return this.registers.transition(auth, key, id, action, ifMatch, body).then((r) => this.tag(res, r));
  }

  @Post(':key/records/:id/submit')
  @HttpCode(200)
  submit(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.act('submit', auth, key, id, ifMatch, body, res);
  }

  @Post(':key/records/:id/review')
  @HttpCode(200)
  review(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.act('review', auth, key, id, ifMatch, body, res);
  }

  @Post(':key/records/:id/approve')
  @HttpCode(200)
  approve(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.act('approve', auth, key, id, ifMatch, body, res);
  }

  @Post(':key/records/:id/reject')
  @HttpCode(200)
  reject(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.act('reject', auth, key, id, ifMatch, body, res);
  }

  @Post(':key/records/:id/claim')
  @HttpCode(200)
  async claim(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.registers.claim(auth, key, id, ifMatch, false));
  }

  @Post(':key/records/:id/release')
  @HttpCode(200)
  async release(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.registers.claim(auth, key, id, ifMatch, true));
  }

  @Post(':key/records/:id/void')
  @HttpCode(200)
  async void(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.registers.void(auth, key, id, ifMatch, body));
  }

  @Get(':key/records/:id/history')
  history(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.registers.history(auth, key, id, q);
  }

  @Get(':key/records/:id/versions')
  versions(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string) {
    return this.registers.versions(auth, key, id);
  }

  @Post(':key/records/:id/versions')
  @HttpCode(201)
  async newVersion(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.registers.newVersion(auth, key, id, ifMatch));
  }
}
