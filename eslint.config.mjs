// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const electronBan = {
  name: 'electron',
  message: 'Runner and MCP servers are plain Node processes: no Electron dependencies.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/contract/schema/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Non-negotiable: runner and mcp-servers have zero Electron dependencies.
  {
    files: ['packages/runner/**/*.ts', 'packages/mcp-servers/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [electronBan], patterns: ['electron/*'] }],
    },
  },
  // Non-negotiable: the renderer depends only on the Backend interface.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'The renderer talks to the Backend interface only.' },
          ],
          patterns: [
            { group: ['**/main/**', '**/preload/**'], message: 'Use the Backend interface.' },
            {
              group: ['@comitiva/runner', '@comitiva/runner/*'],
              message: 'Use the Backend interface.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='api']",
          message: 'window.api is only used by backend/LocalBackend.ts.',
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/src/backend/LocalBackend.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
