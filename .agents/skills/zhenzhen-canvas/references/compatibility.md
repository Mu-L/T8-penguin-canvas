# Compatibility and installation

## Contents

1. Source layout
2. Version matrix
3. Codex discovery
4. Update integrity
5. Pairing lifecycle
6. Capability truth
7. Platform notes

## Source layout

- Skill source: `.agents/skills/zhenzhen-canvas`
- CLI source: `tools/zcanvas-cli`
- Control protocol: `t8-agent-control-v1`
- Canvas write protocol: `t8-canvas-patch-v1`

## Version matrix

The CLI must verify:

- Skill version
- CLI version
- desktop version
- control protocol
- CanvasPatch protocol
- node schema digest
- provider catalog digest
- manifest digest

Fail closed when the matrix is incompatible.

## Codex discovery

The project Skill location is directly discoverable by the existing T8 Codex CLI Agent and Codex workspace scanning.

The source checkout remains directly discoverable at
`<workspace>/.agents/skills/zhenzhen-canvas`. The current-user installer keeps
one verified master installation and atomically projects the same Skill to:

- user: `~/.agents/skills/zhenzhen-canvas`
- Codex home: `$CODEX_HOME/skills/zhenzhen-canvas`

Do not maintain divergent copies. Each installed copy carries an ownership
marker, master-install path, artifact version, and full Skill-tree checksum.
Upgrade, rollback, verification, and uninstall operate on the master and both
discovery copies together. An existing unowned directory is never overwritten.

When the current working directory belongs to a source checkout containing both
`.agents/skills/zhenzhen-canvas/SKILL.md` and `tools/zcanvas-cli/bin/zcanvas.cjs`,
that matched project pair is authoritative. It is resolved before any managed
user/global copy, so an older global Skill cannot shadow project development.

A managed discovery wrapper resolves the master installation from its ownership
marker before trying any command on `PATH`. On Windows it moves both wrapper and
child CLI execution outside the discovery directory and the swappable master root
before update, rollback, or uninstall, so the running process does not lock the
directory it must atomically replace.

## Update integrity

For an external immutable local bundle, use:

`zcanvas skill install --bundle <absolute-directory> --sha256 <whole-bundle-digest> --trust-policy <absolute-independent-policy.json>`

The first install requires an independent trust policy outside the bundle. Its
schema is `t8-zcanvas-bundle-trust-policy-v1` and it contains only previously
trusted Ed25519 public keys. The bundle carries `bundle-signature.json`; the
signature binds skill name/version, CLI version, and the whole-bundle digest.
A bundle cannot provide its own trust policy. After a verified install, future
updates inherit the installed trust anchors and do not need to re-supply the
policy unless the administrator is establishing a new installation.

The digest covers every CLI and Skill file. `manifest.json` must use safe,
path-free immutable version labels and the exact supported control, response,
and CanvasPatch protocols before any staging path is constructed. Installation
stages into a new directory, records every file hash and verified signer,
atomically swaps it into place, and keeps the previous verified install as
last-known-good. `zcanvas skill verify` rejects missing, changed, symlinked, or
untracked files. Use `zcanvas skill rollback` to atomically swap back.

If rollback activation or discovery synchronization fails after the master swap
begins, the installer must restore the exact original manifest/tree and preserve
the rollback candidate as last-known-good before returning failure.

The local installer verifies digest and Ed25519 bundle signatures, but it does
not claim that a production release key, public immutable download URL, SBOM,
or packaged fresh-machine release has been published. Those remain release
pipeline evidence and must be verified separately.

Never execute an unverified remote installer or rely on a permanently valid `latest` ZIP URL.

## Pairing lifecycle

A local Agent receives authority only after the creator verifies that the short
code shown by its terminal exactly matches the trusted desktop dialog, chooses
the final scope set, and explicitly approves. The issued session and local secure
store contain only those approved scopes.

Denial issues no session. Revocation terminates the server session and deletes the
matching local credential. Expired pending requests and sessions are not reported
as configured, and `auth complete` fails with a stable, creator-readable expiry
error. None of these states may be repaired by replaying an old pairing ID, poll
secret, or token; the Agent must start a fresh pairing.

Connection summaries and acceptance reports are non-secret receipts. They may
show approved scope labels and aggregate counts, but never tokens, poll secrets,
verification codes, pairing/session IDs, credentials, private paths, or canvas content.

When several local Agents are paired, the summary may show the union of their
approved scope labels so the creator can understand the desktop state. That union
is not an authorization object. Every request is authenticated against exactly one
access token and that session's own scopes. Revoking one token removes only its
server session and matching local credential; it never grants, revokes, or widens
another active session.

