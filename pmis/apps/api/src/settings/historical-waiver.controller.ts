import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { HistoricalWaiverService } from './historical-waiver.service';

/** The one-time historical-load document waiver (contract tag `settings`, 0.14.3, Q462). */
@Controller('settings')
export class HistoricalWaiverController {
  constructor(private readonly svc: HistoricalWaiverService) {}

  @Get('historical-waiver')
  get() {
    return this.svc.get();
  }

  @Put('historical-waiver')
  @HttpCode(200)
  put(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.svc.put(auth, body);
  }
}
