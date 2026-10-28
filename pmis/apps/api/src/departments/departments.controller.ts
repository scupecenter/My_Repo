import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DepartmentDto, DepartmentsService } from './departments.service';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>): Promise<{ items: DepartmentDto[] }> {
    return this.departments.list(auth, query);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<DepartmentDto> {
    return this.departments.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown): Promise<DepartmentDto> {
    return this.departments.update(id, body);
  }
}
