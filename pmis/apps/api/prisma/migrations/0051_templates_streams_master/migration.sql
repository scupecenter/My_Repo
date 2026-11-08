-- 0051_templates_streams_master: the Site Register stream templates (TPL-SITE-DA, TPL-SITE-CW, TPL-SITE-TE, TPL-SITE-CL, Q73) and the full Master template
-- (TPL-MASTER). CLAUDE.md "Approved templates only", "Two entry ways everywhere", "Site Register and streams", "Full project export to a Master file".
-- Mirror: db/sql/050_templates_streams_master.sql (kept identical).
--
-- What it builds
--   1. Data, not code. `master_columns` is the Master sheet (187 columns, from GSDN_Site_Master.xlsx) with the owner of each column; `template_task_fields`
--      says which task field (a date, a value, a register-owned field) a Master column or a stream column carries; `template_task_rules` excludes or
--      locks a task; `template_parts` names the sheets of TPL-MASTER. They are configuration, never code: a change (a migration today, an admin screen later,
--      open question Q207) issues the next template version.
--   2. Columns and versions. tpl_stream_columns(stream) and tpl_master_parts() build the columns from the active workflow (the stages of the stream,
--      their tasks, Master order where a Master column exists). tpl_sync() now issues versions for stream and master templates too, and the same
--      statement triggers fire when a task, a stage or one of the new tables changes. A file of an older version is refused on upload.
--   3. Staging. imp_stage_batch dispatches a stream template to imp_stage_stream_batch: each row is a site, each touched task becomes one batch row. The
--      database matches the task of the site, and validates the cells with the manual rules by running wf_save_entry on the real task inside a savepoint
--      that is rolled back (holder of L1, region and edit grant, state, date rules), then adds the checks of the submit (actual date, mandatory documents),
--      the lock refusal (a closed gate, Q81) or the hold (predecessors or a submission still open), and the SLA warnings (negative or late).
--      imp_stage_master splits a TPL-MASTER file into one batch per part (a stream batch per stream, a register batch per register sheet), grouped by group_id.
--   4. The flow. imp_submit_batch and imp_decide_batch dispatch by batch: the register functions of 0037/0041 are kept as imp_submit_register_batch and
--      imp_decide_register_batch (not callable by pmis_app); the task functions start the task when it is pending, save the entry and submit it as the
--      uploader through wf_start, wf_save_entry and wf_submit, and L2 decides each row with wf_review, wf_approve or wf_reject: the same grants, holders,
--      step-up, gates and successors as a person on the task. wf_step stamps the import row, so the task history and the audit show "via batch".
--   5. Register-owned fields are never written through a template: they are shown grey and locked, and never read.
--   6. pmis_app only reads the new tables. Every write goes through the functions above (owner pmis_definer, search_path set).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Data tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE master_columns (
  ord         INTEGER PRIMARY KEY,
  letter      TEXT    NOT NULL UNIQUE,
  group_top   TEXT,
  group_mid   TEXT,
  name        TEXT,
  header      TEXT    NOT NULL UNIQUE,
  owner       TEXT    NOT NULL CHECK (owner IN ('row', 'key', 'identity', 'baseline', 'scope', 'calc', 'task', 'dismantle', 'issues')),
  is_active   BOOLEAN NOT NULL DEFAULT true
);
COMMENT ON TABLE master_columns IS 'The columns of the Master sheet in Master order (GSDN_Site_Master.xlsx, sheet Master, 187 columns). owner = who writes the column: key (Site ID), identity (RF & Design), baseline, scope (site scope flags), calc (formula), task (a task field when template_task_fields maps it), dismantle (Dismantle register), issues (Issue Log).';

CREATE TABLE template_task_fields (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_code   TEXT    NOT NULL,
  field_key   TEXT    NOT NULL CHECK (field_key ~ '^(planned_date|planned_start|actual_start|actual_date|submitted_date|approved_date|external_party|v:[a-z0-9_]{1,60}|r:[a-z_]{2,40}\.[a-z0-9_]{1,60})$'),
  label       TEXT    NOT NULL,
  label_ar    TEXT,
  field_type  TEXT    NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'number', 'date', 'list', 'yes_no')),
  options     JSONB,
  master_col  TEXT REFERENCES master_columns (letter) ON UPDATE CASCADE,
  read_only   BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (task_code, field_key)
);
CREATE UNIQUE INDEX template_task_fields_master_col_idx ON template_task_fields (master_col) WHERE master_col IS NOT NULL AND is_active;
COMMENT ON TABLE template_task_fields IS 'The task fields a stream template (and the Master sheet) carries beyond the generic planned and actual date: planned_date, planned_start, actual_start, actual_date are columns of the task; submitted_date, approved_date and external_party are set by the workflow (read only); v:<key> is a key of the task values (written with wf_save_entry); r:<register>.<field> is a register-owned field (shown, never written, Q73, owner decision 2026-10-31). master_col is the Master column the field replaces.';

CREATE TABLE template_task_rules (
  task_code TEXT PRIMARY KEY,
  mode      TEXT NOT NULL CHECK (mode IN ('exclude', 'readonly')),
  reason    TEXT
);
COMMENT ON TABLE template_task_rules IS 'exclude: the task is not on any stream template (Dismantle owns E1 to E3). readonly: the task is shown, never written (its dates are calculated). Milestones are always read only, and so is a task whose date comes from a register (register_task_sources).';

CREATE TABLE template_parts (
  template_id  TEXT NOT NULL REFERENCES template_definitions (template_id) ON UPDATE CASCADE ON DELETE CASCADE,
  register_key TEXT NOT NULL REFERENCES register_definitions (register_key) ON UPDATE CASCADE ON DELETE CASCADE,
  sheet_name   TEXT NOT NULL CHECK (char_length(sheet_name) BETWEEN 1 AND 31 AND sheet_name !~ '[\[\]:*?/\\]' AND lower(sheet_name) NOT IN ('_tpl', '_lists', 'instructions', 'columns', 'master')),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, register_key),
  UNIQUE (template_id, sheet_name)
);
COMMENT ON TABLE template_parts IS 'The names of the register sheets of TPL-MASTER (the Master sheet is always the first one). A register without a row here gets its name as the sheet name.';

