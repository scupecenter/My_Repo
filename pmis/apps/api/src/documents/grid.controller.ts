import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DocsGridService } from './grid.service';

@Controller()
export class DocumentsGridController {
  constructor(private readonly grid: DocsGridService) {}

  @Get('documents/grid')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.grid.grid(auth, q);
  }

  @Get('documents/grid/view')
  view(@Auth() auth: AuthContext) {
    return this.grid.getView(auth);
  }

  @Put('documents/grid/view')
  @HttpCode(204)
  async saveView(@Auth() auth: AuthContext, @Body() body: unknown) {
    await this.grid.saveView(auth, body);
  }

  @Post('sites/:site_id/document-overrides')
  @HttpCode(201)
  setOverride(@Auth() auth: AuthContext, @Param('site_id') siteId: string, @Body() body: unknown) {
    return this.grid.setOverride(auth, siteId, body);
  }

  @Post('document-overrides/:override_id/revert')
  @HttpCode(200)
  revertOverride(@Auth() auth: AuthContext, @Param('override_id') id: string, @Body() body: unknown) {
    return this.grid.revertOverride(auth, id, body);
  }

  @Post('files/:file_id/move')
  @HttpCode(200)
  moveFile(@Auth() auth: AuthContext, @Param('file_id') id: string, @Body() body: unknown) {
    return this.grid.moveFile(auth, id, body);
  }

  @Post('document-library/:doc_type_id/delete')
  @HttpCode(200)
  deleteType(@Auth() auth: AuthContext, @Param('doc_type_id') id: string, @Body() body: unknown) {
    return this.grid.deleteType(auth, id, body);
  }
}
