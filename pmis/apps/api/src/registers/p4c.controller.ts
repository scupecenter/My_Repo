import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { P4cService } from './p4c.service';

/** P4c (contract 0.12.11, migration 0063): HLC purchase requests of an HLC record (Q150), the Dismantle order picker (Q114), the legacy HLC migration (Q139). */
@Controller('registers')
export class P4cController {
  constructor(private readonly p4c: P4cService) {}

  @Put('hlc/records/:id/purchase-requests')
  async setLinks(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.p4c.setHlcPurchaseRequests(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version as number));
    return r;
  }

  @Get('dismantle/order-options')
  orderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.dismantleOrderOptions(auth, q);
  }

  @Get('warehouse/order-options')
  warehouseOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q);
  }

  /** 0.15.92: the same picker for the Car dispatcher and Financial advances (`procurement_record_id`); each needs its own module view, the SQL adds the Procurement view. */
  @Get('car_dispatcher/order-options')
  carOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'car_dispatcher');
  }

  @Get('financial_advances/order-options')
  advanceOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'financial_advances');
  }

  /** The same picker for the Issue log and Quality (`procurement_order_id`; the contractor comes from the order). */
  @Get('issues/order-options')
  issueOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'issues');
  }

  @Get('quality/order-options')
  qualityOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'quality');
  }

  @Get('procurement/:entity_id/receipts')
  orderReceipts(@Auth() auth: AuthContext, @Param('entity_id') entityId: string) {
    return this.p4c.orderReceipts(auth, entityId);
  }

  @Post('hlc/legacy-migration')
  @HttpCode(200)
  legacy(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.p4c.legacyMigration(auth, body);
  }
}
