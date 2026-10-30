/**
 * Dependency rules for Rebook AI (docs/architecture.md §12, docs/adr/ADR-001-stack.md).
 *
 * Layout: src/modules/<module>/{domain,application,infrastructure} + index.ts, src/app (routes),
 * src/shared (cross-cutting code: config, db, kernel).
 *
 * The rules in one sentence each:
 *  - A module's internals are reached only through that module's index.ts.
 *  - domain/ is pure: no framework, I/O or package imports (zod excepted), no outer layers.
 *  - src/shared never depends on modules or routes; src/shared/kernel is pure.
 *  - Nothing under src/modules imports from src/app.
 *
 * Run with `pnpm lint:deps`. tests/unit/dependency-rules.test.ts proves each rule fires.
 */

// $1 captures the module name so a module may reach its own internals but no other module's.
const MODULE = '(?:^|/)src/modules/([^/]+)/';
const DOMAIN = '(?:^|/)src/modules/([^/]+)/domain/';
const MODULE_INTERNALS = '(?:^|/)src/modules/[^/]+/(?:domain|application|infrastructure)/';
const OUTER_LAYERS = '(?:^|/)src/modules/[^/]+/(?:application|infrastructure)/';
const APP = '(?:^|/)src/app/';
const SHARED = '(?:^|/)src/shared/';
const KERNEL = '(?:^|/)src/shared/kernel/';
const TEST_FILE = '[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$';

// Packages that pure code may use. Everything else is a framework or I/O concern.
const PURE_PACKAGES = ['(?:^|/)node_modules/zod(?:/|$)'];
const PACKAGE_TYPES = [
  'npm',
  'npm-dev',
  'npm-peer',
  'npm-optional',
  'npm-bundled',
  'npm-no-pkg',
  'npm-unknown',
  'core',
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---- Module boundaries -------------------------------------------------------------
    {
      name: 'module-internals-only-via-index',
      severity: 'error',
      comment:
        "A module may import another module only through that module's index.ts. " +
        "Export what you need from the other module's index.ts instead.",
      from: { path: MODULE },
      to: { path: MODULE_INTERNALS, pathNot: '(?:^|/)src/modules/$1/' },
    },
    {
      name: 'no-module-internals-from-outside',
      severity: 'error',
      comment:
        'Code outside src/modules (routes, server actions, shared code) may only import a ' +
        'module through its index.ts. Tests are exempt.',
      from: { pathNot: ['(?:^|/)src/modules/', '^tests/'] },
      to: { path: MODULE_INTERNALS },
    },
    {
      name: 'modules-do-not-import-app',
      severity: 'error',
      comment: 'Modules are framework-agnostic; routes depend on modules, never the reverse.',
      from: { path: '(?:^|/)src/modules/' },
      to: { path: APP },
    },

    // ---- Domain purity -------------------------------------------------------------------
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'domain/ holds pure rules: no framework, database, HTTP, filesystem or clock access. ' +
        'Only zod is allowed. Pass values in; keep I/O in application/ and infrastructure/.',
      from: { path: DOMAIN, pathNot: TEST_FILE },
      to: { dependencyTypes: PACKAGE_TYPES, pathNot: PURE_PACKAGES },
    },
    {
      name: 'domain-depends-only-on-domain-and-kernel',
      severity: 'error',
      comment:
        "domain/ may import only its own module's domain/ and src/shared/kernel. " +
        'No application/, infrastructure/, routes, other modules or shared I/O code.',
      from: { path: DOMAIN, pathNot: TEST_FILE },
      to: {
        path: [OUTER_LAYERS, APP, '(?:^|/)src/modules/(?!$1/)[^/]+/', SHARED],
        pathNot: KERNEL,
      },
    },

    // ---- Shared code ---------------------------------------------------------------------
    {
      name: 'shared-does-not-depend-on-modules',
      severity: 'error',
      comment: 'src/shared is a leaf: it must not know about any module or route.',
      from: { path: SHARED },
      to: { path: ['(?:^|/)src/modules/', APP] },
    },
    {
      name: 'kernel-no-packages',
      severity: 'error',
      comment: 'src/shared/kernel is importable from domain code, so it must stay pure.',
      from: { path: KERNEL, pathNot: TEST_FILE },
      to: { dependencyTypes: PACKAGE_TYPES, pathNot: PURE_PACKAGES },
    },
    {
      name: 'kernel-no-app-code',
      severity: 'error',
      comment: 'src/shared/kernel may depend on nothing else in src.',
      from: { path: KERNEL, pathNot: TEST_FILE },
      to: { path: '(?:^|/)src/', pathNot: KERNEL },
    },

    // ---- General hygiene -----------------------------------------------------------------
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports hide ownership and break tree-shaking. Invert the dependency.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment:
        'Nothing imports this file. Delete it or use it. Framework entry points under src/app, ' +
        'instrumentation and proxy files, declaration files and tests are exempt.',
      from: {
        orphan: true,
        path: '^src/',
        pathNot: [
          APP,
          '^src/(?:instrumentation|instrumentation-client|proxy)[.]ts$',
          '[.]d[.]ts$',
          TEST_FILE,
        ],
      },
      to: {},
    },
    {
      name: 'not-to-test-files',
      severity: 'error',
      comment: 'Production and helper code must not import test files.',
      from: { pathNot: TEST_FILE },
      to: { path: TEST_FILE },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Code under src ships to production and may not import devDependencies ' +
        '(type-only imports and @types are fine). Tests are exempt.',
      from: { path: '^src/', pathNot: TEST_FILE },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only'],
        pathNot: ['(?:^|/)node_modules/@types/'],
      },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment: 'Import of a package that is not declared in package.json.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Import that cannot be resolved on disk.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-deprecated',
      severity: 'error',
      comment: 'Import of a deprecated package version.',
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      comment:
        'Import of a deprecated Node core module. node:async_hooks is deliberately not listed: ' +
        'its AsyncLocalStorage export is stable (used by withTenant); only the low-level ' +
        'createHook API is experimental.',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: ['^(?:node:)?(?:punycode|domain|constants|sys|_linklist|_stream_wrap)$'],
      },
    },
    {
      name: 'no-duplicate-dep-types',
      severity: 'error',
      comment: 'A package listed in more than one dependency section of package.json.',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: { path: ['^tests/fixtures/'] },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    detectProcessBuiltinModuleCalls: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    skipAnalysisNotInRules: true,
    reporterOptions: {
      text: { highlightFocused: true },
      dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern:
          '^(?:src/modules/[^/]+|src/app|src/shared/[^/]+|tests/[^/]+)|node_modules/(?:@[^/]+/[^/]+|[^/]+)',
      },
    },
  },
};
