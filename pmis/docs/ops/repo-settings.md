# Repository settings (paste-ready)

These settings live on GitHub, not in the code. The owner applies them in the repository settings. Nothing here changes the code or the CI.

## 1. About box (the gear next to "About")

- Description: `Site delivery workspace for telecom projects: registers, approvals, SLA and dashboards (NestJS, React, PostgreSQL, Arabic RTL).`
- Website: leave empty.
- Topics: `telecom`, `pmis`, `nestjs`, `react`, `postgresql`, `arabic-rtl`.

## 2. Branch protection for `main` (Settings > Branches > Add branch protection rule, pattern `main`)

- Require a pull request before merging, with 1 approval. Dismiss stale approvals when new commits are pushed.
- Require status checks to pass, and require the branch to be up to date. The 8 checks are:
  Installer scripts (syntax and shellcheck), OpenAPI contract lint, API (typecheck, lint, build, tests on PostgreSQL 16), SAST (semgrep), Dependencies (grype), Web (typecheck, lint, unit tests, build, Playwright e2e), IaC (checkov, report only), Secrets (gitleaks).
- Require conversation resolution before merging.
- Do not allow force pushes. Do not allow deletions.
- Leave "Do not allow bypassing" off until the team agrees, so the owner can still merge in an emergency.

## 3. Security (Settings > Code security)

- Private vulnerability reporting: enable (SECURITY.md points to it).
- Secret scanning: enable. Push protection: enable.
- Dependabot alerts: enable. Dependabot security updates: enable. Version updates come from `.github/dependabot.yml`.

State found on 2026-11-27 through the API: the branch is not protected; secret scanning, push protection and Dependabot security updates are off; the repository has no description or topics; there was no license file (this PR adds one).

## 4. Labels (Issues > Labels)

`priority/high`, `priority/medium`, `priority/low`, `area/api`, `area/web`, `area/database`, `area/infra`, `area/docs`, `area/security`.

## 5. Tags and releases

A tag marks a version that was deployed: `v<contract version>-<date>`, for example `v0.15.193-2026-11-27`. Tags are created by the owner, never by CI. No tag is deleted or moved.

## 6. Visibility (optional note)

The repository is public today and stays public for now, because colleagues work on it. If the owner decides later to make it private:
Settings > General > scroll to the bottom > Danger Zone > Change visibility > Make private > confirm by typing the repository name.
Check first that every collaborator who needs access is added (Settings > Collaborators). Some features, such as branch protection, may need a paid plan on private repositories.
