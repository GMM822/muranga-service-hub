# Murang’a County Public Service Request System

A resident-facing service portal for reporting county issues, tracking their progress, and helping authorized county staff manage service requests.

## What it includes

- Clerk-powered resident registration and sign-in
- Service requests for water supply, waste management, roads and transport, street lighting, drainage and flooding, and other issues
- Private request tracking, status history, and optional photo attachments
- An administrator dashboard with request filters, status updates, and totals by status and category
- PostgreSQL persistence for accounts, requests, uploaded-file metadata, and status history
- Clearly labelled sample requests for demonstrations; these are not genuine citizen reports

## Run in Replit

The web app and API server use their managed Replit workflows. Start or restart **Murang’a County Public Service Request System: web** and **API Server** from the Replit workspace. The Clerk app is provisioned for this project and its development keys are managed by Replit.

Run these commands from the workspace root when updating the project:

```bash
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck
```

The schema push applies changes to the development database. Database schema changes for a Replit-managed production database are applied through Replit’s Publish flow.

## Configure administrator access

Set `ADMIN_EMAILS` in the Replit environment to a comma-separated list of the verified primary email addresses that should have administrator access. Each administrator must register and sign in with that address. The server checks the verified Clerk account email on authenticated API requests and stores the resolved role in PostgreSQL.

There is no public role-change endpoint. Residents cannot promote themselves or access administrator-only APIs by changing browser state. If `ADMIN_EMAILS` is not configured, signed-in accounts receive the citizen role.

Development and production Clerk accounts are separate. Configure the same administrator address for the published app and have that person create a production account before expecting access to the production dashboard.

## Image attachments

Request photos are uploaded directly to private Replit App Storage. The API checks authentication, accepted image types, upload ownership, and a 5 MB limit before attaching a photo to a request.

App Storage provisioning returned an internal service error during this setup. Until Replit App Storage is available for the project, the image-upload endpoint returns a clear temporary-unavailable response; residents can still submit requests without a photo. Once provisioning succeeds, the managed bucket settings are supplied by Replit.

## Demonstration data

The development database is preloaded with three sample requests. Each row has `is_demo = true`, a `MUR-DEMO-*` tracking code, sample-only reporter information, and status history labelled as demonstration content. Administrators see a clear warning and sample marker; analytics expose `demoTotal` separately. Samples are excluded from citizen request lists. Production data is not automatically seeded with sample reports.

## Publish

1. Configure `ADMIN_EMAILS` for the published environment.
2. Confirm App Storage is available if photo attachments are required.
3. Use Replit’s **Publish** flow to publish the web app and API and apply the production database schema.
4. Create a production Clerk account with the configured administrator email and confirm administrator access.
5. Submit a test request from a resident account and verify its status history and visibility.

Never use sample records as real resident reports or rely on the development Clerk accounts in production.
