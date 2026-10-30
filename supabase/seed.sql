-- LOCAL ONLY: production onboarding remains disabled by the migration.
update private.settings set self_service_org_creation=true where singleton;
