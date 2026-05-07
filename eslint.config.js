import mbtech from '@mbtech-nl/eslint-config';

export default [
  ...mbtech,
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/*.d.ts', '**/vitest.config.ts'],
  },
];
