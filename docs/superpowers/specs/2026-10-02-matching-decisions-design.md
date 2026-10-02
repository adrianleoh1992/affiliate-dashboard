# Matching and trustworthy decisions

## Intent and authorization

The owner has authorized implementation of easier manual ad/tag matching and the related decision-quality improvements identified by local tests of five accounts, delegating routine design choices. This builds on the accepted audit rather than restarting discovery. The existing isolated feature checkout and draft PR #5 will carry the work; publishing raw source CSVs and merging/deploying production are outside this implementation.

## User flow

Choose account → upload reports → inspect detected dates and source readiness → resolve a spend-sorted matching queue → review decisions with their basis → save new data or explicitly replace a complete report period. Mappings survive reload within their account and are editable/removable. Matching must not require retyping known ad names or tags.

## Required behavior

1. A searchable matching queue defaults to unresolved ads, shows spend and existing/candidate tags, and supports arbitrary observed tags including click-only tags. Save/change/remove is one consistent immediate workflow with a before/after indication and clear scope (individual identity or shared name). Escape source labels. Close/clear on reset and account switch; reject stale actions. Provide a portable, validated, account-scoped mapping export/import.
2. Engine owns readiness. Retain status enum `scale|pantau|stop|organik|evaluasi`; blocked results use evaluasi plus specific labels/reasons. Missing/partial Meta leaves costs, net, ROAS and related money ratios unavailable, while commission/orders remain usable. An explicit no-Meta declaration can establish zero spend for its account/period. Zero matched spend means 'Tanpa biaya Meta terdeteksi', not verified organic acquisition. Unresolved paid mappings block recommendations for those units and implicated candidate tags; they also prevent unsupported organic expansion suggestions.
3. Preserve order-date financial reporting. Evaluate mature production cohorts using affiliate click timestamps, a documented observation cutoff, and lag. Do not fall back to order time when click time is missing. Commissions from before the selected click window must not fund its cohort ROAS. Imported orders beyond the selected spending window may inform its cohorts only through the explicit observation cutoff. Keep daily accounting, product totals, and settlement semantics intact.
4. Preserve individual ad identities when available: Ad ID, otherwise exact name + creation date, otherwise exact name. Expose identity separately from visible name. Identity-specific mappings precede legacy normalized-name mappings, and legacy mappings remain visibly name-scoped. Retain legitimate dimension rows; never dedupe by name/date alone.
5. Atomic save and period replacement. Default append/dedupe stays safe for identical imports. An explicit replacement preview identifies account, source kinds, date bounds, and old/new totals. A complete replacement removes absent rows/dates within the selected range, preserves other ranges/accounts, and rolls back on any write failure. Do not merge revised statuses by guessing order/item identity.
6. Readiness reaches tables, actions, snapshots, CSV/JSON/PDF, and stored summaries. Missing costs must not become Rp0 through formatting/coercion. Explain click differences neutrally; do not infer lost clicks or wasted spend from cross-platform totals.
7. Import feedback prioritizes rejected/review files and detected periods, groups optional warnings, and releases no-longer-needed diagnostic row references. Persistent daily summaries remain explicitly aggregate summaries; do not synthesize raw transactions to reconstruct unsupported analysis. Full historical analytical reconstruction and monthly-only analysis are subsequent product capabilities, not prerequisites for this release.

## Shared interfaces

- `data.sourceState`: optional `{affiliate,ads,clicks}` values `loaded|partial|missing|none` (none only ads, user declaration). App supplies states from import outcomes; absence falls back to observed rows for compatibility. `data.coverage[kind]` may provide `{start,end,confirmed}` when the user explicitly confirms a complete selected report range. Dense observed dates can establish observed range coverage, not proof of the originating system's complete export. Missing dates require a coverage confirmation before dependent conclusions.
- `result.readiness`: `{costsKnown, decisionReady, basis:'click-cohort', unresolvedUnits, unresolvedSpend, reasons, ...}`. Each tag/ad exposes `decisionReady` and `blockers`. Unknown derived financial properties are null. Observed source spend remains available in readiness diagnostics if financial totals are withheld.
- `Engine.adIdentity(row)` → `{adKey,mapKey,adId,adName,createdAt}`. `adKey` uses `id:<id>`, `created:<JSON name/date pair>`, or `name:<exact name>`; `mapKey` is `@` + adKey. Existing normalized-name map keys remain supported.
- `DailyStore.saveBatch(accountId, items, {replacementRanges})` atomically handles all items. Each item contains `kind`, `records`, `rawRows`, and existing saveDaily metadata. Replacement ranges are per-kind explicit `{kind,start,end}`. Store owner may refine item shape but must document it before integration.
- Daily ad records retain `ad_unit` display name and optional `ad_key`, `ad_id`, `created_at`; old records/backups remain readable.

## Validation

Synthetic regressions cover stale-account mapping, no-candidate selection, persistence/edit/remove, unknown-cost exports, unmatched/ambiguous action suppression, click H+0/H+3 and cross-month cohorts, missing click timestamps, duplicate names with independent identities, corrected status replacement, adjacent-range preservation and rollback. Existing full `npm test` and `npm run build` must pass. Private CSVs remain outside Git; local smoke uses all five accounts and revised Nadya. Inspect desktop and narrow mobile matching UI and keyboard operation. Review branch independently before updating the draft PR.
