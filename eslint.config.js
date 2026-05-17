import mbtech from '@mbtech-nl/eslint-config';

export default [
  ...mbtech,
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/vitest.config.ts',
      // harness-niimbot is cut from the 0.6.0 release (see pnpm-workspace.yaml).
      // It is no longer a workspace member, so its deps are never installed and
      // type-aware lint cannot resolve them. Exclude it until niimbot ships.
      'apps/harness-niimbot/**',
    ],
  },
  {
    // verify-cli is an end-user CLI; `console.*` is its primary output
    // surface. Allowing it broadly here keeps the source readable
    // without per-line `eslint-disable` clutter.
    files: ['apps/verify-cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
