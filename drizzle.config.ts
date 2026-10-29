import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'drizzle-kit';

import { getEnv } from './src/shared/config/env';

// Load .env the same way Next.js does, so drizzle-kit sees the validated DATABASE_URL.
loadEnvConfig(process.cwd());

export default defineConfig({
  dialect: 'postgresql',
  // Each module owns its tables in infrastructure/schema.ts. Phase 0 has none.
  schema: './src/modules/*/infrastructure/schema.ts',
  // Migrations are written where the Supabase CLI applies them, with its timestamp prefix,
  // so there is exactly one migration applier (docs/adr/ADR-001-stack.md).
  out: './supabase/migrations',
  migrations: { prefix: 'supabase' },
  casing: 'snake_case',
  dbCredentials: { url: getEnv().DATABASE_URL },
  strict: true,
  verbose: true,
});
