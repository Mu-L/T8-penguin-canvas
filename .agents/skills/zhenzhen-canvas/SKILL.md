---
name: zhenzhen-canvas
description: Create, change, remove, extend, remake, compare, continue, recover, and package images, videos, audio, scripts, Story productions, storyboards, product ads, TVCs, MVs, short dramas, assets, and editing workflows in 贞贞无限画布 through the zcanvas CLI. Use when Codex or another local Agent is asked to make or modify creative work, continue the last production, retry only failed work, diagnose a canvas/run, manage or deliver project assets, or visibly hand the current canvas to Chrome. The Skill turns one natural-language request into an editable plan, preserves accepted work and continuity, requires preview and approval before writes or generation, and verifies persisted results.
---

# 贞贞无限画布

Turn creative intent into an editable production plan, then use `zcanvas` as the only business control surface.

## Current release baseline

- The current released desktop and automatic-update baseline is `v2.7.5`: <https://github.com/T8mars/T8-penguin-canvas/releases/tag/v2.7.5>. It is published, non-prerelease, and GitHub Latest.
- Its immutable `v2.7.5` release Tag and Release target are fixed to packaged-source commit `0d22644f9f751c11cf1dec2dc50b76e57c13b52d`. Later metadata-only commits on `main` must not move that Tag.
- Treat T8-managed `/api/resources/file/<id>`, `/api/resources/set-file/<id>`, and `/api/project-assets/<id>/media` references as Provider-upload media that must be resolved to their controlled physical file before LLM, image, video, audio, or RunningHub submission. Preserve the original name and MIME as hints while validated bytes remain authoritative.
- Prefer generation continuity for valid media: a positive media signature may correct stale CDN MIME or filename metadata, while a genuinely unknown codec may fall back to the declared media kind required by the consuming node. Continue rejecting HTML/JSON error bodies, archives, empty/oversized content, cross-kind input, untrusted remote destinations, and arbitrary disk paths.
- Keep every `CanvasInner` hook before any conditional return, mount RH management modals in the document portal above ReactFlow controls, and scale the selected-node action bar with the same viewport zoom as its node.
- The authorized v2.7.5 flow produced exactly one actual Electron/NSIS artifact set. Installer `T8-PenguinCanvas-Setup-2.7.5.exe` is 1,304,690,274 bytes with SHA-256 `d1cfb27a09a6de0b4586fcf963be21bc75a339d2bab7082cd4762cd0a4f07350`; its blockmap is 1,359,819 bytes with SHA-256 `10f6a59e141052b799d7bb4c5fb04da217ee5d6943326e498d3fa1314094790e`; `latest.yml` is 362 bytes with SHA-256 `7c693bc95ae94b1757f21bffec0f5b125d2177ebabf534ff9ca84dafc99ea2c8`. Post-build, provenance, sealed recovery, GitHub digest/size metadata, full remote re-download, final Latest verification, and recovery cleanup passed.
- Multi-device collaboration, installed-upgrade, and live Provider evidence remains explicitly deferred by the owner and must never be reported as passed before it exists.

## Optimize for the creator

- Treat one natural-language sentence as the mandatory default entry. Start planning immediately; never require the creator to learn a command, node type, provider, model ID, protocol, or UUID first.
- Start from the intended work, not from nodes or API jargon.
- Resolve the creative focus in this strict order: explicit `@`/`--node` references, live selection, visible viewport objects, the current Creator Session phase, then the bounded project summary. A lower-priority failure or project state must not steal an explicitly chosen object. Compile each suggestion's label, ID, intent, capabilities, and operation contract from that same focus.
- Produce the first useful preview quickly, then let the creator compare, accept, lock, and refine.
- Keep image, video, script, Story, Director, and VideoEdit choices connected so a change never silently breaks the production chain.
- Explain choices in creative language first; expose providers, models, parameters, and evidence when professional control is useful.
- Prefer fewer meaningful choices over large undifferentiated batches. Never trade creator continuity for command throughput.

## Core rules

