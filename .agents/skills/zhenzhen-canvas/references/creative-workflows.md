# Creative workflows

## Contents

1. Shared workflow
2. Image
3. Video
4. Script and Story
5. Cross-media production
6. Iteration and recovery

## Shared workflow

Use:

1. restate the intended creative outcome in one short sentence;
2. discover existing project facts, accepted results, assets, locks, and model choices;
3. create a no-write CreativePlan and ask at most three high-impact questions;
4. offer economy, balanced, and quality paths in plain creative language;
5. create a small preview-quality set with meaningful differences;
6. let the creator compare, accept, lock, branch, and roll back;
7. produce only the confirmed missing, failed, or unlocked scope;
8. verify persisted artifacts and present the next useful creative decision.

Do not require the creator to choose a node or provider unless they want professional control.
Do not dump a large model list into the conversation. Recommend one default and one fallback, then expose `model list/search/schema` when requested.

Before generating, write a small creative contract:

- what the audience should feel or understand;
- the deliverable and where it will be viewed;
- hard constraints that must survive every iteration;
- the one or two dimensions that may vary;
- what evidence will make the creator accept the result.

Use the contract to name the candidate differences and to judge progress. A technically valid artifact is not automatically a useful creative result.

## Image

Support creative intents such as text-to-image, image-to-image, inpainting, outpainting, background replacement, wardrobe, character sheet, product image, poster, typography, and batch variations.

Generate a small, meaningfully diverse comparison set first. After selection, refine composition, light, details, text, and final resolution.

Allow locks for identity, product, logo, composition, palette, and reference role.

Name the candidate differences, for example “更克制的冷色电影光”, “更强的人物近景”, and “更清楚的产品轮廓”. Do not create three prompt-identical candidates and call them alternatives.

Evaluate image candidates in this order:

1. intent and focal point;
2. composition and readability at the delivery size;
3. identity/product/reference fidelity;
4. light, color, material, and spatial coherence;
5. hands, faces, typography, logos, and other failure-prone details;
6. only then resolution and polishing.

When changing a single weakness, keep accepted reference images and locks attached to the next candidate. Never claim a lock was honored when its reference did not reach the generation node.

Candidate review must be grounded in the actual returned media. A Prompt, provider, model name, seed, or candidate label is not visual evidence. Bind the review to the current safe URL, asset ID, or content hash; mark composition, identity, product shape, continuity, rhythm, and text accuracy separately. Identity, product shape, continuity, and text accuracy are hard gates. Accepting a result automatically records the relevant continuity locks.

For a character reference, prefer a white sheet with a face close-up on the left and front/side/back views on the right. Keep a clothing design asset clothing-only unless the user explicitly requests a character-worn preview.

## Video

Convert the goal into shots. Define subject, action, environment, camera, framing, duration, first/last frames, audio, and continuity.

Prefer preview-quality previsualization before high-quality full generation. Retry one failed shot without rerunning accepted shots.

Check identity, wardrobe, prop, gaze, pose, light, weather, screen direction, encoding, frame rate, color, audio, and duration continuity.

For each shot, make the motion readable: one primary subject action, one camera intention, a clear beginning and ending state, and a reason the shot belongs in the sequence. Use first/last-frame or accepted keyframe assets when continuity is more important than visual novelty.

For a reference-video shot breakdown, bind one verified project video and preserve its asset ID, content revision, hash, MIME, byte size, and safe project media reference. Analyze controlled timestamped frames with a verified vision model. If the live catalog proves `seedance-nz/whisper-1` executable, the plan may add one optional video-to-Whisper evidence branch; otherwise show the non-blocking reason and keep frames-only analysis.

Ask Whisper for `verbose_json`, but do not assume the Provider will include segments. When the actual response contains valid `start/end/text` windows, preserve the bounded structured segments and format them as speech-window evidence. If the response has no valid segments, treat the plain transcript as whole-video `untimed` evidence.

When the analysis node returns, import the structured breakdown only if the node's analysis mode, output schema, asset ID, content revision, and SHA-256 all match the current reference video, and the result repeats that exact `sourceAsset`. Accept only valid `HH:MM:SS.mmm` intervals, recompute duration from those intervals, and copy only the bounded editable summary, shot, limitation, and evidence fields. Keep malformed or cross-source text in its original node for diagnosis but never write it into the production document. If a matching workflow already exists, review or recover it rather than creating a second workflow.

