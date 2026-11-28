import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SavedViewDto, SavedViewsService } from './saved-views.service';

/** P10 (contract 0.12.12): saved views of the list screens and the caller's drafts. */
@Controller()
export class SavedViewsController {
  constructor(private readonly svc: SavedViewsService) {}

  private tag(res: Response, v: SavedViewDto): SavedViewDto {
    res.setHeader('ETag', etagHeader(v.version));
    return v;
  }

  @Get('saved-views')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.list(auth, q);
  }

  @Post('saved-views')
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.create(auth, body));
  }

  /** F3 (0.15.31): the whitelist of filter fields of a list screen, for the filter builder. */
  @Get('saved-views/filter-fields')
  filterFields(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.filterFields(q, auth);
  }

  /** 0.15.49: the values of one enum field that match `q` (server-side search of a value list that was cut at 500). */
  @Get('saved-views/filter-fields/:field/values')
  filterFieldValues(@Auth() auth: AuthContext, @Param('field') field: string, @Query() q: Record<string, unknown>) {
    return this.svc.filterFieldValues(field, q, auth);
  }

  @Post('saved-views/import')
  @HttpCode(200)
  import(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.svc.import(auth, body);
  }

  @Get('me/default-views')
  defaultViews() {
    return this.svc.defaultViews();
  }

  @Post('saved-views/:id/set-default')
  @HttpCode(200)
  setDefault(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.setDefault(auth, id, true);
  }

  @Post('saved-views/:id/clear-default')
  @HttpCode(200)
  clearDefault(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.setDefault(auth, id, false);
  }

  @Get('me/home-pins')
  homePins() {
    return this.svc.homePins();
  }

  @Post('saved-views/:id/pin')
  @HttpCode(200)
  pin(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.pin(auth, id, true);
  }

  @Post('saved-views/:id/unpin')
  @HttpCode(200)
  unpin(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.pin(auth, id, false);
  }

  @Get('me/view-watches')
  viewWatches() {
    return this.svc.viewWatches();
  }

  @Post('saved-views/:id/watch')
  @HttpCode(200)
  watch(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.watch(auth, id, body);
  }

  @Post('saved-views/:id/unwatch')
  @HttpCode(200)
  unwatch(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.unwatch(auth, id);
  }

  @Post('saved-views/:id/watch-report')
  @HttpCode(200)
  watchReport(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.watchReport(auth, id, body);
  }

  @Get('saved-views/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.get(auth, id));
  }

  @Patch('saved-views/:id')
  async patch(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.update(auth, id, ifMatch, body));
  }

  @Post('saved-views/:id/deactivate')
  @HttpCode(200)
  async deactivate(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.setActive(auth, id, false, ifMatch, body));
  }

  @Post('saved-views/:id/restore')
  @HttpCode(200)
  async restore(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.setActive(auth, id, true, ifMatch, body));
  }

  @Post('saved-views/:id/transfer')
  @HttpCode(200)
  async transfer(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.transfer(auth, id, ifMatch, body));
  }

  @Get('saved-views/:id/versions')
  versions(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.versions(auth, id);
  }

  @Get('me/drafts')
  drafts() {
    return this.svc.drafts();
  }

  @Get('me/drafts/:key')
  getDraft(@Auth() auth: AuthContext, @Param('key') key: string) {
    return this.svc.getDraft(auth, key);
  }

  @Put('me/drafts/:key')
  @HttpCode(200)
  saveDraft(@Auth() auth: AuthContext, @Param('key') key: string, @Body() body: unknown) {
    return this.svc.saveDraft(auth, key, body);
  }

  @Delete('me/drafts/:key')
  @HttpCode(204)
  discardDraft(@Param('key') key: string) {
    return this.svc.discardDraft(key);
  }
}
