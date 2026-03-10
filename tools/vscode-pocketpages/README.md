# VSCode PocketPages

VSCode extension for PocketPages `.ejs` files.

## 한국어 요약

현재 이 확장은 PocketPages `.ejs` 파일에서 `<script server>` 와 EJS 템플릿 태그 작업을 도와줍니다.

- `meta`, `redirect`, `resolve`, `request`, `response`, `dbg` 같은 PocketPages 전역에 대한 자동완성
- `<script server>` 와 EJS 템플릿 태그(`<% %>`, `<%= %>`, `<%- %>`) 안 코드 자동완성 및 hover
- EJS 템플릿 태그(`<% %>`, `<%= %>`, `<%- %>`) 안 JavaScript semantic highlighting
- `<script server>` 안 진단 표시
- `resolve()`, `include()`, 정적 라우트 문자열의 정의로 이동 및 경로 자동완성
- `const svc = resolve('...')` 뒤 `svc.someFn()` 형태에서 export된 함수 정의로 이동
- `pb_schema.json` 기준 컬렉션명 / `record.get('field')` 필드명 보조 및 경고
- 앱별 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`를 읽어서 서비스별로 다르게 동작

아직 안 하는 것은 symbol rename/reference, formatting, 그리고 `<script server>` 밖 EJS 템플릿 영역의 diagnostics 입니다.

It extracts `<script server>` blocks and EJS template code, feeds them into an in-memory TypeScript language service, and surfaces:

- completion
- hover
- diagnostics
- semantic highlighting for JavaScript inside EJS template tags
- document links / go-to-definition for `resolve()`, `include()`, and static route literals
- go-to-definition for exported members called from `resolve()` module aliases
- route path completion for static `href`, `action`, `hx-*`, and `redirect()` literals
- schema-aware `record.get('field')` completion in `<script server>` and EJS template tags

## What this extension covers

- `.ejs` documents under PocketPages app folders like `apps/<service>`
- app-local `pb_data/types.d.ts`
- app-local `pocketpages-globals.d.ts`
- PocketPages globals such as `meta`, `redirect`, `resolve`, `request`, `response`, `dbg`

## What this extension does not cover yet

- symbol references / rename
- formatting
- EJS template tags outside `<script server>` for diagnostics

## Run locally

1. Open `tools/vscode-pocketpages` as the workspace in VSCode.
2. Run `npm install`.
3. Press `F5`.
4. In the Extension Development Host window, open the monorepo root folder.
5. Open an `.ejs` file and test inside `<script server>`.

The included launch config opens the repo root automatically as the test workspace.

When it activates correctly, you should see:

- a new VSCode window titled as an `Extension Development Host`
- an output channel named `VSCode PocketPages`

If you are unsure whether the extension is running, use the command:

`PocketPages: Probe Current EJS File`

This shows whether the current file is inside a detected PocketPages app root and how many diagnostics were produced.

## Sanity check

Run:

```bash
npm run sanity-check
```

This checks the core language-service bridge without starting VSCode.

## Install locally

Build the VSIX:

```bash
npm run package:vsix
```

Then install `dist/vscode-pocketpages.vsix` from your editor:

- VSCode: `Extensions` -> `...` -> `Install from VSIX...`
- Antigravity or other VSCode forks: use the same VSIX install flow if supported

After installing, restart the editor and open a PocketPages `.ejs` file.

If you use VSCode or Antigravity locally, you can package and reinstall in one step:

```bash
npm run install:vscode-pocketpages
```

After reinstalling, run `Developer: Reload Window` in your editor.
