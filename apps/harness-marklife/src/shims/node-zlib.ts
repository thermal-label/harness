/**
 * Browser shim for the subset of `node:zlib` that `marklife-core`
 * imports.
 *
 * `marklife-core/src/zlib.ts` hard-imports `deflateSync` / `inflateSync`
 * from `node:zlib` for its `marklife-yxq` raster compressor. Those are
 * Node builtins — Vite externalises `node:zlib` for a browser bundle,
 * which leaves the named imports unresolved and fails the rollup
 * static-analysis pass. `marklife-core`'s own source comment states the
 * intent is "`pako` under the hood when bundled for the browser"; this
 * shim is exactly that, wired in via the `node:zlib` alias in
 * `vite.config.ts`.
 *
 * The P12 this harness targets is a `marklife-l11` engine — the L11
 * encoder sends an *uncompressed* raster, so `yxqZlibCompress` /
 * `yxqZlibDecompress` are never reached at runtime in this app. The
 * shim exists purely to satisfy the bundler's resolution of the
 * `marklife-core` barrel import; it is functionally correct
 * regardless, so a future YXQ-engine harness could reuse it.
 *
 * `pako` is a real dependency of `marklife-core` (declared there as a
 * devDependency alongside `@types/pako`) — this app adds it as its own
 * devDependency so the alias resolves during the harness build.
 */
import { deflate, inflate } from 'pako';

/** `level` is the only `node:zlib` option `marklife-core` passes that pako honours. */
interface ZlibOptions {
  level?: number;
  chunkSize?: number;
}

/**
 * `node:zlib`-shaped `deflateSync` — zlib container, synchronous.
 * `chunkSize` is accepted for signature parity and ignored (pako
 * streams internally; the output bytes are identical).
 */
export function deflateSync(input: Uint8Array, options?: ZlibOptions): Uint8Array {
  return deflate(input, options?.level !== undefined ? { level: options.level as 0 } : {});
}

/** `node:zlib`-shaped `inflateSync` — zlib container, synchronous. */
export function inflateSync(input: Uint8Array): Uint8Array {
  return inflate(input);
}
