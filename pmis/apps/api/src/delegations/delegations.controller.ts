import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DelegationDto, DelegationsService } from './delegations.service';

@Controller('delegations')
export class DelegationsController {
  constructor(private readonly delegations: DelegationsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.delegations.list(auth, query);
  }

  @Post()
  @HttpCode(201)
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<DelegationDto> {
    return this.delegations.create(auth, body);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<DelegationDto> {
    return this.delegations.revoke(auth, id, body);
  }
}
