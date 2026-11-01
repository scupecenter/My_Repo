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
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { AsBuiltItemsService } from "./as-built-items.service";
import { WarehouseService } from "./warehouse.service";

/** Warehouse (contract tag `warehouse`): item master, stock, movements. */
@Controller("warehouse")
export class WarehouseController {
  constructor(private readonly wh: WarehouseService) {}

  @Get("items")
  items(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.wh.listItems(auth, q);
  }

  @Post("items")
  @HttpCode(201)
  async createItem(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.createItem(auth, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Get("items/:id")
  async item(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.getItem(auth, id);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Patch("items/:id")
  async updateItem(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.updateItem(auth, id, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Get("stock")
  stock(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.wh.stock(auth, q);
  }

  @Get("movements")
  movements(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.wh.listMovements(auth, q);
  }

  @Post("movements")
  @HttpCode(201)
  async createMovement(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.createMovement(auth, body);
    res.setHeader("ETag", etagHeader(r.version as number));
    return r;
  }

  @Get("movements/:id")
  async movement(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.getMovement(auth, id);
    res.setHeader("ETag", etagHeader(r.version as number));
    return r;
  }

  @Post("movements/:id/cancel")
  @HttpCode(200)
  async cancel(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.cancelMovement(auth, id, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version as number));
    return r;
  }
}

/** The As-Built item list (contract tag `as-built`): editable items linked to Warehouse codes (Q74). */
@Controller("as-built")
export class AsBuiltItemsController {
  constructor(private readonly items: AsBuiltItemsService) {}

  @Get("items")
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.items.list(auth, q);
  }

  @Post("items")
  @HttpCode(201)
  async create(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.items.createItem(auth, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Get("items/:id")
  async get(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.items.get(auth, id);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Patch("items/:id")
  async update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.items.updateItem(auth, id, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
