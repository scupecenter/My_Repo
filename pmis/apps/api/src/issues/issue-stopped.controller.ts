import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { IssueStoppedService } from './issue-stopped.service';

/** Migration 0171 (contract 0.15.87): the derived "stopped at" issue rows and their editable category map. */
@Controller()
export class IssueStoppedController {
  constructor(private readonly svc: IssueStoppedService) {}

  @Get('issues/stopped-rows')
  rows(@Auth() auth: AuthContext) {
    return this.svc.rows(auth);
  }

  @Get('settings/issue-task-map')
  map(@Auth() auth: AuthContext) {
    return this.svc.map(auth);
  }

  @Put('settings/issue-task-map/:task_code')
  save(@Auth() auth: AuthContext, @Param('task_code') taskCode: string, @Body() body: unknown) {
    return this.svc.save(auth, taskCode, body);
  }
}
