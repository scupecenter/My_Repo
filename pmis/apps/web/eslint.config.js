import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// RTL rule: physical direction utilities are banned; use ms-/me-/ps-/pe-/start-/end-/text-start/border-s.
const PHYSICAL = '(^|[\\s:])-?(m|p)[lr]-|(^|[\\s:])(left|right)-|text-(left|right)|border-[lr](-|\\s|$)|rounded-[lr]-|rounded-(t|b)[lr]-';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/api/schema.d.ts', 'public', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', {
        selector: `Literal[value=/${PHYSICAL}/]`,
        message: 'Use logical utilities (ms-, me-, ps-, pe-, start-, end-, text-start, border-s) so RTL needs no special cases.',
      }],
    },
  },
);