Execution evidence is verified only from a bounded same-project, same-canvas Run search whose exact NodeRun identity belongs to that Run and whose replayable input snapshot binds the same analysis mode, output schema, source asset ID, content revision, and SHA-256. When the current node carries a request ID, the matching Attempt must carry that exact request ID. A successful target NodeRun and Attempt may be verified while unrelated nodes keep the group Run active; pending, failed, invalid, and unavailable ledgers remain visibly distinct. This execution binding proves the returned text's run lineage, not that a physical image, video, or audio artifact exists.

A Provider segment is not word timing or an exact edit boundary. It may support a conservative dialogue or narration reference only when its window overlaps an approximate frame-derived shot interval. Never infer a speaker. Keep music, ambience, and SFX unknown because speech transcription does not prove those facts.

Planning and preview must not submit either model. Show the exact nodes and connections first, then use the normal Canvas approval and Run preflight boundaries.

Judge a video at three levels:

- frame: anatomy, detail, text, artifacts, exposure;
- shot: motion, camera, timing, subject stability, audio;
- sequence: geography, eyeline, screen direction, wardrobe, props, rhythm, and emotional escalation.

Do not upscale or compose until the shot-level direction is accepted.

## Script and Story

Work progressively:

1. CreativeBrief
2. directions and logline
3. characters and relationships
4. outline and beats
5. scenes and dialogue
6. shot list
7. asset breakdown
8. prompts
9. storyboard
10. video and edit

Entering asset preparation creates a missing-asset list; it does not generate automatically. Generate missing assets only after the user reviews uploads, library selections, locks, and the batch plan.

Keep Story, Director, VideoEdit, and normal canvas nodes on the same asset IDs, provider/model selections, run evidence, and version lineage.

Keep language, image, and video platform/model selections separate. A script-model change must not silently replace the image or video model.

For scripts, protect meaning before visual detail. Track premise, protagonist goal, obstacle, stakes, scene objective, turn, and consequence. Every scene should change knowledge, power, relationship, location, or risk; otherwise propose combining or removing it. Preserve the user's voice and distinguish requested rewriting from optional editorial notes.

For Story continuation:

1. create or find the existing Story;
2. inspect it before editing;
3. import editable scenes, stable shots, source spans, and missing assets without a Provider call;
4. bind uploads or project assets first;
5. compile prompts locally;
6. create up to three different 1K shot previews;
7. compare and accept a keyframe, then lock and adopt it into the Story;
8. materialize the same stable shot IDs into Director;
9. generate only missing/failed/unlocked shots;
10. compose and verify the persisted delivery artifact.

Use `create story --file` for long UTF-8 scripts. Initial Story planning already performs deterministic local scene/shot/asset/audio extraction in the same no-write plan. Use `story analyze` only to explicitly re-analyze an existing Story after its script changes, and `story import` for an externally prepared structured plan. `--candidates 3` explores one item; `story plan-previews` previews distinct shots.

Use Creator Sessions when the creator speaks naturally:

- `ask` infers image, video, audio, script, or Story and a suitable recipe;
- `continue` restores the exact instance/project/canvas and appends a new direction without losing the original brief;
- the Agent translates `ask` and `continue` results into creator language; the creator never needs to run those commands;
- an imported persistent asset may start through `ask --asset <assetId>` with no text; resolve the ID internally, use only the safe project media reference, and let the shared Session rule infer the analysis kind and recipe;
- the session list hides the full prompt while keeping only a bounded local locator and recovery cache;
- the backend Creator Session is the sole cross-entry authority: Canvas, Codex, `zcanvas`, and another paired local Agent must refresh the exact session/project/canvas before deciding the current plan, approval evidence, production phase, lineage, Runs, verification, or delivery;
- a missing backend session or any scope mismatch fails closed instead of reconstructing a second production; durable approval decisions may be observed across entries, but approval authority and secrets remain caller-bound;
- the session layer can only create the same preview-first CreativePlan used by exact commands.

Use a project recipe when the creator wants a repeatable house style. A recipe can carry the director style, character/product bible, shot grammar, negative rules, production stages, review dimensions, and separate model/provider defaults. Save a new immutable version, verify its digest/signature, and pin the version used by `ask`. Updating the Desktop or Skill must not overwrite project recipes. An explicit import may be re-signed for the destination project, but its trust status must remain visible.

For non-destructive editing, pass a persistent project `assetId` to `edit image` or `edit video`. The edit creates candidates and explicitly instructs the generation node to preserve every part not named by the creator. It never overwrites the source asset.

