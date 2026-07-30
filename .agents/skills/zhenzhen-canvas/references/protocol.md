# Control protocol

## Contents

1. Envelope
2. Version handshake
3. Scope and concurrency
4. Preview and apply
5. Run completion
6. Creator response streaming
7. Creator suggestion invariant
8. Cross-entry Creator Session authority
9. Creator Run event recovery
10. Stable errors

## Envelope

Single commands emit one `t8-agent-control-response-v1` JSON object:

```json
{
  "schema": "t8-agent-control-response-v1",
  "ok": true,
  "code": "OK",
  "message": "Command completed",
  "requestId": "uuid",
  "timestamp": "ISO-8601",
  "cliVersion": "0.1.0-dev",
  "data": {},
  "warnings": [],
  "nextActions": []
}
```

Streaming commands emit complete NDJSON events. Progress belongs on stderr.

## Version handshake

Require compatible values for:

- CLI version
- Skill version
- desktop version
- `t8-agent-control-v1`
- `t8-canvas-patch-v1`
- node schema digest

Fail closed with `VERSION_INCOMPATIBLE` or `SCHEMA_STALE`; never guess.

## Scope and concurrency

Every live operation must resolve:

- `instanceId`
- `projectId`
- `canvasId`
- `canvasRevision`
- `actorId`
- `sessionId`
- `operationId`

Use a new request ID per attempt and a stable idempotency key for one logical Provider or mutating operation.

## Preview and apply

Writes follow:

1. proposal
2. validate
3. simulate
4. preview
5. explicit confirmation
6. exact apply
7. revision and audit verification

Apply only the preview's `previewDigest` at its `baseRevision`. A stale revision produces zero writes.

## Run completion

Provider `completed` is only one stage. Report creative success after:

1. provider completion;
2. result URL extraction;
3. safe download;
4. media validation;
5. persistent asset storage;
6. Run/NodeRun/Attempt linkage;
7. intended node or shot verification.

## Creator response streaming

Canvas Creator Agent replies stay inside the same append-only Creator Session:

1. `assistant.response.started` publishes one stable `responseId`;
2. at most eight `assistant.response.delta` events use contiguous zero-based indexes;
3. `assistant.response.completed` is accepted only when the ordered deltas exactly reconstruct the final assistant message and plan;
4. every event is persisted before it is exposed over SSE;
5. reconnect resumes by `Last-Event-ID` or the `after` cursor;
6. the client coalesces one response ID into one visible assistant message.

An identical duplicate `(responseId, index, delta)` is idempotent. A conflicting duplicate, index gap, incomplete completion, or overlapping message fails closed. Partial text may remain visible for recovery, but it is never an executable plan and never authorizes a Provider call or canvas mutation.

## Creator suggestion invariant

Every durable completed Creator response carries one
`t8-creator-suggestion-invariant-receipt-v1` bound to its exact
`responseId`, SuggestionSet digest, capability graph digest, and ordered
suggestion IDs:

1. the response has exactly one terminal completion and exactly one
   SuggestionSet;
2. that set contains exactly three items with unique non-empty IDs and
   unique non-empty intents;
3. every capability ID exists in the current generated capability graph and
   every operation contract exactly matches that capability's operation,
   risk, approval, boundary, and scope contract;
4. an enabled item has no blockers, disabled reason, or unblock actions;
5. a disabled item has a visible reason and may expose bounded unblock
   actions.

Persist the same receipt on the response, assistant plan/completion events,
and nested SuggestionSet. Recompute and revalidate it when reading a session
or its append-only event tail. A mismatched digest, duplicate terminal
response, missing receipt, fake enabled action, or capability/contract drift
fails closed with `CREATOR_SUGGESTION_INVARIANT_FAILED` or
`CREATOR_SESSION_CORRUPT`; do not render or invoke the affected actions.
Concurrent exact completion retries must converge on the one persisted
terminal response instead of appending a second SuggestionSet.

## Cross-entry Creator Session authority

Canvas, Codex, `zcanvas`, and another paired local Agent must converge on the same backend Creator Session:

1. refresh the exact session ID with the exact project and canvas before deciding whether a plan is current or production is planned, approved/applied, running, verified, or delivered;
2. treat any local session file as a bounded locator and recovery cache, never as a second source of truth;
3. project only bounded current plan/digest/targets, durable approval decision evidence, production phase/checkpoint, asset lineage, Run links, artifact verification, delivery evidence, and the durable event cursor;
4. reject a missing backend session or session/project/canvas mismatch instead of reconstructing a duplicate plan or production;
5. share approval decision evidence only; credentials, poll secrets, access tokens, and the authority to approve remain bound to the calling entry.

