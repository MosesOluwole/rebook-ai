import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

/**
 * Raw database connection factory.
 *
 * This is the only place a Postgres connection is created. In Phase 1 the tenancy module wraps
 * it in `withTenant`, and repositories accept only that tenant-scoped transaction handle; nothing
 * in application code should query through this client directly.
 */
export interface DbClient {
  readonly sql: Sql;
  readonly db: PostgresJsDatabase;
  close(): Promise<void>;
}

export interface DbClientOptions {
  /** Maximum pooled connections. Tooling and tests should use a small number. */
  readonly max?: number;
  /** Shown in pg_stat_activity, which makes stray connections easy to attribute. */
  readonly applicationName?: string;
}

export function createDbClient(url: string, options: DbClientOptions = {}): DbClient {
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Production connects through Supavisor in transaction mode (docs/architecture.md §11),
    // which does not support named prepared statements.
    prepare: false,
    connection: { application_name: options.applicationName ?? 'rebook-ai' },
  });
  // snake_case matches drizzle.config.ts so TypeScript camelCase maps to SQL snake_case columns.
  const db = drizzle({ client: sql, casing: 'snake_case' });
  return {
    sql,
    db,
    close: () => sql.end({ timeout: 5 }),
  };
}
