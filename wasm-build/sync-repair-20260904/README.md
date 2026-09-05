# Sync runtime repair, 2026-09-04

This directory preserves the source of the deployed August 13 runtime plus the
operation-local key-image index repair. The server's standalone Salvium-WASM
checkout was older than production despite having the same runtime version.
Building that checkout would discard subsequent balance correctness repairs.

Verified original production inputs:

- SIMD build image: `sha256:d3cf3351dc79b4d7291677db7a54cacb08c26ffbc92577fbe9f37c0e41b472a5`
- Baseline build image: `sha256:3046e4d6163029d26fda72067652f15ae8282fdf3feb57234acd2f3c36efac22`
- Original SIMD WASM: `63eccc04370ed8a0ccb8bc9ed4030377db8446a4023c542912c9fd3c2ceabc91`
- Original baseline WASM: `6e938cb2528acc499d9f22a282e4a7659a15e2f82ace7590d54d9d681422e096`
- Core checkout: `162347f3def9317aab4a61bc8cbaae16623069fd`, with the recovered
  `deployed-core.patch` applied. That patch records existing production changes;
  the sync repair does not change the core wallet implementation.

`src/` preserves all binding/stub sources from the verified build image, with
only `wasm_bindings.cpp` changed by this repair. `sync-lookup.patch` isolates
those changes from the exact production binding source. `link.sh` preserves
its link command. `rebuild.sh` builds both variants from their pinned images.
The images supply the original compiler, libraries and unchanged compiled core.

The index exists only during outgoing reconciliation or history serialization.
It retains the original map lookup priority, candidate order, validated effective
key-image checks, partial/unknown-image rules, and spend-authority checks. It
is never reused across wallet mutations. Balances, amount decoding, normalization,
spent coverage, and cryptographic validation are unchanged.

Validation before release:

- Real QA fixture: 67 outputs and 57 canonical transactions. Both runtime variants
  exactly match production snapshot, history, reconciliation and flush JSON.
- Instrumented test build: 2,388 differential lookup comparisons, up to 5,360
  outputs; empty/stale maps, out-of-range indices, collisions, unknown/partial
  images, watch-only mode and spend-authority requirements. All passed. The
  instrumented method is excluded from the shipped runtime.
- Wallet cache imports succeeded for both release variants.

No wallet credentials or private fixtures belong in this directory.

The final 5.54.13 runtime also tests an injected index-allocation failure. It
propagates rather than publishing a partial index. `lookup-equivalence-test.patch`
adds this failure injection and the differential method to a test-only build;
do not apply it to release artifacts.

## Return-origin repair, 5.54.15

Cold cache loading also performs repeated historical return-origin searches.
`return-origin-index.patch` adds indexes scoped to one metadata repair pass:
confirmed-output return candidates, TRANSFER recovered spend keys, and transaction
public keys used by origin hints. Live ROI/metadata remains the first lookup;
original candidate ordering and all derivation/opening checks are retained.
The repair loop only mutates PROTOCOL/RETURN metadata and key images. It does not
mutate the transaction/output view, TRANSFER recovered spend keys, or public-key
transfer index consumed by these indexes. No index survives that pass.

`origin-equivalence-test.patch` adds the exact previous candidate implementation
and test-only bindings. It passed 1,152 comparisons with up to 5,360 transfer
entries, including duplicate candidates and both indexed/default transaction
public keys, with the wallet snapshot unchanged. A separate synthetic history
benchmark copied the canonical fixture's confirmed transactions to 2,960 entries;
32 identical lookup queries took 11,638.8 ms with the original search and 346.219 ms
with the indexed search, including index construction. This is an isolated
server benchmark, not a phone startup measurement. No synthetic entry is used
as evidence of balance correctness.

Both production runtime variants exactly match 5.54.13 state/history/reconcile/
flush JSON on the original 67-output, 57-canonical-transaction fixture. Stage
measurements added in 5.54.14 remain so actual phone startup can be profiled.
Do not apply the test patch to release artifacts.
