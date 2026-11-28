import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessService } from './access/access.service';
import { AnnouncementsController, MeAnnouncementsController } from './announcements/announcements.controller';
import { AnnouncementsService } from './announcements/announcements.service';
import { AssignmentsController } from './assignments/assignments.controller';
import { AssignmentsService } from './assignments/assignments.service';
import { CalendarController } from './calendar/calendar.controller';
import { CalendarService } from './calendar/calendar.service';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { AsBuiltItemsService } from './warehouse/as-built-items.service';
import { AsBuiltItemsController, NumberSequencesController, WarehouseController } from './warehouse/warehouse.controller';
import { WarehouseService } from './warehouse/warehouse.service';
import { WarehouseConfigService } from './warehouse/warehouse-config.service';
import { ImportService } from './templates/import.service';
import { ImportJobsService } from './templates/import-jobs.service';
import { ImportBatchesController, TemplatesController } from './templates/templates.controller';
import { TemplatesService } from './templates/templates.service';
import { UploadInterceptor } from './templates/upload.interceptor';
import { RegistersController } from './registers/registers.controller';
import { RegisterColumnsController, RegisterStateController, StructurePolicyController, StructureProposalsController } from './registers/register-columns.controller';
import { RegisterRulesController } from './registers/register-rules.controller';
import { RegisterRulesService } from './registers/register-rules.service';
import { RegisterColumnsService } from './registers/register-columns.service';
import { StructureProposalsService } from './registers/structure-proposals.service';
import { RegistersService } from './registers/registers.service';
// P5 (migration 0057): the list catalogue
import { ListCataloguesController } from './registers/list-catalogues.controller';
import { ListCataloguesService } from './registers/list-catalogues.service';
import { FollowController } from './follow/follow.controller';
import { FollowService } from './follow/follow.service';
import { PresenceController } from './presence/presence.controller';
import { SavedViewsController } from './views/saved-views.controller';
import { SavedViewsService } from './views/saved-views.service';
import { FilterCatalogService } from './views/filter-catalog.service';
import { InsightsController } from './insights/insights.controller';
import { InsightsService } from './insights/insights.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationPersonalController } from './notifications/notification-personal.controller';
import { NotificationPersonalService } from './notifications/notification-personal.service';
import { NotificationsService } from './notifications/notifications.service';
import { StatusUpdatesController } from './status-updates/status-updates.controller';
import { StatusUpdatesService } from './status-updates/status-updates.service';
import { IssueStoppedController } from './issues/issue-stopped.controller';
import { IssueStoppedService } from './issues/issue-stopped.service';
import { SlaController } from './sla/sla.controller';
import { SlaService } from './sla/sla.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { LogHmacService } from './auth/log-hmac.service';
import { PasswordService } from './auth/password.service';
import { CspReportController } from './security/csp-report.controller';
import { RateLimiter } from './auth/rate-limiter';
import { SessionGuard } from './auth/session.guard';
import { SessionService } from './auth/session.service';
import { StepUpService } from './auth/step-up.service';
import { SyslogService } from './auth/syslog.service';
import { PasswordResetService } from './auth/password-reset.service';
import { TwoFactorService } from './auth/two-factor.service';
import { UserStateService } from './auth/user-state.service';
import { IdempotencyService } from './common/idempotency.service';
import { ProblemFilter } from './common/problem.filter';
import { APP_CONFIG, AppConfig } from './config/config';
import { DocumentsController, LibraryController } from './documents/documents.controller';
import { DocumentsGridController } from './documents/grid.controller';
import { DocsGridService } from './documents/grid.service';
import { DocumentsService } from './documents/documents.service';
import { LibraryService } from './documents/library.service';
import { StorageService } from './documents/storage.service';
import { PushController } from './push/push.controller';
import { PushService } from './push/push.service';
import { StorageJobsService } from './documents/storage-jobs.service';
import { DocumentTextController } from './documents/document-text.controller';
import { DocumentTextService } from './documents/document-text.service';
import { ZipService } from './documents/zip.service';
import { LibraryMenuController } from './library/library.controller';
import { LibraryMenuService } from './library/library.service';
import { DbService } from './db/db.service';
import { SnagsController } from './qc/snags.controller';
import { SnagsService } from './qc/snags.service';
import { JobsService } from './jobs/jobs.service';
import { TxInterceptor } from './db/tx.interceptor';
import { PmSchedulesController } from './registers/pm-schedules.controller';
import { PmSchedulesService } from './registers/pm-schedules.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { DashboardCacheInvalidator, DashboardCacheService } from './dashboard/dashboard-cache.service';
import { DashboardSettingsController } from './dashboard/dashboard-settings.controller';
import { DashboardSettingsService } from './dashboard/dashboard-settings.service';
import { SnapshotWeekdayController } from './dashboard/snapshot-weekday.controller';
import { SnapshotWeekdayService } from './dashboard/snapshot-weekday.service';
import { ProgressRagController } from './dashboard/progress-rag.controller';
import { ProgressRagService } from './dashboard/progress-rag.service';
import { GoalsController } from './dashboard/goals.controller';
import { GoalsService } from './dashboard/goals.service';
import { SiteMapService } from './dashboard/site-map.service';
import { DashboardExtrasService } from './dashboard/dashboard-extras.service';
import { DashboardOpsController } from './dashboard/dashboard-ops.controller';
import { DashboardTargetPolicyController } from './dashboard/dashboard-target-policy.controller';
import { DashboardTargetPolicyService } from './dashboard/dashboard-target-policy.service';
import { DashboardOpsService } from './dashboard/dashboard-ops.service';
import { DelayPeriodsController } from './dashboard/delay-periods.controller';
import { DelayPeriodsService } from './dashboard/delay-periods.service';
import { ProjectStatusService } from './dashboard/project-status.service';
import { WeightsController } from './dashboard/weights.controller';
import { WeightsService } from './dashboard/weights.service';
import { TeamScopeMatchController } from './settings/team-scope-match.controller';
import { TeamScopeMatchService } from './settings/team-scope-match.service';
import { GecolOrderWarningsController } from './settings/gecol-order-warnings.controller';
import { GecolOrderWarningsService } from './settings/gecol-order-warnings.service';
import { ImportsSettingsController } from './settings/imports-settings.controller';
import { TemplateNoticeSettingsController } from './settings/template-notice-settings.controller';
import { TemplateNoticeSettingsService } from './settings/template-notice-settings.service';
import { KanbanController } from './kanban/kanban.controller';
import { KanbanService } from './kanban/kanban.service';
import { ImportsSettingsService } from './settings/imports-settings.service';
import { NavLayoutController } from './settings/nav-layout.controller';
import { NavLayoutService } from './settings/nav-layout.service';
import { DeriveRulesController } from './settings/derive-rules.controller';
import { DeriveRulesService } from './settings/derive-rules.service';
import { MailPolicyController } from './settings/mail-policy.controller';
import { MailPolicyService } from './settings/mail-policy.service';
import { PartialCreditController } from './settings/partial-credit.controller';
import { PartialCreditService } from './settings/partial-credit.service';
import { MailKindsController } from './settings/mail-kinds.controller';
import { MailKindsService } from './settings/mail-kinds.service';
import { StructuralFreezeController } from './settings/structural-freeze.controller';
import { StructuralFreezeService } from './settings/structural-freeze.service';
import { UiAssetsController, UiIdentityController, UiPublicController } from './settings/ui-identity.controller';
import { OpsLimitsController } from './ops/ops-limits.controller';
import { OpsLimitsService } from './ops/ops-limits.service';
import { SecurityLocksController } from './security/security-locks.controller';
import { SecurityLocksService } from './security/security-locks.service';
import { DownloadLocksController } from './security/download-locks.controller';
import { DownloadLocksService } from './security/download-locks.service';
import { SupportAccessController } from './security/support-access.controller';
import { SupportAccessService } from './security/support-access.service';
import { NewDeviceController } from './security/new-device.controller';
import { NewDeviceService } from './security/new-device.service';
import { PasskeyController, PasskeySettingController } from './security/passkeys.controller';
import { PasskeyService } from './security/passkeys.service';
import { ExportLockInterceptor } from './security/export-lock';
import { UiIdentityService } from './settings/ui-identity.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { LoginPageController } from './settings/login-page.controller';
import { LoginPageService } from './settings/login-page.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { SettingsScreensController } from './settings/settings-screens.controller';
import { SettingsScreensService } from './settings/settings-screens.service';
import { AlertRulesController } from './settings/alert-rules.controller';
import { AlertRulesService } from './settings/alert-rules.service';
import { HistoricalWaiverController } from './settings/historical-waiver.controller';
import { HistoricalWaiverService } from './settings/historical-waiver.service';
import { DataResetController } from './settings/data-reset.controller';
import { DataResetService } from './settings/data-reset.service';
import { DataResetArchiveService } from './settings/data-reset-archive.service';
import { MaintenanceService } from './settings/maintenance.service';
import { SiteMasterController } from './site-master/site-master.controller';
import { CustomFieldsController } from './custom-fields/custom-fields.controller';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { SiteMasterColumnsController } from './site-master/site-master-columns.controller';
import { SiteMasterColumnsService } from './site-master/site-master-columns.service';
import { SiteMasterService } from './site-master/site-master.service';
import { P4cController } from './registers/p4c.controller';
import { FleetController } from './registers/fleet.controller';
import { FleetService } from './registers/fleet.service';
import { P4cService } from './registers/p4c.service';
import { DelegationsController } from './delegations/delegations.controller';
import { DelegationsService } from './delegations/delegations.service';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { GroupsController } from './groups/groups.controller';
import { GroupsService } from './groups/groups.service';
import { MatrixController } from './matrix/matrix.controller';
import { RecycleBinController } from './registers/recycle-bin.controller';
import { RecycleBinService } from './registers/recycle-bin.service';
import { MatrixService } from './matrix/matrix.service';
import { EmailChangeRequestsController, MeController, PhoneChangeRequestsController } from './me/me.controller';
import { MySessionsService } from './me/my-sessions.service';
import { NotifyAdminsService } from './me/notify-admins.service';
import { EmailChangesService, PhoneChangesService, ProfileService } from './me/profile.service';
import { MailPort } from './mail/mail.port';
import { OutboxMail } from './mail/outbox-mail';
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
import { SiteLocksService } from './sites/site-locks.service';
import { SiteDraftsController } from './sites/site-drafts.controller';
import { SiteDraftsService } from './sites/site-drafts.service';
import { UsersController } from './users/users.controller';
import { InvitationsController, PublicInvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { UsersRepo } from './users/users.repo';
import { ApprovalsService } from './workflow/approvals.service';
import { MyWorkService } from './workflow/my-work.service';
import { OverridesService } from './workflow/overrides.service';
import { TaskDetailService } from './workflow/task-detail.service';
import { TaskViewService } from './workflow/task-view.service';
import { TasksController } from './workflow/tasks.controller';
import { WorkflowEditorController, TaskDefinitionsController } from './workflow/workflow-editor.controller';
import { WorkflowEditorService } from './workflow/workflow-editor.service';
import { WorkflowService } from './workflow/workflow.service';
import { UsersService } from './users/users.service';
import { AuditLogController, LogsAdminController, SecurityLogController } from './logs/logs.controller';
import { LogsService } from './logs/logs.service';
import { SecurityLogService } from './logs/security-log.service';
import { JobRunsService } from './logs/job-runs.service';
import { ScenarioSettingsController, SiteApplicabilityController } from './scenario/scenario.controller';
import { ScenarioService } from './scenario/scenario.service';
import { IntegrityService } from './logs/integrity.service';
import { HealthController, MailController } from './mail/mail.controller';
import { MailService } from './mail/mail.service';
import { MappingService } from './master-import/mapping.service';
import { MasterImportController, TemplateMappingController } from './master-import/master-import.controller';
import { MasterImportService } from './master-import/master-import.service';
import { ContractorsController } from './contractors/contractors.controller';
import { ContractorsService } from './contractors/contractors.service';
import { ContractorPerformanceService } from './contractors/contractor-performance.service';
import { ExportsController } from './exports/exports.controller';
import { MasterExportService } from './exports/master-export.service';
import { ExportSchedulesService } from './exports/export-schedules.service';
import { AbsencesController, ReassignmentController } from './reassignment/reassignment.controller';
import { AbsencesService } from './reassignment/absences.service';
import { DailyPlanController, DailyPlanSettingsController } from './daily-plan/daily-plan.controller';
import { DailyPlanService } from './daily-plan/daily-plan.service';
import { DataHubController } from './data-hub/data-hub.controller';
import { FinanceHubController } from './finance-hub/finance-hub.controller';
import { DataHubService } from './data-hub/data-hub.service';
import { FinanceHubService } from './finance-hub/finance-hub.service';
import { ReassignmentService } from './reassignment/reassignment.service';
import { StaffRegistryController } from './staff-registry/staff-registry.controller';
import { StaffRegistryService } from './staff-registry/staff-registry.service';
import { DuplicateRowsSettingsController } from './settings/duplicate-rows-settings.controller';
import { DuplicateRowsSettingsService } from './settings/duplicate-rows-settings.service';

export function appModuleFor(config: AppConfig) {
  @Module({
    controllers: [
      InvitationsController, PublicInvitationsController, // 0091: before UsersController, so /users/invitations is not read as /users/{user_id}
      AuthController, MeController, EmailChangeRequestsController, PhoneChangeRequestsController, UsersController, GroupsController, DepartmentsController, MessagesController,
      AnnouncementsController, MeAnnouncementsController, RegionsController, RolesController, PermissionsController, AssignmentsController,
      DocumentTextController, PushController, DelegationsController, SitesController, SiteDraftsController, TasksController, WorkflowEditorController, TaskDefinitionsController, CalendarController, SlaController, IssueStoppedController, RegistersController, RecycleBinController, RegisterColumnsController, StructureProposalsController, StructurePolicyController, MatrixController, WarehouseController, AsBuiltItemsController, NumberSequencesController, RegisterStateController, RegisterRulesController,
      NotificationsController, NotificationPersonalController, FollowController, StatusUpdatesController, InsightsController, TemplatesController, ImportBatchesController, DocumentsController, DocumentsGridController, LibraryController, SnagsController,
DashboardController, DashboardSettingsController, GoalsController, PmSchedulesController, DashboardOpsController, DashboardTargetPolicyController, SupportAccessController, DownloadLocksController, UiPublicController, UiAssetsController, SecurityLocksController, DelayPeriodsController, WeightsController, TeamScopeMatchController, GecolOrderWarningsController, DeriveRulesController, MailKindsController, MailPolicyController, ImportsSettingsController, KanbanController, NavLayoutController, HistoricalWaiverController, SiteMasterController, SiteMasterColumnsController, CustomFieldsController, StructuralFreezeController, UiIdentityController, LoginPageController, ReportsController, SettingsScreensController, AlertRulesController, P4cController, FleetController, AuditLogController, SecurityLogController, LogsAdminController, NewDeviceController,
DashboardController, DashboardSettingsController, GoalsController, PmSchedulesController, DashboardOpsController, SupportAccessController, DownloadLocksController, UiPublicController, UiAssetsController, SecurityLocksController, DelayPeriodsController, WeightsController, TeamScopeMatchController, GecolOrderWarningsController, DeriveRulesController, MailKindsController, MailPolicyController, ImportsSettingsController, KanbanController, NavLayoutController, HistoricalWaiverController, SiteMasterController, SiteMasterColumnsController, CustomFieldsController, StructuralFreezeController, UiIdentityController, LoginPageController, ReportsController, SettingsScreensController, AlertRulesController, P4cController, FleetController, AuditLogController, SecurityLogController, LogsAdminController, NewDeviceController, OpsLimitsController,
      PartialCreditController, // 0.15.269 progress standards
      MediaController, // 0.15.292 (own line: the long lines above conflict on every merge)
      SnapshotWeekdayController, // 0.15.430 (own line)
      ProgressRagController, // 0.15.432 (own line)
      PasskeySettingController, PasskeyController, // S4
      TemplateNoticeSettingsController,
      CspReportController, // SEC-3
      DuplicateRowsSettingsController,
      ScenarioSettingsController, SiteApplicabilityController, // P1 (0052)
      MailController, HealthController,
      ListCataloguesController,
      MasterImportController, TemplateMappingController,
      ContractorsController,
      PresenceController,
      SavedViewsController,
      SearchController, // 0.15.17 (F4)
      ExportsController, // 0.15.34: Master-format export
      AbsencesController, ReassignmentController, // 0.15.54 (migration 0140): absences and the lead decisions (B12b)
      DailyPlanController, DailyPlanSettingsController, // 0.15.67 (migration 0149): My Work > Daily Plan (W7)
      StaffRegistryController, // 0.15.56 (0142): staff registry card, visibility, edit
      DataResetController, // 0.15.62 (0146): project data reset in Settings, two System Admins
      LibraryMenuController, // 0.15.70 (0151, W5): Library > Forms and Archive
      DataHubController, // 0.15.311 (0400): Data hub landing page
      FinanceHubController, // 0.15.361 (0406): Finance hub landing page
    ],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      DbService, SyslogService, LogHmacService, TwoFactorService, PasswordService, PasswordResetService, RateLimiter, SessionService, UserStateService, StepUpService,
      InvitationsService, // 0091
      AccessService, AuthService, UsersRepo, MeService, NotifyAdminsService, MySessionsService, ProfileService, EmailChangesService, PhoneChangesService, UsersService, GroupsService,
      DepartmentsService, MessagesService, AnnouncementsService, IdempotencyService, RegionsService, RolesService, PermissionsService,
      AssignmentsService, DelegationsService, SitesService, SiteLocksService, SiteDraftsService, TaskViewService, TaskDetailService, WorkflowEditorService, WorkflowService, ApprovalsService, MyWorkService, OverridesService, CalendarService, SlaService, IssueStoppedService, JobsService, RegistersService, RecycleBinService, RegisterColumnsService, StructureProposalsService, RegisterRulesService, MatrixService, WarehouseService, WarehouseConfigService, AsBuiltItemsService,
      NotificationsService, NotificationPersonalService, DocumentTextService, FollowService, StatusUpdatesService, InsightsService, TemplatesService, ImportService, ImportJobsService, UploadInterceptor, StorageService, DocumentsService, DocsGridService, LibraryService, ZipService, StorageJobsService, PushService, SnagsService,
DashboardService, DashboardSettingsService, GoalsService, PmSchedulesService, SiteMapService, ProjectStatusService, DelayPeriodsService, WeightsService, TeamScopeMatchService, GecolOrderWarningsService, DeriveRulesService, MailKindsService, MailPolicyService, ImportsSettingsService, KanbanService, NavLayoutService, HistoricalWaiverService, SiteMasterService, SiteMasterColumnsService, CustomFieldsService, StructuralFreezeService, UiIdentityService, LoginPageService, ReportsService, SettingsScreensService, AlertRulesService, P4cService, FleetService, LogsService, SecurityLogService, JobRunsService, MailService, IntegrityService, DashboardExtrasService, DashboardOpsService, DashboardTargetPolicyService, SecurityLocksService, SupportAccessService, DownloadLocksService, NewDeviceService,
DashboardService, DashboardSettingsService, GoalsService, PmSchedulesService, SiteMapService, ProjectStatusService, DelayPeriodsService, WeightsService, TeamScopeMatchService, GecolOrderWarningsService, DeriveRulesService, MailKindsService, MailPolicyService, ImportsSettingsService, KanbanService, NavLayoutService, HistoricalWaiverService, SiteMasterService, SiteMasterColumnsService, CustomFieldsService, StructuralFreezeService, UiIdentityService, LoginPageService, ReportsService, SettingsScreensService, AlertRulesService, P4cService, FleetService, LogsService, SecurityLogService, JobRunsService, MailService, IntegrityService, DashboardExtrasService, DashboardOpsService, SecurityLocksService, SupportAccessService, DownloadLocksService, NewDeviceService, OpsLimitsService,
      PartialCreditService, // 0.15.269 progress standards
      MediaService, // 0.15.292
      SnapshotWeekdayService, // 0.15.430 (own line)
      ProgressRagService, // 0.15.432 (own line)
      PasskeyService, // S4
      DuplicateRowsSettingsService,
      TemplateNoticeSettingsService,
      ScenarioService, // P1 (0052)
      ListCataloguesService,
      // P8 mails (MailPort) go through P9's mail outbox
      { provide: MailPort, useClass: OutboxMail },
      MasterImportService, MappingService,
      ContractorsService,
      ContractorPerformanceService,
      SavedViewsService, FilterCatalogService,
      SearchService, // 0.15.17 (F4)
      MasterExportService, ExportSchedulesService, // 0.15.34
      AbsencesService, ReassignmentService, // 0.15.54 (migration 0140)
      DailyPlanService, // 0.15.67 (migration 0149)
      StaffRegistryService, // 0.15.56 (0142)
      DataResetService, DataResetArchiveService, MaintenanceService, // 0.15.62 (0146)
      LibraryMenuService, // 0.15.70 (0151, W5)
      DataHubService, // 0.15.311 (0400)
      FinanceHubService, // 0.15.361 (0406)
      DashboardCacheService, // short cache of the /dashboard figures (30 s, scope-keyed)
      { provide: APP_GUARD, useClass: SessionGuard },
      { provide: APP_INTERCEPTOR, useClass: DashboardCacheInvalidator }, // before TxInterceptor: clears the dashboard cache after a configuration write has committed
      { provide: APP_INTERCEPTOR, useClass: TxInterceptor },
      { provide: APP_INTERCEPTOR, useClass: ExportLockInterceptor }, // 0.15.190 (0290): after TxInterceptor, so the lock is read inside the request transaction
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  })
  class AppModule {}
  return AppModule;
}
