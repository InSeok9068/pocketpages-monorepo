const js = require('@eslint/js')
const jsdoc = require('eslint-plugin-jsdoc')
const { builtinModules } = require('module')
const globals = require('globals')
const { buildTemplateVirtualText } = require('./tools/vscode-pocketpages/packages/language-core/ejs-template')

// goja에서 도는 코드에 허용할 최소 CommonJS 전역입니다.
// PocketBase JSVM은 Node.js가 아니므로 globals.node 전체는 열지 않습니다.
const commonJsRuntimeGlobals = {
  console: 'readonly',
  exports: 'readonly',
  module: 'readonly',
  require: 'readonly',
  // jobs 같은 non-pages hooks에서 process.env를 쓰는 경우를 위해 남겨둡니다.
  process: 'readonly',
}

const restrictedNodeModuleNames = builtinModules
  .filter((name) => !name.startsWith('_'))
  .reduce((acc, name) => {
    acc.push(name)
    acc.push(`node:${name}`)
    return acc
  }, [])

// PocketBase가 pb_hooks 전역으로 제공하는 값들입니다.
const pocketBaseHookGlobals = {
  $app: 'readonly',
  $apis: 'readonly',
  $dbx: 'readonly',
  $filesystem: 'readonly',
  $filepath: 'readonly',
  $http: 'readonly',
  $mails: 'readonly',
  $os: 'readonly',
  $security: 'readonly',
  $template: 'readonly',
  __hooks: 'readonly',
  arrayOf: 'readonly',
  cronAdd: 'readonly',
  cronRemove: 'readonly',
  nullArray: 'readonly',
  nullBool: 'readonly',
  nullFloat: 'readonly',
  nullInt: 'readonly',
  nullObject: 'readonly',
  nullString: 'readonly',
  Record: 'readonly',
  onBackupCreate: 'readonly',
  onBackupRestore: 'readonly',
  onBatchRequest: 'readonly',
  onBootstrap: 'readonly',
  onCollectionAfterCreateError: 'readonly',
  onCollectionAfterCreateSuccess: 'readonly',
  onCollectionAfterDeleteError: 'readonly',
  onCollectionAfterDeleteSuccess: 'readonly',
  onCollectionAfterUpdateError: 'readonly',
  onCollectionAfterUpdateSuccess: 'readonly',
  onCollectionCreate: 'readonly',
  onCollectionCreateExecute: 'readonly',
  onCollectionCreateRequest: 'readonly',
  onCollectionDelete: 'readonly',
  onCollectionDeleteExecute: 'readonly',
  onCollectionDeleteRequest: 'readonly',
  onCollectionsImportRequest: 'readonly',
  onCollectionsListRequest: 'readonly',
  onCollectionUpdate: 'readonly',
  onCollectionUpdateExecute: 'readonly',
  onCollectionUpdateRequest: 'readonly',
  onCollectionValidate: 'readonly',
  onCollectionViewRequest: 'readonly',
  onFileDownloadRequest: 'readonly',
  onFileTokenRequest: 'readonly',
  onMailerRecordAuthAlertSend: 'readonly',
  onMailerRecordEmailChangeSend: 'readonly',
  onMailerRecordOTPSend: 'readonly',
  onMailerRecordPasswordResetSend: 'readonly',
  onMailerRecordVerificationSend: 'readonly',
  onMailerSend: 'readonly',
  onModelAfterCreateError: 'readonly',
  onModelAfterCreateSuccess: 'readonly',
  onModelAfterDeleteError: 'readonly',
  onModelAfterDeleteSuccess: 'readonly',
  onModelAfterUpdateError: 'readonly',
  onModelAfterUpdateSuccess: 'readonly',
  onModelCreate: 'readonly',
  onModelCreateExecute: 'readonly',
  onModelDelete: 'readonly',
  onModelDeleteExecute: 'readonly',
  onModelUpdate: 'readonly',
  onModelUpdateExecute: 'readonly',
  onModelValidate: 'readonly',
  onRealtimeConnectRequest: 'readonly',
  onRealtimeMessageSend: 'readonly',
  onRealtimeSubscribeRequest: 'readonly',
  onRecordAfterCreateError: 'readonly',
  onRecordAfterCreateSuccess: 'readonly',
  onRecordAfterDeleteError: 'readonly',
  onRecordAfterDeleteSuccess: 'readonly',
  onRecordAfterUpdateError: 'readonly',
  onRecordAfterUpdateSuccess: 'readonly',
  onRecordAuthRefreshRequest: 'readonly',
  onRecordAuthRequest: 'readonly',
  onRecordAuthWithOAuth2Request: 'readonly',
  onRecordAuthWithOTPRequest: 'readonly',
  onRecordAuthWithPasswordRequest: 'readonly',
  onRecordConfirmEmailChangeRequest: 'readonly',
  onRecordConfirmPasswordResetRequest: 'readonly',
  onRecordConfirmVerificationRequest: 'readonly',
  onRecordCreate: 'readonly',
  onRecordCreateExecute: 'readonly',
  onRecordCreateRequest: 'readonly',
  onRecordDelete: 'readonly',
  onRecordDeleteExecute: 'readonly',
  onRecordDeleteRequest: 'readonly',
  onRecordEnrich: 'readonly',
  onRecordRequestEmailChangeRequest: 'readonly',
  onRecordRequestOTPRequest: 'readonly',
  onRecordRequestPasswordResetRequest: 'readonly',
  onRecordRequestVerificationRequest: 'readonly',
  onRecordsListRequest: 'readonly',
  onRecordUpdate: 'readonly',
  onRecordUpdateExecute: 'readonly',
  onRecordUpdateRequest: 'readonly',
  onRecordValidate: 'readonly',
  onRecordViewRequest: 'readonly',
  onSettingsListRequest: 'readonly',
  onSettingsReload: 'readonly',
  onSettingsUpdateRequest: 'readonly',
  onServe: 'readonly',
  onTerminate: 'readonly',
  readerToString: 'readonly',
  routerAdd: 'readonly',
  routerUse: 'readonly',
  sleep: 'readonly',
  toBytes: 'readonly',
  toString: 'readonly',
  unmarshal: 'readonly',
}

