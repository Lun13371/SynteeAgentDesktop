// Flat config (ESLint 9+) — TypeScript + React. Заменяет стейл .eslintrc.cjs
// (был скопирован из Vue-шаблона electron-vite, никогда не подключался к
// проекту — здесь React/Electron, не Vue).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '*.config.js', '*.config.ts', '*.config.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/core/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
)