The trusted desktop pairing dialog is a keyboard-modal security boundary. Opening
the first pending request moves focus into the dialog. Tab and Shift+Tab wrap
inside it, Escape denies the active request without issuing a session, and closing
the final request restores the creator's previous focus. Confirmation and scope
selection remain explicit; focus movement, Enter, or Space never imply approval.

Development Desktop and Vite may use a dedicated dynamic loopback backend port
for isolated acceptance. The frontend proxy and Electron instance registry must
resolve to the same exact `http://127.0.0.1:<port>` origin. Development commands
must explicitly select the canonical `vite.config.ts`; a legacy generated
`vite.config.js` must never silently shadow it. Packaged Desktop ignores these
development-only port overrides. Real acceptance compares direct and proxied
Creator Agent and collaboration routes before pairing and fails on any 401, 404,
renderer exception, or failed network response.

The Creator Agent composer is not ready merely because the panel DOM exists.
Initial focus waits for the durable Creator Session and the shared capability
contract. Panel-shell readiness is a separate user-visible contract: measure the
launcher activation to the next painted shell frame against 300ms. Measure the
first local editable plan against p95 2000ms with the server monotonic receipt;
zero side effects means Provider, Canvas, and production-file writes, not the
append-only Creator Session recovery ledger. Chinese/Japanese/Korean IME
composition, native key code 229, and the
brief commit window immediately after `compositionend` must never submit a
message. The visual transcript uses `aria-live=off` while streaming; a separate
atomic status announces only the durable completed, failed, or stopped response.

“Stop reply” is a local response-stream operation, not a Provider cancellation.
The UI must say so before the creator clicks it. A successful stop persists exactly
one `assistant.response.stopped` terminal event, preserves any durable partial text,
restores the original request for editing, leaves the last completed plan and canvas
revision unchanged, and reports `remoteTasksAffected=0`. Image, video, audio,
browser, or other remote tasks continue until their exact task card uses a separate
supported cancellation action. Automated Chrome composition-event evidence is
useful but does not replace a manual OS IME
and screen-reader pass for a packaged release.

A versioned `AudioPlan` is compatible only when it binds the exact current
`ShotList` document ID, version ID, content digest, and inherited ScriptDoc
source digest. It may extract dialogue, voice-over, music, ambience, and SFX
only from explicit source labels and must preserve the original one-based line
for every cue. Ordinary prose is not deterministic audio evidence.

AudioPlan confirmation accepts text and layered-track structure only. It keeps
timing, loudness, Provider, model, assets, results, and generation unassigned,
uses `generationScope=none`, and cannot be treated as an audio task, Provider
submission, Canvas write, production completion, or release evidence.

A versioned `EDL` is compatible only when it binds the exact current
`CandidateReview` ID, version, content digest, Canvas revision, and stable
sequence evidence digest. Every item must come from an actual video candidate
with verified review, all required hard gates passed, a valid current
`t8-creative-adoption-receipt-v1`, and an available safe result reference.
Images, prompts, completion flags, legacy acceptance, fuzzy matching, and
unreviewed or failed candidates are not edit evidence.

The EDL may retain bounded candidate/asset/hash identifiers but must not copy a
signed or remote result URL out of CandidateReview. Output timing is proven
only by persisted `output.duration`, `metadata.duration`, or `outputDuration`.
Requested `duration` or `durationSec` is display-only and cannot create source
or timeline timecodes. Timing after the first unknown duration remains unknown.

EDL confirmation accepts only the ordered full-clip/hard-cut review draft. It
keeps audio, subtitles, trims, transitions, and final timing subject to creator
review, uses `generationScope=none`, and cannot be treated as a VideoEdit node,
timeline mutation, Provider call, render, Canvas write, production completion,
or release evidence.

A versioned `QCReport` is compatible only when it binds the exact current EDL
ID, version, content digest, Canvas revision, and stable QC evidence digest.
Planning may consume only exact persisted
`t8-creator-artifact-verification-v1` receipts already held by the Creator
Session. It must not scan files, download media, decode media, call a Provider,
or write to the Canvas.

Every EDL item must keep bounded pass/fail/unknown checks for creative
eligibility, result identity, persisted real source duration, managed-file
presence, SHA-256, magic/MIME, media kind, decode/index evidence, resolution,
indexed duration consistency, and Run/node/asset association. Missing receipts
or required receipt fields remain unknown; node metadata, requested duration,
completion flags, URLs, or thumbnails cannot make a physical check pass.

