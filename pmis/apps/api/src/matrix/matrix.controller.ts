import { Body, Controller, Get, Headers, Patch, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { MatrixDto, MatrixService } from './matrix.service';

/** Responsibility Matrix (contract tag `matrix`, P1-BE-12). */
@Controller('matrix')
export class MatrixController {
  constructor(private readonly matrix: MatrixService) {}

  @Get()
  async get(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<MatrixDto> {
    const m = await this.matrix.get(auth, q);
    res.setHeader('ETag', etagHeader(m.version));
    return m;
  }

  @Patch()
  async patch(
    @Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<MatrixDto> {
    const m = await this.matrix.patch(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(m.version));
    return m;
  }
}
