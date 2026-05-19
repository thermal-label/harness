import mbtech from '@mbtech-nl/eslint-config';

export default [
  ...mbtech,
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/vitest.config.ts',
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
