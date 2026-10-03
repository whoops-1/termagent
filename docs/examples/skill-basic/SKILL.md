---
name: release-review
description: Review a release for versioning, verification, and rollback readiness.
version: 1.0.0
trust: community
license: MIT
category: release
tags:
  - release
  - verification
---

# Release Review

## Use this skill when
- The user asks for a release readiness review.

## Do NOT use this skill when
- The task is unrelated to preparing or validating a release.

## Procedure
1. Inspect the version, changelog, build, and verification commands.
2. Check that the artifact can be reproduced and restored safely.
3. Report blockers and evidence.

## Examples
- In scope: review a release checklist before publishing.
- Out of scope: design a product feature unrelated to release work.

## Self-check before responding
- Every blocker is tied to evidence.
- Verification and rollback steps are explicit.
