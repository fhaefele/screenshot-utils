import js from '@eslint/js';
import globals from 'globals';

export default [
    {ignores: ['dist/**', 'node_modules/**']},
    js.configs.recommended,
    {
        files: ['*.js', 'tests/*.js', 'scripts/*.js'],
        languageOptions: {globals: {global: 'readonly', imports: 'readonly', print: 'readonly',
            ARGV: 'readonly', console: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly'}},
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}],
            eqeqeq: 'error',
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    {
        files: ['eslint.config.js', 'scripts/*.js', 'tests/*.test.js', 'tests/packages.js'],
        languageOptions: {globals: globals.node},
    },
    {
        files: ['extension.js', 'capture-selectors.js', 'capture-icons.js', 'shell-compat.js', 'location.js', 'filename.js', 'delay.js', 'async-utils.js', 'legacy-runtime.js', 'shortcuts.js'],
        rules: {'no-restricted-imports': ['error', {patterns: ['gi://Gtk*', 'gi://Gdk', 'gi://Gdk?*', 'gi://Adw*', 'node:*']}]},
    },
    {
        files: ['prefs.js', 'prefs-compat.js', 'shortcut-prefs.js', 'prefs-release.js'],
        rules: {'no-restricted-imports': ['error', {patterns: ['gi://Clutter*', 'gi://Meta*', 'gi://St', 'gi://St?*', 'gi://Shell*', 'node:*']}]},
    },
];