INSERT INTO master_columns (ord, letter, group_top, group_mid, name, header, owner) VALUES
  (1, 'A', '#', NULL, NULL, '#', 'row'),
  (2, 'B', 'RF & DESIGN', 'Identification', 'Site ID', 'Site ID', 'key'),
  (3, 'C', 'RF & DESIGN', 'Identification', 'Site Owner ID', 'Identification / Site Owner ID', 'identity'),
  (4, 'D', 'RF & DESIGN', 'Identification', 'Site Name', 'Identification / Site Name', 'identity'),
  (5, 'E', 'RF & DESIGN', 'Identification', 'Region', 'Identification / Region', 'identity'),
  (6, 'F', 'RF & DESIGN', 'Identification', 'Sub Region', 'Identification / Sub Region', 'identity'),
  (7, 'G', 'RF & DESIGN', 'Identification', 'Cluster ID', 'Identification / Cluster ID', 'identity'),
  (8, 'H', 'RF & DESIGN', 'Coordinates', 'Latitude', 'Coordinates / Latitude', 'identity'),
  (9, 'I', 'RF & DESIGN', 'Coordinates', 'Longitude', 'Coordinates / Longitude', 'identity'),
  (10, 'J', 'RF & DESIGN', 'Classification', 'Site Type', 'Classification / Site Type', 'identity'),
  (11, 'K', 'RF & DESIGN', 'Classification', 'Site Scenario', 'Classification / Site Scenario', 'identity'),
  (12, 'L', 'RF & DESIGN', 'Classification', 'Site Uplink', 'Classification / Site Uplink', 'identity'),
  (13, 'M', 'RF & DESIGN', 'Tower Information', 'Tower Owner', 'Tower Information / Tower Owner', 'identity'),
  (14, 'N', 'RF & DESIGN', 'Tower Information', 'Existing or New', 'Tower Information / Existing or New', 'identity'),
  (15, 'O', 'RF & DESIGN', 'Tower Information', 'RT or GF', 'Tower Information / RT or GF', 'identity'),
  (16, 'P', 'RF & DESIGN', 'Tower Information', 'Tower Type', 'Tower Information / Tower Type', 'identity'),
  (17, 'Q', 'RF & DESIGN', 'Tower Information', 'Tower Height (m)', 'Tower Information / Tower Height (m)', 'identity'),
  (18, 'R', 'RF & DESIGN', 'Configuration (WL/MW/IP/PWR)', NULL, 'Configuration (WL/MW/IP/PWR)', 'identity'),
  (19, 'S', 'RF & DESIGN', 'RF Survey Date', NULL, 'RF Survey Date', 'identity'),
  (20, 'T', 'RF & DESIGN', 'Acquisition Date', NULL, 'Acquisition Date', 'identity'),
  (21, 'U', 'RF & DESIGN', 'Baseline', 'Site Release Date', 'Baseline / Site Release Date', 'baseline'),
  (22, 'V', 'RF & DESIGN', 'Milestone', 'Site Release Date', 'Milestone / Site Release Date', 'calc'),
  (23, 'W', 'Phase Gate', 'Pre-CW Readiness', NULL, 'Pre-CW Readiness', 'calc'),
  (24, 'X', 'PRE-CW', 'Project Phase', NULL, 'Project Phase', 'scope'),
  (25, 'Y', 'PRE-CW', 'Delivery Batch', NULL, 'Delivery Batch', 'scope'),
  (26, 'Z', 'PRE-CW', 'Delivery Scenario', NULL, 'Delivery Scenario', 'scope'),
  (27, 'AA', 'PRE-CW', 'CW SOW', 'Tower Erection', 'CW SOW / Tower Erection', 'scope'),
  (28, 'AB', 'PRE-CW', 'CW SOW', 'Site Adaption', 'CW SOW / Site Adaption', 'scope'),
  (29, 'AC', 'PRE-CW', 'CW SOW', 'GECOL Power', 'CW SOW / GECOL Power', 'scope'),
  (30, 'AD', 'PRE-CW', 'CW SOW', 'HLC Fiber', 'CW SOW / HLC Fiber', 'scope'),
  (31, 'AE', 'PRE-CW', 'TE SOW', 'Full Scope', 'TE SOW / Full Scope', 'scope'),
  (32, 'AF', 'PRE-CW', 'TE SOW', 'IP Router Only', 'TE SOW / IP Router Only', 'scope'),
  (33, 'AG', 'PRE-CW', 'CW PROCUREMENT', 'CW Delivery Model', 'CW PROCUREMENT / CW Delivery Model', 'scope'),
  (34, 'AH', 'PRE-CW', 'CW PROCUREMENT', 'PR Status', 'CW PROCUREMENT / PR Status', 'calc'),
  (35, 'AI', 'PRE-CW', 'CW PROCUREMENT', 'PO / WO Status', 'CW PROCUREMENT / PO / WO Status', 'calc'),
  (36, 'AJ', 'PRE-CW', 'CW PROCUREMENT', 'Contractor Name', 'CW PROCUREMENT / Contractor Name', 'calc'),
  (37, 'AK', 'PRE-CW', 'CW PROCUREMENT', 'Contractor Team', 'CW PROCUREMENT / Contractor Team', 'calc'),
  (38, 'AL', 'PRE-CW', 'CW Access', 'CW Access Date', 'CW Access / CW Access Date', 'calc'),
  (39, 'AM', 'PRE-CW', 'CW Survey & Analysis Report', 'AAT SE Name', 'CW Survey & Analysis Report / AAT SE Name', 'task'),
  (40, 'AN', 'PRE-CW', 'CW Survey & Analysis Report', 'Planned Date', 'CW Survey & Analysis Report / Planned Date', 'task'),
  (41, 'AO', 'PRE-CW', 'CW Survey & Analysis Report', 'Actual Date', 'CW Survey & Analysis Report / Actual Date', 'task'),
  (42, 'AP', 'PRE-CW', 'CW Survey & Analysis Report', 'Analysis Type', 'CW Survey & Analysis Report / Analysis Type', 'task'),
  (43, 'AQ', 'PRE-CW', 'CW Survey & Analysis Report', 'Analysis Result', 'CW Survey & Analysis Report / Analysis Result', 'task'),
  (44, 'AR', 'PRE-CW', 'CW Survey & Analysis Report', 'Submitted Date', 'CW Survey & Analysis Report / Submitted Date', 'task'),
  (45, 'AS', 'PRE-CW', 'CW Survey & Analysis Report', 'Approved Date', 'CW Survey & Analysis Report / Approved Date', 'task'),
  (46, 'AT', 'PRE-CW', 'CW DN', 'Submitted Date', 'CW DN / Submitted Date', 'task'),
  (47, 'AU', 'PRE-CW', 'CW DN', 'Approved Date', 'CW DN / Approved Date', 'task'),
  (48, 'AV', 'PRE-CW', 'Baseline', 'PRE-CW Completion Date', 'Baseline / PRE-CW Completion Date', 'calc'),
  (49, 'AW', 'PRE-CW', 'Milestone', 'PRE-CW Completion Date', 'Milestone / PRE-CW Completion Date', 'calc'),
  (50, 'AX', 'Phase Gate', 'CW Readiness', NULL, 'CW Readiness', 'calc'),
  (51, 'AY', 'ACTUAL CW', 'CW MOS', 'Planned Date', 'CW MOS / Planned Date', 'task'),
  (52, 'AZ', 'ACTUAL CW', 'CW MOS', 'Actual Date', 'CW MOS / Actual Date', 'task'),
  (53, 'BA', 'ACTUAL CW', 'TOWER ERECTION', 'Tower Foundation', 'TOWER ERECTION / Tower Foundation', 'task'),
  (54, 'BB', 'ACTUAL CW', 'TOWER ERECTION', 'Tower Steel Erection', 'TOWER ERECTION / Tower Steel Erection', 'task'),
  (55, 'BC', 'ACTUAL CW', 'TOWER ERECTION', 'Tower Lightning & Grounding', 'TOWER ERECTION / Tower Lightning & Grounding', 'task'),
  (56, 'BD', 'ACTUAL CW', 'SITE ADAPTION', 'Cabinet Foundation', 'SITE ADAPTION / Cabinet Foundation', 'task'),
  (57, 'BE', 'ACTUAL CW', 'SITE ADAPTION', 'Mounting Pole', 'SITE ADAPTION / Mounting Pole', 'task'),
  (58, 'BF', 'ACTUAL CW', 'SITE ADAPTION', 'Cable Tray', 'SITE ADAPTION / Cable Tray', 'task'),
  (59, 'BG', 'ACTUAL CW', 'SITE ADAPTION', 'Indoor Rack', 'SITE ADAPTION / Indoor Rack', 'task'),
  (60, 'BH', 'ACTUAL CW', 'SITE ADAPTION', 'Site Optical Fiber', 'SITE ADAPTION / Site Optical Fiber', 'task'),
  (61, 'BI', 'ACTUAL CW', 'SITE ADAPTION', 'AC / DC Box', 'SITE ADAPTION / AC / DC Box', 'task'),
  (62, 'BJ', 'ACTUAL CW', 'SITE ADAPTION', 'Site GND', 'SITE ADAPTION / Site GND', 'task'),
  (63, 'BK', 'ACTUAL CW', 'CW Installation Status', 'Planned Start Date', 'CW Installation Status / Planned Start Date', 'task'),
  (64, 'BL', 'ACTUAL CW', 'CW Installation Status', 'Actual Start Date', 'CW Installation Status / Actual Start Date', 'task'),
  (65, 'BM', 'ACTUAL CW', 'CW Installation Status', 'Planned End Date', 'CW Installation Status / Planned End Date', 'task'),
  (66, 'BN', 'ACTUAL CW', 'CW Installation Status', 'Actual End Date', 'CW Installation Status / Actual End Date', 'task'),
  (67, 'BO', 'ACTUAL CW', 'Baseline', 'CW Completion Date', 'Baseline / CW Completion Date', 'calc'),
  (68, 'BP', 'ACTUAL CW', 'Milestone', 'CW Completion Date', 'Milestone / CW Completion Date', 'calc'),
  (69, 'BQ', 'Phase Gate', 'RFI Readiness', NULL, 'RFI Readiness', 'calc'),
  (70, 'BR', 'RFI', 'CW Preliminary Acceptance', 'CW PAC Planned Date', 'CW Preliminary Acceptance / CW PAC Planned Date', 'task'),
  (71, 'BS', 'RFI', 'CW Preliminary Acceptance', 'Snags Found', 'CW Preliminary Acceptance / Snags Found', 'task'),
  (72, 'BT', 'RFI', 'CW Preliminary Acceptance', 'Snags Cleared', 'CW Preliminary Acceptance / Snags Cleared', 'task'),
  (73, 'BU', 'RFI', 'CW Preliminary Acceptance', 'CW As-Built Submitted', 'CW Preliminary Acceptance / CW As-Built Submitted', 'task'),
  (74, 'BV', 'RFI', 'CW Preliminary Acceptance', 'CW PAC Actual Date', 'CW Preliminary Acceptance / CW PAC Actual Date', 'task'),
  (75, 'BW', 'RFI', 'GECOL Status', NULL, 'GECOL Status', 'calc'),
  (76, 'BX', 'RFI', 'HLC Fiber Status', NULL, 'HLC Fiber Status', 'calc'),
  (77, 'BY', 'RFI', 'Baseline', 'Site RFI Date', 'Baseline / Site RFI Date', 'calc'),
  (78, 'BZ', 'RFI', 'Milestone', 'Site RFI Date', 'Milestone / Site RFI Date', 'calc'),
  (79, 'CA', 'Phase Gate', 'TE Installation Readiness', NULL, 'TE Installation Readiness', 'calc'),
  (80, 'CB', 'TE INSTALLATION', 'TE Access', 'TE Access Date', 'TE Access / TE Access Date', 'calc'),
  (81, 'CC', 'TE INSTALLATION', 'TE Survey', 'Survey Date', 'TE Survey / Survey Date', 'task'),
  (82, 'CD', 'TE INSTALLATION', 'TE Survey', 'Vendor Name', 'TE Survey / Vendor Name', 'task'),
  (83, 'CE', 'TE INSTALLATION', 'TE Survey', 'Vendor Team', 'TE Survey / Vendor Team', 'calc'),
  (84, 'CF', 'TE INSTALLATION', 'TE Survey', 'AAT SE Name', 'TE Survey / AAT SE Name', 'task'),
  (85, 'CG', 'TE INSTALLATION', 'TE DN', 'Submitted Date', 'TE DN / Submitted Date', 'task'),
  (86, 'CH', 'TE INSTALLATION', 'TE DN', 'Approved Date', 'TE DN / Approved Date', 'task'),
  (87, 'CI', 'TE INSTALLATION', 'TE MOS', 'Planned Date', 'TE MOS / Planned Date', 'task'),
  (88, 'CJ', 'TE INSTALLATION', 'TE MOS', 'Actual Date', 'TE MOS / Actual Date', 'task'),
  (89, 'CK', 'TE INSTALLATION', 'TE Installation Items', 'MTS Cabinet', 'TE Installation Items / MTS Cabinet', 'task'),
  (90, 'CL', 'TE INSTALLATION', 'TE Installation Items', 'Indoor IP Router', 'TE Installation Items / Indoor IP Router', 'task'),
  (91, 'CM', 'TE INSTALLATION', 'TE Installation Items', 'RF Antenna', 'TE Installation Items / RF Antenna', 'task'),
  (92, 'CN', 'TE INSTALLATION', 'TE Installation Items', 'MW Antenna', 'TE Installation Items / MW Antenna', 'task'),
  (93, 'CO', 'TE INSTALLATION', 'TE Installation Items', 'DC / OF Cable', 'TE Installation Items / DC / OF Cable', 'task'),
  (94, 'CP', 'TE INSTALLATION', 'TE Installation Status', 'Planned Start Date', 'TE Installation Status / Planned Start Date', 'task'),
  (95, 'CQ', 'TE INSTALLATION', 'TE Installation Status', 'Actual Start Date', 'TE Installation Status / Actual Start Date', 'task'),
  (96, 'CR', 'TE INSTALLATION', 'TE Installation Status', 'Planned End Date', 'TE Installation Status / Planned End Date', 'task'),
  (97, 'CS', 'TE INSTALLATION', 'TE Installation Status', 'Actual End Date', 'TE Installation Status / Actual End Date', 'task'),
  (98, 'CT', 'TE INSTALLATION', 'Baseline', 'TE Completion Date', 'Baseline / TE Completion Date', 'calc'),
  (99, 'CU', 'TE INSTALLATION', 'Milestone', 'TE Completion Date', 'Milestone / TE Completion Date', 'calc'),
  (100, 'CV', 'Phase Gate', 'On-Air Readiness', NULL, 'On-Air Readiness', 'calc'),
  (101, 'CW', 'ON-AIR', 'Commissioning & Integration', 'Commissioning Date', 'Commissioning & Integration / Commissioning Date', 'task'),
  (102, 'CX', 'ON-AIR', 'Commissioning & Integration', 'MW Alignment Date', 'Commissioning & Integration / MW Alignment Date', 'task'),
  (103, 'CY', 'ON-AIR', 'Commissioning & Integration', 'MW Measured RSL (dBm)', 'Commissioning & Integration / MW Measured RSL (dBm)', 'task'),
  (104, 'CZ', 'ON-AIR', 'Commissioning & Integration', 'RSL Deviation (dB)', 'Commissioning & Integration / RSL Deviation (dB)', 'calc'),
  (105, 'DA', 'ON-AIR', 'Commissioning & Integration', 'Integration Date', 'Commissioning & Integration / Integration Date', 'task'),
  (106, 'DB', 'ON-AIR', 'Cutover', 'MOP Submitted Date', 'Cutover / MOP Submitted Date', 'task'),
  (107, 'DC', 'ON-AIR', 'Cutover', 'MOP Approved Date', 'Cutover / MOP Approved Date', 'task'),
  (108, 'DD', 'ON-AIR', 'Cutover', 'Window Start', 'Cutover / Window Start', 'task'),
  (109, 'DE', 'ON-AIR', 'Cutover', 'Window End', 'Cutover / Window End', 'task'),
  (110, 'DF', 'ON-AIR', 'Cutover', 'Cutover Result', 'Cutover / Cutover Result', 'task'),
  (111, 'DG', 'ON-AIR', 'Cutover', 'Outage Duration (wd)', 'Cutover / Outage Duration (wd)', 'calc'),
  (112, 'DH', 'ON-AIR', 'Cutover', 'Legacy Dismantle Due', 'Cutover / Legacy Dismantle Due', 'calc'),
  (113, 'DI', 'ON-AIR', 'Cutover', 'Rollback Count', 'Cutover / Rollback Count', 'calc'),
  (114, 'DJ', 'ON-AIR', 'Cutover', 'Pre-Swap KPI Baseline Date', 'Cutover / Pre-Swap KPI Baseline Date', 'task'),
  (115, 'DK', 'ON-AIR', 'Cutover', 'Post-Swap KPI Check Date', 'Cutover / Post-Swap KPI Check Date', 'task'),
  (116, 'DL', 'ON-AIR', 'Cutover', 'Post-Swap KPI Result', 'Cutover / Post-Swap KPI Result', 'task'),
  (117, 'DM', 'ON-AIR', 'On-Air', 'On-Air Planned Date', 'On-Air / On-Air Planned Date', 'task'),
  (118, 'DN', 'ON-AIR', 'On-Air', 'On-Air Actual Date', 'On-Air / On-Air Actual Date', 'task'),
  (119, 'DO', 'ON-AIR', 'Baseline', 'On-Air Date', 'Baseline / On-Air Date', 'calc'),
  (120, 'DP', 'ON-AIR', 'Milestone', 'On-Air Date', 'Milestone / On-Air Date', 'calc'),
  (121, 'DQ', 'Phase Gate', 'TE PAC Readiness', NULL, 'TE PAC Readiness', 'calc'),
  (122, 'DR', 'TE PAC', 'SSV', 'SSV Date', 'SSV / SSV Date', 'task'),
  (123, 'DS', 'TE PAC', 'SSV', 'SSV Result', 'SSV / SSV Result', 'task'),
  (124, 'DT', 'TE PAC', 'HWID Date', NULL, 'HWID Date', 'task'),
  (125, 'DU', 'TE PAC', 'Site Standalone (EIR)', 'PWR', 'Site Standalone (EIR) / PWR', 'task'),
  (126, 'DV', 'TE PAC', 'Site Standalone (EIR)', 'WL', 'Site Standalone (EIR) / WL', 'task'),
  (127, 'DW', 'TE PAC', 'Site Standalone (EIR)', 'MW', 'Site Standalone (EIR) / MW', 'task'),
  (128, 'DX', 'TE PAC', 'Site Standalone (EIR)', 'IP', 'Site Standalone (EIR) / IP', 'task'),
  (129, 'DY', 'TE PAC', 'Site Standalone (EIR)', 'EIR Date', 'Site Standalone (EIR) / EIR Date', 'task'),
  (130, 'DZ', 'TE PAC', 'Network Test (PAT)', 'PWR', 'Network Test (PAT) / PWR', 'task'),
  (131, 'EA', 'TE PAC', 'Network Test (PAT)', 'WL', 'Network Test (PAT) / WL', 'task'),
  (132, 'EB', 'TE PAC', 'Network Test (PAT)', 'MW', 'Network Test (PAT) / MW', 'task'),
  (133, 'EC', 'TE PAC', 'Network Test (PAT)', 'IP', 'Network Test (PAT) / IP', 'task'),
  (134, 'ED', 'TE PAC', 'Network Test (PAT)', 'NOC Alarm Verification', 'Network Test (PAT) / NOC Alarm Verification', 'task'),
  (135, 'EE', 'TE PAC', 'Network Test (PAT)', 'PAT Date', 'Network Test (PAT) / PAT Date', 'task'),
  (136, 'EF', 'TE PAC', 'As-Built Date', NULL, 'As-Built Date', 'task'),
  (137, 'EG', 'TE PAC', 'TE Snags', 'Snags Found', 'TE Snags / Snags Found', 'task'),
  (138, 'EH', 'TE PAC', 'TE Snags', 'Snags Cleared', 'TE Snags / Snags Cleared', 'task'),
  (139, 'EI', 'TE PAC', 'TE PAC', 'TE PAC Planned Date', 'TE PAC / TE PAC Planned Date', 'task'),
  (140, 'EJ', 'TE PAC', 'TE PAC', 'TE PAC Actual Date', 'TE PAC / TE PAC Actual Date', 'task'),
  (141, 'EK', 'TE PAC', 'Baseline', 'TE PAC Date', 'Baseline / TE PAC Date', 'calc'),
  (142, 'EL', 'TE PAC', 'Milestone', 'TE PAC Date', 'Milestone / TE PAC Date', 'calc'),
  (143, 'EM', 'Phase Gate', 'Cluster Optimization Readiness', NULL, 'Cluster Optimization Readiness', 'calc'),
  (144, 'EN', 'CLUSTER OPTIMIZATION', 'Cluster ID', NULL, 'Cluster ID', 'calc'),
  (145, 'EO', 'CLUSTER OPTIMIZATION', 'Cluster Optimization Date', NULL, 'Cluster Optimization Date', 'task'),
  (146, 'EP', 'CLUSTER OPTIMIZATION', 'KPI Acceptance Source Date', NULL, 'KPI Acceptance Source Date', 'task'),
  (147, 'EQ', 'CLUSTER OPTIMIZATION', 'KPI Source Validation', NULL, 'KPI Source Validation', 'calc'),
  (148, 'ER', 'CLUSTER OPTIMIZATION', 'Baseline', 'KPI Acceptance Date', 'Baseline / KPI Acceptance Date', 'calc'),
  (149, 'ES', 'CLUSTER OPTIMIZATION', 'Milestone', 'KPI Acceptance Date', 'Milestone / KPI Acceptance Date', 'calc'),
  (150, 'ET', 'Phase Gate', 'HOTO Readiness', NULL, 'HOTO Readiness', 'calc'),
  (151, 'EU', 'SOFT / COMMERCIAL LAUNCH & HOTO', 'Launch Date', NULL, 'Launch Date', 'task'),
  (152, 'EV', 'SOFT / COMMERCIAL LAUNCH & HOTO', 'Material Reconciliation Date', NULL, 'Material Reconciliation Date', 'task'),
  (153, 'EW', 'SOFT / COMMERCIAL LAUNCH & HOTO', 'HOTO Package Date', NULL, 'HOTO Package Date', 'calc'),
  (154, 'EX', 'SOFT / COMMERCIAL LAUNCH & HOTO', 'Baseline', 'HOTO Date', 'Baseline / HOTO Date', 'calc'),
  (155, 'EY', 'SOFT / COMMERCIAL LAUNCH & HOTO', 'Milestone', 'HOTO Date', 'Milestone / HOTO Date', 'calc'),
  (156, 'EZ', 'Phase Gate', 'Final Closure Readiness', NULL, 'Final Closure Readiness', 'calc'),
  (157, 'FA', 'FINAL CLOSURE', 'CW DLP / FAC', 'CW DLP Start Date', 'CW DLP / FAC / CW DLP Start Date', 'calc'),
  (158, 'FB', 'FINAL CLOSURE', 'CW DLP / FAC', 'CW DLP End Date', 'CW DLP / FAC / CW DLP End Date', 'calc'),
  (159, 'FC', 'FINAL CLOSURE', 'CW DLP / FAC', 'Snags Found', 'CW DLP / FAC / Snags Found', 'task'),
  (160, 'FD', 'FINAL CLOSURE', 'CW DLP / FAC', 'Snags Cleared', 'CW DLP / FAC / Snags Cleared', 'task'),
  (161, 'FE', 'FINAL CLOSURE', 'CW DLP / FAC', 'CW FAC Date', 'CW DLP / FAC / CW FAC Date', 'task'),
  (162, 'FF', 'FINAL CLOSURE', 'TE DLP / FAC', 'TE DLP Start Date', 'TE DLP / FAC / TE DLP Start Date', 'calc'),
  (163, 'FG', 'FINAL CLOSURE', 'TE DLP / FAC', 'TE DLP End Date', 'TE DLP / FAC / TE DLP End Date', 'calc'),
  (164, 'FH', 'FINAL CLOSURE', 'TE DLP / FAC', 'Snags Found', 'TE DLP / FAC / Snags Found', 'task'),
  (165, 'FI', 'FINAL CLOSURE', 'TE DLP / FAC', 'Snags Cleared', 'TE DLP / FAC / Snags Cleared', 'task'),
  (166, 'FJ', 'FINAL CLOSURE', 'TE DLP / FAC', 'TE FAC Date', 'TE DLP / FAC / TE FAC Date', 'task'),
  (167, 'FK', 'FINAL CLOSURE', 'Contractual Obligations Closure Date', NULL, 'Contractual Obligations Closure Date', 'calc'),
  (168, 'FL', 'FINAL CLOSURE', 'Baseline', 'Final Closure Date', 'Baseline / Final Closure Date', 'calc'),
  (169, 'FM', 'FINAL CLOSURE', 'Milestone', 'Final Closure Date', 'Milestone / Final Closure Date', 'calc'),
  (170, 'FN', 'DISMANTLE', 'CW Dismantle (RN)', 'Site CW RFD', 'CW Dismantle (RN) / Site CW RFD', 'dismantle'),
  (171, 'FO', 'DISMANTLE', 'CW Dismantle (RN)', 'Contractor / Vendor', 'CW Dismantle (RN) / Contractor / Vendor', 'dismantle'),
  (172, 'FP', 'DISMANTLE', 'CW Dismantle (RN)', 'Planned Date', 'CW Dismantle (RN) / Planned Date', 'dismantle'),
  (173, 'FQ', 'DISMANTLE', 'CW Dismantle (RN)', 'Actual Date', 'CW Dismantle (RN) / Actual Date', 'dismantle'),
  (174, 'FR', 'DISMANTLE', 'CW Dismantle (RN)', 'CW RN Date', 'CW Dismantle (RN) / CW RN Date', 'dismantle'),
  (175, 'FS', 'DISMANTLE', 'TE Dismantle (RN)', 'Site TE RFD', 'TE Dismantle (RN) / Site TE RFD', 'dismantle'),
  (176, 'FT', 'DISMANTLE', 'TE Dismantle (RN)', 'Contractor / Vendor', 'TE Dismantle (RN) / Contractor / Vendor', 'dismantle'),
  (177, 'FU', 'DISMANTLE', 'TE Dismantle (RN)', 'Planned Date', 'TE Dismantle (RN) / Planned Date', 'dismantle'),
  (178, 'FV', 'DISMANTLE', 'TE Dismantle (RN)', 'Actual Date', 'TE Dismantle (RN) / Actual Date', 'dismantle'),
  (179, 'FW', 'DISMANTLE', 'TE Dismantle (RN)', 'TE RN Date', 'TE Dismantle (RN) / TE RN Date', 'dismantle'),
  (180, 'FX', 'STATUS', 'Progress', 'Current Milestone', 'Progress / Current Milestone', 'calc'),
  (181, 'FY', 'STATUS', 'Progress', 'Next Milestone', 'Progress / Next Milestone', 'calc'),
  (182, 'FZ', 'STATUS', 'Progress', 'Overall Status', 'Progress / Overall Status', 'calc'),
  (183, 'GA', 'STATUS', 'Issue & Remark', 'Pending Issue', 'Issue & Remark / Pending Issue', 'issues'),
  (184, 'GB', 'STATUS', 'Issue & Remark', 'Issue Owner', 'Issue & Remark / Issue Owner', 'issues'),
  (185, 'GC', 'STATUS', 'Issue & Remark', 'Issue Raised Date', 'Issue & Remark / Issue Raised Date', 'issues'),
  (186, 'GD', 'STATUS', 'Issue & Remark', 'Issue Status', 'Issue & Remark / Issue Status', 'issues'),
  (187, 'GE', 'STATUS', 'Issue & Remark', 'Remark', 'Issue & Remark / Remark', 'issues');

