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
 * Every option `marklife-core` passes must be forwarded. `windowBits`
 * in particular is load-bearing, not decorative — see the note in
 * `marklife-core/src/zlib.ts` for why the YXQ stream needs a 1 KiB
 * window. Dropping it yields a 32 KiB-window stream the S2 cannot
 * inflate: the job is accepted, the paper feeds, nothing prints.
 *
 * `pako` is a real dependency of `marklife-core` (declared there as a
 * devDependency alongside `@types/pako`) — this app adds it as its own
 * devDependency so the alias resolves during the harness build.
 */
import { deflate, inflate } from 'pako';

/** The `node:zlib` options `marklife-core` passes. pako honours all but `chunkSize`. */
interface ZlibOptions {
  level?: number;
  chunkSize?: number;
  windowBits?: number;
}

/**
 * `node:zlib`-shaped `deflateSync` — zlib container, synchronous.
 * `chunkSize` is accepted for signature parity and ignored (pako
 * streams internally; the output bytes are identical).
 */
export function deflateSync(input: Uint8Array, options?: ZlibOptions): Uint8Array {
  const opts: { level?: 0; windowBits?: number } = {};
  if (options?.level !== undefined) opts.level = options.level as 0;
  if (options?.windowBits !== undefined) opts.windowBits = options.windowBits;
  return deflate(input, opts);
}

/** `node:zlib`-shaped `inflateSync` — zlib container, synchronous. */
export function inflateSync(input: Uint8Array): Uint8Array {
  return inflate(input);
}
