# VSCode PocketPages

VSCode extension for PocketPages `.ejs` files.

It extracts `<script server>` blocks, feeds them into an in-memory TypeScript language service, and surfaces:

- completion
- hover
- diagnostics

## What this extension covers

- `.ejs` documents under PocketPages app folders like `apps/sample`
- app-local `pb_data/types.d.ts`
- app-local `pocketpages-globals.d.ts`
- PocketPages globals such as `meta`, `redirect`, `resolve`, `request`, `response`, `dbg`

## What this extension does not cover yet

- route-param-specific typing like `params.boardSlug`
- go-to-definition / references
- formatting
- EJS template tags outside `<script server>`

## Run locally

1. Open `tools/vscode-pocketpages` as the workspace in VSCode.
2. Run `npm install`.
3. Press `F5`.
4. In the Extension Development Host window, open the monorepo root folder.
5. Open an `.ejs` file and test inside `<script server>`.

The included launch config opens the repo root automatically as the test workspace.

When it activates correctly, you should see:

- a new VSCode window titled as an `Extension Development Host`
- an information toast saying `VSCode PocketPages activated.`
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