INSERT INTO template_task_rules (task_code, mode, reason) VALUES
  ('E1', 'exclude',  'Dismantle (Track E) is its own register (TPL-DIS), outside the stream mapping (Q41)'),
  ('E2', 'exclude',  'Dismantle (Track E) is its own register (TPL-DIS), outside the stream mapping (Q41)'),
  ('E3', 'exclude',  'Dismantle (Track E) is its own register (TPL-DIS), outside the stream mapping (Q41)'),
  ('B14', 'readonly', 'the DLP period is calculated from the CW PAC date'),
  ('D4b', 'readonly', 'the dispatch is calculated from the warehouse movements');

-- Lists of the Master Setting sheet (CompletionStatus, YesNA, AnalysisType, AnalysisResult, CutoverResult, KPIResult, SSVResult).
-- A Master column that holds a value the workflow sets itself (submitted, approved, vendor) or that another register owns (As-Built) is read only.
INSERT INTO template_task_fields (task_code, field_key, label, field_type, options, master_col, read_only) VALUES
  ('MS1',  'actual_date', 'Site Release (milestone)', 'date', NULL, 'V', true),
  ('B4',   'v:aat_se_name', 'AAT SE Name', 'text', NULL, 'AM', false),
  ('B4',   'planned_date', 'CW Survey Planned', 'date', NULL, 'AN', false),
  ('B4',   'actual_date', 'CW Survey Actual', 'date', NULL, 'AO', false),
  ('B5',   'v:analysis_type', 'Analysis Type', 'list', '["STA", "ST", "N/A"]', 'AP', false),
  ('B5',   'v:analysis_result', 'Analysis Result', 'list', '["Pass", "Reinforce", "Fail", "N/A"]', 'AQ', false),
  ('B7',   'submitted_date', 'CW DN Submitted', 'date', NULL, 'AT', true),
  ('B7',   'approved_date', 'CW DN Approved', 'date', NULL, 'AU', true),
  ('MS2',  'actual_date', 'PRE-CW Completion (milestone)', 'date', NULL, 'AW', true),
  ('B8',   'planned_date', 'CW MOS Planned', 'date', NULL, 'AY', false),
  ('B8',   'actual_date', 'CW MOS Actual', 'date', NULL, 'AZ', false),
  ('B10',  'v:tower_foundation', 'Tower Foundation', 'list', '["Done", "Pending", "N/A"]', 'BA', false),
  ('B10',  'v:tower_steel_erection', 'Tower Steel Erection', 'list', '["Done", "Pending", "N/A"]', 'BB', false),
  ('B10',  'v:tower_lightning_grounding', 'Tower Lightning & Grounding', 'list', '["Done", "Pending", "N/A"]', 'BC', false),
  ('B11',  'v:cabinet_foundation', 'Cabinet Foundation', 'list', '["Done", "Pending", "N/A"]', 'BD', false),
  ('B11',  'v:mounting_pole', 'Mounting Pole', 'list', '["Done", "Pending", "N/A"]', 'BE', false),
  ('B11',  'v:cable_tray', 'Cable Tray', 'list', '["Done", "Pending", "N/A"]', 'BF', false),
  ('B11',  'v:indoor_rack', 'Indoor Rack', 'list', '["Done", "Pending", "N/A"]', 'BG', false),
  ('B11',  'v:site_optical_fiber', 'Site Optical Fiber', 'list', '["Done", "Pending", "N/A"]', 'BH', false),
  ('B11',  'v:ac_dc_box', 'AC / DC Box', 'list', '["Done", "Pending", "N/A"]', 'BI', false),
  ('B11',  'v:site_gnd', 'Site GND', 'list', '["Done", "Pending", "N/A"]', 'BJ', false),
  ('B11',  'planned_start', 'CW Planned Start', 'date', NULL, 'BK', true),
  ('B11',  'actual_start', 'CW Actual Start', 'date', NULL, 'BL', false),
  ('B11',  'planned_date', 'CW Planned End', 'date', NULL, 'BM', false),
  ('B11',  'actual_date', 'CW Actual End', 'date', NULL, 'BN', false),
  ('MS3',  'actual_date', 'CW Completion (milestone)', 'date', NULL, 'BP', true),
  ('B13',  'planned_date', 'CW PAC Planned', 'date', NULL, 'BR', false),
  ('B13',  'v:snags_found', 'CW Snags Found', 'list', '["Yes", "N/A"]', 'BS', false),
  ('B13',  'v:snags_cleared', 'CW Snags Cleared', 'list', '["Yes", "N/A"]', 'BT', false),
  ('B13',  'r:as_built.cw_as_built_submitted', 'CW As-Built Submitted (As-Built register)', 'text', NULL, 'BU', true),
  ('B13',  'actual_date', 'CW PAC Actual', 'date', NULL, 'BV', false),
  ('MS4',  'actual_date', 'Site RFI (milestone)', 'date', NULL, 'BZ', true),
  ('D2',   'actual_date', 'TE Survey Date', 'date', NULL, 'CC', false),
  ('D2',   'external_party', 'Vendor Name', 'text', NULL, 'CD', true),
  ('D2',   'v:aat_se_name', 'AAT SE Name', 'text', NULL, 'CF', false),
  ('D3',   'submitted_date', 'TE DN Submitted', 'date', NULL, 'CG', true),
  ('D4',   'approved_date', 'TE DN Approved', 'date', NULL, 'CH', true),
  ('D5',   'planned_date', 'TE MOS Planned', 'date', NULL, 'CI', false),
  ('D5',   'actual_date', 'TE MOS Actual', 'date', NULL, 'CJ', false),
  ('D6',   'v:mts_cabinet', 'MTS Cabinet', 'list', '["Done", "Pending", "N/A"]', 'CK', false),
  ('D6',   'v:indoor_ip_router', 'Indoor IP Router', 'list', '["Done", "Pending", "N/A"]', 'CL', false),
  ('D6',   'v:rf_antenna', 'RF Antenna', 'list', '["Done", "Pending", "N/A"]', 'CM', false),
  ('D6',   'v:mw_antenna', 'MW Antenna', 'list', '["Done", "Pending", "N/A"]', 'CN', false),
  ('D6',   'v:dc_of_cable', 'DC / OF Cable', 'list', '["Done", "Pending", "N/A"]', 'CO', false),
  ('D6',   'planned_start', 'TE Planned Start', 'date', NULL, 'CP', true),
  ('D6',   'actual_start', 'TE Actual Start', 'date', NULL, 'CQ', false),
  ('D6',   'planned_date', 'TE Planned End', 'date', NULL, 'CR', false),
  ('D6',   'actual_date', 'TE Actual End', 'date', NULL, 'CS', false),
  ('MS5',  'actual_date', 'TE Completion (milestone)', 'date', NULL, 'CU', true),
  ('D7',   'actual_date', 'Commissioning Date', 'date', NULL, 'CW', false),
  ('D8',   'actual_date', 'MW Alignment Date', 'date', NULL, 'CX', false),
  ('D8',   'v:measured_rsl', 'MW Measured RSL (dBm)', 'number', NULL, 'CY', false),
  ('D9',   'actual_date', 'Integration Date', 'date', NULL, 'DA', false),
  ('D10a', 'submitted_date', 'MOP Submitted', 'date', NULL, 'DB', true),
  ('D10a', 'approved_date', 'MOP Approved', 'date', NULL, 'DC', true),
  ('D10',  'v:window_start', 'Window Start', 'date', NULL, 'DD', false),
  ('D10',  'v:window_end', 'Window End', 'date', NULL, 'DE', false),
  ('D10',  'v:cutover_result', 'Cutover Result', 'list', '["Success", "Rollback"]', 'DF', false),
  ('D10',  'v:pre_swap_kpi_baseline', 'Pre-Swap KPI Baseline Date', 'date', NULL, 'DJ', false),
  ('D10',  'v:post_swap_kpi_check', 'Post-Swap KPI Check Date', 'date', NULL, 'DK', false),
  ('D10',  'v:post_swap_kpi_result', 'Post-Swap KPI Result', 'list', '["Pass", "Degraded", "N/A"]', 'DL', false),
  ('D10',  'planned_date', 'On-Air Planned', 'date', NULL, 'DM', false),
  ('D10',  'actual_date', 'On-Air Actual', 'date', NULL, 'DN', false),
  ('MS6',  'actual_date', 'On-Air (milestone)', 'date', NULL, 'DP', true),
  ('D11',  'actual_date', 'SSV Date', 'date', NULL, 'DR', false),
  ('D11',  'v:result', 'SSV Result', 'list', '["Pass", "Fail", "N/A"]', 'DS', false),
  ('D12',  'actual_date', 'HWID Date', 'date', NULL, 'DT', false),
  ('D13',  'v:pwr', 'EIR PWR', 'list', '["Done", "Pending", "N/A"]', 'DU', false),
  ('D13',  'v:wl', 'EIR WL', 'list', '["Done", "Pending", "N/A"]', 'DV', false),
  ('D13',  'v:mw', 'EIR MW', 'list', '["Done", "Pending", "N/A"]', 'DW', false),
  ('D13',  'v:ip', 'EIR IP', 'list', '["Done", "Pending", "N/A"]', 'DX', false),
  ('D13',  'actual_date', 'EIR Date', 'date', NULL, 'DY', false),
  ('D14',  'v:pwr', 'PAT PWR', 'list', '["Done", "Pending", "N/A"]', 'DZ', false),
  ('D14',  'v:wl', 'PAT WL', 'list', '["Done", "Pending", "N/A"]', 'EA', false),
  ('D14',  'v:mw', 'PAT MW', 'list', '["Done", "Pending", "N/A"]', 'EB', false),
  ('D14',  'v:ip', 'PAT IP', 'list', '["Done", "Pending", "N/A"]', 'EC', false),
  ('D14',  'v:noc_alarm_verification', 'NOC Alarm Verification', 'list', '["Done", "Pending", "N/A"]', 'ED', false),
  ('D14',  'actual_date', 'PAT Date', 'date', NULL, 'EE', false),
  ('D15',  'r:as_built.as_built_date', 'As-Built Date (As-Built register)', 'date', NULL, 'EF', true),
  ('D16',  'v:snags_found', 'TE Snags Found', 'list', '["Yes", "N/A"]', 'EG', false),
  ('D16',  'v:snags_cleared', 'TE Snags Cleared', 'list', '["Yes", "N/A"]', 'EH', false),
  ('D16',  'planned_date', 'TE PAC Planned', 'date', NULL, 'EI', false),
  ('D16',  'actual_date', 'TE PAC Actual', 'date', NULL, 'EJ', false),
  ('MS7',  'actual_date', 'TE PAC (milestone)', 'date', NULL, 'EL', true),
  ('F1',   'actual_date', 'Cluster Optimization Date', 'date', NULL, 'EO', false),
  ('F2',   'actual_date', 'KPI Acceptance Source Date', 'date', NULL, 'EP', false),
  ('MS8',  'actual_date', 'KPI Acceptance (milestone)', 'date', NULL, 'ES', true),
  ('D17',  'v:launch_date', 'Launch Date', 'date', NULL, 'EU', false),
  ('D17',  'v:material_reconciliation_date', 'Material Reconciliation Date', 'date', NULL, 'EV', false),
  ('MS9',  'actual_date', 'HOTO (milestone)', 'date', NULL, 'EY', true),
  ('B15',  'v:snags_found', 'CW FAC Snags Found', 'list', '["Yes", "N/A"]', 'FC', false),
  ('B15',  'v:snags_cleared', 'CW FAC Snags Cleared', 'list', '["Yes", "N/A"]', 'FD', false),
  ('B15',  'actual_date', 'CW FAC Date', 'date', NULL, 'FE', false),
  ('D18',  'v:snags_found', 'TE FAC Snags Found', 'list', '["Yes", "N/A"]', 'FH', false),
  ('D18',  'v:snags_cleared', 'TE FAC Snags Cleared', 'list', '["Yes", "N/A"]', 'FI', false),
  ('D18',  'actual_date', 'TE FAC Date', 'date', NULL, 'FJ', false),
  ('MS10', 'actual_date', 'Final Closure (milestone)', 'date', NULL, 'FM', true);

