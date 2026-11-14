import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { RegisterColumnsService } from './register-columns.service';

type Json = Record<string, unknown>;

/** Migration 0095: the columns, sections and name of a register, for the System Admin or a delegate of `fields.edit` (the database decides). */
@Controller('registers')
export class RegisterColumnsController {
  constructor(private readonly cols: RegisterColumnsService) {}

  private tag(res: Response, r: Json): Json {
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get(':key/fields')
  screen(@Param('key') key: string): Promise<Json> {
    return this.cols.screen(key);
  }

  @Post(':key/fields')
  @HttpCode(201)
  async create(@Param('key') key: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.create(key, body));
  }

  @Put(':key/fields-order')
  order(@Param('key') key: string, @Body() body: unknown): Promise<Json> {
    return this.cols.order(key, body);
  }

  @Get(':key/fields/:code/impact')
  impact(@Param('key') key: string, @Param('code') code: string, @Query() q: Record<string, string>): Promise<Json> {
    return this.cols.impact(key, code, { field_type: q.field_type, list_catalogue: q.list_catalogue, required: q.required });
  }

  @Patch(':key/fields/:code')
  async update(@Auth() auth: AuthContext, @Param('key') key: string, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.update(auth, key, code, ifMatch, body));
  }

  @Delete(':key/fields/:code')
  @HttpCode(200)
  remove(@Auth() auth: AuthContext, @Param('key') key: string, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown): Promise<Json> {
    return this.cols.remove(auth, key, code, ifMatch, body);
  }

  @Post(':key/sections')
  @HttpCode(201)
  async createSection(@Param('key') key: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.createSection(key, body));
  }

  @Patch(':key/sections/:id')
  async updateSection(@Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.updateSection(key, id, ifMatch, body));
  }

  @Delete(':key/sections/:id')
  @HttpCode(200)
  deleteSection(@Param('key') key: string, @Param('id') id: string, @Body() body: unknown): Promise<Json> {
    return this.cols.deleteSection(key, id, body);
  }

  @Patch(':key')
  async rename(@Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.rename(key, ifMatch, body));
  }
}
