# Learning guide: Phase 00

## What you can run

The browser shows a responsive workspace preview with reusable components, two real navigation routes, themes, and honest empty states. One real data flow checks API connectivity. The Node server has health, startup validation, security headers, safe error responses, and structured logs. There is no login, lead database, or agent. That restraint lets us verify a small foundation before adding sensitive operations.

## Why these technologies fit

React lets a screen be composed from small parts: the shell owns navigation; a route owns page composition; HealthCard owns status presentation. TypeScript catches mismatches while editing. Vite provides browser development and production bundling. React Router owns client URL/navigation behavior without introducing a server framework. Tailwind expresses layout and states with consistent tokens. Our shadcn-derived Button uses Radix Slot when composing a link, preserving native semantics instead of nesting interactive controls.

Fastify owns HTTP routing, request lifecycle, security plugins and serialization. Pino produces structured JSON that operations tools can query by request ID. Zod validates runtime values such as an environment string or JSON response. A TypeScript type disappears when JavaScript runs; a Zod schema remains executable. Zod's native JSON Schema conversion feeds Fastify's validators without another adapter library.

Supabase is the planned identity and PostgreSQL platform. It is not connected in Phase 00. Its Auth layer will establish identity; our API will establish organization permission; database policies and constraints will reinforce data isolation. None of those jobs can be inferred from the other two.

pnpm links local packages and records external resolutions in one lockfile. Turborepo understands which package must build first. Vitest runs observable-behavior tests; Testing Library asks about elements the way users perceive them (roles, labels, and keyboard interactions).

## Follow one request

1. React renders HealthCard, which asks `useHealth` for state.
2. The hook starts an abortable request using `apiClient.getHealth()`.
3. The centralized client builds `/health` against the validated public API origin, sets a five-second timeout, and omits credentials.
4. Fastify validates the request and returns the shared health response shape.
5. The client parses the actual response with Zod. Invalid JSON, HTTP errors, network failures, and schema failures become safe client errors.
6. The hook updates loading/success/error state only if its request remains active.
7. The component renders a live status region or a retry action. No UI component needs to know how fetch works.

This separation makes testing easier: client tests control HTTP responses; hook/component tests substitute the client's method; API tests use Fastify injection. An integration can change its implementation without forcing every Card to know about it.

## Workspaces are contracts between teams

An app consumes a shared package's exported entry point. It cannot reach into another app or import server modules into a browser bundle. A useful analogy is a building with doors: exports are the doors; reaching through a neighboring wall is an unauthorized relative import. The boundary script checks both package declarations and import syntax. It also checks dependency cycles, which otherwise make ownership and build order harder to understand.

## Environment variables are inputs, not magic

The API reads its own optional `.env` through Node and validates values once at startup. An invalid port or CORS origin prevents startup, with field names rather than sensitive values in the error. The browser's `VITE_API_BASE_URL` is injected by Vite at development/build time. Anyone can inspect it in the bundle. Changing a deployment secret does not update a static browser bundle, and a `VITE_` prefix never makes a value private.

Local defaults work without copying environment files. If you customize the frontend port/origin, update the API's exact CORS allowlist. Production origins must be explicit and HTTPS. CORS controls browser access; a caller outside the browser can still send HTTP requests.

## Run and debug

Use the README setup commands. `pnpm dev` builds UI/contracts before starting watchers. Open the browser Network panel to inspect `/health` and its timing. Use React DevTools to inspect status state. API logs are JSON; match `x-request-id` from a response with the log's request identifier. Messages/stack traces are intentionally not echoed in public errors. Debug locally with breakpoints rather than expanding logs to include request headers or credentials.

For a server breakpoint, build packages first, then run from `apps/api`:

```sh
node --inspect=127.0.0.1:9229 --env-file-if-exists=.env --import tsx src/server.ts
```

Use your editor's Node inspector attachment on the local machine. Never expose the inspector publicly. Production execution uses compiled JavaScript through `pnpm --filter @leadops/api start` after a build.

If a managed sandbox reports EMFILE or prevents loopback listening, run development in your regular terminal or an authorized process with normal watcher/socket access. The application was verified with normal local permissions. If a port is occupied, stop the conflicting process you own or change explicit settings; Vite uses strictPort to avoid silently changing the URL.

## Understanding the security layers

Authentication is a checked identity. Authorization is a checked permission for a particular operation and organization. Isolation is a persistent guarantee that records and related records remain inside the authorized organization. A frontend organization dropdown expresses intent only. Future backend code must verify membership before constructing context, and future agents cannot choose that context.

An LLM can propose an action. An application tool must decide whether it is allowed. A durable workflow must remember the action and recover correctly after failure. These are separate engineering responsibilities; fluent model output is not authority or durable state.

## What we deliberately deferred

There are no empty worker/database/agent/integration/observability packages. No cloud project, credentials, real leads, scraping, outreach, billing, queue or workflow engine exists. TanStack Query and React Hook Form are deferred until cached server state or complex forms justify them. Playwright is reserved for future maintained end-to-end suites; real-browser checks in Phase 00 are manual/ad hoc verification, not a claimed automated E2E suite.

The next learning step is to implement one authenticated, organization-scoped vertical slice and prove its negative cases before storing customer data. That work requires Phase 01 approval.
