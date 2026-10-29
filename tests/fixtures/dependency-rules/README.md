# Dependency-rule fixture

A tiny, deliberately rule-breaking module tree. `tests/unit/dependency-rules.test.ts` runs
dependency-cruiser from this directory with the real `.dependency-cruiser.cjs` and asserts that
each forbidden import is reported under the expected rule name, and that the allowed imports are not.
Every boundary rule in the configuration has at least one deliberately broken file here; add one
whenever you add a rule.

This directory is excluded from TypeScript, ESLint and the real `pnpm lint:deps` run.
