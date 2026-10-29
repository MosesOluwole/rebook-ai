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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
});

export type Env = Readonly<z.infer<typeof schema>>;
export type Environment = Env['NODE_ENV'];
type EnvVariable = keyof Env;

const HINTS: Readonly<Record<EnvVariable, string>> = {
  NODE_ENV: "one of 'development', 'test' or 'production' (set by Next.js)",
  DATABASE_URL:
    'Postgres connection string, e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres',
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
 * empty `DATABASE_URL=` line in .env is reported as missing rather than as a malformed URL.
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