QCReport content may retain bounded asset IDs, hashes, verification digests,
Run IDs, dimensions, durations, and timestamps. It must not copy signed or
remote URLs, local paths, credentials, or Provider payloads. Confirmation
freezes only the exact evidence report and cannot be treated as a new scan,
reverification, download, generation, render, delivery, Canvas write,
production completion, or release evidence.

A versioned `DeliveryManifest` is compatible only when it binds the exact
current QCReport ID, version, content digest, Canvas revision, and stable
delivery evidence digest. Planning may consume only completed persisted
`t8-creator-delivery-evidence-v1` receipts already held by the Creator Session.
It must not package files, scan folders, download media, call a Provider,
render, deliver, publish, or write to the Canvas.

Every included deliverable requires all QC checks to pass with an actual asset
ID and 64-character SHA-256 hash. A matching receipt must use the same Canvas
revision, carry valid package and selection digests, keep internally consistent
item/file/byte counts, contain unique asset/hash file pairs, and cover every
exact QC asset/hash pair. Additional receipt files are compatible but cannot
substitute for missing or mismatched QC evidence.

Deliverables use only `blocked-by-qc`, `awaiting-current-delivery`, and
`included-and-verified`. Document status uses only `awaiting-qc-report`,
`blocked-by-qc`, `awaiting-current-delivery`,
`delivered-needs-license-review`, and `delivered-and-verified`. Release
readiness uses only `blocked`, `needs-license-review`, and `ready`; unknown
license evidence cannot become ready.

DeliveryManifest content may retain bounded package name, package and
selection digests, scope, revisions, counts, bytes, license summary, asset IDs,
and hashes. It must not copy local paths, remote or signed URLs, credentials,
or Provider payloads. Confirmation freezes only the exact manifest evidence
and cannot be treated as packaging, file creation or overwrite, download,
generation, render, delivery, publication, Canvas write, production
completion, or release.

## Capability truth

Treat `zcanvas capabilities` as live runtime evidence, not a static feature
list. An operation is available only when the current Desktop implements it,
the Agent is paired with every required scope, the intended project/canvas is
bound when required, and host Chrome exists for visible browser handoff.
“Implemented”, “paired”, “workspace bound”, and “host executed” are separate
facts; never collapse them into one success claim.

`tools/zcanvas-cli/creativeCapabilityManifest.json` is the creator-facing policy
source, while Canvas Node Schema, runtime model/action catalogs, and the handler
registry remain their own domain authorities. The generated
`t8-creative-capability-graph-v1` is their shared compatibility handshake. The generated
`t8-creative-capability-surfaces-v1` projects every manifest entry into exactly one Agent
tool, CLI command/subcommand, Skill machine reference, and Canvas UI action with the same
handler, scopes, request action, and per-operation L0-L3 contracts. Generated CLI JSON,
Skill Markdown, Skill surface JSON, backend surface JSON, and UI surface JSON are indexes,
not independent catalogs. Duplicate or missing CLI/UI actions, handler drift, graph digest
drift, or hand-written copies of a creative operation fail closed. Static runtime
compatibility must never claim `executable=true` without live evidence.

Every external Agent creative call must use the generated `t8-versioned-creative-tool-v1`
catalog and the exact `t8-versioned-creative-tool-request-v1` /
`t8-versioned-creative-tool-result-v1` schemas. The public catalog may expose only
versioned high-level tools, operations, scopes, schemas, and risk contracts; handler,
service, method, binding operation, raw routes, Provider requests, DOM/store/source,
database, shell, CanvasPatch, nodes, and edges remain internal. A stale version,
schema, operation, manifest, project/canvas binding, or scope fails closed. Only
operations explicitly generated as direct L0 may dispatch; L1/L2/L3 must use the
existing preview and approval lifecycle.

A runtime entry being `known` only means that its catalog record exists. A model or
action is currently usable only when the matching live graph digest reports
`installed=true`, `credentialReady=true`, `regionReady=true`, `available=true`,
`executable=true`, and no blockers. Unknown or missing evidence fails closed but
must not hide other known choices. Blocker responses may name the missing class;
they must never return an API key, token, cookie, signed URL, or local path.

Run `npm run feature-sync:check` after changing a creative capability. The same
check is the production `prebuild` gate, and Electron resources must include the
raw domain sources plus `generated/creative-capabilities.json`, the generated
capability graph, generated command catalog, and all four byte-identical capability
surface artifacts for backend, CLI, Skill, and UI. A manifest/index/runtime/risk/action binding mismatch is an incompatible
build, not a warning. Repair the responsible domain authority and regenerate the
indexes; do not hand-edit generated artifacts.

## Platform notes

Windows is the first complete target. PowerShell/CMD call the Node wrapper without shell interpolation. macOS/Linux are not called verified until their own install and runtime evidence exists.
