# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub private vulnerability reporting: on the repository page open **Security**, then **Report a vulnerability**. If that button is not shown, contact the repository owner directly through GitHub and ask for a private channel before you share any detail.

Please include what you found, the steps to reproduce it, and the version (the contract version in `pmis/contracts/openapi.yaml` and the newest migration number).

## What to expect

The repository owner reads every report and keeps it private until a fix is merged.

## Scope

In scope: the API (`pmis/apps/api`), the web app (`pmis/apps/web`), the database migrations and functions (`pmis/apps/api/prisma/migrations`, `pmis/db`), the installer and infrastructure scripts (`pmis/tools`, `pmis/infra`).

Out of scope: findings that need a stolen or shared account, physical access to a server, or a change to the deployment that the runbook does not describe.

## For contributors

- Never commit a secret, a real person's data, or a real server address. Test data is synthetic.
- The secret scan (`gitleaks`), the code scan (`semgrep`), the dependency scan (`grype`) and the infrastructure scan (`checkov`) run on every pull request.
- Security changes (permissions, grants, defaults) are never part of an unrelated change. They go in their own pull request with a CHANGELOG entry.
