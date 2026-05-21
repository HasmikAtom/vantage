// ESLint v9 flat config — minimal, hooks-focused.
// Goal of this config (per audit §5): catch the next `usePolling`-style hook
// dep bug at lint time. Type-aware rules (`strict-type-checked`) are
// deliberately out of scope for this pass.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.js', '*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // `exhaustive-deps` is a warn, not an error: usePolling deliberately
      // omits `fetcher` from its effect deps (see hook's JSDoc) and that
      // pattern is the right call there. New violations should still get
      // fixed; treat warnings here as "show your work".
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