// PocketPages가 pages/templates 문맥에 주입하는 전역 헬퍼들입니다.
const pocketPagesContextGlobals = {
  api: 'readonly',
  asset: 'readonly',
  auth: 'readonly',
  body: 'readonly',
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
  params: 'readonly',
  redirect: 'readonly',
  request: 'readonly',
  resolve: 'readonly',
  response: 'readonly',
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

const pocketPagesGlobals = {
  ...pocketBaseHookGlobals,
  ...pocketPagesContextGlobals,
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
      '**/pb_migrations/**',
      '**/pb_hooks/pages/_private/vendor/**',
      '**/pb_hooks/pages/assets/**',
      '**/pb_public/**',
      'scripts/**',
      'tools/**',
      'eslint.config.js',
      'unocss.config.js',
      'tailwind.config.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ejs'],
    processor: ejsProcessor,
  },
  {
    files: ['apps/**/pb_hooks/**/*.js', 'packages/**/*.js'],
    languageOptions: {
      ecmaVersion: 2015,
      sourceType: 'commonjs',
      globals: commonJsRuntimeGlobals,
    },
    plugins: {
      jsdoc,
    },
    settings: {
      jsdoc: {
        mode: 'typescript',
      },
    },
    rules: {
      'jsdoc/check-param-names': 'warn',
      'jsdoc/check-property-names': 'warn',
      'jsdoc/check-syntax': 'warn',
      'jsdoc/check-tag-names': 'warn',
      'jsdoc/check-types': 'warn',
      'jsdoc/check-values': 'warn',
      'jsdoc/empty-tags': 'warn',
      'jsdoc/no-bad-blocks': 'warn',
      'jsdoc/require-returns-check': 'warn',
      'jsdoc/valid-types': 'warn',
      'no-restricted-modules': ['error', ...restrictedNodeModuleNames],
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
    files: ['packages/**/*.js'],
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: {
            cjs: true,
            esm: true,
          },
          require: {
            ArrowFunctionExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
          },
        },
      ],
    },
  },
  {
    files: ['apps/**/pb_hooks/**/*.js'],
    languageOptions: {
      globals: pocketBaseHookGlobals,
    },
  },
  {
    files: ['apps/**/pb_hooks/pages/**/*.js'],
    languageOptions: {
      globals: pocketPagesGlobals,
    },
  },
  {
    files: ['apps/**/__tests__/**/*.mjs', 'packages/test-support/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['packages/**/test/**/*.js', 'packages/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-restricted-modules': 'off',
    },
  },
  {
    files: ['**/*.ejs.js'],
    languageOptions: {
      ecmaVersion: 2015,
      sourceType: 'script',
      globals: pocketPagesGlobals,
    },
    rules: {
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
    },
  },
]
