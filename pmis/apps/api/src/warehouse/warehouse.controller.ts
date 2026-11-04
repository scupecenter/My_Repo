import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { AsBuiltItemsService } from "./as-built-items.service";
import { WarehouseConfigService } from "./warehouse-config.service";
import { WarehouseService } from "./warehouse.service";

/** Warehouse (contract tag `warehouse`): item master, stock, movements. */
@Controller("warehouse")
export class WarehouseController {
  constructor(
    private readonly wh: WarehouseService,
    private readonly cfg: WarehouseConfigService,
  ) {}

  // Migration 0053 (P7): the TE dispatch of each site (D6), the region WL vendors (D58) and the owner data still missing (Q107).
  @Get("dispatch-status")
  dispatch(@Query() q: Record<string, unknown>) {
    return this.cfg.dispatchList(q);
  }

  @Get("dispatch-status/:siteId")
  dispatchSite(@Param("siteId") siteId: string) {
    return this.cfg.dispatchSite(siteId);
  }

  @Get("region-vendors")
  regionVendors(@Auth() auth: AuthContext) {
    return this.cfg.listRegionVendors(auth);
  }

  @Put("region-vendors/:regionId")
  async putRegionVendor(
    @Param("regionId") regionId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.cfg.putRegionVendor(regionId, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Get("config-gaps")
  configGaps(@Auth() auth: AuthContext) {
    return this.cfg.configGaps(auth);
  }

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

  // Q270 (migration 0067): the three movements that take quarantined stock out again.
  @Post("quarantine-exits")
  @HttpCode(201)
  async createQuarantineExit(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.wh.createQuarantineExit(auth, body);
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

/** Numbering sequences (contract tag `forms`, Q106): the numbering service, separate from the PDF; the warehouse documents use it today. */
@Controller("number-sequences")
export class NumberSequencesController {
  constructor(private readonly cfg: WarehouseConfigService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.cfg.listSequences(auth);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.cfg.createSequence(body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Patch(":key")
  async update(
    @Param("key") key: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.cfg.updateSequence(key, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