An applied production remains applied even after the append-only event tail rotates: the authoritative production checkpoint is the fallback lifecycle receipt. Cross-entry refresh must happen before any local applied-status shortcut.

## Creator Run event recovery

Only a Run already linked to the same Creator Session through verified plan, canvas, RunIntent, and NodeRun evidence may enter the Agent event stream.

- Keep one durable database RunEvent cursor per linked Run. A late link starts at zero so it can recover earlier events.
- Read at most twelve recent linked Runs and at most two hundred events per Run per pump.
- Persist meaningful `run.*` / `node.*` states, terminal evidence, and bounded progress; advance the cursor without displaying noisy provider polls.
- Coalesce progress by ten-percent buckets and display only the newest activity for each Run or NodeRun.
- Redact remote URLs and credential-like text. Never copy raw Provider responses, prompts, signed download URLs, or local paths into the Creator Session.
- A Run sync error never closes the reply stream and never causes a canvas write or Provider retry.

## Creator canvas object context

The UI may attach a bounded `canvasObjects` array and `offscreenSummary` to the same Creator Session:

- maximum 24 objects, ordered by selection, failure, running state, visibility, protection, and output relevance;
- stable node identity/type plus bounded creator label and normalized state;
- result count and safe media-kind enum only, never result URLs or bodies;
- accepted flag, bounded lock keys, and upstream/downstream counts;
- bounded offscreen node/failure/output/locked counts;
- at most eight recent actions using fixed event labels rather than raw payload text.

The backend normalizes the context again and discards unknown fields. This summary is navigation context, not permission to mutate the canvas, call a Provider, or claim persistent asset lineage.

## Creator persistent asset lineage

When current selected nodes have persisted `outputRefs` in verified recent Runs, the UI may query their project assets and `AssetLineageRecord` rows on demand:

- maximum six selected output assets;
- maximum twelve lineage events per asset;
- no background catalog scan and no refresh solely because a Run polling interval elapsed;
- prefer records belonging to the current canvas;
- persist only bounded asset kind/label, relation, parent asset, source node, Run/NodeRun, derived operation, event count, and truncation state;
- discard prompts, prompt summaries, metadata, remote or signed URLs, local paths, Provider responses, and unknown fields.

Preview images, first frames, contact sheets, and waveforms may appear in a lazy local filmstrip but never enter Creator Session context. A lineage read failure is non-authoritative and non-blocking: it cannot write the canvas, call a Provider, retry generation, or invalidate already persisted work.

## Creative capability coverage receipt

The generated capability graph carries one
`t8-creative-capability-coverage-receipt-v1`. It is valid only when:

1. `sourceDigests` binds the creative capability manifest, Canvas Node Schema,
   runtime catalog sources, handler bindings, and the receipt compiler;
2. node `total`, `executable`, and `generatable` counts are recomputed from the
   Node Schema;
3. LLM, image, video, audio, and action counts are recomputed from the runtime
   catalog, and capability, handler, and operation counts are recomputed from
   their own authorities;
4. `unknownNodeReferences`, `missingHandlers`, `missingOperationRisk`,
   `missingVerification`, and `missingCompatibilityEdges` are all empty;
5. the receipt digest, graph summary counts, and graph gap copies match the
   recomputed receipt exactly.

Backend and `zcanvas` consumers must run the same validator. A missing source
digest, stale generated graph, copied count, unknown node, unbound handler,
operation without a risk/verification contract, or runtime entry without a
compatibility section fails closed before planning, execution, or generation.

## Stable errors

- `USAGE_ERROR`
- `APP_NOT_RUNNING`
- `APP_INSTANCE_AMBIGUOUS`
- `PAIRING_REQUIRED`
- `AUTH_EXPIRED`
- `VERSION_INCOMPATIBLE`
- `CAPABILITY_UNAVAILABLE`
- `PROJECT_NOT_BOUND`
- `CANVAS_NOT_FOUND`
- `NODE_TYPE_UNKNOWN`
- `NODE_NAME_AMBIGUOUS`
- `SCHEMA_STALE`
- `REVISION_STALE`
- `PREVIEW_REQUIRED`
- `CONFIRMATION_REQUIRED`
- `DELIVERY_INCOMPLETE`
- `DELIVERY_SOURCE_CHANGED`
- `DELIVERY_VERIFY_FAILED`
- `RUN_ALREADY_EXISTS`
- `UPLOAD_REQUIRES_CONFIRMATION`
- `BROWSER_CAPABILITY_UNAVAILABLE`
- `BROWSER_ORIGIN_NOT_ALLOWED`
- `INTERNAL_ERROR`

Every error includes a plain Chinese `message` and actionable `nextActions`.