-- The templates. A stream template is one per stream (Q73); TPL-MASTER is the whole Master. Their versions are issued by tpl_sync_all() below.
INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, stream_code, module_key, match_keys, sort_order, is_master_format) VALUES
  ('TPL-MASTER',  'Master (all sheets)',                  'الماستر الكامل (كل الأوراق)',        'master',     'master', NULL,         'sites', '[["site_code"]]', 1, true),
  ('TPL-SITE-DA', 'Site Register: Design & Acquisition',  'سجل المواقع: التصميم والاستحواذ',     'task_dates', 'stream', 'DESIGN_ACQ', 'sites', '[["site_code"]]', 3, false),
  ('TPL-SITE-CW', 'Site Register: Civil Works',           'سجل المواقع: الأعمال المدنية',        'task_dates', 'stream', 'CW',         'sites', '[["site_code"]]', 4, false),
  ('TPL-SITE-TE', 'Site Register: Installation (TE)',     'سجل المواقع: التركيبات',              'task_dates', 'stream', 'TE',         'sites', '[["site_code"]]', 5, false),
  ('TPL-SITE-CL', 'Site Register: Handover & Closure',    'سجل المواقع: التسليم والإغلاق',       'task_dates', 'stream', 'CLOSURE',    'sites', '[["site_code"]]', 6, false);

-- The sheets of TPL-MASTER: the Master sheet, then the register sheets under the names of the Master where the Master has the sheet.
INSERT INTO template_parts (template_id, register_key, sheet_name, sort_order)
SELECT 'TPL-MASTER', v.rk, v.sheet, v.ord FROM (VALUES
  ('rf_design', 'RF & Design', 10), ('acquisition', 'Acquisition', 20), ('procurement', 'PR-PO', 30), ('contractors', 'Contractors', 35), ('gecol', 'GECOL', 40),
  ('hlc', 'HLC', 50), ('as_built', 'As-Built', 60), ('warehouse', 'WH', 70), ('risks', 'Risk Register', 80), ('permits_hse', 'Permits & HSE', 90),
  ('quality', 'Quality Inspections', 100), ('change_control', 'Change Control', 110), ('readiness_handover', 'Readiness & Handover', 120),
  ('issues', 'Issue Log', 130), ('meetings', 'Meetings', 140), ('dismantle', 'Dismantle', 150)
) AS v(rk, sheet, ord) JOIN register_definitions r ON r.register_key = v.rk;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Columns and versions
-- ---------------------------------------------------------------------------------------------------------------------
-- The hash now also covers the fixed list values of a task column (a list of the Master Setting sheet).
CREATE OR REPLACE FUNCTION tpl_field_hash(p_cols jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(coalesce((
    SELECT jsonb_agg(jsonb_build_array(c ->> 'code', c ->> 'header', c ->> 'type', c ->> 'kind', coalesce((c ->> 'required')::boolean, false), coalesce((c ->> 'derived')::boolean, false),
      CASE WHEN c ->> 'kind' IN ('field', 'task') AND c ->> 'type' = 'list' THEN c -> 'options' END) ORDER BY ord)
    FROM jsonb_array_elements(p_cols) WITH ORDINALITY AS t(c, ord)), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- The workflow the templates follow: the published version in force (sites of an older version keep their own tasks; the upload resolves the task
-- of a site by code inside the site's own workflow version).
CREATE OR REPLACE FUNCTION tpl_active_workflow() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT w.id FROM public.workflow_definitions w WHERE w.status = 'published' ORDER BY w.version DESC LIMIT 1
$$;

-- The tasks of one stream, in order, and how a template treats each: edit (dates and values are typed), register (its date comes from a register:
-- shown, never written), readonly (a milestone, or calculated), exclude (not on the template).
CREATE OR REPLACE FUNCTION tpl_stream_tasks(p_stream text) RETURNS TABLE (code text, name_en text, stage_seq int, sort_order int, mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT td.code, td.name_en, sd.seq, td.sort_order,
    CASE WHEN td.is_milestone_task OR r.mode = 'readonly' THEN 'readonly'
         WHEN EXISTS (SELECT 1 FROM public.register_task_sources s WHERE s.task_code = td.code AND s.is_active) THEN 'register'
         ELSE 'edit' END
  FROM public.task_definitions td
  JOIN public.stage_definitions sd ON sd.id = td.stage_id AND sd.workflow_id = td.workflow_id
  LEFT JOIN public.template_task_rules r ON r.task_code = td.code
  WHERE td.workflow_id = public.tpl_active_workflow() AND sd.stream_code = p_stream AND td.is_active AND sd.is_active AND coalesce(r.mode, '') <> 'exclude'
$$;

-- The columns of a stream template: Site ID, three grey identity columns, then per task (stage and task order) its fields, in Master column order where a
-- Master column exists. Each task has Planned Date and Actual Date (generic when the Master has no column for it). Grey (derived) = never read.
CREATE OR REPLACE FUNCTION tpl_stream_columns(p_stream text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb;
BEGIN
  WITH t AS (SELECT * FROM public.tpl_stream_tasks(p_stream)),
  seeded AS (
    SELECT t.code AS task, t.stage_seq, t.sort_order AS task_ord, t.mode, f.field_key, f.label, f.field_type AS type, f.options, f.master_col,
           coalesce(mc.ord, 5000) AS ford, f.read_only
    FROM t JOIN public.template_task_fields f ON f.task_code = t.code AND f.is_active
    LEFT JOIN public.master_columns mc ON mc.letter = f.master_col
  ), generic AS (
    SELECT t.code AS task, t.stage_seq, t.sort_order AS task_ord, t.mode, g.field_key, g.label, 'date'::text AS type, NULL::jsonb AS options, NULL::text AS master_col,
           5000 + g.n AS ford, false AS read_only
    FROM t CROSS JOIN (VALUES ('planned_date', 'Planned Date', 1), ('actual_date', 'Actual Date', 2)) AS g(field_key, label, n)
    WHERE (g.field_key = 'actual_date' OR t.mode = 'edit')
      AND NOT EXISTS (SELECT 1 FROM public.template_task_fields f WHERE f.task_code = t.code AND f.field_key = g.field_key AND f.is_active)
  ), allf AS (SELECT * FROM seeded UNION ALL SELECT * FROM generic)
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'code', a.task || ':' || a.field_key, 'header', a.task || ' ' || a.label, 'type', a.type, 'kind', 'task', 'required', false,
      'derived', a.read_only OR a.mode <> 'edit' OR a.field_key !~ '^(planned_date|actual_start|actual_date|v:)', 'options', a.options, 'task', a.task, 'field', a.field_key, 'master_col', a.master_col, 'stream', p_stream))
    ORDER BY a.stage_seq, a.task_ord, a.task COLLATE "C", a.ford, a.field_key COLLATE "C"), '[]'::jsonb)
  INTO out FROM allf a;
  RETURN jsonb_build_array(
    jsonb_build_object('code', 'site_code', 'header', 'Site ID', 'type', 'text', 'kind', 'site', 'required', true, 'derived', false),
    jsonb_build_object('code', 'site_name', 'header', 'Site Name', 'type', 'text', 'kind', 'info', 'required', false, 'derived', true),
    jsonb_build_object('code', 'region', 'header', 'Region', 'type', 'text', 'kind', 'info', 'required', false, 'derived', true),
    jsonb_build_object('code', 'scenario', 'header', 'Delivery Scenario', 'type', 'text', 'kind', 'info', 'required', false, 'derived', true)) || out;
END $$;

-- The Master sheet: the 187 columns in Master order. A column that a task field maps to carries it (grey when the field is read only); every other column
-- is shown grey and ignored on upload with a warning (the calculated ones, identity from RF & Design, scope, baseline, Dismantle, Issue Log).
CREATE OR REPLACE FUNCTION tpl_master_columns() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb;
BEGIN
  WITH tk AS (
    SELECT st.code AS stream, x.code AS task, x.mode
    FROM public.workflow_streams st CROSS JOIN LATERAL public.tpl_stream_tasks(st.code) x
    WHERE st.workflow_id = public.tpl_active_workflow()
  ), m AS (
    SELECT mc.ord, mc.letter, mc.header, mc.owner, f.task_code, f.field_key, f.field_type, f.options, f.read_only, tk.stream, tk.mode
    FROM public.master_columns mc
    LEFT JOIN public.template_task_fields f ON f.master_col = mc.letter AND f.is_active
    LEFT JOIN tk ON tk.task = f.task_code
    WHERE mc.is_active
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(
    CASE WHEN m.owner = 'key' THEN jsonb_build_object('code', 'site_code', 'header', m.header, 'type', 'text', 'kind', 'site', 'required', true, 'derived', false, 'master_col', m.letter)
         WHEN m.task_code IS NOT NULL AND m.stream IS NOT NULL THEN jsonb_build_object('code', m.task_code || ':' || m.field_key, 'header', m.header, 'type', m.field_type, 'kind', 'task',
           'required', false, 'derived', m.read_only OR m.mode <> 'edit' OR m.field_key !~ '^(planned_date|actual_start|actual_date|v:)', 'options', m.options, 'task', m.task_code, 'field', m.field_key, 'master_col', m.letter, 'stream', m.stream)
         ELSE jsonb_build_object('code', 'm:' || m.letter, 'header', m.header, 'type', 'text', 'kind', 'info', 'required', false, 'derived', true, 'master_col', m.letter, 'owner', m.owner)
    END) ORDER BY m.ord), '[]'::jsonb)
  INTO out FROM m;
  RETURN out;
END $$;

-- The parts of TPL-MASTER: the Master sheet and one sheet per active register template, each with its columns and the checksum of its header row.
CREATE OR REPLACE FUNCTION tpl_master_parts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb;
BEGIN
  WITH p AS (
    SELECT 0 AS ord, 'master'::text AS part, 'Master'::text AS sheet, 'master'::text AS kind, NULL::text AS ref, public.tpl_master_columns() AS cols
    UNION ALL
    SELECT 10 + d.sort_order, d.register_key, coalesce(tp.sheet_name, left(btrim(regexp_replace(d.name, '[\[\]:*?/\\]', '', 'g')), 31)), 'register', d.register_key,
           public.tpl_columns(d.register_key)
    FROM public.template_definitions d
    LEFT JOIN public.template_parts tp ON tp.template_id = 'TPL-MASTER' AND tp.register_key = d.register_key
    WHERE d.kind = 'register' AND d.is_active
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('part', p.part, 'sheet', p.sheet, 'kind', p.kind, 'ref', p.ref, 'columns', p.cols,
           'header_checksum', public.tpl_header_checksum(p.cols))) ORDER BY p.ord, p.part COLLATE "C"), '[]'::jsonb)
  INTO out FROM p;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION tpl_master_hash(p_parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(coalesce((SELECT jsonb_agg(jsonb_build_array(x ->> 'part', x ->> 'sheet', x ->> 'kind', public.tpl_field_hash(x -> 'columns')) ORDER BY ord)
    FROM jsonb_array_elements(p_parts) WITH ORDINALITY AS t(x, ord)), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION tpl_master_checksum(p_parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(coalesce((SELECT string_agg((x ->> 'sheet') || E'\x1e' || (x ->> 'header_checksum'), E'\x1f' ORDER BY ord)
    FROM jsonb_array_elements(p_parts) WITH ORDINALITY AS t(x, ord)), ''), 'UTF8')), 'hex')
$$;

-- Issues the next version of one template when its columns changed (or the first one). Registers, streams and the Master follow the same rule.
CREATE OR REPLACE FUNCTION tpl_sync(p_template text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.template_definitions%ROWTYPE; cols jsonb; h text; cs text; cur public.template_versions%ROWTYPE; fsv integer; nv integer; why text;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.kind = 'register' THEN
    cols := public.tpl_columns(d.register_key); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'register fields changed';
  ELSIF d.kind = 'stream' THEN
    cols := public.tpl_stream_columns(d.stream_code); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'stream tasks or fields changed';
  ELSE
    cols := public.tpl_master_parts(); h := public.tpl_master_hash(cols); cs := public.tpl_master_checksum(cols); why := 'Master columns, tasks or register fields changed';
  END IF;
  SELECT version INTO fsv FROM public.field_set_versions WHERE entity_type::text = d.custom_entity;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  -- nothing changed (the usual case): no lock is taken, so the saves of other screens never wait for this check
  IF FOUND AND cur.field_set_hash IS NOT DISTINCT FROM h THEN RETURN cur.version; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE id = d.id FOR UPDATE;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF NOT FOUND THEN
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
    VALUES (d.id, 1, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, 'first version'));
    UPDATE public.template_definitions SET current_version = 1, updated_at = now() WHERE id = d.id;
    RETURN 1;
  END IF;
  IF cur.field_set_hash IS DISTINCT FROM h THEN
    nv := cur.version + 1;
    UPDATE public.template_versions SET is_current = false, retired_at = now() WHERE id = cur.id;
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason, published_by)
    VALUES (d.id, nv, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, why), public.app_actor());
    UPDATE public.template_definitions SET current_version = nv, updated_at = now() WHERE id = d.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('template_version_issued', 'template', p_template, jsonb_build_object('version', cur.version, 'field_set_hash', cur.field_set_hash),
            jsonb_build_object('version', nv, 'field_set_hash', h, 'columns', jsonb_array_length(cols)), coalesce(p_reason, why), public.app_actor());
    RETURN nv;
  END IF;
  RETURN cur.version;
