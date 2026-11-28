import { Controller, Get } from '@nestjs/common';
import { FinanceHubService } from './finance-hub.service';

/** The Finance hub landing page: read-only summary cards over the financial_advances and invoices registers. Read only. */
@Controller('finance-hub')
export class FinanceHubController {
  constructor(private readonly hub: FinanceHubService) {}

  @Get('summary')
  summary() {
    return this.hub.summary();
  }
}
