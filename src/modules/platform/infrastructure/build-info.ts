import packageJson from '../../../../package.json';

/** Build facts baked in at bundle time. */
export const buildInfo = {
  version: packageJson.version,
} as const;
