#!/usr/bin/env node
// Thin shim — invokes the TS entrypoint via tsx (registered as a Node loader)
// so the local-dev workflow stays one-step. This binary is not published; the
// canonical invocation is `pnpm --filter verify-cli verify ...` which calls
// the same code path with a friendlier name.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('tsx/esm', pathToFileURL('./'));
await import('../src/index.ts');
