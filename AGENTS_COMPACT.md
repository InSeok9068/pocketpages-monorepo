# AGENTS.md (Lite+)

## 0. Core Principles

- Prefer explicit structure over abstraction
- File path must explain flow
- Keep logic close to usage
- SSR-first, predictable over SPA complexity

---

## 1. Stack

- PocketBase (JSVM)
- PocketPages (SSR, file routing)
- EJS
- HTMX (partial updates)
- Alpine.js (light UI)
- UnoCSS (Tailwind v3 compatible)

---

## 2. Project Structure

- apps/<service>/*
- pb_hooks/pages = routing root
- (site) = layout pages
- api/* = API
- xapi/* = no-layout interaction
- _private/* = internal (partial, service, util)

---

## 3. Routing

- filename = URL meaning
- index.ejs = default route
- use explicit names (new/edit/[slug])
- [param] only if static path insufficient

---

## 4. Params & Query

- params = route params only
- query = request.url.query
- exception: params.__flash only

---

## 5. Page / Middleware / Load

- +load.js runs once (page-level)
- +middleware.js runs hierarchically

### Rules
- page-specific data → page `<script server>`
- shared logic → middleware
- avoid +load unless structure requires it

### Selection Rule (IMPORTANT)
- page-only logic → page
- multi-route shared logic → middleware
- DO NOT move shared logic into page

### Middleware
- must handle early return explicitly

---

## 6. Layout

- shared UI → +layout.ejs
- page UI → page
- layout sees leaf data only

---

## 7. EJS

- render only
- NO heavy logic
- NO formatting logic

### Allowed
- simple if / loop / short expression

---

## 8. _private

- internal only (no route exposure)

### Partial
- pass minimal props only
- DO NOT pass:
  - request
  - response
  - api
  - resolve
  - full params
  - full data

### Module
- CommonJS only
- no implicit resolve inside module
- dependencies must be injected

### Resolve (CRITICAL)
- resolve() = entry-level only
- DO NOT use in _private modules
- DO NOT use '/_private/...' path
- resolve('moduleName') only

---

## 9. HTMX

- return partial HTML only (no layout)

### Structure
- (site) → full page
- xapi → interaction
- api → data

- reuse markup via _private partial

---

## 10. Redirect & Flash

- use:
  - redirect('/path', { message })

- DO NOT build query manually

- read:
  - params.__flash

### Logging (IMPORTANT)
- log BEFORE redirect:
  - dbg(status, redirectTo, message)

---

## 11. PocketBase / JSVM

- ES6 only
- sync only
- CommonJS only

### Source of truth
- pb_data/types.d.ts
- pb_schema.json

---

## 12. Record Access

- use record.get('field')
- DO NOT use record.field

---

## 13. Roles

- _private/roles/*

### Responsibility
- domain logic ONLY

### Rules
- NO DB write
- NO redirect
- NO response
- NO hidden DB query

- input = prepared data only

---

## 14. Logging

- dbg = debug
- info = normal
- warn = expected issue
- error = failure

### Log at
- entry
- branch
- DB access
- mutation
- error

---

## 15. Migration

- use actual collection.id
- no hardcoded relation id
- self relation = post-create update

---

## 16. Frontend

### Alpine
- UI helper only
- NO business logic
- NO complex state

### Use for
- toggle / modal / tab

---

## 17. Code Style

- explicit > abstraction
- short trace path
- avoid unnecessary helpers

### Types (IMPORTANT)
- define in apps/<service>/types.d.ts
- use types.* directly
- DO NOT use local typedef bridge

### JSDoc (IMPORTANT)
- required for shared functions
- short Korean description
- DO NOT describe implementation

---

## 18. AI Workflow

### Before
- identify layer (PocketPages vs PB)
- check structure:
  - ./task.sh index <service>

### After
- run:
  - ./task.sh lint <service>

---

## 19. Structure Analysis

Use when multi-file change:

- routes
- partials
- resolveGraph
- routeLinks
- schemaUsage
- impactByFile

---

## 20. Checklist

### Before
- correct layer?
- correct responsibility split?
- correct routing?
- schema verified?

### After
- params vs query correct?
- partial minimal props?
- HTMX returns partial only?
- redirect uses flash?
- record.get used?
- lint passed?

---

## 21. Priority

1. .docs/pocketpages/*
2. .docs/pocketbase/*
3. pb_schema.json / types.d.ts

AGENTS.md overrides defaults when conflict
