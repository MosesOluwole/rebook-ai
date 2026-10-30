/**
 * Regenerates the catalogue section of docs/schema.md from the local database (`pnpm db:docs`),
 * or verifies it is current (`pnpm db:docs --check`, used in CI). The output is formatted with
 * the project's Prettier configuration so this check and `pnpm format:check` always agree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as prettier from 'prettier';

import { getOwnerDatabaseUrl } from '../src/shared/config/env';
import { createDbClient } from '../src/shared/db/client';
import { loadProjectEnv } from './lib/load-env';
import { renderSchemaDoc, spliceGenerated } from './lib/schema-doc';

const DOC_PATH = path.join(process.cwd(), 'docs', 'schema.md');
const checkOnly = process.argv.includes('--check');

loadProjectEnv();

const owner = createDbClient(getOwnerDatabaseUrl(), {
  max: 1,
  applicationName: 'rebook-ai-db-docs',
});
try {
  const current = readFileSync(DOC_PATH, 'utf8');
  const prettierOptions = (await prettier.resolveConfig(DOC_PATH)) ?? {};
  const next = await prettier.format(spliceGenerated(current, await renderSchemaDoc(owner.sql)), {
    ...prettierOptions,
    filepath: DOC_PATH,
  });
  if (next === current) {
    process.stdout.write('db:docs: docs/schema.md is up to date\n');
  } else if (checkOnly) {
    process.stderr.write(
      'db:docs: docs/schema.md is stale. Run `pnpm db:docs` and commit the result.\n',
    );
    process.exitCode = 1;
  } else {
    writeFileSync(DOC_PATH, next);
    process.stdout.write('db:docs: docs/schema.md updated\n');
  }
} finally {
  await owner.close();
}