Audio model discovery and `create audio` cover the current Audio node's proven Suno v5.5 generate/cover/extend and Seed Audio routes. Cover and extend require a persistent audio asset. One-line requests distinguish music, dialogue, voiceover, ambience, SFX, and transcription. Proven Grok OAuth `xai-tts` and `xai-stt` workflows preserve voice/language/output settings and require login; STT requires a persistent audio asset.

For Story, preserve dialogue/voiceover, ambience, and SFX as separate editable layers. Route dialogue and voiceover to the proven TTS workflow; route ambience/SFX to the selected Audio model. Keep output format, sample rate, source asset, lineage, and license status with each planned layer. License status defaults to `unknown`, never inferred.

For a request such as “让这张人物照片跟着旁白音频说话”, infer a video lip-sync task before generic image/audio editing. Bind exactly one persistent image and one persistent audio asset to the proven FAL Toolbox `creatify-aurora-fal` contract, keep the workflow editable, and stop before Provider submission. Never guess the source pair or substitute a different tool when either kind is missing.

## Cross-media production

Connect script, shots, character/scene/prop/wardrobe/audio assets, image previews, videos, voices, music, subtitles, edit, and export.

Persist every stage as an editable project artifact. Show downstream impact before changing an upstream object.

Accept sources from local upload, project assets, current Chrome selection, Photoshop current layer, or existing canvas output only with visible source and authorization.

Before handoff, use `delivery collect` to find persistent, hash-verifiable results. Use `delivery package` only after the creator reviews the exact set and license warnings. Keep image, video, audio, text, master, proxy, and unknown rendition roles separate; do not invent a master/proxy designation. Save the independently returned package digest, then pass it to `delivery verify`. Verification must reject manifest rewrites, unexpected files, links, changed totals, missing assets, and hash changes instead of silently delivering a partial folder.

## Iteration and recovery

Use accepted versions and candidate slots. Regeneration never destroys the accepted result.

When the creator continues with “只把背景换成清晨” or “只重试失败镜头”, compile it into the same Creator Session's incremental plan. Preserve accepted results, uploads, locks, successful attempts, and completed unaffected shots. Story re-analysis may clear only semantically changed shots; omitted derived prompts do not invalidate an otherwise unchanged completed shot.

Offer:

- only missing;
- only failed;
- only unlocked;
- continue from here;
- reuse successful results;
- retry with fallback provider;
- lower specification and retry;
- skip temporarily.

Persist a checkpoint after every successful stage. Never duplicate a Provider submission after an app, Agent, network, or provider interruption.

Canvas replies stream as durable `started` / `delta` / `completed` events and resume by cursor. Partial text remains visible after an interruption, but only a verified completed response may expose an executable plan.

Closing the Canvas panel releases only its foreground stream, polling, and UI resources. The durable reply and linked Runs continue in the backend. Reopening must load the authoritative snapshot of the same Creator Session before replaying missed events from the last confirmed cursor; it must never translate panel close into stop-response or remote cancellation.

Real Run progress also resumes by a per-Run database cursor, but only after the Run is linked to this Creator Session by verified plan and NodeRun evidence. Show the latest meaningful state for each Run or NodeRun instead of flooding the creator with provider poll logs.

For a reference-video breakdown, keep “learn only rhythm” and “extract only camera language” inside the same analysis document. The continue-production suggestion must stay disabled until the current breakdown document, stable content digest, source asset version, and exact Run/NodeRun/Attempt evidence are all verified.

After verification, transform no more than 240 bounded shots—timecodes, camera grammar, action, sound evidence, editable prompts, and unknowns—into an original Story storyboard plan. Preserve source lineage, but do not rerun the Provider, create another breakdown workflow, copy protected characters, brands, dialogue, or distinctive content, or start image/video generation. A patchless review or recovery plan is valid evidence state, not a request to invent a CanvasPatch.

Before any CanvasPatch apply, preview every structural operation from the exact patch: node type, stable node ID and position; edge source/target IDs and port handles; and persistent asset ID, content revision, SHA-256 prefix, target/source ports, and placement position when lineage is involved. A node field patch may show field paths only—never raw before/after values, prompts, URLs, metadata, local paths, or Provider payloads. Keep long previews in a bounded, theme-aware, responsive scroll region, and apply only the same verified preview digest.

When presenting a result, lead with the work itself: which image direction was accepted, which shots are ready, which continuity locks are active, and what creative choice comes next. Put protocol IDs and diagnostics after that.