1. Use the bundled wrapper in `scripts/zcanvas.cjs`; pass user values as separate arguments.
2. External Agents may invoke only authenticated `t8-versioned-creative-tool-v1` tools from the generated public catalog. Require the exact tool version, request/result schema, operation, project, canvas, scopes, and manifest version; the public catalog must never expose handler, service, method, or internal binding. Reject raw route/URL/header/credential/Provider payload, DOM/store/source/database/shell/CanvasPatch and nodes/edges fields. Only generated L0 direct operations may dispatch; L1/L2/L3 must continue through their preview, approval, and execution routes. Do not invent HTTP requests, edit SQLite/Zustand/ReactFlow state, or automate canvas DOM controls.
3. Inspect the live app, project, canvas revision, node schema, existing assets, locks, and run evidence before proposing changes.
4. Generate an editable plan before any write, upload, generation, replacement, deletion, or browser submission.
5. Preserve locked and accepted results. Regeneration creates candidates; it does not silently overwrite the accepted version.
6. Treat a provider task as complete only after its result is downloaded, validated, persisted, and linked to the intended run and asset. Preserve the runtime's native system proxy/TUN/VPN/IPv6 path for the first Provider request; connection recovery may use a fresh bounded connection only after failure. A write may be replayed only with the same stable submission identity and replayable body. A completed asynchronous task is recovered by querying and persisting that same task, never by submitting a replacement that could duplicate work or billing.
7. Keep credentials opaque. Only report configured/not configured; never request or reveal API keys, cookies, passwords, tokens, signed URLs, or browser profile data.
8. Treat Canvas Patch apply/revert evidence as authoritative only when the persisted Patch ledger confirms the exact project, canvas, actor, patch ID, status, and revision. Never infer a revision or mark an Agent plan applied from UI state alone; do not offer exact revert after a real Run has been linked.
9. Treat the desktop Codex connection indicator as a non-secret receipt only. It may show active-session counts, approved scope labels, pending confirmation count, and expiry, but never a token, pairing secret, code, session ID, client identity, local path, or private canvas content. A copied one-sentence onboarding prompt starts planning only; the trusted desktop verification code and explicit scope approval remain mandatory before any authority is granted.
10. Treat the Creator Session production state as authoritative for `idea → script → assets → shots → candidates → delivery`. UI context such as `context.phase` is only a hint and cannot skip stages. Revising an earlier phase must invalidate that phase and downstream completion marks while preserving uploaded, accepted, locked, and already verified artifacts. Present the current, completed, pending, and affected phases from that persisted state; never label an uncompleted future phase as invalidated. Sending one artifact to the canvas is not delivery completion. A launcher or agent surface may summarize only persisted session, reply, approval, Run, and error evidence; it must use readable text in addition to color and must never present reply completion as production or delivery completion. Decorative launcher motion must pause when its document is hidden or the full panel is open, while readable status remains visible and reduced-motion continues to take precedence. A Canvas launcher anchored above MiniMap must derive its safe position from visible screen geometry, preserve the last valid anchor during transient MiniMap hiding, keep a deterministic responsive fallback, move left of intersecting right-side drawers when space permits, and become non-interactive and non-focusable when no safe width remains. Launcher effects must default on, expose a persistent creator-controlled off/low-resource setting, use lighter and slower semantic treatment in light mode than dark mode, and disable rotation, blur, entry and decorative animation without hiding readable status; system reduced-motion remains the strongest constraint.

