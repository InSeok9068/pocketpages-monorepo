# AGENTS.md

## 0. Principles & Code Style

- Prefer explicit, local code over abstraction
- File paths and trace paths should make request flow easy to follow
- Keep logic close to usage; add helpers only when readability or reuse is clear
- SSR-first, predictable structure over SPA complexity
- Shared named shapes live in `apps/<service>/types.d.ts`
- Use `types.*` directly in JSDoc; do not use local typedef bridges
- Shared functions require JSDoc
- Keep Korean descriptions short and describe function/param roles, not implementation details
- MUST = always follow
- DEFAULT = choose first unless there is a clear reason
- EXCEPTION = allow only when explicitly justified

---

## 1. Stack & Structure

- Stack: PocketBase (JSVM), PocketPages (SSR, file routing), EJS, HTMX, Alpine.js, UnoCSS (Tailwind v3 compatible)
- Service root: `apps/<service>/*`
- `pb_hooks/pages` = routing root
- `apps/<service>/pb_hooks/pages/+config.js` = service plugin/config entry
- `apps/<service>/pocketpages-globals.d.ts` = editor globals/plugin helper typing
- `(site)` = full pages with layout
- `xapi/*` = no-layout interaction
- `api/*` = data/API
- `_private/*` = internal partials, services, utils, modules

---

## 2. Shared Packages

- DEFAULT: Before adding AI or OneSignal logic, check and reuse existing packages under `packages/ai` and `packages/onesignal`.
- DEFAULT: For TTL cache on PocketBase `$app.store()` or PocketPages `store()`, use `packages/utils/store-cache.js` before adding ad hoc cache indexes or expiration logic.
- MUST: Use `packages/utils/dateutil.js` for date parsing, formatting, comparison, day ranges, and timezone handling.
- MUST: For PocketBase `date` fields with date-only values, use `dateutil.toDateOnlyIso(...)`; for date search, prefer `dateutil.startOfDay(...)` / `dateutil.endOfDay(...)` ranges.

---

## 3. Routing & Params

- filename = URL meaning
- `index.ejs` = directory default route
- prefer explicit names like `new.ejs`, `edit.ejs`, `[slug].ejs`
- use `[param]` only when static path is insufficient
- `params` = route params only
- query = `request.url.query`
- EXCEPTION: `params.__flash` only

---

## 4. Page / Middleware / Load

- `+load.js` runs once at page level
- `+middleware.js` runs hierarchically
- DEFAULT: page-specific data or meta -> page `<script server>`
- DEFAULT: shared logic across child routes -> `+middleware.js`
- DEFAULT: avoid `+load.js` unless structure clearly requires it
- MUST: page-only logic stays in page
- MUST: multi-route shared logic goes to middleware
- MUST: middleware early return sends response explicitly

---

## 5. Rendering

- shared UI -> `+layout.ejs`
- page-specific UI -> page file
- layout sees leaf-page data only
- template = render only
- avoid heavy logic or formatting logic in template
- allowed: simple `if`, simple loop, short expression
- DEFAULT: simple mutations use POST -> redirect -> message -> GET render
- DEFAULT: use HTMX only for partial updates with clear UX benefit, such as preserving scroll, focus, open panel, or list position
- HTMX returns partial HTML or redirect only, never layout HTML
- DEFAULT: reuse shared markup via `_private` partial

---

## 6. \_private & Resolve

- `_private` is internal only; use it for partials, services, utils, and internal modules, never route-exposed
- partials take minimal props only
- DO NOT pass full context such as `request`, `response`, `api`, `resolve`, full `params`, full `data`
- `_private` modules use CommonJS only
- plain `_private` `require()` is fine for fixed wiring
- choose request-context dependencies at entry level, then inject them
- use `_private`-relative names like `resolve('moduleName')`; do not use `resolve('/_private/...')`
- do not chain or default to `resolve()` inside `_private`

---

## 7. Redirect, Roles & Logging

- use `redirect('/path', { status, message })`
- use redirect option `message`, not `flash`
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

## 8. PocketBase / JSVM

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

## 9. Frontend

- Alpine is UI helper only
- no business logic or complex state
- use for toggle, modal, tab, and short local UI state
- Datastar is opt-in only for pages where server-driven patches or realtime state clearly reduce complexity
- Do not share the same UI state between Alpine and Datastar on one page
- UnoCSS classes must be complete literals in scanned files

---

## 10. AI Workflow & Structure Analysis

- identify layer first: PocketPages or PocketBase
- single-file, low-impact change -> open file directly
- multi-file or unclear impact -> run `./task.sh index <service>`
- service change must end with running `./task.sh lint <service>` from **Windows Git Bash**

Use index sections when relevant:

- `impactByFile` first when impact is unclear
- `partials` before `_private/*.ejs` partial change
- `resolveGraph` before `_private/*.js` module change
- `routeLinks` before route, redirect, `href`, `action`, `hx-*` change
- `schemaUsage` before collection or field change
- `routes` when route list or path matters

---

## 11. Priority

1. `.docs/pocketpages/*`
2. `.docs/pocketbase/*`
3. `pb_schema.json`
4. `pb_data/types.d.ts`
5. `apps/<service>/types.d.ts`

If rules conflict, this file overrides defaults for this repo.
If docs are ambiguous or seem to conflict, also check existing local service patterns and keep changes consistent.
