import { Controller, Get } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DataHubService } from './data-hub.service';

/** The Data hub landing page: batches waiting for the caller, template changes and the caller's last template downloads. Read only. */
@Controller('data-hub')
export class DataHubController {
  constructor(private readonly hub: DataHubService) {}

  @Get('summary')
  summary(@Auth() auth: AuthContext) {
    return this.hub.summary(auth);
  }
}
