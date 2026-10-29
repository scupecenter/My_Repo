import { Controller, Get } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { RegionDto, RegionsService } from './regions.service';

@Controller('regions')
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  @Get()
  list(@Auth() auth: AuthContext): Promise<{ items: RegionDto[] }> {
    return this.regions.list(auth);
  }
}
