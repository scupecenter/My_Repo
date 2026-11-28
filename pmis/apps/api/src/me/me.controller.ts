import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AllowIncomplete, Auth, Public } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { contentVersion, etagHeader } from '../common/etag';
import { MeDto, MeService } from './me.service';
import { MySessionsService } from './my-sessions.service';
import { NotifyAdminsService } from './notify-admins.service';
import { EmailChangesService, PhoneChangesService, ProfileDto, ProfileService } from './profile.service';

@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly profile: ProfileService,
    private readonly notify: NotifyAdminsService,
    private readonly mySessions: MySessionsService,
  ) {}

  @AllowIncomplete()
  @Get()
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    const body = await this.me.me(auth);
    res.setHeader('ETag', etagHeader(contentVersion(body)));
    return body;
  }

  /** 0143: a pending (or active) user asks the System Admins for an assignment. Reachable by a pending account (ADR 0002 item 5). */
  @AllowIncomplete()
  @Post('notify-admins')
  @HttpCode(202)
  async notifyAdmins(@Auth() auth: AuthContext, @Body() body: unknown): Promise<void> {
    await this.notify.notify(auth, body);
  }

  /** 0.15.460 (D4): my personal calendar feed. Off until I turn it on; the link is shown once; rotate replaces it, revoke removes it. Own data only. */
  @Get('calendar-feed')
  feedStatus(@Auth() auth: AuthContext) {
    return this.me.feedStatus(auth);
  }

  @Post('calendar-feed')
  @HttpCode(200)
  feedSet(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.me.feedSet(auth);
  }

  @Delete('calendar-feed')
  feedRevoke(@Auth() auth: AuthContext) {
    return this.me.feedRevoke(auth);
  }

  /** The feed itself, read by a calendar app with the secret link and no session. A wrong, rotated or revoked link answers 404 and nothing else. */
  @Public()
  @Get('calendar-feed/:file')
  async feedRead(@Param('file') file: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    const body = file.endsWith('.ics') ? await this.me.feedIcs(file.slice(0, -4)) : null;
    if (body === null) throw problems.notFound('This calendar link is not active.');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return body;
  }

  /** 0.15.102: my own sessions (device list) and ending them. Own rows only; the current session is ended by sign out. */
  @Get('sessions')
  listSessions(@Auth() auth: AuthContext) {
    return this.mySessions.list(auth);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  endOtherSessions(@Auth() auth: AuthContext) {
    return this.mySessions.endOthers(auth);
  }

  @Post('sessions/:id/revoke')
  @HttpCode(200)
  endSession(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.mySessions.end(auth, id);
  }

  // ------------------------------------------------------------------ self-service profile (contract 0.9.2, migration 0044)
  @Get('profile')
  async getProfile(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<ProfileDto> {
    const p = await this.profile.get(auth);
    res.setHeader('ETag', etagHeader(p.version));
    return p;
  }

  @Patch('profile')
  async patchProfile(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response): Promise<ProfileDto> {
    const p = await this.profile.patch(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(p.version));
    return p;
  }

  // The top bar's language and theme buttons (contract updateMyPreferences): saved on the server, so they follow the user to every device
  @Patch('preferences')
  async patchPreferences(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    await this.profile.preferences(body);
    const me = await this.me.me(auth);
    res.setHeader('ETag', etagHeader(contentVersion(me)));
    return me;
  }

  @Post('password')
  @HttpCode(200)
  password(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.profile.changePassword(auth, body);
  }

  @Post('email-change')
  @HttpCode(201)
  requestEmailChange(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.profile.requestEmailChange(auth, body);
  }

  @Delete('email-change')
  @HttpCode(204)
  async cancelEmailChange(): Promise<void> {
    // the global guard requires the session; the database acts for the signed-in user (app_actor)
    await this.profile.cancelEmailChange();
  }

  // 0058 (Q158): the code mailed to the new address, and a new code
  @Post('email-change/verify')
  @HttpCode(200)
  verifyEmailChange(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.profile.verifyEmailChange(auth, body);
  }

  @Post('email-change/resend')
  @HttpCode(200)
  resendEmailVerification(@Auth() auth: AuthContext) {
    return this.profile.resendEmailVerification(auth);
  }

  // 0058 (D156): the phone is a sign-in identifier; it changes through a request an admin approves
  @Post('phone-change')
  @HttpCode(201)
  requestPhoneChange(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.profile.requestPhoneChange(auth, body);
  }

  @Delete('phone-change')
  @HttpCode(204)
  async cancelPhoneChange(): Promise<void> {
    await this.profile.cancelPhoneChange();
  }

  @Post('two-factor/enrol/start')
  @HttpCode(200)
  enrolStart(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store'); // carries the secret, once
    return this.profile.enrolStart(auth);
  }

  @Post('two-factor/enrol/confirm')
  @HttpCode(200)
  enrolConfirm(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store'); // carries the recovery codes, once
    return this.profile.enrolConfirm(auth, body);
  }

  @Post('two-factor/disable')
  @HttpCode(200)
  disable(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.profile.disable(auth, body);
  }
}

@Controller('email-change-requests')
export class EmailChangeRequestsController {
  constructor(private readonly changes: EmailChangesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.changes.list(query);
  }

  @Post(':id/decide')
  @HttpCode(200)
  decide(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.changes.decide(auth, id, body);
  }
}

@Controller('phone-change-requests')
export class PhoneChangeRequestsController {
  constructor(private readonly changes: PhoneChangesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.changes.list(query);
  }

  @Post(':id/decide')
  @HttpCode(200)
  decide(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.changes.decide(auth, id, body);
  }
}
