# Supabase boundary and migration policy

No Supabase project, local database, `config.toml`, schema, credentials, or runtime client exists in Phase 00. Local database startup and Docker are not required. The proposed model and authorization flow live in `docs/architecture/multi-tenancy.md`.

When persistence is approved, discover the installed CLI commands with `supabase --help` and subcommand help, verify current documentation/changelog, and configure an explicitly selected non-production environment. Generate migration files using `supabase migration new <descriptive-name>` rather than inventing timestamps. SQL migrations belong under `supabase/migrations/` in version control; none is needed for a schema that does not exist.

Migrations must include the table/index/constraint changes, deliberate grants, RLS enablement and policies for exposed tenant tables, and tests with ordinary authenticated database roles. Apply and test the migration from a clean local database and check database advisors before review. Service-role tests do not establish RLS correctness. Never apply changes to a remote project implicitly or store generated local database state/credentials in Git.
