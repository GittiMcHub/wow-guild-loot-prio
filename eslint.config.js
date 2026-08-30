// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.js'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Domain-purity guard for packages/core (§3: isMainCharacter/spec/characterId
    // must never enter the resolver's comparison key).
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', 'drizzle-orm', 'pg', 'react', '@glps/contracts'],
              message: 'packages/core must stay pure: no I/O, no framework, no DB imports.',
            },
          ],
        },
      ],
    },
  },
);
