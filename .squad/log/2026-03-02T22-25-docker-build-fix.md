# Docker Build Fix Session Log

**Timestamp:** 2026-03-02T22:25Z  
**Agent:** McManus (Frontend Dev)  
**Requested by:** Michael Brown  

## Summary

Fixed portal Docker build failure by excluding test files from TypeScript compilation in `portal/tsconfig.json`.

## Root Cause Analysis

`docker build -f Dockerfile.portal .` was failing during the `tsc && vite build` step. TypeScript was compiling test files under `src/**/__tests__/` and `src/**/*.test.tsx`, which reference `global` (a Node.js global unavailable in the browser DOM TS lib).

Locally `npm run build` succeeded because Vite handles transpilation itself. Docker exposes the failure because it runs a clean `tsc` pass first.

## Solution Implemented

Added `"exclude"` to `portal/tsconfig.json`:

```json
"exclude": ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx"]
```

This minimal, idiomatic fix aligns with standard Vite+React+Vitest conventions.

## Alternatives Rejected

1. **Add `@types/node`** — allows `global` compile, but incorrect for production browser code
2. **Add `tsconfig.test.json`** — adds unnecessary complexity; Vitest handles its own config
3. **Move test files outside `src/`** — invasive refactor of 635 existing tests

## Verification

- Docker build now passes
- 635 existing tests continue to pass via Vitest (uses own config)
- No impact to test setup, test files, or Vite config

## Status

✅ Complete. Portal Docker build is now functional.
