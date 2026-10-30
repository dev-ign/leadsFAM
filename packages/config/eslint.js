import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/.tools/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
    },
  },
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      ...hooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                '@leadops/api',
                '@leadops/api/*',
                '@leadops/database',
                '@leadops/database/*',
                '@leadops/agents',
                '@leadops/agents/*',
                '@leadops/integrations',
                '@leadops/integrations/*',
                '@leadops/observability',
                '@leadops/observability/*',
              ],
              message: 'Server-only modules cannot enter browser code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/lib/api-client.ts', '**/*.test.*'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use the centralized API client.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='fetch']",
          message: 'Use the centralized API client.',
        },
      ],
    },
  },
];