## Start every task
11. Treat the generated creative capability graph and `t8-creative-capability-surfaces-v1` as the compatibility handshake across Canvas UI, Agent Control, `zcanvas`, and this Skill. Every public capability must derive its Agent tool, CLI command/subcommand, Skill machine reference, UI action, handler, scopes, and per-operation risk contract from the same manifest entry. Before any creative write or generation, `status` and `capabilities` must report matching non-empty graph and surface digests, one valid recomputed `t8-creative-capability-coverage-receipt-v1`, and empty `unknownNodeReferences`, `missingHandlers`, `missingOperationRisk`, `missingVerification`, and `missingCompatibilityEdges`. The receipt must bind source digests for the capability manifest, Canvas Node Schema, runtime catalog, handler bindings, and receipt compiler, while every inventory matches the graph. Never trust copied counts or a hand-edited generated receipt; missing or drifted evidence fails closed.
12. Treat catalog presence as `known`, not as permission or runtime proof. Before pinning a model or action, require live `installed`, `credentialReady`, `regionReady`, and `executable` evidence from the matching graph digest. Report only blocker labels; never expose the credential value.
13. Use the graph's per-operation policy as the authority: `plan`, `preview`, `compare`, and `verify` stay L0; reversible canvas writes normally require L1; Provider generation, external import/transfer, delivery, and browser submission enter L2/L3 by their declared boundary. Never infer one risk level from the capability summary.
14. Require the read-only `ModelDecisionReceipt` before presenting any model-dependent creative plan. A creator-fixed language, image, video, or audio provider/model must remain exact; if it is unknown, incompatible, or not executable, show the returned plain-language blocker and recovery action, and never switch provider, cost tier, or privacy boundary silently.
15. For smart selection, explain the selected model, verified reasons, alternatives, limitations, and the evidence status of cost and latency. Keep unverifiable estimates explicitly `unknown`. Every completed reply must expose exactly three distinct next suggestions; each suggestion must carry a real operation contract and be executable now or visibly disabled with blockers and `unblockActions`. The persisted response, event, nested SuggestionSet, API snapshot, and rendered actions must carry the same valid `t8-creator-suggestion-invariant-receipt-v1`: exactly three items, unique non-empty IDs and intents, capability IDs and operation contracts matching the current generated capability graph, no enabled item with blockers, and every disabled item with a visible reason. Revalidate that receipt when reading the append-only event tail, fail closed on corruption, and allow only one terminal SuggestionSet per response ID. Before selection, show its expected effect, authoritative Provider-call evidence, and exact per-operation risk/approval boundary in visible creator language. `providerCalls: 0` means zero model calls for this step, never “free”; missing cost or risk evidence stays unknown/disabled. Make clear that later Canvas writes or generation still require their own contract. Never present a placeholder as a working button.
16. Treat every persisted SuggestionSet as version-bound. Invoke a suggestion only with its ID and the exact `setDigest` returned by the same Creator Session; the server must recompute `canvasRevision`, `contextDigest`, `assetVersion`, and `planDigest` before model choice or planning. On any mismatch, stop and show the returned recovery message. Never replay an old label as free text to bypass freshness. The three pre-session blank ideas remain new natural-language requests, not approvals.
17. Treat every plan-dependent approval as version-bound. Present and complete only the current `t8-agent-control-approval-binding-v1` for the same session, project, canvas, action, and logical subject. A newer plan for that subject invalidates the old approval before any Canvas write, Run intent, Provider call, or file write. Different Run node scopes remain independent. Keep unavailable cost-tier and privacy-boundary evidence explicitly `unknown`; never infer that an unknown boundary was approved.
18. Keep one stable client request ID for one logical Creator message. Closing the Canvas panel may release only its foreground EventSource, polling, and UI resources; it must not stop the reply or cancel a remote task or Run. On reopen, fetch the authoritative snapshot of the same Creator Session first, then replay from its durable event cursor and reconcile linked Runs. Codex, zcanvas, Canvas UI, and another paired local Agent must all read that same backend Creator Session before deciding the current plan, approval evidence, production phase, asset lineage, Run, verification, or delivery result. The local zcanvas JSON is only a bounded session locator and recovery cache; it never outranks the backend snapshot. Approval decisions may be observed through durable evidence, but approval authority and secrets remain caller-bound and never transfer between entries. If a response is lost, the UI disconnects, the page refreshes, or the desktop/backend process restarts, recover the existing request and cursor before retrying. An exact retry may return the original in-progress/completed receipt; changed content requires a new request ID. Never create a second plan, Provider submission, CanvasPatch, or asset because delivery status was unknown.
19. For Skill install, update, downgrade, rollback, or uninstall, use only an installer-verified whole-bundle digest. An external immutable bundle additionally requires an Ed25519 signature from a key already trusted by the current installation or an independent absolute trust-policy file outside that bundle. Reject unsafe/path-like version labels, incompatible protocols, untracked installed files, digest/signature drift, unowned same-name Skill directories, and partial activation before replacement. When invoked inside a source checkout, the matching project Skill + CLI outrank managed user/global copies; outside a project, managed discovery resolves its immutable owner before PATH. Preserve the exact current install and last-known-good on every failure, never overwrite or delete an unowned directory, and return creator-readable recovery.
20. Pair only after the creator verifies the same short code in the trusted desktop dialog and explicitly approves the final scope set. The CLI may store only those approved scopes. Denial, revocation, or expiry must delete or hide stale local state and fail closed; recovery requires a fresh pairing request. Never expose a token, poll secret, pairing/session ID, verification code, credential, or private canvas content in a connection summary or report.
21. Treat a multi-session connection summary as a non-authoritative display aggregate. Authenticate and authorize every operation against the calling session's own access token and scopes; never borrow another active session's scope from the summary union. Revoking one credential must not revoke or broaden any other session.
22. Treat the trusted desktop pairing dialog as a keyboard-modal security boundary. It must take focus when opened, trap Tab and Shift+Tab inside itself, make Escape an explicit denial, and restore the creator's previous focus when the last request closes. Keyboard navigation must never auto-check the confirmation or auto-approve scopes.
23. Treat one-sentence composition as an IME and assistive-technology boundary. Opening Creator Agent must focus the composer only after its durable session and capability contract are ready. Measure launcher-to-shell paint separately from composer readiness: the shell target is 300ms, while the first local editable plan target is p95 <= 2000ms. Persist only monotonic local-planner timing and explicit zero Provider, zero Canvas, and zero production-file-write receipts; the durable Creator Session ledger remains recovery evidence and must not be mislabeled as a production output. Enter must never submit while composition is active, on native key code 229, or during the short post-composition commit window; Shift+Enter remains a newline. Streaming deltas stay visually visible but silent to the live region, and only a durable completed, failed, or stopped reply may be announced.
24. Treat “stop reply” and “cancel remote task” as different operations. Stopping a Creator Agent reply may end only that response stream, must keep its durable partial text and the creator's original request, and must be idempotent under completion/stop races. It must report zero remote tasks affected, must not apply the unfinished plan, and must never claim that an image, video, audio, browser, or Provider task was cancelled. Remote task cancellation requires the exact task card and its own supported cancellation contract.
25. For reference-video shot breakdown, keep controlled timestamped frames as the required visual evidence and treat `seedance-nz/whisper-1` as optional speech evidence only when live readiness proves it executable. Request `verbose_json`, but accept segment timing only when the actual response contains valid `start/end/text` windows; otherwise preserve the transcript as whole-video `untimed` evidence. Provider windows may support only conservative overlap with approximate shots, never word timing, speaker identity, or exact cuts. An unavailable transcriber must leave a visible non-blocking receipt and keep frames-only analysis. Whisper never proves music, ambience, or SFX. Import a completed breakdown only from an LLM node whose analysis schema and asset ID, content revision, and SHA-256 exactly match the current source; validate the result's own `sourceAsset` and timecodes, whitelist the editable shot fields, and reject malformed or cross-source results. Reuse the matching workflow instead of creating a duplicate. Mark execution evidence verified only when a same-project, same-canvas Run contains the exact NodeRun identity, a replayable snapshot bound to the same source version and schema, and the same request ID when one exists; keep pending, failed, invalid, and missing ledgers visible instead of borrowing another run or waiting for unrelated nodes in the group. Keep the continue-production suggestion disabled until the current result document and exact Run evidence are verified; once verified, convert the bounded shot grammar into an original storyboard plan instead of rerunning shot breakdown.

Run:

```text
node <skill-dir>/scripts/zcanvas.cjs status
node <skill-dir>/scripts/zcanvas.cjs capabilities
```

For every normal creative request, use the one-line session entry by default:

```text
node <skill-dir>/scripts/zcanvas.cjs ask "<the creator's request>"
```

The creator does not need to know this command or run a second command. A natural request such as “把这段剧本做成 30 秒竖屏短片” must trigger the Skill and start planning directly. This is a product requirement, not an optional shortcut. Infer duration, ratio, audience, recipe, provider defaults, and production stages as visible assumptions. Story planning must return the first editable shot, asset, and audio analysis in this same session; do not ask the creator to run `story analyze`. Ask only when the target asset or another safety-critical choice cannot be inferred.

An imported project asset may start the same Session through `ask --asset <assetId>` with no text.
Resolve the ID internally; never expose it or a local path. No text and no persistent asset still fails closed.

