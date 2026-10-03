# Phase 2: Context intelligence

Phase 2 gives TermAgent a structural view of the repository and a hard context-budget layer.
The implementation follows the current TermAgent repository-map model: enumerate relevant files, cache per-file analysis, extract symbols for TypeScript/JavaScript/Python, build a weighted directed reference graph, and rank structurally important files with PageRank. It also follows TermAgent's compaction boundary: estimate the complete model-visible request, reserve output headroom, keep a recent tail, and compact older context without mutating the durable transcript.

TermAgent deliberately adapts those concepts to a Node-only ARMv7/Termux runtime. The analyzer is regex-based, the cache is JSON, and compaction summaries are generated locally and deterministically rather than by a second provider call.

## Runtime pieces

- the relevant TermAgent subsystem: file discovery, cache, analysis, graph construction, structural ranking, rendering.
- the relevant TermAgent subsystem: TypeScript/JavaScript/Python symbol/import/reference extraction.
- the relevant TermAgent subsystem: lexical/content/symbol/graph retrieval and output bounds.
- the relevant TermAgent subsystem: conservative Unicode-aware request token estimation and budget math.
- the relevant TermAgent subsystem: active-context projection and rolling summaries.
- the relevant TermAgent subsystem: pre-provider request budget enforcement.

## User surfaces

`/repomap` renders the structural map without contacting a model. The `repo_map` tool exposes the same map to agents with token and focus limits.

## Resource policy

The cache lives outside the repository and uses atomic writes. High-noise directories are excluded. Analysis arrays are capped per file. Retrieval and rendering have file, byte, and token ceilings. Exact provider tokenizers are intentionally deferred so the baseline remains dependency-free on ARMv7.
