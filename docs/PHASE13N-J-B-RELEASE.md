# Phase 13N-J-B — Android/ARMv7 release engineering

## Scope

This sub-phase adds a deterministic release path for TermAgent's Node/TypeScript
runtime while treating Android/ARMv7 as an explicit target class. TermAgent has
no native runtime addon, so the application artifact is JavaScript rather than a
native ARM binary. The release target is still recorded explicitly so installers
and CI cannot confuse Android ARMv7 with Linux ARMv7 or silently select an
unsupported architecture. Release archive generation uses deterministic GNU
tar metadata so identical source trees produce byte-stable target bundles.
The release design was compared with the recorded the release tooling and process
patterns at `the implementation behavior` the recorded behavior:

- prebuilt-first installation is attempted before source compilation;
- platform target detection is explicit and ordered;
- downloaded release archives are checksum-verified before extraction;
- source fallback validates the downloaded archive before building;
- Termux receives a prefix inside its writable application tree rather than a
  sudo-dependent global path;
- process/platform failures are reported as installer diagnostics rather than
  being hidden by a silent fallback.

TermAgent's recorded process runtime was also used for the preceding 13N-J-A
lifecycle work: process groups, detached POSIX children, and bounded forced
termination remain the runtime contract behind this release.

## Runtime target model

the relevant TermAgent subsystem defines stable release target IDs:

- `android-armv7` → `armeabi-v7a`, `armv7a-linux-androideabi`
- `android-arm64` → `arm64-v8a`, `aarch64-linux-android`
- `linux-armv7` → `armv7l`, `armv7-linux-gnueabihf`
- `linux-x64` → `x86_64`, `x86_64-unknown-linux-gnu`

These identifiers describe the runtime class and installer selection. They do
not imply that TermAgent itself contains target-specific native code.

## Release builder

`scripts/release.mjs` builds deterministic target-labeled bundles containing:

- `dist/`
- `docs/`
- package/release metadata
- `TARGET-INFO.json`

It also emits:

- `release-manifest.json`
- `SHA256SUMS`

All archive hashes are SHA-256 and are calculated after the archive is fully
written.

## Installer

`scripts/install.sh` uses this order:

```text
runtime check
     ↓
resolve target
     ↓
prebuilt target bundle
     ↓
checksum verification
     ↓
install under prefix

(no compatible prebuilt)
     ↓
source archive
     ↓
archive validation
     ↓
existing `tsc` OR recorded TypeScript via npm exec
     ↓
install compiled dist
```

The installer never extracts an unverified prebuilt archive. The source path is
also checked as a valid tar archive before extraction.

Termux defaults to `/data/data/com.termux/files/usr`, avoiding sudo. The target
can be overridden explicitly with `TERMAGENT_TARGET` for controlled testing.
The release repository/base URL is supplied with `TERMAGENT_REPO` or
`TERMAGENT_RELEASE_BASE_URL` rather than inventing a GitHub repository identity
inside the product.

## ARMv7 CI boundary

The release tooling is target-aware and can generate an ARMv7-labeled bundle on
any CI host. The JavaScript artifact itself is architecture-independent.
Physical Android ARMv7 smoke remains a device gate because an x86_64 CI runner
cannot establish Android/Bionic behavior merely by constructing a tarball.
Node.js currently publishes Linux ARMv7 binaries for the v22 line, which keeps
an ARMv7 JavaScript smoke environment available for non-Android validation. See Node.js v22 release listings for the current ARMv7 Linux artifacts.

## Verification

- `npm run build` — PASS.
- `tests/phase13n-j-release.test.mjs` — PASS (10/10).
- Combined 13N-J-A + 13N-I UI/process/provider/specialist/checkpoint gate — PASS (75/75).
- Generated production JavaScript `node --check` sweep — PASS (145 files).
- `npm pack --dry-run` — PASS.
- Release builder produced byte-stable target archives and SHA-256 manifests — PASS.
- Workflow YAML/static installer checks — PASS.
- `tests/phase13n-j-release.test.mjs` covers target mapping, forced target
  validation, archive creation, manifest/checksum generation, extracted bundle
  contents, and installer fallback contracts.
- No `node_modules/` directory is included in release bundles.
- Physical Termux/ARMv7 smoke remains unchecked until the artifact is exercised
  on the target device.

## Status

13N-J-B is complete at the release-tooling level when the focused tests/build
pass. The 13N-J phase is not fully closed until a real Termux/ARMv7 device run
is recorded.
