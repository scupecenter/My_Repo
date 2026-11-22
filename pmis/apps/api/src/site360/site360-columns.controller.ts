import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import {
  Site360ColumnsService,
  type Site360ColumnListDto,
} from './site360-columns.service';

type Json = Record<string, unknown>;

/** Workflow Studio S2 (contract 0.15.43): the admin of the Site Master columns. The database decides who may (System Admin or an all-regions delegate of `fields` edit). */
@Controller('site360/columns')
export class Site360ColumnsController {
  constructor(private readonly cols: Site360ColumnsService) {}

  private tag(res: Response, r: Json): Json {
    if (typeof r.version === 'number')
      res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get()
  list(@Query() q: Record<string, unknown>): Promise<Site360ColumnListDto> {
    return this.cols.list(q);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(res, await this.cols.create(auth, body));
  }

  @Get(':ord')
  async get(
    @Param('ord') ord: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(res, await this.cols.get(ord));
  }

  @Patch(':ord')
  @HttpCode(200)
  async update(
    @Auth() auth: AuthContext,
    @Param('ord') ord: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(res, await this.cols.update(auth, ord, ifMatch, body));
  }

  @Delete(':ord')
  @HttpCode(200)
  remove(
    @Auth() auth: AuthContext,
    @Param('ord') ord: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Query() q: Record<string, unknown>,
  ): Promise<Json> {
    return this.cols.remove(auth, ord, ifMatch, q);
  }

  @Post(':ord/type-preview')
  @HttpCode(200)
  preview(@Param('ord') ord: string, @Body() body: unknown): Promise<Json> {
    return this.cols.preview(ord, body);
  }

  @Post(':ord/deactivate')
  @HttpCode(200)
  async deactivate(
    @Auth() auth: AuthContext,
    @Param('ord') ord: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(
      res,
      await this.cols.setActive(auth, ord, ifMatch, body, false),
    );
  }

  @Post(':ord/reactivate')
  @HttpCode(200)
  async reactivate(
    @Auth() auth: AuthContext,
    @Param('ord') ord: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(
      res,
      await this.cols.setActive(auth, ord, ifMatch, body, true),
    );
  }
}