After `ask` returns a ready plan, present its assumptions, analysis summary, and exact change scope in creator language. Do not echo CLI commands, node types, protocol fields, UUIDs, or Provider jargon as prerequisites. When the creator confirms in the conversation, the Agent—not the creator—uses the saved session internally with `continue --session <creatorSessionId> --complete`. This only opens the authoritative canvas approval and never bypasses the separate approval required before graph writes or Provider generation.

Use `continue --session ... --prompt "<new direction>"` after a conversation restart or when the creator adds a change. It keeps the original request, exact instance/project/canvas, recipe, accepted direction, and plan checkpoint.

Before `continue` decides whether production is planned, approved/applied, running, verified, or delivered, it must refresh the exact backend Creator Session. The local session file is only a bounded locator and recovery cache. Canvas, Codex, zcanvas, and other paired local Agents report the same current plan/digest/targets, durable approval evidence, production phase/checkpoint, bounded lineage, Run links, verified artifacts, and delivery evidence. A missing or cross-scope backend session fails closed. Approval evidence is shared, but approval authority and secrets never transfer between entries.

If that session is already applied, `continue` restores the linked Story/node instead of creating another source workflow. A concrete new direction creates an authoritative `production.continue` CreativePlan and one `node.patch` against the original production; it does not merely record local notes. Never satisfy a follow-up by creating a second Story or repeating an already submitted Provider task.

The returned `incrementalPlan` is authoritative for the next conversational turn. It records the same target production, exact affected dimensions, protected results and locks, failed/missing-only scope, shot references, zero immediate writes, and zero immediate Provider calls. Present that plan in creator language, then route it through the existing preview and approval contract.

If the CLI reports an unavailable capability, stop that action and explain the returned `message` and `nextActions`. Do not substitute a hidden browser click or raw API call.

Use the current working-directory binding when present. With one paired instance and one available canvas, `ask` selects it automatically. If the project or canvas is ambiguous, show creator-facing names and last activity, then ask the user to choose; never ask them to interpret UUIDs.

Project recipes are creator-owned production memory. Use `recipe save/import/pin/rollback/verify` to preserve a director style, character or product bible, shot grammar, negative rules, stages, review dimensions, and separate language/image/video/audio defaults. Recipes are versioned per project and signed with a key protected by the current user's secure store. `ask --recipe <name>` resolves only the pinned, verified version. A missing or modified recipe must fail closed instead of silently using `general`.

## Route the request

- Read [references/generated-capabilities.md](references/generated-capabilities.md) before selecting a registered creative action, [references/generated-capability-surfaces.json](references/generated-capability-surfaces.json) for the exact Agent tool / CLI / UI action mapping, then [references/generated-capability-coverage.md](references/generated-capability-coverage.md) for its real node, handler, runtime and operation coverage. These are generated artifacts and never override the human safety, approval, or evidence rules in this Skill.
- A capability is usable only when the generated graph resolves its policy entry to a known Canvas Node Schema type and an implemented runtime service/action. Unknown nodes, duplicate capabilities, missing handlers, digest drift, or an unhealthy graph fail closed; never replace them with an improvised API, DOM action, or shell path.
- The production build runs the cross-source capability graph gate before TypeScript/Vite. If node schema, runtime model catalog, capability policy, handler registry, generated CLI/Skill/backend artifacts, or the packaged indexes differ, repair the responsible domain authority and regenerate; never hand-edit generated files.
- Read [references/creative-workflows.md](references/creative-workflows.md) for image, video, audio, script, Story, Director, VideoEdit, and cross-media production.
- Read [references/commands.md](references/commands.md) before issuing CLI commands or composing pipes.
- Read [references/protocol.md](references/protocol.md) when handling JSON/NDJSON, revisions, previews, idempotency, runs, or errors.
- Read [references/browser-control.md](references/browser-control.md) before using Chrome or the existing T8 extension.
- Read [references/security.md](references/security.md) before uploads, generation, delivery, deletion, replacement, external providers, or multi-Agent edits.
- Read [references/compatibility.md](references/compatibility.md) for installation, version handshake, Codex discovery, or update failures.

## Create a useful plan

Translate the user's goal into a compact plan containing:

- outcome, audience, format, duration, aspect ratio, style, audio layers, and delivery;
- assets and results to reuse, lock, add, modify, or skip;
- proposed stages, shots, candidates, models/providers, and fallback choices;
- waiting stages and the boundary of each Provider batch;
- exact scope for words such as “only”, “except”, “keep”, “from shot N”, “missing”, “failed”, and “unlocked”;
- one of `economy`, `balanced`, `quality`, or `custom`.

Ask no more than three questions at once. Ask only questions that materially change the result; infer visible project facts instead of asking again.

Prefer a small useful preview before a full-quality batch. Entering a workflow stage must never start generation by itself.

Before selecting a model, run `model list` or `model search`. For Story, keep language, image, and video provider/model selections separate and pass all three into the plan.

For long scripts, use `create story --file <absolute-utf8-file>` instead of putting the script in a shell command. Continue the same Story with `story inspect`, `story import`, `story bind-asset`, `story compile`, and `story plan-previews`; do not create a second Story merely because the Agent resumed in a new conversation.

Treat quality as a creator feedback loop:

- explore a few named directions at preview quality;
- compare the work, not only prompts or model names;
- accept one direction and lock identity, wardrobe, product, scene, or composition as needed;
- refine only the unlocked weakness;
- move to full quality only after the direction and continuity are accepted.

Do not evaluate a candidate from its Prompt, label, seed, provider, or model name. Open or otherwise inspect the actual safe media reference first. Use `iterate review` to bind the visual/audio assessment to the current asset URL, asset ID, or content hash. Compare composition, identity, product shape, continuity, rhythm, and text accuracy as applicable; identity, product shape, continuity, and text accuracy are hard gates. A missing or stale review is “not yet reviewed”, never a quality pass.

