/**
 * CI schema check: fails when a table in the `rebook` schema breaks a tenant-isolation rule
 * (missing tenant_id, RLS not enabled or not forced, no policy, a foreign key that is not
 * tenant_id → tenants(id) or composite on tenant_id, or any privilege for a Supabase Data API role). Runs as the owner against the migrated database.
 *
 *   pnpm db:check-schema
 */
import { getOwnerDatabaseUrl } from '../src/shared/config/env';
import { createDbClient } from '../src/shared/db/client';
import { loadProjectEnv } from './lib/load-env';
import { checkSchema, FORBIDDEN_GRANTEES, formatFindings } from './lib/schema-check';

loadProjectEnv();

const owner = createDbClient(getOwnerDatabaseUrl(), {
  max: 1,
  applicationName: 'rebook-ai-check-schema',
});
try {
  const findings = await checkSchema(owner.sql);
  if (findings.length > 0) {
    process.stderr.write(
      `db:check-schema: ${findings.length} problem(s) in schema rebook\n${formatFindings(findings)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `db:check-schema: every rebook table has tenant_id (or is allow-listed), forced RLS, a policy, tenant-scoped foreign keys, and no grants to ${FORBIDDEN_GRANTEES.join('/')}
`,
    );
  }
} finally {
  await owner.close();
}
