import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { DashboardUserWidgetsService } from "./dashboard-user-widgets.service";

/** Per-user dashboard widgets (contract tag `dashboard`, 0.15.585): the caller's own card order, hidden cards and layout templates. */
@Controller("me")
export class DashboardUserWidgetsController {
  constructor(private readonly svc: DashboardUserWidgetsService) {}

  @Get("dashboard-layout")
  layouts(@Auth() auth: AuthContext) {
    return this.svc.layouts(auth);
  }

  @Put("dashboard-layout/:tab")
  save(@Auth() auth: AuthContext, @Param("tab") tab: string, @Body() body: unknown) {
    return this.svc.save(auth, tab, body);
  }

  @Delete("dashboard-layout/:tab")
  reset(@Auth() auth: AuthContext, @Param("tab") tab: string) {
    return this.svc.reset(auth, tab);
  }

  @Get("dashboard-templates")
  templates(@Auth() auth: AuthContext) {
    return this.svc.templates(auth);
  }

  @Post("dashboard-templates")
  @HttpCode(201)
  saveTemplate(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.svc.saveTemplate(auth, body);
  }

  @Post("dashboard-templates/:id/apply")
  @HttpCode(200)
  apply(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.svc.applyTemplate(auth, id);
  }

  @Delete("dashboard-templates/:id")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.svc.deleteTemplate(auth, id);
  }
}