Accepting a candidate automatically locks its Prompt and any relevant identity, wardrobe, background, product shape, logo, composition, or scene dimension. Explicit `--lock` values add to those automatic locks. Later edits must preserve accepted results, uploads, locks, and completed unaffected work; Story re-analysis invalidates only semantically changed shots.

`--candidates 3` means three alternatives for the same image or shot. Three different Story shots must be represented by three stable shot IDs and planned with `story plan-previews`.

## Apply changes safely

Follow this sequence:

1. Inspect the authoritative canvas and node schema.
2. Validate and simulate the intended execution plan with `doctor validate` and
   `doctor simulate`; this is read-only analysis with zero Provider calls.
3. Create a structured CanvasPatch preview with `baseRevision` and `previewDigest`.
4. Summarize the affected nodes, node types and positions, edge endpoints and ports, persistent asset lineage, locks, downstream impact, Provider boundary, and risk in plain language. Never expose raw before/after values, prompts, URLs, or Provider payloads in the preview.
5. Obtain the required confirmation.
6. Apply the exact preview using an idempotency key.
7. Verify the new revision and audit record.
8. Run only the confirmed scope.
9. Follow the same durable RunIntent to a terminal state.
10. Verify persisted artifacts and report success, failure, skipped, and reused counts.

If the revision or schema is stale, do not retry the write blindly. Re-inspect, regenerate the preview, and show the changed scope.

## Approval levels

- `L0`: status, version, capabilities, list, show, schema, search, inspect, validate, simulate, run evidence, and preview. These may run automatically.
- `L1`: small, reversible graph edits within an explicit user scope. Still show a structured preview and an undo path.
- `L2`: generation, upload/download, delivery packaging, external provider transfer, batch regeneration, deletion, replacement, cascading updates, browser form submission, or cross-origin navigation. Confirm each batch with exact boundaries.
- `L3`: credential access, cookie/profile reading, CAPTCHA bypass, safety bypass, arbitrary shell/filesystem access, silent publishing, or database mutation. Never perform these actions.

## Iterate without destroying work

- Lock accepted characters, scenes, prompts, shots, media, audio, and edits.
- Use candidate versions, comparison sets, branches, and “set accepted”.
- Default batch scopes to missing, failed, or unlocked items.
- Persist creative briefs, style/character/scene/audio bibles, shot lists, asset plans, generation plans, selections, and delivery manifests in the project.
- Preserve lineage: inputs, prompt, model, parameters, provider task, parent version, and accepted version.
- On interruption, continue from the last persisted checkpoint and do not duplicate Provider submissions.

## Use Chrome only as a visible handoff

Use the host Agent's Chrome capability only when the user explicitly requests visible browser work. A non-status handoff must carry that explicit-user contract, remain bound to the exactly one local Canvas origin in `allowedOrigins`, and never accept an arbitrary target URL.
Allowed uses include opening the current canvas, focusing the tab, highlighting a node, taking a screenshot, reading a visible error, completing user-driven login, and invoking the existing extension's selection UI.
Every `browser` command first returns a handoff with `executed:false`. The command name does not prove that Chrome was opened, highlighted, or captured. Only report success after the host Chrome capability performs the visible action and returns evidence.
If Chrome control is unavailable, return the project URL and state that it was not opened automatically. Never attach or read headers, credentials, cookies, localStorage/sessionStorage, passwords, profiles, storage state, or other tabs. Cross-origin navigation, form submission, download, and login require a separate visible L2 confirmation and cannot reuse the local Canvas handoff.

## Report the outcome

Lead with the creative result and the next useful choice. Include:

- what was created, changed, reused, skipped, locked, or left pending;
- run and artifact evidence;
- any partial failure and safe recovery options;
- the project/canvas link when useful.

Do not call a task successful when a provider says `completed` but the artifact is missing, invalid, undecodable, or not persisted.

On failure, lead with three creator-facing facts: what did not finish, whether existing work is safe, and the next recovery action. Keep technical codes in structured evidence. Resume the same Creator Session, approval, run intent, cursor, download, or verification stage; never turn a recoverable failure into a duplicate Provider submission.

For Canvas UI replies, preserve the response ID and event cursor across interruption. Show persisted partial text, but expose a CreativePlan or any executable action only after the ordered response deltas are verified and completed.

For real task progress, resume only verified linked Runs from their durable database event cursors. Prefer one current creator-facing state per Run or NodeRun; never copy raw provider polling payloads, signed URLs, credentials, prompts, or local paths into the chat session.

## Use object-aware canvas context

Treat one sentence as the default start, then ground the reply in the creator's current canvas instead of forcing node or CLI vocabulary.

Use a bounded summary of at most 24 priority objects: current selection, viewport visibility, type/status, media result kinds and count, accepted/locked state, and upstream/downstream counts. Include only bounded offscreen counts and fixed creator-facing recent-action labels. Never place raw prompts, media bodies, signed or remote URLs, local paths, or provider payloads in Creator Session context.

Prioritize three safe next actions in this order: verified failed Run or offscreen failure recovery; the current selected object while preserving accepted and locked parts; then the general Story/image/video/audio phase.

Node graph counts are not database asset lineage. Query persistent lineage only when selected objects have persisted output references from verified recent Runs. Read at most six current-selection assets and twelve lineage records per asset; do not scan the asset catalog.

Persist only bounded asset IDs, kinds, labels, relation names, parent IDs, source node IDs, Run/NodeRun IDs, derived operation names, and truncation state. Never persist lineage prompt summaries, metadata, remote or signed URLs, preview URLs, or local paths in a Creator Session.

