import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { Auth } from "../auth/decorators";
import type { AuthContext } from "../auth/auth.types";
import { etagHeader } from "../common/etag";
import { CustomFieldsService } from "./custom-fields.service";

/** The custom field definitions (contract tag `custom-fields`, 0.15.264): the reading side. */
@Controller("custom-fields")
export class CustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.list(auth, q);
  }

  @Get(":id")
  async one(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.one(auth, id);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Post()
  @HttpCode(201)
  async create(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.create(auth, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Patch(":id")
  @HttpCode(200)
  async update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.update(auth, id, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
