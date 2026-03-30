# AGENTS.md

## 0. Principles

- Prefer explicit structure over abstraction
- File path should explain flow
- Keep logic close to usage
- SSR-first, predictable structure over SPA complexity
- MUST = always follow
- DEFAULT = choose first unless there is a clear reason
- EXCEPTION = allow only when explicitly justified

---

## 1. Stack & Structure

- Stack: PocketBase (JSVM), PocketPages (SSR, file routing), EJS, HTMX, Alpine.js, UnoCSS (Tailwind v3 compatible)
- Service root: `apps/<service>/*`
- `pb_hooks/pages` = routing root
- `(site)` = full pages with layout
- `xapi/*` = no-layout interaction
- `api/*` = data/API
- `_private/*` = internal partials, services, utils, modules

---

## 2. Routing & Params

- filename = URL meaning
- `index.ejs` = directory default route
- prefer explicit names like `new.ejs`, `edit.ejs`, `[slug].ejs`
- use `[param]` only when static path is insufficient
- `params` = route params only
- query = `request.url.query`
- EXCEPTION: `params.__flash` only

---

## 3. Page / Middleware / Load

- `+load.js` runs once at page level
- `+middleware.js` runs hierarchically
- DEFAULT: page-specific data or meta -> page `<script server>`
- DEFAULT: shared logic across child routes -> `+middleware.js`
- DEFAULT: avoid `+load.js` unless structure clearly requires it
- MUST: page-only logic stays in page
- MUST: multi-route shared logic goes to middleware
- MUST: middleware early return sends response explicitly

---

## 4. Rendering

- shared UI -> `+layout.ejs`
- page-specific UI -> page file
- layout sees leaf-page data only
- template = render only
- avoid heavy logic or formatting logic in template
- allowed: simple `if`, simple loop, short expression
- HTMX returns partial HTML or redirect only, never layout HTML
- DEFAULT: reuse shared markup via `_private` partial

---

## 5. _private & Resolve

- `_private` is internal only, never route-exposed
- use for partials, services, utils, internal modules
- partials take minimal props only
- DO NOT pass full context such as `request`, `response`, `api`, `resolve`, full `params`, full `data`
- `_private` modules use CommonJS only
- do not treat `resolve()` inside `_private` as default pattern
- dependencies should be chosen at entry and injected
- `resolve()` is for entry-level dependency selection first
- do not use `resolve('/_private/...')`
- use `_private`-relative names like `resolve('moduleName')`

---

## 6. Redirect, Roles & Logging

- use `redirect('/path', { status, message })`
- do not build flash query manually
- read flash via `params.__flash`
- MUST: log before redirect with `dbg(status, redirectTo, flash or error)`
- roles live in `_private/roles/*`
- roles handle domain logic only
- MUST: no DB write, redirect, response building, or hidden DB query in roles
- MUST: role input must be prepared data only
- `dbg` = debug, `info` = normal flow, `warn` = expected issue, `error` = failure
- DEFAULT: log at request entry, branch point, DB access, mutation, and error
- DEFAULT: log key fields, not full `Record` dump

---

## 7. PocketBase / JSVM

- ES6 only
- sync code only
- CommonJS only
- no `async/await`
- no Promise-based flow
- `pb_data/types.d.ts` = JSVM runtime API
- `pb_schema.json` = schema truth
- `apps/<service>/types.d.ts` = shared JSDoc shapes
- use `record.get('field')`, not `record.field`
- use actual `collection.id`
- no hardcoded relation id
- self relation = post-create update

---

## 8. Frontend

- Alpine is UI helper only
- no business logic or complex state
- use for toggle, modal, tab, and short local UI state

---

## 9. Code Style

- explicit > abstraction
- short trace path
- avoid unnecessary helpers
- define shared named shapes in `apps/<service>/types.d.ts`
- use `types.*` directly in JSDoc
- do not use local typedef bridge
- JSDoc is required for shared functions
- keep Korean description short
- describe role of function and params, not implementation detail

---

## 10. AI Workflow

- identify layer first: PocketPages or PocketBase
- single-file, low-impact change -> open file directly
- multi-file or unclear impact -> run `./task.sh index <service>`
- service change must end with `./task.sh lint <service>`

---

## 11. Structure Analysis

- `impactByFile` first when impact is unclear
- `partials` before `_private/*.ejs` partial change
- `resolveGraph` before `_private/*.js` module change
- `routeLinks` before route, redirect, `href`, `action`, `hx-*` change
- `schemaUsage` before collection or field change
- `routes` when route list or path matters

---

## 12. Checklist

- Before: correct layer, responsibility split, routing choice, schema/runtime source checked
- After: params vs query correct, partial minimal props, HTMX partial-or-redirect only, flash pattern used, `record.get()` used, shared function JSDoc added, lint passed

---

## 13. Priority

1. `.docs/pocketpages/*`
2. `.docs/pocketbase/*`
3. `pb_schema.json`
4. `pb_data/types.d.ts`
5. `apps/<service>/types.d.ts`

If rules conflict, this file overrides defaults for this repo.
