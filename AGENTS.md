# LeadsFam — Codex Project Instructions

## Engineering standards

Maintain production-quality, scalable, secure, and maintainable implementations. Preserve strict organization boundaries, Supabase RLS, authentication, authorization, and data integrity. Choose the smallest practical change, reuse existing patterns, and avoid speculative infrastructure, premature abstractions, unnecessary dependencies and file proliferation.

## Verification strategy

- Follow the smart-test-strategy skill at `.agents/skills/smart-test-strategy/SKILL.md` when deciding which tests to run.
- Default to the smallest relevant verification scope based on actual code changes and their risk.
- Do not run the complete test suite after every code change.
- Do not rerun passing tests unless relevant code or configuration has changed.
- Batch related edits before executing verification.
- Do not create tests by default. Extend existing tests first; add tests only for meaningful user behavior, business rules, security boundaries or realistic regressions not already covered.
- Do not add tests for static copy, styling, trivial wrappers or behavior-preserving refactors. Test count is not a quality metric.
- Instruction-only configuration changes use inspection-only validation; do not run tests, builds, migrations or database resets for them.
- For UI-only changes, use focused static checks or relevant component tests when justified.
- For API logic changes, run relevant unit or integration tests.
- For authentication, tenant isolation, Supabase RLS, migrations, and sensitive workflows, run appropriate focused security and database tests.
- Reserve comprehensive suites for explicit requests, release readiness, cross-cutting changes, or when focused checks are insufficient.
- Investigate failures before rerunning. Avoid repetitive test/fix loops.
- Keep verification output concise.
- Preserve CI security checks and never remove tests simply to reduce execution time.

## Completion reporting

Keep routine summaries concise: state the risk, changes, verification results, skipped checks and unresolved issues. Create detailed reports only when explicitly requested or justified by a substantial architectural or security decision. Never claim CI passed without actual results.
