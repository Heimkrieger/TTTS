import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      '.devdata/**',
      '.devdata-test/**',
      'docs/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },
  {
    // В тестах "!" после значения допустим: если значения нет, тест и так упадёт.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' }
  },
  {
    // Служебные скрипты выпуска запускаются в Node.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // Посредник отзывов работает в Cloudflare Workers: там глобальные fetch, URL, FormData, Blob.
    files: ['feedback-relay/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  }
)