END $$;

CREATE OR REPLACE FUNCTION tpl_sync_all() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rd record; tr record; tid text;
BEGIN
  FOR rd IN SELECT r.register_key, r.name_en, r.name_ar, r.module_key, r.sort_order FROM public.register_definitions r
            WHERE r.is_active AND r.enabled AND NOT EXISTS (SELECT 1 FROM public.template_definitions t WHERE t.register_key = r.register_key) LOOP
    tid := 'TPL-' || upper(replace(rd.register_key, '_', '-'));
    IF NOT EXISTS (SELECT 1 FROM public.template_definitions t WHERE t.template_id = tid) THEN
      INSERT INTO public.template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, sort_order)
      VALUES (tid, rd.name_en, rd.name_ar, rd.register_key, 'register', rd.register_key, rd.module_key, rd.sort_order);
    END IF;
  END LOOP;
  UPDATE public.template_definitions t SET is_active = (r.is_active AND r.enabled), updated_at = now()
    FROM public.register_definitions r WHERE t.register_key = r.register_key AND t.is_active IS DISTINCT FROM (r.is_active AND r.enabled);
  FOR tr IN SELECT x.template_id FROM public.template_definitions x
            ORDER BY CASE x.kind WHEN 'register' THEN 0 WHEN 'stream' THEN 1 ELSE 2 END, x.sort_order, x.template_id LOOP
    PERFORM public.tpl_sync(tr.template_id);
  END LOOP;
END $$;

-- the first versions of the new templates (the statement triggers are created after the seed, as in 0037)
SELECT tpl_sync_all();
CREATE TRIGGER tpl_task_fields_changed AFTER INSERT OR UPDATE OR DELETE ON template_task_fields FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_task_rules_changed AFTER INSERT OR UPDATE OR DELETE ON template_task_rules FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_master_columns_changed AFTER INSERT OR UPDATE OR DELETE ON master_columns FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_parts_changed AFTER INSERT OR UPDATE OR DELETE ON template_parts FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
-- only the columns a template is built from (a version bump, a rename or a level count must not run the check: the Matrix and the workflow screens save these rows often)
CREATE TRIGGER tpl_task_definitions_changed AFTER INSERT OR DELETE OR UPDATE OF workflow_id, code, stage_id, sort_order, is_active, is_milestone_task ON task_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_stage_definitions_changed AFTER INSERT OR DELETE OR UPDATE OF workflow_id, seq, stream_code, is_active ON stage_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_register_task_sources_changed AFTER INSERT OR UPDATE OR DELETE ON register_task_sources FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The batch tables learn tasks, groups and sources
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches
  ADD COLUMN stream_code TEXT,        -- a stream batch: the rows are tasks of this stream (register_key is NULL)
  ADD COLUMN group_id    UUID,        -- the batches of one TPL-MASTER file (one batch per part)
  ADD COLUMN part_sheet  TEXT;        -- the sheet of the file this batch came from
CREATE INDEX import_batches_group_idx ON import_batches (group_id) WHERE group_id IS NOT NULL;
COMMENT ON COLUMN import_batches.source IS 'template (a register or stream template), master_template (a part of a TPL-MASTER file: the parallel-run import path), master_import (reserved).';

ALTER TABLE import_batch_rows
  ADD COLUMN task_instance_id UUID,         -- a task row: the task of the site this row enters
  ADD COLUMN task_code        TEXT,
  ADD COLUMN warnings         JSONB,        -- [{column, field, code, message}] never blocking (SLA, calculated column, held for a predecessor)
  ADD COLUMN ord              INTEGER NOT NULL DEFAULT 0,   -- the order of the rows in the preview (several task rows share one file row)
  ADD COLUMN source_ref       TEXT,         -- where the row came from in the file: Sheet!row (the comparison report of the parallel run)
  ADD COLUMN task_submitted_at TIMESTAMPTZ(6);
DROP INDEX import_batch_rows_batch_id_row_no_key;
CREATE UNIQUE INDEX import_batch_rows_batch_sheet_row_task_key ON import_batch_rows (batch_id, sheet, row_no, coalesce(task_code, ''));
CREATE INDEX import_batch_rows_task_idx ON import_batch_rows (task_instance_id) WHERE task_instance_id IS NOT NULL;

-- A task row follows the task it entered: approved when the task is approved, returned when it went back to L1 after the submission.
DROP VIEW v_import_rows;
CREATE VIEW v_import_rows WITH (security_invoker = true) AS
  SELECT r.*,
    CASE WHEN r.action IN ('error', 'unchanged') THEN r.decision
         WHEN r.task_instance_id IS NOT NULL THEN
           CASE WHEN r.decision = 'pending' AND r.task_submitted_at IS NOT NULL AND ti.state = 'approved' THEN 'approved'
                WHEN r.decision = 'pending' AND r.task_submitted_at IS NOT NULL AND ti.state IN ('open', 'entry', 'na', 'skipped') THEN 'rejected'
                ELSE r.decision END
         WHEN r.decision = 'pending' AND rr.state = 'approved' THEN 'approved'
         WHEN r.decision = 'pending' AND rr.state = 'voided' THEN 'rejected'
         WHEN r.decision = 'pending' AND rr.state = 'entry' AND rr.submitted_at IS NOT NULL THEN 'rejected'
         ELSE r.decision END AS eff_decision,
    coalesce(rr.state, ti.state::text) AS record_state, rr.version AS record_version
  FROM import_batch_rows r
  LEFT JOIN register_records rr ON rr.id = r.register_record_id
  LEFT JOIN task_instances ti ON ti.id = r.task_instance_id;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Staging a stream upload
