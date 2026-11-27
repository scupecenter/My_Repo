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

  @Get('dismantle/rn-options')
  rnOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.dismantleRnOptions(auth, q);
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

  /** F2: the same picker for Change Control (`procurement_order_id`). */
  @Get('change_control/order-options')
  changeControlOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'change_control');
  }

  @Get('quality/order-options')
  qualityOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'quality');
  }

  /** D58: the advances an expense or settlement may name (`advance_id`): approved, disbursed or in settlement, of the site when it is given. */
  @Get('financial_advances/advance-options')
  advanceIdOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.advanceOptions(auth, q);
  }

  /** D58: the same order picker for the Invoices register (`procurement_record_id`). */
  @Get('invoices/order-options')
  invoiceOrderOptions(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.p4c.warehouseOrderOptions(auth, q, 'invoices');
  }

  /** D58: the companies of the Contractors list an invoice may name as its supplier (`supplier_party_id`); needs the Invoices view. */
  @Get('invoices/supplier-options')
  invoiceSupplierOptions(@Auth() auth: AuthContext) {
    return this.p4c.invoiceSupplierOptions(auth);
  }

  /** 0431: the picker of any link field of the catalogue (the records of the target register the caller may see; a Procurement link is the order picker). */
  @Get(':key/link-options')
  linkOptions(@Auth() auth: AuthContext, @Param('key') key: string, @Query() q: Record<string, unknown>) {
    return this.p4c.linkOptions(auth, key, q);
  }

  @Get('issues/risk-options')
  issueRiskOptions(@Auth() auth: AuthContext) {
    return this.p4c.issueRiskOptions(auth);
  }

  @Get('risks/:entity_id/issues')
  riskIssues(@Auth() auth: AuthContext, @Param('entity_id') entityId: string) {
    return this.p4c.riskIssues(auth, entityId);
  }

  @Get('procurement/:entity_id/receipts')
  orderReceipts(@Auth() auth: AuthContext, @Param('entity_id') entityId: string) {
    return this.p4c.orderReceipts(auth, entityId);
  }

  /** 0324: the records linked to this record, in both directions. */
  @Get(':register_key/:entity_id/related')
  related(@Auth() auth: AuthContext, @Param('register_key') key: string, @Param('entity_id') entityId: string) {
    return this.p4c.relatedRecords(auth, key, entityId);
  }

  @Post('hlc/legacy-migration')
  @HttpCode(200)
  legacy(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.p4c.legacyMigration(auth, body);
  }
}
