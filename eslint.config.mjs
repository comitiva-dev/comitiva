// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import i18next from 'eslint-plugin-i18next';
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
        {
          // Prose (two words or more) in what people read or hear; single-word
          // samples in inputs (`npx`, a URL) are fine.
          selector:
            'JSXAttribute[name.name=/^(placeholder|title|alt|aria-label|aria-description)$/] > Literal[value=/[A-Za-z]+\\s+[A-Za-z]+/]',
          message: 'User-visible text goes through i18n (t()).',
        },
      ],
    },
  },
  // Every string a user reads goes through i18n (en and pt-BR): JSX text here,
  // and prose in the attributes people read or hear in the renderer block above.
  {
    files: ['apps/desktop/src/renderer/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          // Symbols, arrows and emoji are not prose; "Aa" is the initials swatch.
          words: { exclude: ['[0-9!-/:-@[-`{-~·•…✕✎↑↓▾▸—]+', /^\p{Emoji}+$/u, 'Aa'] },
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
