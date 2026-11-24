import { Body, Controller, Get, Headers, HttpCode, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SettingsScreensService } from './settings-screens.service';

/** DLP, idle-task alert, notification policy (contract tag `settings`, 0.15.61, migration 0145) and the table display defaults (0.15.68, migration 0148). The session guard is global; the database checks the rights. */
@Controller('settings')
export class SettingsScreensController {
  constructor(private readonly screens: SettingsScreensService) {}

  @Get('dlp')
  dlp() {
    return this.screens.dlp();
  }

  @Post('dlp/versions')
  @HttpCode(201)
  publishDlp(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.screens.publishDlp(auth, body);
  }

  @Get('idle-task-alert')
  async idle(@Res({ passthrough: true }) res: Response) {
    const r = await this.screens.idle();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('idle-task-alert')
  async setIdle(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.screens.setIdle(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('table-display')
  async tableDisplay(@Res({ passthrough: true }) res: Response) {
    const r = await this.screens.tableDisplay();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('table-display')
  async setTableDisplay(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.screens.setTableDisplay(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('notification-policy/catalogue')
  catalogue() {
    return this.screens.catalogue();
  }

  @Get('notification-policy')
  async policy(@Res({ passthrough: true }) res: Response) {
    const r = await this.screens.policy();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('notification-policy')
  async setPolicy(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.screens.setPolicy(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
