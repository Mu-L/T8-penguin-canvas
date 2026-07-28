# Production evidence and acceptance

Use this reference for the evidence-heavy final production stages and real UI
acceptance gates. The main Skill remains the routing surface.

## Versioned edit decision list

For Story and script plans, expect a versioned `EDL` after the current
`CandidateReview`. Include only actual video candidates whose current review
is verified, every required hard gate passes, and explicit adoption has a
valid `t8-creative-adoption-receipt-v1`.

Bind every edit item to the exact CandidateReview evidence item, PromptPack
item, Storyboard frame, ShotList item, source shot, candidate, and Canvas node.
Order by current PromptPack ordinal. Never infer an edit from an image, Prompt,
completion flag, legacy acceptance, fuzzy match, or list position.

Persist bounded evidence identifiers, asset ID, and content hash, not copied
signed or remote result URLs. Treat duration as real only when the persisted
result carries `output.duration`, `metadata.duration`, or `outputDuration`.
Requested `duration` or `durationSec` is a hint only. After the first item
without real duration evidence, keep all following timeline timecodes unknown.

The initial EDL is a review draft: full source clips in PromptPack order, hard
cuts, and unassigned audio/subtitles. Confirm only after the exact
CandidateReview, or confirm the complete dependency chain in one batch.
Confirmation must not create an edit node, mutate a timeline, trim, call a
Provider, render, write the Canvas, or advance production.

## Evidence-backed QCReport

Bind `QCReport` to the exact EDL ID, version, content digest, Canvas revision,
and stable QC evidence digest. Consume only exact persisted
`t8-creator-artifact-verification-v1` receipts from the current Creator
Session. Planning must not scan files, download, call a Provider, decode, or
write the Canvas.

Check creative eligibility, result identity, real source duration, managed
file presence, SHA-256, magic/MIME, media kind, decode/index evidence,
resolution, indexed duration consistency, and Run/node/asset association.
Existing result metadata is not physical verification.

Use only `pass`, `fail`, and `unknown`. Pass only with exact proof, fail on
persisted contradiction, and keep absent evidence unknown. Retain bounded
asset IDs, hashes, verification digests, Run IDs, dimensions, durations, and
timestamps. Never copy signed URLs, local paths, credentials, or Provider
payloads.

Confirm only after the exact EDL or in one explicit dependency batch.
Confirmation freezes the report version and must not rescan, reverify,
download, call a Provider, generate, render, deliver, write the Canvas, or
advance production.

## Evidence-backed DeliveryManifest

Bind `DeliveryManifest` to the exact QCReport ID, version, content digest,
Canvas revision, and stable delivery evidence digest. Consume only completed
persisted `t8-creator-delivery-evidence-v1` receipts from the current Creator
Session. Planning must not package, scan folders, download, call a Provider,
render, deliver, or write the Canvas.

A deliverable is `included-and-verified` only when every QC check passes with
a real asset ID and 64-character SHA-256 hash, and one completed receipt for
the same Canvas revision proves that exact pair. Require valid package and
selection digests, consistent item/file/byte counts, and unique file pairs.
Extra files never satisfy missing or mismatched evidence.

Deliverable states are `blocked-by-qc`, `awaiting-current-delivery`, and
`included-and-verified`. Document states are `awaiting-qc-report`,
`blocked-by-qc`, `awaiting-current-delivery`,
`delivered-needs-license-review`, and `delivered-and-verified`. Release
readiness is `blocked`, `needs-license-review`, or `ready`. Unknown licensing
is never ready.

Retain only bounded package metadata, digests, scope, revisions, counts, bytes,
license summary, asset IDs, and hashes. Confirm only after the exact QCReport
or in one explicit dependency batch. Confirmation must not package, create or
overwrite files, download, call a Provider, render, publish, deliver, or write
the Canvas.

## Capability coverage acceptance

Regenerate the capability artifacts from their domain authorities, then require
one valid `t8-creative-capability-coverage-receipt-v1` in both backend and CLI
graphs. The receipt must expose five non-empty source digests, dynamically
recomputed node/runtime/capability/handler/operation inventories, `complete:
true`, and empty unknown-node, missing-handler, missing-risk,
missing-verification, and missing-compatibility-edge lists.

Mutation tests must prove that changing only a copied graph count or receipt,
removing a handler, risk boundary, verification contract, compatibility
section, or adding an unknown node is rejected by both backend and `zcanvas`.
Source assertions or checked-in generated JSON without recomputation do not
satisfy this gate.

## Development-browser acceptance

Open Creator Agent from the launcher above the minimap with Enter, submit one
natural-language request, and require one persistent session with exactly
three next suggestions. Reload must restore the same session without changing
Canvas revision or duplicating it.

Audit both the blank state and the durable completed response. The blank state
must expose exactly three stable, unique ideas. The completed response must
contain exactly one terminal event and one three-item SuggestionSet whose
`t8-creator-suggestion-invariant-receipt-v1` matches the response, nested set,
event, generated capability graph, and rendered DOM. Require unique IDs and
intents, zero unknown capability IDs, zero operation-contract drift, zero
enabled fake actions, and a visible reason for every disabled action. A source
assertion without the persisted receipt and real browser DOM does not satisfy
this gate.

Arm the shell observer before activating the launcher. Require
`t8-creator-agent-shell-readiness-receipt-v1` to measure the next painted frame
within 300ms; do not substitute React state or a source assertion. Arm the plan
observer before submit and require the first editable plan within 2000ms.
Benchmark at least 20 isolated non-stream local plans and use nearest-rank p95.
Every `t8-creator-agent-local-readiness-receipt-v1` must report zero Provider
calls, zero Canvas writes, and zero production-file writes, while the durable
Creator Session ledger remains allowed recovery evidence.

Require launcher `aria-controls`, arrow-key resize, Escape close with focus
restoration, and reduced-motion support. Exercise `tech-default` dark and
`pixel-candy` light at 1280x720 and 2560x1440 without covering the minimap.

Run `scripts/verify-creator-agent-p4-ui.cjs`. Its
`t8-creator-agent-p4-ui-acceptance-v1` report is development-browser evidence
only, not Electron, real Provider, artwork quality, screen reader/IME,
packaged-build, or release evidence.

## Development Electron acceptance

Use the project-pinned Electron binary, real main process, trusted preload,
in-process development backend, and Vite renderer. Require context isolation
and reject renderer access to Node `require` or `process`.

Submit one natural-language request, require the same persistent Creator
Session and exactly three suggestions, then navigate again and restore it
without graph mutation. Exercise Enter, arrow resize, Escape, and focus
restoration. The Agent Control IPC summary must expose no token, and the
updater stays disabled in development.

`T8PC_DEV_DATA_ROOT` may isolate QA data only in development, must be absolute,
and must not change the normal development default. Packaged mode ignores it.

Run `scripts/verify-creator-agent-p4-electron.cjs` and retain its
`t8-creator-agent-p4-electron-acceptance-v1` report and screenshot. Treat it as
development-Electron evidence only, not real Provider, artwork quality,
screen-reader/IME, network recovery, packaged-build, or release proof.
