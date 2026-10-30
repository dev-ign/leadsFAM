---
name: smart-test-strategy
description: Apply cost-efficient, risk-based verification for LeadsFam code changes. Use when implementing, debugging, refactoring, or validating changes to avoid unnecessary test execution while preserving security-critical checks.
---

# Smart Test Strategy — LeadsFam

## Objective

Minimize unnecessary test executions, agent reasoning, tool output, and repeated validation while maintaining production-quality engineering.

## Implementation and test creation

- Choose the smallest correct implementation using existing patterns. Avoid speculative infrastructure, premature abstractions, unnecessary dependencies and file proliferation.
- Do not create tests or test files by default. First check existing coverage and prefer extending a relevant test.
- Add tests when they protect meaningful behavior, a business invariant, security/data boundaries or a realistic regression not already covered.
- Skip tests for static copy, styling, trivial wrappers and behavior-preserving refactors. Test quantity is not a quality measure.
- Instruction-only configuration changes use inspection-only validation, without tests, builds, migrations or database resets.

## Workflow

1. Inspect the change scope using git diff and relevant files.
2. Determine risk and affected functionality.
3. Choose the smallest meaningful verification set.
4. Group coherent implementation changes before testing.
5. Execute verification once after a logical unit of work.
6. Investigate failures before any retry.
7. Report executed checks and any omitted broader verification.

## Risk levels

- Level 0 — Documentation, comments, copy, styling: no test suite unless behavior is affected.
- Level 1 — Localized component or utility changes: relevant unit/component tests, if present.
- Level 2 — API and workflow logic: affected unit/integration tests.
- Level 3 — Authentication, authorization, tenant isolation, Supabase RLS, migrations, secrets, payments, and durable messaging: required focused security/database/integration checks.
- Level 4 — Cross-cutting architecture, release or major refactoring: broader regression testing or full suite where justified.

## Execution rules

- Never run the entire test suite by default.
- Never repeatedly rerun passing suites without relevant changes.
- Prefer a specific test file or package over workspace-wide test commands.
- Do not start database resets, Docker integration environments, end-to-end browsers, or broad security scans unless the change requires them.
- Avoid tests for untouched and unaffected packages unless dependency or contract changes justify them.
- Prefer concise test output; preserve failure diagnostics.
- Before running expensive tests, identify their purpose.
- Use one diagnostic retry only when justified; additional retries require a changed hypothesis or corrective action.
- Never alter or remove existing tests merely to reduce cost.
- Never modify CI security gates merely to make local verification faster.
- Never claim unexecuted checks passed.

## Security requirements

For sensitive changes, verify the relevant guarantees:

- Organization boundaries and tenant isolation
- Membership-based authorization and access control
- Supabase RLS and least-privilege grants
- Authentication/session integrity
- Database migration correctness
- Idempotency, concurrency and data consistency where affected
- Outbound provider operations and secrets where affected

Do not substitute superficial lint or compilation checks for security verification.

## Completion report

Keep routine summaries concise. Detailed reports require an explicit request or a substantial architectural/security reason. State:

- Risk level
- Checks executed and their results
- Checks intentionally skipped
- Remaining risks, if any

## Priority

Follow explicit user test instructions and applicable repository safety requirements. When constraints conflict, preserve security and clearly explain the minimum necessary verification.
