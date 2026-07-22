'use strict'

const { extractServerBlocks } = require('./tools/vscode-pocketpages/packages/language-core/script-server')

/** @type {import('knip').KnipConfig} */
module.exports = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  ignoreDependencies: ['@iconify-json/lucide', '@pocketpages/test-support', '@unocss/cli', 'cheerio', 'patch-package', 'tailwindcss'],
  ignoreBinaries: ['taskkill'],
  compilers: {
    ejs: (text) =>
      extractServerBlocks(text)
        .map((block) => block.content)
        .join('\n'),
  },
  workspaces: {
    '.': {
      entry: ['eslint.config.js', 'unocss.config.js', 'tools/prettier-plugin-ejs-safe.mjs', 'scripts/**/*.{js,mjs,cjs}', '!scripts/vendor/**'],
      project: ['*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}', 'tools/prettier-plugin-ejs-safe.mjs', '!scripts/vendor/**'],
    },
    'apps/*': {
      entry: [
        '__tests__/**/*.mjs',
        'pb_hooks/**/*.js',
        'pb_hooks/**/*.ejs',
        'pocketpages-globals.d.ts',
        'types.d.ts',
        '!pb_hooks/pages/assets/**',
        '!pb_hooks/pages/**/vendor/**',
        '!pb_migrations/**',
        '!pb_public/**',
      ],
      project: [
        '__tests__/**/*.mjs',
        'pb_hooks/**/*.js',
        'pb_hooks/**/*.ejs',
        '!pb_hooks/pages/assets/**',
        '!pb_hooks/pages/**/vendor/**',
        '!pb_migrations/**',
        '!pb_public/**',
      ],
      ignoreDependencies: [
        'html-to-text',
        'pocketpages-plugin-auth',
        'pocketpages-plugin-datastar-v1',
        'pocketpages-plugin-ejs',
        'pocketpages-plugin-js-sdk',
        'pocketpages-plugin-realtime',
      ],
    },
    'packages/*': {
      entry: ['index.js', 'test/**/*.js', '*.mjs'],
      project: ['*.js', '*.mjs', 'test/**/*.js', '!assets/**'],
      ignoreIssues: {
        'dateutil.js': ['exports'],
        'store-cache.js': ['exports'],
      },
      ignoreBinaries: ['taskkill'],
    },
    'tools/vscode-pocketpages': {
      entry: ['package.json', 'scripts/**/*.js', 'packages/**/*.js'],
      project: ['scripts/**/*.js', 'packages/**/*.js'],
      ignoreDependencies: ['@dlstj-local/pocketpages-typescript-plugin'],
    },
  },
}
