# Matching and decision quality implementation plan

> For agentic workers: use Superpowers subagent-driven-development for independent owners, integrated and reviewed in this session. User delegated routine execution decisions; continue through reversible implementation and testing.

**Goal:** Make manual matching easy and prevent incomplete or misattributed data from producing misleading financial/action claims.

**Architecture:** Extend the existing pure Engine, account-scoped browser UI, and IndexedDB store. Keep accounting separate from click-cohort decisions and source identity separate from display names.

**Tech stack:** Plain JavaScript, existing Papa Parse/Chart.js/jsPDF, IndexedDB, Node assertions and Playwright. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-matching-decisions-design.md`.

## Global constraints

- Keep personal CSVs and derived customer rows out of Git and public artifacts.
- Keep old maps, existing account data, and v2 backups compatible.
- Use existing statuses; blocked rows are evaluasi with explanatory labels.
- No fabricated raw rows from saved aggregates. No average daily allocation of monthly costs.
- Retain unrelated changes and coordinate exclusive file ownership.

## Review focus

- Old-account UI events cannot mutate the newly selected account (UI tests).
- A revised completed order replaces pending status without double-counting; failures restore all old data (store tests).
- Missing-cost nulls survive snapshots/trends/PDF/CSV without becoming zeros (engine/export tests).
- Same-name identities can map independently, while old name-scoped rules retain their stated scope (engine/UI/storage tests).
- Orders after the spend window and invalid/missing click times cannot silently contaminate cohort decisions (engine tests).

## Task 1 — Engine readiness, cohorts and identity

**Owner/files:** Engine worker: `engine.js`, engine test files. No app/storage/export file edits.

**Interfaces:** Produces spec's sourceState/coverage/readiness and adIdentity contracts for UI/storage/export consumers.

- [ ] Add failing behavioral cases for missing vs explicitly absent Meta, unresolved/ambiguous decisions, click H+3 cohort versus order-date accounting, missing/pre-window clicks, identity-scoped mapping and null snapshot trends.
- [ ] Run focused tests and record expected failures.
- [ ] Implement readiness, cohort buckets, observed tags and identity keys without changing financial accounting definitions.
- [ ] Run engine tests; report interface details and intentional compatibility changes to other owners.

## Task 2 — Manual matching and source-ready UI

**Owner/files:** UI worker: `app.js`, `index.html`, `styles.css`, new `matching-ui.test.js`, appropriate experience/browser tests if needed. No engine/daily/export edits.

**Interfaces:** Consumes Engine identity/readiness. Supplies sourceState/coverage from imports and explicit period declarations. Exposes an account-scoped mapping/session hook if storage needs settings.

- [ ] Add failing browser tests for arbitrary tag selection with no suggestion, edit/remove persistence, stale-account action rejection, unknown-cost display and mapping export/import validation.
- [ ] Implement spend-sorted searchable queue, known-tag picker, immediate-save workflow, clear scope and after-change feedback.
- [ ] Implement readiness controls and unavailable financial formatting; keep snapshot validation compatible with nulls.
- [ ] Improve grouped import feedback and release accepted diagnostic row references while retaining required FILES rows.
- [ ] Run focused browser tests and inspect desktop/mobile keyboard behavior.

## Task 3 — Atomic report replacement and saved summaries

**Owner/files:** Store worker: `daily-store.js`, `daily-agg.js`, `daily-layer.js`, daily tests and `DAILY-STORE.md`.

**Interfaces:** Produces `saveBatch`; consumes Engine.adIdentity where available. Keep ordinary saveDaily compatible.

- [ ] Add failing tests for corrected status replacement, complete-range removal, adjacent ranges/accounts, overlapping input files, duplicate reimport, and rollback after deletion/partial insert.
- [ ] Implement batch transactions and explicit replacement preview/choice using full incoming rows.
- [ ] Preserve ad identity fields with compatible validation/backup behavior and account-scoped settings where needed.
- [ ] Gate stored financial summaries on source presence/range knowledge, with honest aggregate-only capability labels.
- [ ] Run daily regression/parity tests and a focused replacement UI flow.

## Task 4 — Export and integration consistency

**Owner/files:** Root: `export-data.js`, `pdf-export.js`, export/PDF tests, `package.json`, build scripts if needed; integration edits only after the owner has finished.

- [ ] Reproduce unknown-cost serialization/formatting and decision-blocker omissions with meaningful fixtures.
- [ ] Preserve nulls and explanatory basis in exports/PDF; remove causal lost/wasted-click wording.
- [ ] Wire new focused tests into project command and run full suite/build.
- [ ] Run private-account import/readiness/mapping smokes without publishing fixtures; compare accounting totals with independent references.
- [ ] Independently review code and visual/keyboard flows; fix findings; rerun affected checks.
- [ ] Commit scoped changes and update the existing draft PR title/body and attach it. Do not merge or deploy production.
