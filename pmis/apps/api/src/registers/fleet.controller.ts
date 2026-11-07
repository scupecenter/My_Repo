import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { FleetService } from './fleet.service';

/** Migration 0076 (contract 0.15.0): extend a booking, top up an advance, free vehicles, readiness of an assignment. */
@Controller()
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Post('registers/car_dispatcher/records/:id/extend')
  @HttpCode(201)
  extend(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.fleet.extendBooking(auth, id, body);
  }

  @Post('registers/financial_advances/records/:id/top-up')
  @HttpCode(201)
  topUp(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.fleet.topUp(auth, id, body);
  }

  @Get('fleet/availability')
  availability(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.fleet.availability(auth, q);
  }

  @Get('registers/procurement/records/:id/readiness')
  readiness(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.fleet.readiness(auth, id);
  }
}
