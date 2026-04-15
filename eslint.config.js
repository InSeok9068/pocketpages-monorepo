const js = require('@eslint/js')
const globals = require('globals')
const { buildTemplateVirtualText } = require('./tools/vscode-pocketpages/src/ejs-template')

const pocketPagesGlobals = {
  $app: 'readonly',
  $apis: 'readonly',
  $http: 'readonly',
  __hooks: 'readonly',
  api: 'readonly',
  asset: 'readonly',
  auth: 'readonly',
  body: 'readonly',
  cronAdd: 'readonly',
  core: 'readonly',
  data: 'readonly',
  dbg: 'readonly',
  echo: 'readonly',
  env: 'readonly',
  error: 'readonly',
  formData: 'readonly',
  include: 'readonly',
  info: 'readonly',
  meta: 'readonly',
  onBootstrap: 'readonly',
  onServe: 'readonly',
  onTerminate: 'readonly',
  params: 'readonly',
  redirect: 'readonly',
  request: 'readonly',
  resolve: 'readonly',
  response: 'readonly',
  Record: 'readonly',
  routerAdd: 'readonly',
  routerUse: 'readonly',
  signInWithPassword: 'readonly',
  signOut: 'readonly',
  sleep: 'readonly',
  slot: 'readonly',
  slots: 'readonly',
  store: 'readonly',
  stringify: 'readonly',
  url: 'readonly',
  warn: 'readonly',
}

const ejsProcessor = {
  meta: {
    name: 'pocketpages-ejs-processor',
    version: '0.0.0-local',
  },
  preprocess(text, filename) {
    const wrappedText = `void function(){${buildTemplateVirtualText(text)}\n}()`

    return [
      {
        text: wrappedText,
        filename: `${filename}.ejs.js`,
      },
    ]
  },
  postprocess(messages) {
    return messages.flat()
  },
}

module.exports = [
  {
    ignores: [
      '**/.download/**',
      '**/.git/**',
      '**/.history/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/*.bundle.js',
      '**/*.d.ts',
      '**/*.min.js',
      '**/*.pb.js',
      '**/pb_hooks/pages/_private/vendor/**',
      '**/pb_hooks/pages/assets/**',
      '**/pb_migrations/**',
      '**/pb_public/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ejs'],
    processor: ejsProcessor,
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...pocketPagesGlobals,
      },
    },
    rules: {
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.ejs.js'],
    rules: {
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
]
