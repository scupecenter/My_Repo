import { Controller, Get } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DocumentTextService } from './document-text.service';

/** Settings > Documents > Search index (contract 0.15.104, tag documents). System Admin only: counts of the files whose text is searchable. */
@Controller('admin/document-search-index')
export class DocumentTextController {
  constructor(private readonly text: DocumentTextService) {}

  @Get()
  status(@Auth() auth: AuthContext) {
    return this.text.status(auth);
  }
}