A local filmstrip may show lazy-loaded persisted thumbnails, first frames, contact sheets, or waveforms and locate the real source node. Keep those preview references in UI memory only. A partial lineage-read failure is non-blocking and must not trigger a Provider call, generation retry, canvas write, or loss of already verified work.

## Place a verified asset on the canvas

Use `asset place --asset <assetId>` only for a current-project asset that is already persistent, re-openable, hash-verified, and represented by a stable asset ID. The returned plan must show the new node, position, optional target port/edge, and lineage source before the creator approves it. This is an L1 reversible CanvasPatch: it must not read an external file, transfer the asset to a Provider, or trigger generation.

After approval, complete the same stored request with `asset place-apply`; do not create another plan. Treat an authoritative duplicate result as recovery of the original placement, then refresh the canvas snapshot. Record `artifact.sent-to-canvas` only after the exact Session plan and canonical applied Patch ledger agree on project, canvas, asset ID, content hash, node ID, patch ID, and revision. A button state, preview, or remote URL is never delivery evidence.

## Add a creator-visible node

Use `graph add --type <schema-type>` when the creator explicitly needs a node
that is not already represented by a higher-level one-sentence workflow. The
type must be one of the 58 non-hidden entries referenced by
`canvas.node-add` in the generated capability coverage report. Hidden or
internal node types fail closed.

`graph add` is an L1, preview-first CanvasPatch operation. It only adds the
node; it never runs the node or calls a Provider. For the seven schema-marked
generatable node types, initial data is limited to the exact
`generation.allowedDataFields` contract. Other nodes are added empty and must
be configured in their visible node UI. Never treat create coverage as
run/verify coverage: only the 11 nodes that the generated graph marks fully
operable may be described as end-to-end executable.

Use the same command again after the desktop approves its exact plan. The CLI
resumes the stored approval and must not create a duplicate node.

## Trust production evidence, not the plan

- A chat reply, three suggestions, CreativePlan, or Canvas Patch preview expresses intent only. It never completes `idea`, `script`, `assets`, `shots`, `candidates`, or `delivery`.
- After a confirmed apply or revert, require the canonical Patch ledger entry for the same project, canvas, actor, plan digest, patch ID, status, and exact revision. Then derive stage progress from the persisted canvas document.
- Story progress comes from persisted script and confirmed shots, ready assets, compiled prompts, completed videos, and final-film state. Candidate completion additionally requires visual review plus acceptance/lock evidence, or verified Run/NodeRun artifacts.
- Production evidence is bounded metadata only: IDs, counts, revisions, stages, and booleans. Never copy script bodies, prompts, media or signed URLs, local paths, Provider payloads, API keys, tokens, or cookies into the Creator Session.
- Revert and upstream revision recompute completion from the resulting document and invalidate only affected downstream stages. Preserve uploads, accepted versions, locks, Run/Asset lineage, and physical delivery evidence.
- If the ledger, document revision, actor, plan, or persisted artifact evidence is missing, fail closed with a creator-facing recovery step. Never guess completion to keep the conversation moving.

## Show the exact approval boundary

When an approval carries `t8-agent-control-approval-binding-v1`, require the desktop confirmation to show the bound plan/model receipt, Provider/model selections, cost status, privacy status, and a stable short receipt digest. Unknown cost or privacy metadata must stay visibly unknown; never infer it. Any plan, Provider, model, cost, or privacy boundary change invalidates the old approval before a Canvas, Run, Provider, or file side effect. Legacy approvals without this binding remain compatible with their existing scoped preview.

## Retry one logical approval without creating another

Reuse the same `operationId` only for the exact same logical approval request. A retry after a lost response or refresh must recover the same `approvalRequestId`, protected poll secret, expiry, and status; it must not create another confirmation card. If actor, project, canvas, Patch, payload, preview, expected revision, plan/model receipt, Provider, cost, or privacy boundary changed, use a new operation ID and require a fresh approval. Treat `APPROVAL_IDEMPOTENCY_CONFLICT` and `APPROVAL_STALE` as fail-closed recovery signals. Never print or persist poll secrets in chat, Creator Sessions, logs, or public evidence.

## Recover one approved plan across Canvas UI and Codex

Persist the server-validated Patch in the same Creator Session before presenting it as executable. Canvas UI and Codex may recover one already approved Creator apply only when `patchId`, normalized request digest, preview digest, project, canvas and expected revision are exact. Reuse the stable operation and treat an authoritative `duplicate:true` response as success for the original commit; refresh the canvas from the returned snapshot instead of submitting a second Patch.

Cross-entry recovery does not transfer ownership. Keep the original actor in Patch evidence, personal history and exact revert authority. A recovering actor must not claim or revert another actor's Patch. Generic `patch.apply`, changed content, a changed preview, a stale revision, new credentials, or a different permission boundary requires a new preview and confirmation. Never expose the internal request digest in public Patch history.

## Keep pre-production documents versioned and honest

For every Story or script plan, expect the same response to include
`ProductionBrief`, `ScriptDoc`, and `WorldBible` documents using
`t8-creator-production-document-v1`. Other creative plans should include at
least the `ProductionBrief`.

Continue editing these documents with natural language in the same Creator
Session. Preserve the revision when content is unchanged; changed content must
create a new revision while the prior `assistant.plan` event remains available.
Treat a content/digest mismatch as a fail-closed recovery condition.

Never invent analysis to fill an intermediate document. Keep unanalysed
characters, scenes, shots, locations, and world rules empty and visibly
unknown. A draft document is not proof that script, assets, shots, candidates,
or delivery are complete, and it never authorizes Provider or Canvas writes.

## Confirm only one exact document version