-- ---------------------------------------------------------------------------------------------------------------------
-- One cell: nothing for an empty cell, {value} for a good one, {error, message} for a bad one. The same rules as the manual entry (D13: dates between
-- DateMin and DateMax; lists from the Setting list; numbers).
CREATE OR REPLACE FUNCTION imp_clean_cell(p_type text, p_options jsonb, p_raw jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE s text; d date; o text;
BEGIN
  IF p_raw IS NULL OR jsonb_typeof(p_raw) = 'null' THEN RETURN NULL; END IF;
  s := btrim(p_raw #>> '{}');
  IF s = '' THEN RETURN NULL; END IF;
  IF p_type = 'date' THEN
    IF s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('error', 'invalid_date', 'message', 'Type a date (yyyy-mm-dd).'); END IF;
    BEGIN d := s::date; EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', 'invalid_date', 'message', 'This is not a calendar date.'); END;
    IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN RETURN jsonb_build_object('error', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'); END IF;
    RETURN jsonb_build_object('value', to_jsonb(d::text));
  ELSIF p_type = 'number' THEN
    IF s !~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' THEN RETURN jsonb_build_object('error', 'invalid_number', 'message', 'Type a number.'); END IF;
    RETURN jsonb_build_object('value', to_jsonb(s::numeric));
  ELSIF p_type = 'list' THEN
    SELECT x INTO o FROM jsonb_array_elements_text(coalesce(p_options, '[]'::jsonb)) x WHERE lower(x) = lower(s) LIMIT 1;
    IF o IS NULL THEN RETURN jsonb_build_object('error', 'not_in_list', 'message', 'Not a value of the list.'); END IF;
    RETURN jsonb_build_object('value', to_jsonb(o));
  ELSIF p_type = 'yes_no' THEN
    IF lower(s) IN ('yes', 'y', 'true', '1') THEN RETURN jsonb_build_object('value', to_jsonb(true)); END IF;
    IF lower(s) IN ('no', 'n', 'false', '0') THEN RETURN jsonb_build_object('value', to_jsonb(false)); END IF;
    RETURN jsonb_build_object('error', 'invalid_yes_no', 'message', 'Yes or No.');
  END IF;
  IF length(s) > 500 THEN RETURN jsonb_build_object('error', 'too_long', 'message', 'At most 500 characters.'); END IF;
  RETURN jsonb_build_object('value', to_jsonb(s));
END $$;

-- The error or warning object of one cell of a task: the header and code of the column (the task's column of that field, else its first column).
CREATE OR REPLACE FUNCTION imp_task_note(p_cols jsonb, p_task text, p_field text, p_code text, p_msg text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('column', coalesce(c ->> 'header', p_task), 'field', coalesce(c ->> 'code', p_task), 'code', p_code, 'message', p_msg)
  FROM (SELECT (SELECT x FROM jsonb_array_elements(p_cols) x
                WHERE x ->> 'task' = p_task AND x ->> 'kind' = 'task'
                ORDER BY (x ->> 'field' = p_field) DESC, coalesce((x ->> 'derived')::boolean, false), x ->> 'code' COLLATE "C" LIMIT 1) AS c) q
$$;

-- The patch wf_save_entry takes, from the cleaned fields and the diff: the three dates of the task, and the rest under `values`.
CREATE OR REPLACE FUNCTION imp_task_patch(p_fields jsonb, p_diff jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE patch jsonb := '{}'::jsonb; vals jsonb := '{}'::jsonb; k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(coalesce(p_diff, '{}'::jsonb)) LOOP
    IF NOT (p_fields ? k) THEN CONTINUE; END IF;
    IF k IN ('planned_date', 'actual_start', 'actual_date') THEN patch := patch || jsonb_build_object(k, p_fields -> k);
    ELSE vals := vals || jsonb_build_object(k, p_fields -> k); END IF;
  END LOOP;
  IF vals <> '{}'::jsonb THEN patch := patch || jsonb_build_object('values', vals); END IF;
  RETURN patch;
END $$;

-- What a person sees of a refusal of the workflow engine (wf:<code>:<json>), as one sentence.
CREATE OR REPLACE FUNCTION imp_wf_message(p_json jsonb, p_fallback text DEFAULT 'The task refused this row.') RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_json IS NULL THEN p_fallback
    WHEN p_json ->> 'code' = 'mandatory_slots_missing' THEN 'Missing document(s): ' || coalesce((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(p_json -> 'extra' -> 'missing') x), '?') || '.'
    WHEN p_json ->> 'code' = 'mandatory_fields_missing' THEN 'Missing field(s): ' || coalesce((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(p_json -> 'extra' -> 'missing') x), '?') || '.'
    WHEN p_json ->> 'code' = 'not_eligible_holder' THEN 'You are not an entry holder (L1) of this task.'
    WHEN p_json ->> 'code' = 'already_claimed' THEN 'Another holder has claimed this task.'
    WHEN p_json ->> 'code' = 'open_snags' THEN 'Open snags block this task.'
    ELSE coalesce(p_json -> 'extra' ->> 'detail', (SELECT string_agg(e ->> 'message', ' ') FROM jsonb_array_elements(coalesce(p_json -> 'extra' -> 'errors', '[]'::jsonb)) e), p_fallback)
  END
$$;

-- One file row of a stream template: a site and the cells of its tasks. Returns {site_id, site_code, region_id, row_errors, items[]}; an item is one task of
-- the site: its action (update, unchanged, error), the hold (pending previous approval), the errors and warnings per cell, the diff and the cleaned fields.
CREATE OR REPLACE FUNCTION imp_stage_task_row(p_cols jsonb, p_row jsonb, p_task_site uuid, p_view int[], p_imp int[], p_edit int[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); rowerrs jsonb := '[]'::jsonb; pre jsonb := coalesce(p_row -> 'pre_errors', '[]'::jsonb); cells jsonb := coalesce(p_row -> 'cells', '{}'::jsonb);
  scode text := nullif(btrim(p_row ->> 'site_code'), ''); s public.sites%ROWTYPE; col record; v jsonb; cl jsonb; tc text; plain text; pe jsonb;
  order_codes text[] := ARRAY[]::text[]; pay jsonb := '{}'::jsonb; terr jsonb := '{}'::jsonb; twarn jsonb := '{}'::jsonb; items jsonb := '[]'::jsonb;
  p jsonb; e jsonb; w jsonb; diff jsonb; ti public.task_instances%ROWTYPE; tname text; action text; decision text; hold text; k text; nv jsonb; pend text; missing text[];
  eff_actual date; eff_start date; patch jsonb; j jsonb; item jsonb; cur date; have boolean;
BEGIN
  -- the site, inside the caller's regions (an unknown site and one outside the regions answer the same)
  IF scode IS NULL THEN
    rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'required', 'message', 'The Site ID is required.'));
  ELSE
    SELECT * INTO s FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id) AND public.imp_region_ok(p_view, x.region_id);
    IF NOT FOUND THEN
      rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'site_not_in_scope', 'message', 'Unknown site, or a site outside your regions.'));
    ELSIF p_task_site IS NOT NULL AND s.id <> p_task_site THEN
      rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'not_task_site',
        'message', 'This file was uploaded from a task: only the rows of the task''s site are accepted.'));
    END IF;
  END IF;
  IF jsonb_array_length(rowerrs) > 0 THEN
    RETURN jsonb_build_object('site_id', NULL, 'site_code', scode, 'region_id', NULL, 'row_errors', rowerrs || pre, 'items', '[]'::jsonb);
  END IF;

  -- cell errors found while reading the file (a formula, an error value) belong to the task of their column
  FOR pe IN SELECT * FROM jsonb_array_elements(pre) LOOP
    SELECT c ->> 'task' INTO tc FROM jsonb_array_elements(p_cols) c WHERE c ->> 'code' = pe ->> 'field' LIMIT 1;
    IF tc IS NULL THEN rowerrs := rowerrs || jsonb_build_array(pe); CONTINUE; END IF;
    IF NOT (tc = ANY (order_codes)) THEN order_codes := order_codes || tc; END IF;
    terr := terr || jsonb_build_object(tc, coalesce(terr -> tc, '[]'::jsonb) || jsonb_build_array(pe));
  END LOOP;

  -- the typed cells (grey columns are never read), cleaned with the rules of manual entry
  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'type' AS type, c -> 'options' AS options, c ->> 'header' AS header
             FROM jsonb_array_elements(p_cols) c
             WHERE c ->> 'kind' = 'task' AND NOT coalesce((c ->> 'derived')::boolean, false) LOOP
    v := cells -> col.code;
    IF v IS NULL THEN CONTINUE; END IF;
    cl := public.imp_clean_cell(col.type, col.options, v);
    IF cl IS NULL THEN CONTINUE; END IF;
    IF NOT (col.task = ANY (order_codes)) THEN order_codes := order_codes || col.task; END IF;
    IF cl ? 'error' THEN
      terr := terr || jsonb_build_object(col.task, coalesce(terr -> col.task, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('column', col.header, 'field', col.code, 'code', cl ->> 'error', 'message', cl ->> 'message')));
    ELSE
      plain := regexp_replace(col.field, '^v:', '');
      pay := pay || jsonb_build_object(col.task, coalesce(pay -> col.task, '{}'::jsonb) || jsonb_build_object(plain, cl -> 'value'));
    END IF;
  END LOOP;

  -- grey cells: a value that differs from what GSDN Workspace holds is reported, never read (R5)
  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'header' AS header
             FROM jsonb_array_elements(p_cols) c
             WHERE c ->> 'kind' = 'task' AND coalesce((c ->> 'derived')::boolean, false)
               AND c ->> 'field' IN ('planned_date', 'planned_start', 'actual_start', 'actual_date', 'submitted_date', 'approved_date') LOOP
    v := cells -> col.code;
    IF v IS NULL THEN CONTINUE; END IF;
    cl := public.imp_clean_cell('date', NULL, v);
    IF cl IS NULL OR cl ? 'error' THEN CONTINUE; END IF;
    SELECT CASE col.field WHEN 'planned_date' THEN x.planned_date WHEN 'planned_start' THEN x.planned_start WHEN 'actual_start' THEN x.actual_start
                          WHEN 'actual_date' THEN x.actual_date WHEN 'submitted_date' THEN x.submitted_date ELSE x.approved_date END INTO cur
      FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = col.task AND td.workflow_id = s.workflow_version_id;
    CONTINUE WHEN NOT FOUND;
    IF cur IS DISTINCT FROM (cl ->> 'value')::date THEN
      IF NOT (col.task = ANY (order_codes)) THEN order_codes := order_codes || col.task; END IF;
      twarn := twarn || jsonb_build_object(col.task, coalesce(twarn -> col.task, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('column', col.header, 'field', col.code, 'code', 'calculated_column', 'message', 'Calculated or register-owned column: the value is not read.')));
    END IF;
  END LOOP;

  FOREACH tc IN ARRAY order_codes LOOP
    p := coalesce(pay -> tc, '{}'::jsonb); e := coalesce(terr -> tc, '[]'::jsonb); w := coalesce(twarn -> tc, '[]'::jsonb);
    diff := '{}'::jsonb; action := 'update'; decision := 'pending'; hold := NULL;
    SELECT x.* INTO ti FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = tc AND td.workflow_id = s.workflow_version_id;
    have := FOUND;
    tname := CASE WHEN have THEN (SELECT d2.name_en FROM public.task_definitions d2 WHERE d2.id = ti.task_def_id) END;
    IF NOT have THEN
      e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_on_site', 'This task does not exist on this site (its scope or delivery scenario does not use it).'));
      action := 'error';
    ELSE
      IF p ? 'planned_date' AND (p ->> 'planned_date')::date IS DISTINCT FROM ti.planned_date THEN
        diff := diff || jsonb_build_object('planned_date', jsonb_build_object('old', to_jsonb(ti.planned_date), 'new', p -> 'planned_date')); END IF;
      IF p ? 'actual_start' AND (p ->> 'actual_start')::date IS DISTINCT FROM ti.actual_start THEN
        diff := diff || jsonb_build_object('actual_start', jsonb_build_object('old', to_jsonb(ti.actual_start), 'new', p -> 'actual_start')); END IF;
      IF p ? 'actual_date' AND (p ->> 'actual_date')::date IS DISTINCT FROM ti.actual_date THEN
        diff := diff || jsonb_build_object('actual_date', jsonb_build_object('old', to_jsonb(ti.actual_date), 'new', p -> 'actual_date')); END IF;
      FOR k, nv IN SELECT * FROM jsonb_each(p) LOOP
        CONTINUE WHEN k IN ('planned_date', 'actual_start', 'actual_date');
        IF (ti.values -> k) IS DISTINCT FROM nv THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', ti.values -> k, 'new', nv)); END IF;
      END LOOP;

      IF jsonb_array_length(e) = 0 THEN
        IF diff = '{}'::jsonb THEN
          action := 'unchanged';
        ELSIF ti.is_na OR ti.state IN ('na', 'skipped', 'suspended', 'rejected') THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_open', 'The task is ' || ti.state::text || ': it takes no entry.'));
        ELSIF ti.state = 'approved' THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_approved', 'The task is approved. An approved task is changed only by an admin reopening it.'));
        ELSIF NOT public.imp_region_ok(p_imp, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'region_forbidden', 'You may not import in this region.'));
        ELSIF NOT public.imp_region_ok(p_edit, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'action_forbidden', 'You may not edit tasks in this region.'));
        ELSIF NOT (public.wf_is_eligible(ti.id, 'entry', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.wf_has_holder(ti.id, 'entry'))) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'not_entry_holder', 'You are not an entry holder (L1) of this task in the Matrix.'));
        ELSIF ti.state IN ('in_review', 'in_approval') THEN
          decision := 'pending_previous_approval'; hold := 'open_submission';
          w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_open_submission', 'The task is in ' || ti.state::text || ': the row waits until that submission is decided.'));
        ELSIF ti.state = 'locked' THEN
          SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
            JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
            JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = tp.predecessor_id
            WHERE tp.task_def_id = ti.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
          IF pend IS NOT NULL THEN
            decision := 'pending_previous_approval'; hold := 'predecessor_open';
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_predecessor', 'The row waits until ' || pend || ' is approved.'));
          ELSE
            e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'gate_locked',
              'The task is locked: ' || CASE WHEN starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:') THEN 'the gate ' || substr(ti.lock_reason, 13) || ' is not open yet'
                                             ELSE coalesce(ti.lock_reason, 'the gate of its stage is not open yet') END || ' (Q81).'));
          END IF;
        ELSE
          -- open or ongoing: the manual rules, by running the save on the real task inside a savepoint that is rolled back
          patch := public.imp_task_patch(p, diff);
          BEGIN
            PERFORM public.wf_save_entry(ti.id, NULL, patch);
            RAISE EXCEPTION 'imp:probe_done';
          EXCEPTION WHEN others THEN
            IF SQLERRM <> 'imp:probe_done' THEN
              j := public.imp_wf_json(SQLERRM);
              IF j ->> 'code' = 'validation_failed' THEN
                FOR item IN SELECT * FROM jsonb_array_elements(coalesce(j -> 'extra' -> 'errors', '[]'::jsonb)) LOOP
                  e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, regexp_replace(item ->> 'path', '^/', ''), coalesce(item ->> 'code', 'invalid'), coalesce(item ->> 'message', 'Not valid.')));
                END LOOP;
              ELSIF j IS NOT NULL THEN
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', coalesce(j ->> 'code', 'row_failed'), public.imp_wf_message(j)));
              ELSE
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'row_failed', left(SQLERRM, 200)));
              END IF;
            END IF;
          END;
          IF jsonb_array_length(e) = 0 THEN
            -- what the submit asks for (the same checks as the task screen): the actual date and the mandatory documents
            eff_actual := coalesce((p ->> 'actual_date')::date, ti.actual_date);
            IF eff_actual IS NULL THEN
              e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'actual_date_required',
                'The actual date is required: the task is submitted with its row, as on the task screen.'));
            END IF;
            missing := public.wf_missing_slots(ti.id);
            IF cardinality(missing) > 0 THEN
              e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'mandatory_slots_missing', 'Missing document(s): ' || array_to_string(missing, ', ') || '. Upload them on the task first.'));
            END IF;
          END IF;
        END IF;

        -- warnings that never block: the date order, and the SLA clock (a negative duration is a data-quality alert, Q82; a date after the limit is late)
        IF jsonb_array_length(e) = 0 AND action = 'update' THEN
          eff_actual := coalesce((p ->> 'actual_date')::date, ti.actual_date);
          eff_start := coalesce((p ->> 'actual_start')::date, ti.actual_start);
          IF eff_start IS NOT NULL AND eff_actual IS NOT NULL AND eff_start > eff_actual THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'date_order', 'The actual start is after the actual date.'));
          END IF;
          IF eff_actual IS NOT NULL AND ti.sla_start_date IS NOT NULL AND eff_actual < ti.sla_start_date THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'sla_negative',
              'The actual date is before the SLA start (' || ti.sla_start_date::text || '): the duration is negative and raises a data-quality alert.'));
          ELSIF eff_actual IS NOT NULL AND ti.due_date IS NOT NULL AND eff_actual > ti.due_date THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'sla_late', 'The actual date is after the SLA limit (' || ti.due_date::text || '): the task is late.'));
          END IF;
        END IF;
      END IF;
    END IF;
    IF jsonb_array_length(e) > 0 THEN action := 'error'; diff := '{}'::jsonb; decision := 'pending'; hold := NULL; END IF;
    items := items || jsonb_build_array(jsonb_build_object('task_code', tc, 'task_id', ti.id, 'name', tname, 'action', action, 'decision', decision, 'hold_reason', hold,
      'errors', e, 'warnings', w, 'diff', diff, 'payload', jsonb_build_object('fields', p), 'key', s.site_code || ' / ' || tc,
      'sig', CASE WHEN ti.id IS NOT NULL THEN 't:' || ti.id::text END));
  END LOOP;
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'region_id', s.region_id, 'row_errors', rowerrs, 'items', items);
END $$;

