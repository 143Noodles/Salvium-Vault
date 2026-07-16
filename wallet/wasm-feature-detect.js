(function installSalviumWasmFeatureDetector(root) {
    'use strict';

    // A 57-byte module containing both v128.const (SIMD) and memory.fill
    // (bulk-memory). The canonical wallet requires both features; validate()
    // parses without compiling or executing application code.
    var REQUIRED_FEATURE_PROBE = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2,
        1, 0, 5, 3, 1, 0, 1, 10, 32, 1, 30, 0, 253, 12, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 65,
        0, 65, 0, 65, 0, 252, 11, 0, 11
    ]);

    var VARIANT_FILES = {
        simd: Object.freeze({
            glue: 'SalviumWallet.js',
            wasm: 'SalviumWallet.wasm'
        }),
        baseline: Object.freeze({
            glue: 'SalviumWalletBaseline.js',
            wasm: 'SalviumWalletBaseline.wasm'
        })
    };

    function supportsCanonicalFeatures(webAssemblyApi) {
        try {
            var api = webAssemblyApi || root.WebAssembly;
            return !!api && typeof api.validate === 'function' && api.validate(REQUIRED_FEATURE_PROBE) === true;
        } catch (_) {
            return false;
        }
    }

    function selectVariant(webAssemblyApi) {
        return supportsCanonicalFeatures(webAssemblyApi) ? 'simd' : 'baseline';
    }

    function getAssetFilenames(variant) {
        return variant === 'simd' ? VARIANT_FILES.simd : VARIANT_FILES.baseline;
    }

    root.SalviumWasmFeatures = Object.freeze({
        supportsCanonicalFeatures: supportsCanonicalFeatures,
        selectVariant: selectVariant,
        getAssetFilenames: getAssetFilenames,
        getRequiredFeatureProbe: function () { return REQUIRED_FEATURE_PROBE.slice(); }
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
