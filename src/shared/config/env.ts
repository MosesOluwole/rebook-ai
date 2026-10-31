import { z } from 'zod';

/**
 * Environment configuration. Server-only.
 *
 * Every variable the app reads is declared here and validated once: at server start by
 * src/instrumentation.ts, and on first use anywhere else. Nothing outside this file reads
 * application configuration from process.env. Add a variable by extending the schema and the
 * HINTS below, then .env.example and docs/setup.md.
 *
 * getEnv() must not be imported from client components: Next.js inlines only literal
 * `process.env.NEXT_PUBLIC_*` references into browser bundles, so a browser would see nothing
 * and validation would fail. NEXT_PUBLIC_* values are public; never put secrets in them.
 */

const postgresUrl = z.url({ protocol: /^postgres(?:ql)?$/ });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Runtime connection for the app: the `rebook_authenticator` login role, which holds no table
   * privileges until `withTenant` switches to `rebook_app` or `rebook_worker` in a transaction.
   */
  APP_DATABASE_URL: postgresUrl,
  /**
   * Owner connection (Supabase's `postgres` role, the design's `rebook_owner`). Used only by
   * migrations, Drizzle Kit, `pnpm db:roles` and test fixtures; the app never needs it, so it is
   * optional here and tooling asks for it through getOwnerDatabaseUrl().
   */
  DATABASE_URL: postgresUrl.optional(),
  /**
   * Supabase Auth, reached only from the server (docs/adr/ADR-004-auth-sessions.md): the API
   * gateway URL and the publishable (anon) key. The browser never receives either. The admin
   * key and the JWT secret are never configured for this app (`pnpm check:secrets`).
   */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(20),
  /**
   * The request header that carries the client IP, set by the trusted reverse proxy in front of
   * the app (docs/adr/ADR-004-auth-sessions.md §9). Rate limits key on it. Required: without a
   * trusted header the app cannot tell clients apart, so it refuses to start rather than guess.
   */
  CLIENT_IP_HEADER: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,64}$/, 'a header name such as x-forwarded-for'),
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
});

export type Env = Readonly<z.infer<typeof schema>>;
export type Environment = Env['NODE_ENV'];
type EnvVariable = keyof Env;

const HINTS: Readonly<Record<EnvVariable, string>> = {
  NODE_ENV: "one of 'development', 'test' or 'production' (set by Next.js)",
  APP_DATABASE_URL:
    'Postgres connection string for the app role rebook_authenticator, e.g. ' +
    'postgresql://rebook_authenticator:<password>@127.0.0.1:54322/postgres',
  DATABASE_URL:
    'Postgres connection string for the owner role used by migrations and tooling, e.g. ' +
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL:
    'URL of the Supabase API gateway, e.g. http://127.0.0.1:54321 (API_URL in `pnpm db:status`)',
  SUPABASE_PUBLISHABLE_KEY:
    'the publishable or anon key of the Supabase project (PUBLISHABLE_KEY or ANON_KEY in `pnpm db:status`)',
  CLIENT_IP_HEADER:
    'the request header the trusted proxy sets to the client IP, e.g. x-forwarded-for locally or x-real-ip on the platform',
  NEXT_PUBLIC_APP_URL: 'public origin of the web app, e.g. http://localhost:3000',
};

export interface EnvIssue {
  readonly variable: string;
  readonly problem: string;
  readonly hint: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(formatIssues(issues));
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

function formatIssues(issues: readonly EnvIssue[]): string {
  const lines = issues.map(
    (issue) => `  - ${issue.variable}: ${issue.problem}. Expected ${issue.hint}.`,
  );
  const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
  return [
    `Invalid environment configuration (${count}). The app will not start until this is fixed.`,
    ...lines,
    'Copy .env.example to .env for local defaults; see docs/setup.md.',
  ].join('\n');
}

function isBlank(value: string | undefined): value is undefined | '' {
  return value === undefined || value.trim() === '';
}

/**
 * Validates a raw environment (normally process.env). Blank values count as missing, so an
 * empty `APP_DATABASE_URL=` line in .env is reported as missing rather than as a malformed URL.
 * Throws EnvValidationError with one line per problem.
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => !isBlank(value)));
  const result = schema.safeParse(present);
  if (result.success) {
    return Object.freeze(result.data);
  }

  const issues: EnvIssue[] = result.error.issues.map((issue) => {
    const variable = String(issue.path[0] ?? '(root)');
    const missing = isBlank(source[variable]);
    return {
      variable,
      problem: missing ? 'missing' : issue.message,
      hint: variable in HINTS ? HINTS[variable as EnvVariable] : 'a valid value',
    };
  });
  throw new EnvValidationError(issues);
}

let cached: Env | undefined;

/** The validated environment for this process. Parses process.env on first call, then caches. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/**
 * The owner connection string, for tooling and test fixtures only. Throws the same readable
 * error as boot validation when it is not configured.
 */
export function getOwnerDatabaseUrl(): string {
  const url = getEnv().DATABASE_URL;
  if (url === undefined) {
    throw new EnvValidationError([
      { variable: 'DATABASE_URL', problem: 'missing', hint: HINTS.DATABASE_URL },
    ]);
  }
  return url;
}