-- Inserts one batch of task rows. p_results = [{row_no, sheet, res}] as imp_stage_task_row answers them.
CREATE OR REPLACE FUNCTION imp_insert_task_batch(p_version_id uuid, p_template text, p_stream text, p_file_name text, p_sha text, p_group uuid, p_sheet text,
  p_results jsonb, p_task uuid, p_task_site uuid, p_source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); bid uuid := gen_random_uuid(); flat jsonb := '[]'::jsonb; el jsonb; res jsonb; it jsonb; regions int[]; n_rows int; n_err int;
BEGIN
  FOR el IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    res := el -> 'res';
    IF jsonb_array_length(coalesce(res -> 'row_errors', '[]'::jsonb)) > 0 THEN
      flat := flat || jsonb_build_array(jsonb_build_object('row_no', el -> 'row_no', 'sheet', el ->> 'sheet', 'site_code', res ->> 'site_code', 'region_id', res -> 'region_id',
        'site_id', res -> 'site_id', 'action', 'error', 'decision', 'pending', 'errors', res -> 'row_errors', 'warnings', '[]'::jsonb, 'diff', '{}'::jsonb,
        'payload', '{}'::jsonb, 'key', res ->> 'site_code'));
    END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(res -> 'items', '[]'::jsonb)) LOOP
      flat := flat || jsonb_build_array(it || jsonb_build_object('row_no', el -> 'row_no', 'sheet', el ->> 'sheet', 'site_code', res ->> 'site_code', 'region_id', res -> 'region_id', 'site_id', res -> 'site_id'));
    END LOOP;
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT (f ->> 'region_id')::int) FILTER (WHERE f ->> 'action' <> 'error' AND f ->> 'region_id' IS NOT NULL), ARRAY[]::int[]),
         count(*), count(*) FILTER (WHERE f ->> 'action' = 'error')
    INTO regions, n_rows, n_err FROM jsonb_array_elements(flat) f;
  IF n_rows = 0 THEN RETURN NULL; END IF;      -- nothing in the file can be entered: no empty batch

  INSERT INTO public.import_batches (id, template_version_id, source, file_name, file_sha256, status, uploaded_by, region_scope, rows_total, rows_error, register_key, task_id, site_id,
    stream_code, group_id, part_sheet)
  VALUES (bid, p_version_id, p_source, left(p_file_name, 200), p_sha, 'validated', actor, regions, n_rows, n_err, NULL, p_task, p_task_site, p_stream, p_group, p_sheet);
  INSERT INTO public.import_batch_rows (batch_id, row_no, sheet, site_code, region_id, target_entity, target_id, action, payload, diff, errors, warnings, decision, row_key, site_id,
    hold_reason, task_instance_id, task_code, ord, source_ref)
  SELECT bid, (f ->> 'row_no')::int, f ->> 'sheet', f ->> 'site_code', (f ->> 'region_id')::int, 'task', (f ->> 'task_id')::uuid, f ->> 'action', coalesce(f -> 'payload', '{}'::jsonb),
         f -> 'diff', f -> 'errors', f -> 'warnings', f ->> 'decision', f ->> 'key', (f ->> 'site_id')::uuid, f ->> 'hold_reason', (f ->> 'task_id')::uuid, f ->> 'task_code', t.n::int,
         (f ->> 'sheet') || '!' || (f ->> 'row_no')
  FROM jsonb_array_elements(flat) WITH ORDINALITY AS t(f, n);
  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, after, actor_id)
  VALUES ('import_batch_create', 'import_batch', bid::text, NULL,
          jsonb_build_object('template_id', p_template, 'stream', p_stream, 'sheet', p_sheet, 'source', p_source, 'group_id', p_group, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha,
            'rows', n_rows, 'errors', n_err, 'update', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'update'),
            'unchanged', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'unchanged')), actor);
  RETURN bid;
END $$;

-- The register upload of 0037 keeps its name under imp_stage_register_batch; imp_stage_batch dispatches a stream template to the task staging.
ALTER FUNCTION imp_stage_batch(text,int,text,text,text,uuid,jsonb) RENAME TO imp_stage_register_batch;

CREATE OR REPLACE FUNCTION imp_stage_stream_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb,
  p_group uuid DEFAULT NULL, p_source text DEFAULT 'template', p_sheet text DEFAULT 'Data') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; r_import int[]; r_view int[]; r_edit int[]; task_site uuid;
  el jsonb; res jsonb; it jsonb; items jsonb; seen jsonb := '{}'::jsonb; results jsonb := '[]'::jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'stream';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF p_checksum IS NOT NULL AND v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_view := public.wf_actor_regions('sites', 'view');
  r_edit := public.wf_actor_regions('sites', 'edit');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_view IS NOT NULL AND cardinality(r_view) = 0) OR (r_edit IS NOT NULL AND cardinality(r_edit) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not import tasks of the Site Register.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.site_id INTO task_site FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id);
    IF task_site IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
                   WHERE ti.id = p_task AND sd.stream_code = d.stream_code) THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'This task belongs to another stream: this template is for the stream ' || d.stream_code || '.'));
    END IF;
  END IF;

  FOR el IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    res := public.imp_stage_task_row(v.columns, el, task_site, r_view, r_import, r_edit);
    items := '[]'::jsonb;
    FOR it IN SELECT x FROM jsonb_array_elements(coalesce(res -> 'items', '[]'::jsonb)) x LOOP
      IF it ->> 'sig' IS NOT NULL THEN
        IF seen ? (it ->> 'sig') THEN
          it := it || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
            'errors', coalesce(it -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'duplicate_in_file',
              'message', 'Row ' || (seen ->> (it ->> 'sig')) || ' of this file is the same task of the same site.')));
        ELSE
          seen := seen || jsonb_build_object(it ->> 'sig', el ->> 'row_no');
        END IF;
      END IF;
      items := items || jsonb_build_array(it);
    END LOOP;
    res := res || jsonb_build_object('items', items);
    results := results || jsonb_build_array(jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', p_sheet), 'res', res));
  END LOOP;
  RETURN public.imp_insert_task_batch(v.id, p_template, d.stream_code, p_file_name, p_sha, p_group, p_sheet, results, p_task, task_site, p_source);
END $$;

CREATE OR REPLACE FUNCTION imp_stage_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE k text;
BEGIN
  SELECT d.kind INTO k FROM public.template_definitions d WHERE d.template_id = p_template AND d.is_active;
  IF k = 'stream' THEN RETURN public.imp_stage_stream_batch(p_template, p_version, p_checksum, p_file_name, p_sha, p_task, p_rows); END IF;
  RETURN public.imp_stage_register_batch(p_template, p_version, p_checksum, p_file_name, p_sha, p_task, p_rows);
END $$;

-- TPL-MASTER: the Master sheet is split into one stream batch per stream (the stream template's own version and columns decide the rows), and each register sheet
-- is staged as the register's own template. Each part follows its own flow; they share group_id, and source = master_template (the parallel-run import path:
-- every row keeps its sheet and file row in source_ref, and its diff against what GSDN Workspace holds). A part the caller may not import is skipped, with the reason.
-- p_parts = [{sheet, header_checksum, rows}]; the rows of the Master sheet carry `cells` keyed by the codes of the Master columns.
CREATE OR REPLACE FUNCTION imp_stage_master(p_template text, p_version int, p_file_name text, p_sha text, p_parts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; gid uuid := gen_random_uuid(); part jsonb; vp jsonb; st record;
  sd public.template_definitions%ROWTYPE; sv public.template_versions%ROWTYPE; srows jsonb; el jsonb; cells jsonb; pres jsonb; codes text[]; bid uuid; batches jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb; j jsonb; rd public.template_definitions%ROWTYPE; rv public.template_versions%ROWTYPE; n_imp int := 0;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'master';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  -- every sheet of the file keeps the header row as issued
  FOR part IN SELECT x FROM jsonb_array_elements(p_parts) x LOOP
    SELECT x INTO vp FROM jsonb_array_elements(v.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    IF vp IS NULL OR vp ->> 'header_checksum' <> part ->> 'header_checksum' THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch',
        'detail', 'The header row of the sheet "' || left(part ->> 'sheet', 40) || '" was changed. Use the template as it was issued.'));
    END IF;
  END LOOP;

  FOR part IN SELECT x FROM jsonb_array_elements(p_parts) x LOOP
    SELECT x INTO vp FROM jsonb_array_elements(v.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    IF vp ->> 'kind' = 'master' THEN
      FOR st IN SELECT s.code, s.sort_order FROM public.workflow_streams s WHERE s.workflow_id = public.tpl_active_workflow() ORDER BY s.sort_order LOOP
        SELECT * INTO sd FROM public.template_definitions x WHERE x.kind = 'stream' AND x.stream_code = st.code AND x.is_active;
        CONTINUE WHEN NOT FOUND;
        SELECT * INTO sv FROM public.template_versions x WHERE x.template_def_id = sd.id AND x.is_current;
        SELECT array_agg(c ->> 'code') INTO codes FROM jsonb_array_elements(sv.columns) c WHERE c ->> 'kind' = 'task';
        srows := '[]'::jsonb;
        FOR el IN SELECT x FROM jsonb_array_elements(part -> 'rows') x LOOP
          SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO cells FROM jsonb_each(coalesce(el -> 'cells', '{}'::jsonb)) e WHERE e.key = ANY (codes);
          SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO pres FROM jsonb_array_elements(coalesce(el -> 'pre_errors', '[]'::jsonb)) x WHERE x ->> 'field' = ANY (codes);
          CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
          srows := srows || jsonb_build_array(jsonb_build_object('row_no', el -> 'row_no', 'sheet', 'Master', 'site_code', el ->> 'site_code', 'cells', cells, 'pre_errors', pres));
        END LOOP;
        CONTINUE WHEN jsonb_array_length(srows) = 0;
        BEGIN
          bid := public.imp_stage_stream_batch(sd.template_id, sv.version, NULL, p_file_name, p_sha, NULL, srows, gid, 'master_template', 'Master');
          IF bid IS NOT NULL THEN
            batches := batches || jsonb_build_array(jsonb_build_object('id', bid, 'sheet', 'Master', 'kind', 'stream', 'ref', st.code, 'template_id', sd.template_id));
          END IF;
        EXCEPTION WHEN others THEN
          j := public.imp_wf_json(SQLERRM);
          IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
          skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', 'Master', 'kind', 'stream', 'ref', st.code, 'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
        END;
      END LOOP;
    ELSE
      SELECT * INTO rd FROM public.template_definitions x WHERE x.kind = 'register' AND x.register_key = vp ->> 'ref' AND x.is_active;
      IF NOT FOUND THEN
        skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', part ->> 'sheet', 'kind', 'register', 'ref', vp ->> 'ref', 'reason', 'template_unknown_or_inactive',
          'detail', 'The register of this sheet is not available.'));
        CONTINUE;
      END IF;
      SELECT * INTO rv FROM public.template_versions x WHERE x.template_def_id = rd.id AND x.is_current;
      BEGIN
        bid := public.imp_stage_register_batch(rd.template_id, rv.version, rv.header_checksum, p_file_name, p_sha, NULL, part -> 'rows');
        UPDATE public.import_batches SET source = 'master_template', group_id = gid, part_sheet = part ->> 'sheet' WHERE id = bid;
        UPDATE public.import_batch_rows SET source_ref = (part ->> 'sheet') || '!' || row_no::text, ord = row_no WHERE batch_id = bid;
        batches := batches || jsonb_build_array(jsonb_build_object('id', bid, 'sheet', part ->> 'sheet', 'kind', 'register', 'ref', rd.register_key, 'template_id', rd.template_id));
      EXCEPTION WHEN others THEN
        j := public.imp_wf_json(SQLERRM);
        IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
        skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', part ->> 'sheet', 'kind', 'register', 'ref', rd.register_key, 'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
      END;
    END IF;
  END LOOP;

  IF jsonb_array_length(batches) = 0 AND jsonb_array_length(skipped) > 0 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', coalesce(skipped -> 0 ->> 'reason', 'import_not_allowed'),
      'detail', coalesce(skipped -> 0 ->> 'detail', 'You may not import any part of this file.')));
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('import_master_upload', 'import_group', gid::text,
          jsonb_build_object('template_id', p_template, 'template_version', v.version, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha,
            'batches', batches, 'skipped', skipped), actor);
  RETURN jsonb_build_object('group_id', gid, 'batches', batches, 'skipped', skipped);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The task history and the audit show "via batch"
