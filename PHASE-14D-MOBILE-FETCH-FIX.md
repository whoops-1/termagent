# Phase 14D Mobile Browser Fetch Binding Fix

## Symptom

On Android/Brave, the Web View reported:

`Failed to execute 'fetch' on 'Window': Illegal invocation`

## Root cause

`TermAgentClient` stored the browser's native `fetch` function without its global receiver (`this.http = options.fetch || fetch`) and invoked it later as an instance property. Some browser implementations require `Window`/global receiver binding for native fetch, so the detached invocation throws before an HTTP request reaches the runtime.

## Fix

The default transport now uses `globalThis.fetch.bind(globalThis)`. An explicitly supplied fetch adapter remains untouched, preserving dependency injection for tests and alternate transports.

## Verification

- TypeScript build: PASS
- Phase 14B event stream tests: PASS
- Phase 14C HTTP/client tests: PASS
- Phase 14D Web View tests: PASS
- Combined focused suite: 14/14 PASS
- Distribution verification: PASS
- `npm pack --dry-run`: PASS

The focused suite verifies the default fetch function receives `globalThis` as its receiver. Physical Android confirmation still requires reloading the updated source/runtime on the device.
