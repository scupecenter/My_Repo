import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessService } from './access/access.service';
import { AnnouncementsController, MeAnnouncementsController } from './announcements/announcements.controller';
import { AnnouncementsService } from './announcements/announcements.service';
import { AssignmentsController } from './assignments/assignments.controller';
import { AssignmentsService } from './assignments/assignments.service';
import { CalendarController } from './calendar/calendar.controller';
import { CalendarService } from './calendar/calendar.service';
import { AsBuiltItemsService } from './warehouse/as-built-items.service';
import { AsBuiltItemsController, WarehouseController } from './warehouse/warehouse.controller';
import { WarehouseService } from './warehouse/warehouse.service';
import { ImportService } from './templates/import.service';
import { ImportBatchesController, TemplatesController } from './templates/templates.controller';
import { TemplatesService } from './templates/templates.service';
import { UploadInterceptor } from './templates/upload.interceptor';
import { RegistersController } from './registers/registers.controller';
import { RegistersService } from './registers/registers.service';
import { FollowController } from './follow/follow.controller';
import { FollowService } from './follow/follow.service';
import { InsightsController } from './insights/insights.controller';
import { InsightsService } from './insights/insights.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { StatusUpdatesController } from './status-updates/status-updates.controller';
import { StatusUpdatesService } from './status-updates/status-updates.service';
import { SlaController } from './sla/sla.controller';
import { SlaService } from './sla/sla.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { LogHmacService } from './auth/log-hmac.service';
import { PasswordService } from './auth/password.service';
import { RateLimiter } from './auth/rate-limiter';
import { SessionGuard } from './auth/session.guard';
import { SessionService } from './auth/session.service';
import { StepUpService } from './auth/step-up.service';
import { SyslogService } from './auth/syslog.service';
import { TwoFactorService } from './auth/two-factor.service';
import { UserStateService } from './auth/user-state.service';
import { IdempotencyService } from './common/idempotency.service';
import { ProblemFilter } from './common/problem.filter';
import { APP_CONFIG, AppConfig } from './config/config';
import { DbService } from './db/db.service';
import { JobsService } from './jobs/jobs.service';
import { TxInterceptor } from './db/tx.interceptor';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { ProjectStatusService } from './dashboard/project-status.service';
import { WeightsController } from './dashboard/weights.controller';
import { WeightsService } from './dashboard/weights.service';
import { DelegationsController } from './delegations/delegations.controller';
import { DelegationsService } from './delegations/delegations.service';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { GroupsController } from './groups/groups.controller';
import { GroupsService } from './groups/groups.service';
import { MatrixController } from './matrix/matrix.controller';
import { MatrixService } from './matrix/matrix.service';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { PermissionsController } from './permissions/permissions.controller';
import { PermissionsService } from './permissions/permissions.service';
import { RegionsController } from './regions/regions.controller';
import { RegionsService } from './regions/regions.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';
import { UsersController } from './users/users.controller';
import { UsersRepo } from './users/users.repo';
import { ApprovalsService } from './workflow/approvals.service';
import { TaskDetailService } from './workflow/task-detail.service';
import { TaskViewService } from './workflow/task-view.service';
import { TasksController } from './workflow/tasks.controller';
import { WorkflowService } from './workflow/workflow.service';
import { UsersService } from './users/users.service';

export function appModuleFor(config: AppConfig) {
  @Module({
    controllers: [
      AuthController, MeController, UsersController, GroupsController, DepartmentsController, MessagesController,
      AnnouncementsController, MeAnnouncementsController, RegionsController, RolesController, PermissionsController, AssignmentsController,
      DelegationsController, SitesController, TasksController, CalendarController, SlaController, RegistersController, MatrixController, WarehouseController, AsBuiltItemsController,
      NotificationsController, FollowController, StatusUpdatesController, InsightsController, TemplatesController, ImportBatchesController,
      DashboardController, WeightsController,
    ],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      DbService, SyslogService, LogHmacService, TwoFactorService, PasswordService, RateLimiter, SessionService, UserStateService, StepUpService,
      AccessService, AuthService, UsersRepo, MeService, UsersService, GroupsService,
      DepartmentsService, MessagesService, AnnouncementsService, IdempotencyService, RegionsService, RolesService, PermissionsService,
      AssignmentsService, DelegationsService, SitesService, TaskViewService, TaskDetailService, WorkflowService, ApprovalsService, CalendarService, SlaService, JobsService, RegistersService, MatrixService, WarehouseService, AsBuiltItemsService,
      NotificationsService, FollowService, StatusUpdatesService, InsightsService, TemplatesService, ImportService, UploadInterceptor,
      DashboardService, ProjectStatusService, WeightsService,
      { provide: APP_GUARD, useClass: SessionGuard },
      { provide: APP_INTERCEPTOR, useClass: TxInterceptor },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  })
  class AppModule {}
  return AppModule;
}