-- ---------------------------------------------------------------------------------------------------------------------
-- wf_step keeps the import row of the step when it belongs to the task (app.batch_row is set only by the functions below). The audit row is stamped by the
-- trigger of 0045 from the same setting.
CREATE OR REPLACE FUNCTION wf_step(p_task uuid, p_level int, p_action text, p_actor uuid, p_note text, p_before "TaskState", p_after "TaskState",
  p_stepup boolean, p_self boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid;
BEGIN
  -- clock_timestamp(): the steps of one transaction (a submit and its auto-skips) must keep their order in the history
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, batch_row_id, created_at)
  VALUES (p_task, p_level, p_action::public."WorkflowAction", p_actor, p_note, p_before, p_after, coalesce(p_stepup, false), coalesce(p_self, false),
          (SELECT r.id FROM public.import_batch_rows r WHERE r.id = public.imp_current_row() AND r.task_instance_id = p_task), clock_timestamp())
  RETURNING id INTO sid;
  RETURN sid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Sending a stream batch into the flow, and deciding its rows
-- ---------------------------------------------------------------------------------------------------------------------
-- The uploader confirms the preview: each valid task row starts the task when it is pending, saves the entry and submits it, as the uploader (L1 Data Entry),
-- through the functions of the task screen. The task then waits for L2 Data Reviewer & Approver of its Matrix cell. A row whose task is in review or approval,
-- or still locked by a predecessor, is held "pending previous approval" and is retried at the next send; a row whose task a closed gate locks becomes an error.
CREATE OR REPLACE FUNCTION imp_submit_stream_batch(p_batch uuid, p_version int, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; t public.task_instances%ROWTYPE; submitted int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; st text; new_st text; msg text; pend text; start_d date;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update'
             AND x.decision IN ('pending', 'pending_previous_approval') AND x.task_submitted_at IS NULL ORDER BY x.ord LOOP
    BEGIN
      SELECT * INTO t FROM public.task_instances x WHERE x.id = r.task_instance_id FOR UPDATE;
      IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN
        RAISE EXCEPTION 'wf:not_found:{"detail": "The task does not exist or is not visible to you."}';
      END IF;
      IF t.state IN ('in_review', 'in_approval') THEN
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'open_submission' WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'open_submission', 'record_id', NULL));
        CONTINUE;
      ELSIF t.state = 'locked' THEN
        SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
          JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
          JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
          WHERE tp.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
        IF pend IS NOT NULL THEN
          UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'predecessor_open' WHERE id = r.id;
          held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'predecessor_open', 'record_id', NULL));
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'wf:gate_locked:{"detail": "The task is locked: its gate is not open yet (Q81)."}';
      ELSIF t.state NOT IN ('open', 'entry') THEN
        RAISE EXCEPTION 'wf:task_not_open:{"detail": "The task is no longer open for entry."}';
      END IF;

      patch := public.imp_task_patch(r.payload -> 'fields', r.diff);
      PERFORM set_config('app.batch_row', r.id::text, true);
      IF t.state = 'open' THEN
        start_d := least(coalesce((patch ->> 'actual_start')::date, current_date), current_date);
        PERFORM public.wf_start(t.id, NULL, start_d);
      END IF;
      PERFORM public.wf_save_entry(t.id, NULL, patch);
      PERFORM public.wf_submit(t.id, NULL, NULL, p_stepup);
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      UPDATE public.import_batch_rows SET hold_reason = NULL, task_submitted_at = now(),
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The task refused this row. See the System Log (template-check) for the technical reason.' END;
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', task_submitted_at = NULL, hold_reason = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('column', coalesce(r.task_code, 'Task'), 'field', coalesce(r.task_code, 'task'), 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  new_st := CASE WHEN submitted > 0 OR b.status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE b.status END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('import_batch_submit', 'import_batch', p_batch::text, jsonb_build_object('submitted', submitted, 'held', jsonb_array_length(held), 'failed', jsonb_array_length(failed), 'status', new_st), actor);
  RETURN jsonb_build_object('submitted', submitted, 'held', held, 'failed', failed);
END $$;

-- Decisions on a stream batch: the same actions as for a register batch. A row is decided by the same function a person calls on the task (wf_review,
-- wf_approve, wf_reject), with the same grants, holders, step-up and successors; "approve all" never touches held rows.
CREATE OR REPLACE FUNCTION imp_decide_stream_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.v_import_rows%ROWTYPE; act text; rnote text; decided int := 0; approved int := 0; rejected int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; st text; new_st text; msg text; t public.task_instances%ROWTYPE; item jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF p_action NOT IN ('review', 'approve', 'reject', 'discard') OR p_scope NOT IN ('all', 'rows') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope.'))));
  END IF;

  IF p_action = 'discard' THEN
    IF b.uploaded_by <> actor AND NOT public.app_user_is_system_admin(actor) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can discard it.'));
    END IF;
    IF b.status <> 'validated' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a batch that has not been sent can be discarded. Return the rows with a note instead.'));
    END IF;
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = coalesce(nullif(btrim(p_note), ''), 'discarded') WHERE batch_id = p_batch;
    UPDATE public.import_batches SET status = 'discarded', note = nullif(btrim(p_note), ''), closed_at = now(), version = version + 1 WHERE id = p_batch;
    INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id) VALUES ('import_batch_discard', 'import_batch', p_batch::text, jsonb_build_object('status', 'discarded'), p_note, actor);
    RETURN jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'held', held, 'failed', failed);
  END IF;

  IF b.status NOT IN ('in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
  END IF;
  IF p_action = 'reject' AND coalesce(btrim(p_note), '') = '' AND p_scope = 'all' THEN PERFORM public.wf_err('note_required'); END IF;
  IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
  END IF;

  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update' AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision IN ('pending', 'pending_previous_approval'))
                  OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.ord LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision = 'approved' OR r.eff_decision = 'rejected' THEN CONTINUE; END IF;
    -- a held row has not entered the task: "approve all" lists it and leaves it; a return takes it back (the uploader, or an L2 holder of the task)
    IF r.task_submitted_at IS NULL THEN
      IF act = 'reject' THEN
        IF rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
        IF actor <> b.uploaded_by AND NOT public.wf_is_eligible(r.task_instance_id, 'approve', actor) THEN
          BEGIN
            PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the uploader or an L2 holder of this task can return the row.'));
          EXCEPTION WHEN others THEN
            first_forbidden := coalesce(first_forbidden, SQLERRM);
          END;
          failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'not_eligible_holder',
            'message', 'Only the uploader or an L2 holder of this task can return the row.'));
          CONTINUE;
        END IF;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, hold_reason = NULL WHERE id = r.id;
        decided := decided + 1; rejected := rejected + 1;
      ELSE
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', coalesce(r.hold_reason, 'open_submission'), 'record_id', NULL));
      END IF;
      CONTINUE;
    END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO t FROM public.task_instances x WHERE x.id = r.task_instance_id;
      IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN RAISE EXCEPTION 'wf:not_found:{"detail": "The task does not exist or is not visible to you."}'; END IF;
      IF act <> 'reject' AND ((act = 'approve' AND t.state <> 'in_approval') OR (act = 'review' AND t.state <> 'in_review')) THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition',
          'message', 'The task is ' || t.state::text || ': ' || act || ' is not possible now.'));
        CONTINUE;
      END IF;
      PERFORM set_config('app.batch_row', r.id::text, true);
      IF act = 'reject' THEN PERFORM public.wf_reject(t.id, NULL, rnote, '[]'::jsonb);
      ELSIF act = 'review' THEN PERFORM public.wf_review(t.id, NULL, rnote, p_stepup);
      ELSE PERFORM public.wf_approve(t.id, NULL, rnote, p_stepup); END IF;
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      IF act = 'reject' THEN
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        rejected := rejected + 1; decided := decided + 1;
      ELSIF st = 'approved' THEN
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
      ELSE
        decided := decided + 1;     -- passed a level; the row stays open
      END IF;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j ->> 'code' IN ('not_eligible_holder', 'action_forbidden') AND first_forbidden IS NULL THEN first_forbidden := SQLERRM; END IF;
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be decided', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The row could not be decided. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  IF decided = 0 AND first_forbidden IS NOT NULL THEN RAISE EXCEPTION '%', first_forbidden USING ERRCODE = 'P0001'; END IF;

  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
  VALUES ('import_batch_' || p_action, 'import_batch', p_batch::text,
          jsonb_build_object('scope', p_scope, 'decided', decided, 'approved', approved, 'rejected', rejected, 'held', jsonb_array_length(held), 'failed', jsonb_array_length(failed), 'status', new_st), p_note, actor);
  IF b.uploaded_by <> actor AND decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (b.uploaded_by, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || approved || ' approved, ' || rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/templates/batches/' || p_batch::text);
  END IF;
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'held', held, 'failed', failed);
END $$;

-- The register functions of 0037 and 0041 keep their code under new names; the names the API calls dispatch by the kind of batch.
ALTER FUNCTION imp_submit_batch(uuid,int,boolean) RENAME TO imp_submit_register_batch;
ALTER FUNCTION imp_decide_batch(uuid,int,text,text,jsonb,text,boolean) RENAME TO imp_decide_register_batch;

CREATE OR REPLACE FUNCTION imp_submit_batch(p_batch uuid, p_version int, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_submit_stream_batch(p_batch, p_version, p_stepup);
  END IF;
  RETURN public.imp_submit_register_batch(p_batch, p_version, p_stepup);
END $$;

CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_decide_stream_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  RETURN public.imp_decide_register_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON master_columns, template_task_fields, template_task_rules, template_parts TO pmis_definer;
GRANT SELECT ON v_import_rows TO pmis_definer;
GRANT SELECT ON import_batch_rows, import_batches TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'tpl_active_workflow()', 'tpl_stream_tasks(text)', 'tpl_stream_columns(text)', 'tpl_master_columns()', 'tpl_master_parts()', 'tpl_master_hash(jsonb)', 'tpl_master_checksum(jsonb)',
    'imp_clean_cell(text,jsonb,jsonb)', 'imp_task_note(jsonb,text,text,text,text)', 'imp_task_patch(jsonb,jsonb)', 'imp_wf_message(jsonb,text)',
    'imp_stage_task_row(jsonb,jsonb,uuid,int[],int[],int[])',
    'imp_insert_task_batch(uuid,text,text,text,text,uuid,text,jsonb,uuid,uuid,text)',
    'imp_stage_register_batch(text,int,text,text,text,uuid,jsonb)',
    'imp_stage_stream_batch(text,int,text,text,text,uuid,jsonb,uuid,text,text)', 'imp_stage_batch(text,int,text,text,text,uuid,jsonb)', 'imp_stage_master(text,int,text,text,jsonb)',
    'imp_submit_register_batch(uuid,int,boolean)', 'imp_decide_register_batch(uuid,int,text,text,jsonb,text,boolean)',
    'imp_submit_stream_batch(uuid,int,boolean)', 'imp_decide_stream_batch(uuid,int,text,text,jsonb,text,boolean)',
    'imp_submit_batch(uuid,int,boolean)', 'imp_decide_batch(uuid,int,text,text,jsonb,text,boolean)',
    'wf_step(uuid,int,text,uuid,text,"TaskState","TaskState",boolean,boolean)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON master_columns, template_task_fields, template_task_rules, template_parts FROM pmis_app;
    GRANT SELECT ON master_columns, template_task_fields, template_task_rules, template_parts, v_import_rows TO pmis_app;
    -- the register functions are reached only through the dispatchers
    REVOKE EXECUTE ON FUNCTION imp_stage_register_batch(text,int,text,text,text,uuid,jsonb), imp_submit_register_batch(uuid,int,boolean),
      imp_decide_register_batch(uuid,int,text,text,jsonb,text,boolean) FROM pmis_app;
    FOREACH f IN ARRAY ARRAY[
      'tpl_stream_columns(text)', 'tpl_master_parts()', 'tpl_master_checksum(jsonb)',
      'imp_stage_batch(text,int,text,text,text,uuid,jsonb)', 'imp_stage_master(text,int,text,text,jsonb)',
      'imp_submit_batch(uuid,int,boolean)', 'imp_decide_batch(uuid,int,text,text,jsonb,text,boolean)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
