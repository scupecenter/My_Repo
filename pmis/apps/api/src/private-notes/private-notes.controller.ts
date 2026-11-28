import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { PrivateNotesService } from './private-notes.service';

/** Private notes (contract 0.15.597): GET and PUT /me/private-notes/{entity_type}/{entity_id}, always the caller's own. */
@Controller()
export class PrivateNotesController {
  constructor(private readonly svc: PrivateNotesService) {}

  @Get('me/private-notes/:type/:id')
  get(@Param('type') type: string, @Param('id') id: string) {
    return this.svc.get(type, id);
  }

  @Put('me/private-notes/:type/:id')
  set(@Param('type') type: string, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.set(type, id, body);
  }
}