Confirm a pre-production document only when its document ID, version ID,
content digest, source plan ID, and plan digest all match the current
Creator Session plan. Treat an old plan, old version, changed digest, duplicate
document in one request, or replaced content as stale and refresh before
continuing.

An exact repeated confirmation is idempotent and must recover the existing
receipt without another event. Keep confirmation evidence separate from the
plan so it never changes the plan digest. A later natural-language edit creates
a new draft; only byte-for-byte-equivalent semantic content may retain the
confirmed status.

Show field-level before/after changes from
`t8-creator-production-document-diff-v1` in a lightweight collapsed review.
Confirmation accepts text only. It does not approve Provider calls, Canvas or
file writes, Runs, production phase completion, or delivery.

## Map explicit script structure back to source

For a ScriptDoc, treat only explicit `Scene` / `场景`, `Shot` / `镜头`, and
`Characters` / `人物` / `角色` labels as deterministic structure. Preserve a
stable source digest, stable scene and shot IDs, one-based source line ranges,
and bounded source excerpts. Missing structure stays unresolved; do not infer
facts from incidental names or prose.

Use `t8-creator-script-analysis-v1` with
`method=deterministic-source-map`, `sourceBacked=true`, `providerCalls=0`, and
`inferredFacts=0` for this local mapping. A changed source creates a new
ScriptDoc draft and follows the existing field diff and exact confirmation
rules.

Keep the review lightweight: show counts and a collapsed list of shot titles
and line ranges. This mapping is not LLM interpretation, dramatic rewriting,
character-relationship inference, asset preparation, storyboard completion,
or permission to run a model.

## Review source-backed character and asset proposals

For Story and script plans, expect versioned `CharacterBible` and `AssetNeed`
documents alongside the existing pre-production documents. Treat them as
proposals derived from the current ScriptDoc, never as completed creative
facts or generated assets.

Accept characters only from explicit `Characters` / `人物` / `角色` labels and
location asset needs only from explicit `Scene` / `场景` headings. Every item
must preserve a stable ID, one-based source line, bounded source evidence, and
the exact source ScriptDoc ID, version ID, content digest, and source digest.
Appearance, wardrobe, personality, relationships, and unstated location facts
stay unresolved.

Require `t8-creator-source-derivation-v1` with
`method=deterministic-source-map`, `sourceBacked=true`, `providerCalls=0`, and
`inferredFacts=0`. New asset needs remain `missing`, unaccepted, unlocked, and
use `generationScope=none`; reviewing a proposal must not call a Provider,
generate media, or write to the Canvas.

Confirm a derived document only after its exact source ScriptDoc is confirmed,
or confirm that ScriptDoc and its derived documents together in one batch.
Fail closed when any source document ID, version, content digest, or source
digest differs. Keep individual derived confirmation disabled until the source
is confirmed, while allowing one explicit batch confirmation of the complete
current dependency chain.

## Review a source-backed shot list

For Story and script plans, expect a versioned `ShotList` document derived
from the current ScriptDoc. Accept entries only from explicit `Shot` / `镜头`
headings. Preserve each stable shot-list ID, source shot ID, ordinal, title,
scene binding, one-based source range, bounded source evidence, and exact
source description.

Keep duration, shot size, camera movement, dialogue or voice-over, sound
design, and related asset IDs empty and listed as unresolved unless the creator
explicitly supplies them. Use `generationScope=none`; a source-backed shot
list is not a completed director storyboard, image candidate, video Run, or
quality approval.

Require the same `t8-creator-source-derivation-v1` evidence with
`providerCalls=0` and `inferredFacts=0`. Confirm the shot list only after its
exact source ScriptDoc is confirmed, or confirm both in one explicit batch.
Fail closed on a changed source document ID, version, content digest, or source
digest.

Keep the review lightweight: show at most ten shot rows with scene, title, and
source line range. Reviewing or confirming must not call a Provider, generate
media, or write to the Canvas.

## Review a source-backed AudioPlan

For Story and script plans, expect a versioned `AudioPlan` document after the
current `ShotList`. Every audio item must bind one exact shot-list item and
preserve its shot-list item ID, source shot ID, ordinal, title, scene, exact
one-based source line, and bounded source evidence.

Create items only from explicit `Dialogue` / `对白` / `台词`,
`Voiceover` / `Narration` / `旁白` / `解说`, `Music` / `BGM` / `音乐` /
`配乐`, `Ambience` / `Ambient` / `环境声` / `氛围声`, and `SFX` /
`Sound effect` / `音效` labels. Do not infer a cue from ordinary prose such
as rain, footsteps, sirens, mood, or camera direction.

Keep speaker, voice, timing, duration, loudness, ducking, fades, asset IDs,
Provider, model, and generated results empty unless the creator explicitly
supplies them. New items remain `trackStatus=source-draft`,
`promptSource=script-evidence`, `generationStatus=not-requested`, and
`locked=false`. Use `generationScope=none`.

Require the same `t8-creator-source-derivation-v1` evidence with
`providerCalls=0` and `inferredFacts=0`. Confirm the AudioPlan only after its
exact source `ShotList` is confirmed, or confirm the current dependency chain
together in one explicit batch. Validate source document ID, version ID,
content digest, and the inherited ScriptDoc source digest at every step. Fail
closed on any mismatch.

Keep the review lightweight: show total and dialogue, voice-over, music,
ambience, and SFX counts plus at most ten collapsed cue rows. Confirmation
accepts only the current text and layered-track structure. It must not select
a Provider or model, generate or upload audio, submit a task, write to the
Canvas, or advance a production phase.

## Review source-backed storyboard frames

