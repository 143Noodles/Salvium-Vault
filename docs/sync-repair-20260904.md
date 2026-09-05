# Incremental sync and warm-unlock repair

## Reproduced failures

A foreground Android wallet with 5,053 outputs repeatedly needed 20–21 seconds
for a one-block catch-up with no new outputs. Spent checking finished in about
1.2 seconds; outgoing reconciliation then took about 8.5 seconds, followed by
about 10.5 seconds publishing wallet state. Repeated effective key-image fallback
walks in reconciliation and history serialization made this depend on the size
of the entire wallet history.

Locking also cleared the loaded wallet's balance trust verdict. Warm unlock kept
the loaded engine but never restored that verdict. Successful no-op scans could
therefore continue indefinitely while the dashboard displayed a blank balance.

## Changes

- Native reconciliation and history use an operation-local reverse index of
  validated effective key images, preserving the original fallback semantics.
  Every candidate still receives the same ownership and authority checks.
- Remove duplicate complete mirror publication after hydration's flush, which
  already publishes the changed native state.
- Keep the loaded wallet's validity verdict across authentication lock, hide
  balances while locked, and preserve an active scanner across warm unlock.
- Classify explicit background catch-ups from the native height as incremental;
  restore and historical repair requests retain their previous safety policies.
- Preserve active scans across background suspension. Worker execution budgets
  count foreground time; scanner liveness also excludes offline time.
- Compute chunk progress from scheduled work, and reserve progress for final
  reconciliation and publication instead of reaching 100% during spent checks.
- Update Browserslist and its supporting data packages to clear the release
  audit's high-severity build dependency finding.

## Verification

Both SIMD and baseline release runtimes matched production snapshot, history,
reconciliation and flush JSON exactly on a real QA fixture (67 outputs, 57
canonical transactions). A separate instrumented native build passed 2,388
original-versus-indexed lookup comparisons with up to 5,360 outputs, including
stale maps, duplicates, unknown/partial images, and watch-only authority checks.
The test-only method is absent from the shipped runtime.

A browser canary completed a real 40,794-block catch-up, discovered two additional
outputs, committed and persisted successfully, and displayed its balance with
no browser errors. Repeated warm unlock restored the unchanged balance in
175–199 ms on the server's headless browser. This is not a phone speed claim.
Regression tests cover warm unlock during active sync, retained integrity
failures, background freezes, worker export completion after suspension, and
single-block progress bounds.

The exact deployed native sources were recovered from verified August 13 build
images because the separate server WASM checkout was stale despite its version
string matching production. Source and build provenance are preserved under
`wasm-build/sync-repair-20260904/`.

## Remaining investigation

Production telemetry also contained one historical canonical hydration candidate
rejected as `parse_failed`. Only a hash prefix was available in client events;
it was not reproduced on the QA corpus. This repair does not suppress or bypass
that rejection. Additional optimization of derived-state repair passes must
preserve cryptographic ownership and spendability validation.
