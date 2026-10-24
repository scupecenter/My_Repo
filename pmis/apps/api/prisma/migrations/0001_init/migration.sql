-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending_assignment', 'active', 'suspended', 'disabled');

-- CreateEnum
CREATE TYPE "PermissionLevel" AS ENUM ('view', 'entry', 'review', 'approve', 'admin');

-- CreateEnum
CREATE TYPE "TeamKind" AS ENUM ('cw', 'te', 'both', 'none');

-- CreateEnum
CREATE TYPE "DelegationScope" AS ENUM ('full', 'partial');

-- CreateEnum
CREATE TYPE "DeliveryScenario" AS ENUM ('new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation');

-- CreateEnum
CREATE TYPE "OverallStatus" AS ENUM ('not_started', 'in_progress', 'on_hold', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ScopeFlag" AS ENUM ('yes', 'na');

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('locked', 'open', 'entry', 'in_review', 'in_approval', 'approved', 'rejected', 'na', 'skipped', 'suspended');

-- CreateEnum
CREATE TYPE "WorkflowAction" AS ENUM ('submit', 'approve', 'reject', 'auto_skip', 'claim', 'release', 'reassign', 'admin_override', 'reopen');

-- CreateEnum
CREATE TYPE "MatrixRule" AS ENUM ('any_one', 'all_members');

-- CreateEnum
CREATE TYPE "AssigneeKind" AS ENUM ('user', 'role', 'sub_role', 'group');

-- CreateEnum
CREATE TYPE "DocKind" AS ENUM ('scanned_document', 'photo', 'email', 'report', 'excel_template');

-- CreateEnum
CREATE TYPE "DocPlacementKind" AS ENUM ('task', 'qc', 'register');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('missing', 'uploaded', 'in_review', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AppliesTo" AS ENUM ('new_tasks_only', 'open_tasks_too');

-- CreateEnum
CREATE TYPE "SnagStatus" AS ENUM ('open', 'fix_uploaded', 'in_review', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "GeofenceResult" AS ENUM ('inside', 'outside', 'no_gps', 'not_checked');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('uploaded', 'validated', 'in_review', 'partially_approved', 'approved', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "RowAction" AS ENUM ('create', 'update', 'unchanged', 'error');

-- CreateEnum
CREATE TYPE "RowDecision" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ChangeKind" AS ENUM ('scope_change', 'date_change', 'suspension', 'resumption', 'other');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('requested', 'approved', 'rejected', 'applied');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('debug', 'info', 'warn', 'error');

-- CreateEnum
CREATE TYPE "NotifyChannel" AS ENUM ('in_app', 'email');

-- CreateEnum
CREATE TYPE "RegisterStatus" AS ENUM ('open', 'in_progress', 'closed', 'na');

-- CreateEnum
CREATE TYPE "ExternalPartyType" AS ENUM ('cw_contractor', 'te_vendor', 'gecol', 'hlc', 'supplier', 'landlord', 'other');

-- CreateTable
CREATE TABLE "regions" (
    "id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "team" "TeamKind" NOT NULL DEFAULT 'none',
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sub_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "m365_object_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "employee_id" CHAR(4),
    "status" "UserStatus" NOT NULL DEFAULT 'pending_assignment',
    "role_id" UUID,
    "team" "TeamKind" NOT NULL DEFAULT 'none',
    "permission_level" "PermissionLevel" NOT NULL DEFAULT 'view',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "theme" TEXT NOT NULL DEFAULT 'light',
    "is_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret_enc" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sub_roles" (
    "user_id" UUID NOT NULL,
    "sub_role_id" UUID NOT NULL,

    CONSTRAINT "user_sub_roles_pkey" PRIMARY KEY ("user_id","sub_role_id")
);

-- CreateTable
CREATE TABLE "user_regions" (
    "user_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,

    CONSTRAINT "user_regions_pkey" PRIMARY KEY ("user_id","region_id")
);

-- CreateTable
CREATE TABLE "user_modules" (
    "user_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,

    CONSTRAINT "user_modules_pkey" PRIMARY KEY ("user_id","module_key")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system_admins" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "delegations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "scope" "DelegationScope" NOT NULL,
    "permissions" JSONB,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clusters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cluster_code" TEXT NOT NULL,
    "name" TEXT,
    "region_id" INTEGER,
    "kpi_acceptance_date" DATE,
    "kpi_source_date" DATE,
    "kpi_validated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_code" TEXT NOT NULL,
    "owner_site_id" TEXT,
    "name" TEXT NOT NULL,
    "region_id" INTEGER NOT NULL,
    "sub_region" TEXT,
    "cluster_id" UUID,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "address" TEXT,
    "site_type" TEXT,
    "site_scenario" TEXT,
    "uplink_site" TEXT,
    "tower_owner" TEXT,
    "existing_or_new" TEXT,
    "rt_or_gf" TEXT,
    "tower_type" TEXT,
    "tower_height_m" DECIMAL(6,1),
    "config_summary" TEXT,
    "rf_survey_date" DATE,
    "acquisition_date" DATE,
    "project_phase" TEXT,
    "delivery_batch" TEXT,
    "delivery_scenario" "DeliveryScenario",
    "cw_delivery_model" TEXT,
    "scope_tower_erection" "ScopeFlag" NOT NULL DEFAULT 'na',
    "scope_site_adaption" "ScopeFlag" NOT NULL DEFAULT 'na',
    "scope_gecol_power" "ScopeFlag" NOT NULL DEFAULT 'na',
    "scope_hlc_fiber" "ScopeFlag" NOT NULL DEFAULT 'na',
    "scope_te_full" "ScopeFlag" NOT NULL DEFAULT 'na',
    "scope_te_ip_router_only" "ScopeFlag" NOT NULL DEFAULT 'na',
    "overall_status" "OverallStatus" NOT NULL DEFAULT 'not_started',
    "current_milestone" TEXT,
    "next_milestone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "milestone_name" TEXT NOT NULL,
    "approval_levels" INTEGER NOT NULL DEFAULT 3,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "stage_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "stage_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "has_documents" BOOLEAN NOT NULL DEFAULT true,
    "is_milestone_task" BOOLEAN NOT NULL DEFAULT false,
    "approval_levels" INTEGER,
    "sla_working_days" INTEGER,
    "sla_from_task_code" TEXT,
    "condition_rule" JSONB,
    "default_external_party" "ExternalPartyType",
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "task_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "task_def_id" UUID NOT NULL,
    "state" "TaskState" NOT NULL DEFAULT 'locked',
    "current_level" INTEGER NOT NULL DEFAULT 0,
    "levels_required" INTEGER NOT NULL DEFAULT 3,
    "ball_in_court_user_id" UUID,
    "ball_in_court_group_id" UUID,
    "ball_in_court_role_id" UUID,
    "external_party_id" UUID,
    "baseline_date" DATE,
    "planned_date" DATE,
    "planned_start" DATE,
    "actual_start" DATE,
    "actual_date" DATE,
    "submitted_date" DATE,
    "approved_date" DATE,
    "values" JSONB,
    "lock_reason" TEXT,
    "is_na" BOOLEAN NOT NULL DEFAULT false,
    "na_reason" TEXT,
    "admin_override" BOOLEAN NOT NULL DEFAULT false,
    "has_override_flag_in_kpi" BOOLEAN NOT NULL DEFAULT false,
    "due_date" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "action" "WorkflowAction" NOT NULL,
    "holder_user_id" UUID,
    "holder_group_id" UUID,
    "acted_by" UUID,
    "on_behalf_of" UUID,
    "claimed_by" UUID,
    "note" TEXT,
    "admin_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "stepup_verified" BOOLEAN NOT NULL DEFAULT false,
    "batch_row_id" UUID,
    "before_state" "TaskState",
    "after_state" "TaskState",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matrix_cells" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stage_id" UUID NOT NULL,
    "task_def_id" UUID,
    "level" INTEGER NOT NULL,
    "rule" "MatrixRule" NOT NULL DEFAULT 'any_one',
    "region_id" INTEGER,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "matrix_cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matrix_cell_assignees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cell_id" UUID NOT NULL,
    "kind" "AssigneeKind" NOT NULL,
    "ref_id" UUID NOT NULL,

    CONSTRAINT "matrix_cell_assignees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_parties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "type" "ExternalPartyType" NOT NULL,
    "company_type" TEXT,
    "contract_ref" TEXT,
    "contract_start" DATE,
    "contract_end" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "external_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "party_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "team_type" TEXT,
    "specialization" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "external_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "kind" "DocKind" NOT NULL DEFAULT 'scanned_document',
    "is_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "condition_rule" JSONB,
    "formats" TEXT[] DEFAULT ARRAY['pdf', 'jpg', 'jpeg', 'png']::TEXT[],
    "max_size_mb" INTEGER NOT NULL DEFAULT 20,
    "min_files" INTEGER NOT NULL DEFAULT 1,
    "max_files" INTEGER,
    "photo_rules" JSONB,
    "has_expiry" BOOLEAN NOT NULL DEFAULT false,
    "expiry_field" TEXT,
    "blank_form_file_id" UUID,
    "applies_to" "AppliesTo" NOT NULL DEFAULT 'new_tasks_only',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type_placements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doc_type_id" UUID NOT NULL,
    "kind" "DocPlacementKind" NOT NULL,
    "task_def_id" UUID,
    "snag_type_id" UUID,
    "register_key" TEXT,

    CONSTRAINT "document_type_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID,
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "doc_type_id" UUID NOT NULL,
    "candidate_label" TEXT,
    "status" "DocStatus" NOT NULL DEFAULT 'missing',
    "reject_reason" TEXT,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slot_id" UUID NOT NULL,
    "file_group_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "original_name" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_date" DATE,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snag_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "min_photos" INTEGER NOT NULL DEFAULT 1,
    "required_shots" JSONB,
    "formats" TEXT[] DEFAULT ARRAY['jpg', 'png', 'heic']::TEXT[],
    "max_size_mb" INTEGER NOT NULL DEFAULT 20,
    "blocks_preliminary_acceptance" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "snag_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "task_id" UUID,
    "snag_type_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "stage_ref" TEXT,
    "description" TEXT NOT NULL,
    "severity" TEXT,
    "status" "SnagStatus" NOT NULL DEFAULT 'open',
    "raised_by" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target_date" DATE,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by" UUID,
    "responsible_party_id" UUID,

    CONSTRAINT "snags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snag_photos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snag_id" UUID NOT NULL,
    "shot_type" TEXT,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "exif_date" TIMESTAMPTZ(6),
    "unknown_capture_date" BOOLEAN NOT NULL DEFAULT false,
    "before_snag_raised" BOOLEAN NOT NULL DEFAULT false,
    "gps_lat" DECIMAL(9,6),
    "gps_lon" DECIMAL(9,6),
    "distance_m" DECIMAL(9,1),
    "geofence_result" "GeofenceResult" NOT NULL DEFAULT 'not_checked',
    "geofence_radius_m" INTEGER NOT NULL DEFAULT 300,
    "captured_in_app" BOOLEAN NOT NULL DEFAULT false,
    "stamp_meta" JSONB,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_note" TEXT,

    CONSTRAINT "snag_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_entity" TEXT NOT NULL,
    "is_master_format" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "template_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_def_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "header_checksum" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "storage_key" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_version_id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'uploaded',
    "uploaded_by" UUID NOT NULL,
    "region_scope" INTEGER[],
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "rows_error" INTEGER NOT NULL DEFAULT 0,
    "approve_mode" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batch_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "site_code" TEXT,
    "region_id" INTEGER,
    "target_entity" TEXT NOT NULL,
    "target_id" UUID,
    "action" "RowAction" NOT NULL DEFAULT 'create',
    "payload" JSONB NOT NULL,
    "diff" JSONB,
    "errors" JSONB,
    "decision" "RowDecision" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,

    CONSTRAINT "import_batch_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID,
    "entity_type" TEXT,
    "entity_id" UUID,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "is_rejection_note" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "channel" "NotifyChannel" NOT NULL DEFAULT 'in_app',
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "task_id" UUID,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "milestone_code" TEXT NOT NULL,
    "baseline_date" DATE,
    "planned_start" DATE,

    CONSTRAINT "baseline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_gate_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "link_code" TEXT NOT NULL,
    "from_milestone" TEXT NOT NULL,
    "to_milestone" TEXT NOT NULL,
    "min_wd" INTEGER NOT NULL,
    "max_wd" INTEGER NOT NULL,

    CONSTRAINT "phase_gate_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "change_code" TEXT NOT NULL,
    "site_id" UUID,
    "region_id" INTEGER,
    "kind" "ChangeKind" NOT NULL,
    "scope_item" TEXT,
    "old_value" TEXT,
    "new_value" TEXT,
    "reason" TEXT,
    "request_date" DATE,
    "status" "ChangeStatus" NOT NULL DEFAULT 'requested',
    "approved_by" UUID,
    "approval_date" DATE,
    "ticket_id" TEXT,
    "requested_by" UUID NOT NULL,
    "suspension_start" DATE,
    "resumption_date" DATE,
    "paired_change_id" UUID,
    "shift_working_days" INTEGER,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rf_design_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "nominal_plan_issue_date" DATE,
    "nominal_lat" DECIMAL(9,6),
    "nominal_lon" DECIMAL(9,6),
    "search_ring_radius_m" INTEGER,
    "search_ring_received_date" DATE,
    "deviation_from_nominal_m" DECIMAL(9,1),
    "antenna_height_m" DECIMAL(6,1),
    "sectors" INTEGER,
    "azimuths" TEXT,
    "tilt" TEXT,
    "tss_plan_date" DATE,

    CONSTRAINT "rf_design_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "candidate_no" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "address" TEXT,
    "distance_to_nominal_m" DECIMAL(9,1),
    "within_search_ring" BOOLEAN,
    "submitted_date" DATE,
    "mw_los_check" TEXT,
    "test_pit_result" TEXT,
    "tss_date" DATE,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "selection_date" DATE,
    "owner_name" TEXT,
    "ownership_type" TEXT,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "negotiation_start" DATE,
    "contract_no" TEXT,
    "contract_signoff_date" DATE,
    "lease_expiry_date" DATE,
    "title_verified" BOOLEAN,

    CONSTRAINT "acquisition_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "delivery" TEXT,
    "pr_no" TEXT,
    "pr_date" DATE,
    "po_wo_no" TEXT,
    "po_wo_date" DATE,
    "party_id" UUID,
    "team_id" UUID,
    "order_status" TEXT,
    "remark" TEXT,

    CONSTRAINT "procurement_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gecol_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "pr_no" TEXT,
    "contractor" TEXT,
    "survey_date" DATE,
    "layout_received" DATE,
    "layout_approved" DATE,
    "notice_date" DATE,
    "mos_date" DATE,
    "installation_finish" DATE,
    "aat_acceptance_date" DATE,
    "docs_approval_date" DATE,
    "meter_no" TEXT,
    "power_on_date" DATE,
    "billing_conversion_date" DATE,
    "status" TEXT,
    "remark" TEXT,

    CONSTRAINT "gecol_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hlc_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "request_no" TEXT,
    "request_date" DATE,
    "fiber_uplink" TEXT,
    "fiber_status" TEXT,
    "internal_fiber_team" TEXT,
    "installation_date" DATE,
    "tx_link_tested_date" DATE,
    "status" TEXT,
    "remark" TEXT,

    CONSTRAINT "hlc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permit_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "permit_type" TEXT NOT NULL,
    "applied_date" DATE,
    "status" TEXT,
    "valid_from" DATE,
    "valid_to" DATE,
    "na_reason" TEXT,
    "na_approved_by" TEXT,
    "hse_checks" JSONB,
    "stop_work" BOOLEAN NOT NULL DEFAULT false,
    "stop_lifted_date" DATE,
    "remark" TEXT,

    CONSTRAINT "permit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_code" TEXT NOT NULL,
    "item_group" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "serialised" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "warehouse_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_serials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_id" UUID NOT NULL,
    "serial_no" TEXT NOT NULL,
    "pl_invoice_no" TEXT,
    "box_no" TEXT,
    "dn_no" TEXT,
    "rn_no" TEXT,
    "site_id" UUID,
    "region_id" INTEGER,
    "dispatch_date" DATE,
    "return_condition" TEXT,
    "status" TEXT,
    "installed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "warehouse_serials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_site_qty" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "item_id" UUID NOT NULL,
    "required" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "dispatched" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "installed" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_site_qty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_inspections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_code" TEXT NOT NULL,
    "record_type" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "stage" TEXT,
    "activity" TEXT,
    "point_type" TEXT,
    "description" TEXT,
    "severity" TEXT,
    "team" TEXT,
    "party_id" UUID,
    "raised_date" DATE,
    "target_date" DATE,
    "result" TEXT,
    "closed_date" DATE,
    "released_by" TEXT,
    "root_cause" TEXT,
    "linked_record_code" TEXT,
    "na_reason" TEXT,
    "status" TEXT,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "snag_id" UUID,

    CONSTRAINT "quality_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "owner_id" UUID,
    "owner_text" TEXT,
    "party_id" UUID,
    "raised_date" DATE NOT NULL,
    "due_date" DATE,
    "status" "RegisterStatus" NOT NULL DEFAULT 'open',
    "closed_date" DATE,
    "delay_days" INTEGER,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "risk_code" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "category" TEXT,
    "scope" TEXT,
    "affected_sites" INTEGER,
    "probability" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "response" TEXT,
    "mitigation" TEXT,
    "risk_owner" TEXT,
    "action_owner" TEXT,
    "target_date" DATE,
    "status" "RegisterStatus" NOT NULL DEFAULT 'open',
    "trend" TEXT,
    "last_review" DATE,
    "next_review" DATE,
    "region_id" INTEGER,

    CONSTRAINT "risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_handover" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "commissioning_power_safe" BOOLEAN,
    "uplink_ready_date" DATE,
    "om_checklist" TEXT,
    "na_reason" TEXT,
    "om_accepted_by" TEXT,
    "om_acceptance_date" DATE,
    "site_access_keys_handed" BOOLEAN,
    "hoto_package_date" DATE,
    "legacy_handover_date" DATE,
    "obligations_closure_date" DATE,
    "closure_approved_by" TEXT,
    "closure_approval_date" DATE,
    "closure_ready" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "readiness_handover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "as_built_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "region_id" INTEGER NOT NULL,
    "submitted_date" DATE,
    "quantities" JSONB NOT NULL,

    CONSTRAINT "as_built_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "meeting_date" TIMESTAMPTZ(6) NOT NULL,
    "region_id" INTEGER,
    "attendees" JSONB,
    "minutes" TEXT,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meeting_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "owner_id" UUID,
    "due_date" DATE,
    "status" "RegisterStatus" NOT NULL DEFAULT 'open',
    "site_id" UUID,

    CONSTRAINT "meeting_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "on_behalf_of" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "site_id" UUID,
    "region_id" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "is_admin_override" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "user_id" UUID,
    "request_id" TEXT,

    CONSTRAINT "system_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "regions_code_key" ON "regions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sub_roles_code_key" ON "sub_roles"("code");

-- CreateIndex
CREATE INDEX "sub_roles_role_id_idx" ON "sub_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_m365_object_id_key" ON "users"("m365_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_name_key" ON "groups"("name");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE INDEX "delegations_to_user_id_revoked_idx" ON "delegations"("to_user_id", "revoked");

-- CreateIndex
CREATE UNIQUE INDEX "clusters_cluster_code_key" ON "clusters"("cluster_code");

-- CreateIndex
CREATE UNIQUE INDEX "sites_site_code_key" ON "sites"("site_code");

-- CreateIndex
CREATE INDEX "sites_region_id_overall_status_idx" ON "sites"("region_id", "overall_status");

-- CreateIndex
CREATE INDEX "sites_cluster_id_idx" ON "sites"("cluster_id");

-- CreateIndex
CREATE INDEX "sites_delivery_scenario_idx" ON "sites"("delivery_scenario");

-- CreateIndex
CREATE INDEX "sites_project_phase_delivery_batch_idx" ON "sites"("project_phase", "delivery_batch");

-- CreateIndex
CREATE UNIQUE INDEX "stage_definitions_code_key" ON "stage_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "stage_definitions_seq_key" ON "stage_definitions"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "task_definitions_code_key" ON "task_definitions"("code");

-- CreateIndex
CREATE INDEX "task_definitions_stage_id_seq_idx" ON "task_definitions"("stage_id", "seq");

-- CreateIndex
CREATE INDEX "task_instances_region_id_state_idx" ON "task_instances"("region_id", "state");

-- CreateIndex
CREATE INDEX "task_instances_state_ball_in_court_user_id_idx" ON "task_instances"("state", "ball_in_court_user_id");

-- CreateIndex
CREATE INDEX "task_instances_ball_in_court_group_id_state_idx" ON "task_instances"("ball_in_court_group_id", "state");

-- CreateIndex
CREATE INDEX "task_instances_ball_in_court_role_id_state_idx" ON "task_instances"("ball_in_court_role_id", "state");

-- CreateIndex
CREATE INDEX "task_instances_task_def_id_state_idx" ON "task_instances"("task_def_id", "state");

-- CreateIndex
CREATE INDEX "task_instances_due_date_idx" ON "task_instances"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "task_instances_site_id_task_def_id_key" ON "task_instances"("site_id", "task_def_id");

-- CreateIndex
CREATE INDEX "workflow_steps_task_id_created_at_idx" ON "workflow_steps"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "workflow_steps_acted_by_idx" ON "workflow_steps"("acted_by");

-- CreateIndex
CREATE INDEX "matrix_cells_stage_id_level_idx" ON "matrix_cells"("stage_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "matrix_cells_stage_id_task_def_id_level_region_id_key" ON "matrix_cells"("stage_id", "task_def_id", "level", "region_id");

-- CreateIndex
CREATE INDEX "matrix_cell_assignees_kind_ref_id_idx" ON "matrix_cell_assignees"("kind", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "matrix_cell_assignees_cell_id_kind_ref_id_key" ON "matrix_cell_assignees"("cell_id", "kind", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_parties_name_key" ON "external_parties"("name");

-- CreateIndex
CREATE UNIQUE INDEX "external_teams_party_id_name_key" ON "external_teams"("party_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "document_types_code_key" ON "document_types"("code");

-- CreateIndex
CREATE INDEX "document_type_placements_doc_type_id_idx" ON "document_type_placements"("doc_type_id");

-- CreateIndex
CREATE INDEX "document_type_placements_task_def_id_idx" ON "document_type_placements"("task_def_id");

-- CreateIndex
CREATE INDEX "document_slots_task_id_idx" ON "document_slots"("task_id");

-- CreateIndex
CREATE INDEX "document_slots_site_id_doc_type_id_idx" ON "document_slots"("site_id", "doc_type_id");

-- CreateIndex
CREATE INDEX "document_slots_region_id_status_idx" ON "document_slots"("region_id", "status");

-- CreateIndex
CREATE INDEX "document_files_slot_id_is_current_idx" ON "document_files"("slot_id", "is_current");

-- CreateIndex
CREATE INDEX "document_files_sha256_idx" ON "document_files"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "document_files_file_group_id_version_key" ON "document_files"("file_group_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "snag_types_code_key" ON "snag_types"("code");

-- CreateIndex
CREATE INDEX "snags_site_id_status_idx" ON "snags"("site_id", "status");

-- CreateIndex
CREATE INDEX "snags_region_id_status_idx" ON "snags"("region_id", "status");

-- CreateIndex
CREATE INDEX "snags_task_id_status_idx" ON "snags"("task_id", "status");

-- CreateIndex
CREATE INDEX "snag_photos_snag_id_idx" ON "snag_photos"("snag_id");

-- CreateIndex
CREATE INDEX "snag_photos_geofence_result_idx" ON "snag_photos"("geofence_result");

-- CreateIndex
CREATE UNIQUE INDEX "template_definitions_template_id_key" ON "template_definitions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_def_id_version_key" ON "template_versions"("template_def_id", "version");

-- CreateIndex
CREATE INDEX "import_batches_status_created_at_idx" ON "import_batches"("status", "created_at");

-- CreateIndex
CREATE INDEX "import_batches_uploaded_by_idx" ON "import_batches"("uploaded_by");

-- CreateIndex
CREATE INDEX "import_batch_rows_batch_id_decision_idx" ON "import_batch_rows"("batch_id", "decision");

-- CreateIndex
CREATE INDEX "import_batch_rows_site_code_idx" ON "import_batch_rows"("site_code");

-- CreateIndex
CREATE UNIQUE INDEX "import_batch_rows_batch_id_row_no_key" ON "import_batch_rows"("batch_id", "row_no");

-- CreateIndex
CREATE INDEX "comments_task_id_created_at_idx" ON "comments"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_entity_type_entity_id_idx" ON "comments"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_channel_sent_at_idx" ON "notifications"("channel", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_versions_version_key" ON "baseline_versions"("version");

-- CreateIndex
CREATE INDEX "baseline_entries_site_id_idx" ON "baseline_entries"("site_id");

-- CreateIndex
CREATE INDEX "baseline_entries_region_id_idx" ON "baseline_entries"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_entries_version_id_site_id_milestone_code_key" ON "baseline_entries"("version_id", "site_id", "milestone_code");

-- CreateIndex
CREATE UNIQUE INDEX "phase_gate_rules_link_code_key" ON "phase_gate_rules"("link_code");

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_change_code_key" ON "change_requests"("change_code");

-- CreateIndex
CREATE INDEX "change_requests_site_id_kind_idx" ON "change_requests"("site_id", "kind");

-- CreateIndex
CREATE INDEX "change_requests_region_id_status_idx" ON "change_requests"("region_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rf_design_records_site_id_key" ON "rf_design_records"("site_id");

-- CreateIndex
CREATE INDEX "rf_design_records_region_id_idx" ON "rf_design_records"("region_id");

-- CreateIndex
CREATE INDEX "acquisition_candidates_region_id_idx" ON "acquisition_candidates"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_candidates_site_id_candidate_no_key" ON "acquisition_candidates"("site_id", "candidate_no");

-- CreateIndex
CREATE INDEX "procurement_records_site_id_idx" ON "procurement_records"("site_id");

-- CreateIndex
CREATE INDEX "procurement_records_region_id_order_status_idx" ON "procurement_records"("region_id", "order_status");

-- CreateIndex
CREATE UNIQUE INDEX "gecol_records_site_id_key" ON "gecol_records"("site_id");

-- CreateIndex
CREATE INDEX "gecol_records_region_id_status_idx" ON "gecol_records"("region_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hlc_records_site_id_key" ON "hlc_records"("site_id");

-- CreateIndex
CREATE INDEX "hlc_records_region_id_status_idx" ON "hlc_records"("region_id", "status");

-- CreateIndex
CREATE INDEX "permit_records_site_id_idx" ON "permit_records"("site_id");

-- CreateIndex
CREATE INDEX "permit_records_region_id_status_idx" ON "permit_records"("region_id", "status");

-- CreateIndex
CREATE INDEX "permit_records_valid_to_idx" ON "permit_records"("valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_items_item_code_key" ON "warehouse_items"("item_code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_serials_serial_no_key" ON "warehouse_serials"("serial_no");

-- CreateIndex
CREATE INDEX "warehouse_serials_site_id_idx" ON "warehouse_serials"("site_id");

-- CreateIndex
CREATE INDEX "warehouse_serials_region_id_status_idx" ON "warehouse_serials"("region_id", "status");

-- CreateIndex
CREATE INDEX "warehouse_site_qty_region_id_idx" ON "warehouse_site_qty"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_site_qty_site_id_item_id_key" ON "warehouse_site_qty"("site_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_inspections_record_code_key" ON "quality_inspections"("record_code");

-- CreateIndex
CREATE INDEX "quality_inspections_site_id_idx" ON "quality_inspections"("site_id");

-- CreateIndex
CREATE INDEX "quality_inspections_region_id_status_idx" ON "quality_inspections"("region_id", "status");

-- CreateIndex
CREATE INDEX "issues_site_id_status_idx" ON "issues"("site_id", "status");

-- CreateIndex
CREATE INDEX "issues_region_id_status_idx" ON "issues"("region_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "risks_risk_code_key" ON "risks"("risk_code");

-- CreateIndex
CREATE INDEX "risks_status_idx" ON "risks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "readiness_handover_site_id_key" ON "readiness_handover"("site_id");

-- CreateIndex
CREATE INDEX "readiness_handover_region_id_idx" ON "readiness_handover"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "as_built_records_site_id_key" ON "as_built_records"("site_id");

-- CreateIndex
CREATE INDEX "as_built_records_region_id_idx" ON "as_built_records"("region_id");

-- CreateIndex
CREATE INDEX "meetings_meeting_date_idx" ON "meetings"("meeting_date");

-- CreateIndex
CREATE INDEX "meeting_actions_meeting_id_idx" ON "meeting_actions"("meeting_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "audit_log"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_site_id_at_idx" ON "audit_log"("site_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE INDEX "system_log_at_idx" ON "system_log"("at");

-- CreateIndex
CREATE INDEX "system_log_level_at_idx" ON "system_log"("level", "at");

-- CreateIndex
CREATE INDEX "system_log_source_at_idx" ON "system_log"("source", "at");

-- AddForeignKey
ALTER TABLE "sub_roles" ADD CONSTRAINT "sub_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sub_roles" ADD CONSTRAINT "user_sub_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sub_roles" ADD CONSTRAINT "user_sub_roles_sub_role_id_fkey" FOREIGN KEY ("sub_role_id") REFERENCES "sub_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_regions" ADD CONSTRAINT "user_regions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_regions" ADD CONSTRAINT "user_regions_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_modules" ADD CONSTRAINT "user_modules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_definitions" ADD CONSTRAINT "task_definitions_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_task_def_id_fkey" FOREIGN KEY ("task_def_id") REFERENCES "task_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_external_party_id_fkey" FOREIGN KEY ("external_party_id") REFERENCES "external_parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matrix_cells" ADD CONSTRAINT "matrix_cells_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matrix_cells" ADD CONSTRAINT "matrix_cells_task_def_id_fkey" FOREIGN KEY ("task_def_id") REFERENCES "task_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matrix_cell_assignees" ADD CONSTRAINT "matrix_cell_assignees_cell_id_fkey" FOREIGN KEY ("cell_id") REFERENCES "matrix_cells"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_teams" ADD CONSTRAINT "external_teams_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "external_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_placements" ADD CONSTRAINT "document_type_placements_doc_type_id_fkey" FOREIGN KEY ("doc_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_placements" ADD CONSTRAINT "document_type_placements_task_def_id_fkey" FOREIGN KEY ("task_def_id") REFERENCES "task_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_placements" ADD CONSTRAINT "document_type_placements_snag_type_id_fkey" FOREIGN KEY ("snag_type_id") REFERENCES "snag_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_slots" ADD CONSTRAINT "document_slots_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_slots" ADD CONSTRAINT "document_slots_doc_type_id_fkey" FOREIGN KEY ("doc_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "document_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snags" ADD CONSTRAINT "snags_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snags" ADD CONSTRAINT "snags_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snags" ADD CONSTRAINT "snags_snag_type_id_fkey" FOREIGN KEY ("snag_type_id") REFERENCES "snag_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snag_photos" ADD CONSTRAINT "snag_photos_snag_id_fkey" FOREIGN KEY ("snag_id") REFERENCES "snags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_def_id_fkey" FOREIGN KEY ("template_def_id") REFERENCES "template_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_entries" ADD CONSTRAINT "baseline_entries_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "baseline_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_serials" ADD CONSTRAINT "warehouse_serials_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_actions" ADD CONSTRAINT "meeting_actions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