Keep the lightweight Creator Agent launcher readable before the panel opens: derive `idle`, `replying`, `approval`, `running`, `completed`, or `warning` only from persisted session/reply/approval/Run/error evidence, show a short text label as well as theme color, pause decorative motion when the document is hidden or the full panel is open, anchor from the visible MiniMap geometry with a stable fallback instead of hard-coded theme height, move left of intersecting right-side drawers when safe and leave pointer/focus order when no width remains, expose a persistent creator-controlled effects switch that turns off rotation, blur, panel-entry and other decorative animation without hiding status, use lighter/slower light-mode semantics than dark mode, respect reduced-motion as the strongest constraint, and never equate a completed reply with completed media or delivery.

Render each of the three next suggestions as a compact receipt, not a mystery shortcut: show `expectedEffect`, the exact SuggestionSet Provider-call evidence, and the suggestion's own operation-contract risk/approval boundary before selection. Say “0 model calls” when that is the evidence, never “free”; keep missing evidence unknown or disabled, and remind the creator that later Canvas writes or Provider generation have separate confirmation contracts.

## Object-aware continuation

After the one-sentence start, keep the conversation attached to what the creator is looking at. Summarize no more than 24 priority canvas objects and prefer selected, failed, running, visible, protected, and output objects in that order. Describe an object by creator label, state, result count/kinds, accepted/locked state, and graph neighbors—not by raw prompt or URL.

Choose the turn focus from context sources in a stricter order than the object-summary sort: explicit `@`/`--node` references first, then the live selection, then visible viewport objects, then the current Creator Session phase, and finally the bounded project summary. A global failure, Story phase, or offscreen project state may guide recovery only after higher-priority object focus is absent. Generate the suggestion label, ID, intent, required capabilities, and operation contract from the same focus group so object-specific wording can never carry an unrelated recovery contract.

If a selected object exists, the first three suggestions should refine that object, review its continuity/locks, and continue only its missing or failed scope. If no selection exists but an offscreen object failed, explain where the failure is, repair only that scope, and offer to bring it into view. Otherwise continue the current production phase. Show completed phases, pending phases, and the exact persisted invalidated phase set separately; future work is pending, not automatically affected by a revision.

Recent actions use fixed labels from persisted Creator Session events. They are orientation hints, not authorization.

For a concrete selected-object comparison or downstream-impact decision, resolve only persisted output references from verified recent Runs. Query no more than six project assets and twelve lineage events per asset. Prefer current-canvas lineage and show a compact local filmstrip with lazy thumbnails, first frames, contact sheets, or waveforms.

Lineage in the Creator Session is a safe structural receipt, never the raw media record: keep asset/relation/source/Run identifiers and derived-operation names, but exclude prompts, signed URLs, preview URLs, local paths, metadata, and Provider responses. Preview media remains UI-local.

Use a lineage source-node link to focus the originating canvas node. If one source cannot be read, preserve the other results and explain that existing work is safe. Do not convert a read failure into regeneration.

### Explicit Canvas references

Use `@ 引用选区` when the creator wants the next instruction bound to a specific node instead of whichever node happens to remain selected. Explicit references outrank the live selection, survive selection changes during the current turn, and remain individually removable.

Pin at most eight nodes. If a pinned node has available persisted Run output, attach only its stable project asset ID and `/api/project-assets/<id>/media` reference; never copy a local path, signed Provider URL, source locator, Base64 body, or private filename into the Creator Session. Deduplicate these references with manually uploaded attachments and keep the shared 16-attachment ceiling.

If no persisted output exists, retain the node identity and type as semantic context but do not claim media was attached. A completed turn clears the pins; stopped, failed, or offline-recoverable turns keep them. Removing a pin affects only the current message context and never deletes the Canvas node or asset.

Codex and other local Agents use this same context through `zcanvas ask "<request>" --node <id>,<id>`. Resolve the IDs internally from the bound current Canvas, never expose them as a creator prerequisite. The Agent Control plan route must reject missing or cross-canvas references before planning, revalidate them during Creator Session synchronization, and derive node types from the authoritative Canvas document without copying node data or prompts.

For an unapplied plan, a `continue` refinement keeps its existing references unless replacements are supplied. After production has been applied, a new continuation clears stale references unless the creator explicitly chooses nodes again. Store those supporting IDs in the structured incremental plan while keeping the original Story or production node as the only Patch target.