For Story and script plans, expect a versioned `Storyboard` document after
the current `ShotList`. Each frame must map to one exact shot-list item and
preserve its shot-list item ID, source shot ID, ordinal, title, scene, and
bounded source evidence.

A new frame is an unresolved production slot, not generated media. Require
`frameStatus=missing`, empty `candidateIds`, no selected candidate, no asset,
no acceptance timestamp, no lock, and empty prompt, composition, and
continuity notes. Keep composition, subject state, reference assets, and the
storyboard image listed as unresolved.

Require `adoptionPolicy=explicit-only` and `generationScope=none`. Confirming
the Storyboard accepts only that exact structure. It must never adopt or lock
a candidate, call a Provider, create media, write to the Canvas, or advance a
production phase.

Confirm the Storyboard only after its exact source `ShotList` is confirmed,
or confirm the current ScriptDoc, ShotList, and Storyboard together in one
explicit batch. Validate source document ID, version ID, content digest, and
the inherited ScriptDoc source digest at every step. Fail closed on any
mismatch.

Keep the review lightweight: show total, accepted, and missing frame counts
plus at most ten collapsed source rows. Always state that structure
confirmation and candidate adoption are separate creator actions.

## Review source-backed PromptPack drafts

For Story and script plans, expect a versioned `PromptPack` document after
the current `Storyboard`. Each prompt item must map to one exact storyboard
frame and preserve its storyboard frame ID, shot-list item ID, source shot ID,
ordinal, title, scene, and bounded source evidence.

Use the exact source-evidence text as the initial positive prompt. Do not
rewrite, translate, expand, beautify, or infer it during this deterministic
stage. Keep negative, motion or action, audio, reference-asset, and image,
video, or audio model fields empty unless the creator explicitly supplies
them, and list those fields as unresolved.

A new prompt item must remain `promptStatus=source-draft`,
`creatorReviewed=false`, and `locked=false`. Require
`reviewPolicy=explicit-confirmation` and `generationScope=none`. Confirming the
PromptPack accepts only that exact text and structure. It must never call a
Provider, generate media, adopt a candidate, lock an asset, write to the
Canvas, or advance a production phase.

Confirm the PromptPack only after its exact source `Storyboard` is confirmed,
or confirm the current ScriptDoc, ShotList, Storyboard, and PromptPack together
in one explicit batch. Validate source document ID, version ID, content digest,
and the inherited ScriptDoc source digest at every step. Fail closed on any
mismatch.

Keep the review lightweight: show total, draft, and reviewed prompt counts
plus at most ten collapsed source rows. Always state that PromptPack
confirmation is not a Provider call, generation, candidate adoption, or lock.

## Review and adopt real production candidates

For Story and script plans, expect a read-only `CandidateReview` document after
the current `PromptPack`. Include only Canvas nodes whose
`t8-creator-production-binding-v1` exactly matches the current PromptPack
document ID, version ID, content digest, and prompt item ID. Story preview
nodes must also bind one uniquely matching shot source digest. Never recover a
binding by fuzzy text, list position, or an older PromptPack.

Count a candidate only when it has an actual text result or at least one safe
persisted image, video, or audio reference. Empty preview slots, thumbnails,
prompts, provider names, model names, or completion flags are not candidate
evidence. Preserve the exact candidate ID, node ID, result kind, safe result
references, execution references, review evidence, and adoption state.

A Story candidate may be adopted only after an actual-result review and an
explicit accept action create `t8-creative-adoption-receipt-v1`. Verify that
the receipt binds the same node ID, candidate ID, current evidence digest, and
current review digest. A legacy or manually edited `accepted=true` without a
valid current receipt is unverified and must fail closed at Story adoption.

Confirm `CandidateReview` only after its exact current PromptPack is confirmed,
or confirm the complete current dependency chain in one explicit batch.
Validate the source document ID, version ID, content digest, and persisted
candidate evidence digest. Confirmation freezes only that evidence version; it
must not adopt a candidate, add locks, run a node, call a Provider, generate
media, write to the Canvas, or advance a production phase.

Keep the UI lightweight: show total, reviewed, adopted, and blocked counts plus
a bounded candidate list. Explain missing evidence in creator language and
keep review, accept, and document confirmation as separate explicit actions.

## Review production evidence and acceptance gates
Read [production evidence and acceptance](references/production-evidence-and-acceptance.md)
before confirming an EDL, QCReport, DeliveryManifest, or claiming browser or
Electron acceptance. Keep the exact dependency order:
`CandidateReview → EDL → QCReport → DeliveryManifest`.

Only verified, reviewed, explicitly adopted video may enter the EDL. Only
persisted physical verification receipts may turn QC checks into `pass`. Only
an exact completed delivery receipt may mark a deliverable included. Requested
duration, node status, preview URLs, or missing evidence must never become
proof. Confirming a document freezes that exact version only and causes no
generation, edit, delivery, Provider, Canvas, or file side effect.

## Use dedicated local media utilities

Use `media extract-frames --node <id> --count <1-20>`, `media remove-solid-background
--node <id>`, and `media resample-upscale --node <id> --scale <1.5|2|3|4>` instead
of generic hidden-node creation. Preview the `source → utility → output` patch;
separately approve apply and run. Solid-background removal means sampled-color
removal, not AI matting; Lanczos resampling changes pixels, not true detail.

In Canvas Creator Agent, explicit `@ 引用选区` is stronger than live selection; from Codex use the same session contract internally with `zcanvas ask/continue ... --node <id>,<id>`. Keep at most eight current-canvas nodes, send only available persisted project assets through `/api/project-assets/<id>/media`, and clear stale references for a new post-apply continuation unless explicitly selected again. Never ask the creator for IDs. A reference never deletes, mutates, runs, or adopts its source.
