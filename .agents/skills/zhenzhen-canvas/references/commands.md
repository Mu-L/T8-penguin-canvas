# Command reference

## Contents

1. Invocation
2. Connect and bind
3. Plan and create
4. Compare and continue
5. Run and verify
6. Composition rules

## Invocation

Always invoke the bundled wrapper and pass each value as a separate argument:

```text
node <skill-dir>/scripts/zcanvas.cjs <command> [subcommand] [flags]
```

The wrapper resolves the CLI from `ZCANVAS_CLI`, the current project, or `PATH`. It never uses a shell.

CLI output defaults to one JSON object on stdout. Use `--human` only when a person explicitly wants formatted terminal help.

## Connect and bind

Use:

```text
zcanvas status
zcanvas app list
zcanvas auth pair
zcanvas auth complete
zcanvas workspace list
zcanvas workspace use --canvas <canvasId>
zcanvas doctor inspect
zcanvas doctor validate
zcanvas doctor simulate
zcanvas doctor simulate --file <absolute-execution-proposal.json>
```

Pairing grants scoped local access; it is not approval for a write or generation run.

`doctor simulate` uses the Desktop's authoritative node schemas and current
revision to return the execution batches, blocking diagnostics, executable node
count, and runtime-only uncertainty. With no file it simulates the current
canvas. With `--file` it simulates the supplied bounded execution proposal
entirely in memory. Both forms perform zero canvas writes and zero Provider
calls; they do not estimate price.

Use `skill install|update|rollback|verify|uninstall` for the current-user Skill/CLI copy. A versioned local bundle can be installed with `--bundle <absolute-directory> --sha256 <whole-bundle-digest>`. Update is atomic and keeps the previous verified install as last-known-good.

## Plan and create

Discover real choices first:

```text
zcanvas model list --kind llm
zcanvas model search --kind image --query gpt-image-2
zcanvas model schema --model zhenzhen-image-g2-t2i
zcanvas asset search --kind image --query "角色参考"
```

Create a no-write plan card:

```text
zcanvas create plan-card --type image --prompt "电影感角色海报"
```

Create editable workflows:

```text
zcanvas create image --prompt "雨夜女侦探" --ratio 16:9 --profile balanced --candidates 3 --template character-sheet
zcanvas create video --prompt "人物走出电梯" --duration 8 --ratio 16:9 --profile economy
zcanvas ask "让这张人物照片跟着旁白音频自然对口型" --asset <imageAssetId>,<audioAssetId>
zcanvas create audio --prompt "雨夜悬疑配乐" --audio-model suno-v5.5-generate
zcanvas ask "用温和女声朗读这段产品旁白" --voice eve --output-format wav
zcanvas ask "把这段采访音频转成中文文字" --asset <audioAssetId>
zcanvas create script --prompt "两名特工在雨夜对峙" --audience "悬疑短片观众" --language 中文
zcanvas create story --file "D:\创作\唐人街巷战.txt" --duration 60 --ratio 16:9 --llm-model gemini-3.5-flash --image-model zhenzhen-image-g2-t2i --video-model doubao-seedance-2-0-fast-260128
zcanvas edit image --asset <assetId> --prompt "只把纸船换成白色爱心，人物与构图不变"
zcanvas edit video --asset <assetId> --prompt "保留人物动作，只把环境改成雨夜"
```

Use `--llm-provider/--llm-model`, `--image-provider/--image-model`, `--video-provider/--video-model`, and `--audio-provider/--audio-model` for separate routing. Do not use an unlisted provider or guess a model name.

For one-line creator sessions and editable recipes:

```text
zcanvas ask "为透明折叠伞做20秒竖屏雨季广告，复用已有 logo"
zcanvas ask --asset <assetId>
zcanvas ask "只调整这两个节点的构图，其他保持不变" --node <nodeId>,<nodeId>
zcanvas continue --session <creatorSessionId> --prompt "继续采用的方向，只把背景换成清晨"
zcanvas continue --session <creatorSessionId> --prompt "参考这两个节点，只修改背景" --node <nodeId>,<nodeId>
zcanvas create story --recipe short-drama --prompt "雨夜追逐"
```

These are internal Agent commands. The creator gives one natural-language request; the Agent runs `ask`, presents the inferred assumptions and analysis, and internally resumes the same session after conversational confirmation. Do not ask the creator to copy a session ID or run `continue`.
For attachment-only start, first resolve the creator's imported project asset to
its stable ID, then use `ask --asset`; never expose the ID or persist a local path.
For explicit Canvas references, resolve at most eight nodes from the current workspace and use `ask --node`; the server revalidates their canvas membership and derives their types. Never ask the creator to provide node IDs, and never copy node data or prompts into the request.
For `continue`, preserve references while refining an unapplied plan, but clear old references for a new post-apply turn unless the creator explicitly selects them again. Referenced nodes support the incremental plan; they do not replace its one authoritative production-node write target.

Built-in editable recipes include `short-drama`, `tvc`, `mv`, `product`, `education`, `remake`, `character-sheet`, and `storyboard`.

Project-owned recipes keep production preferences across Skill/Desktop updates:

```text
zcanvas recipe save --name rain-director --file "D:\创作\rain-director.json"
zcanvas recipe list
zcanvas recipe show --name rain-director
zcanvas recipe pin --name rain-director --revision 2
zcanvas recipe rollback --name rain-director
zcanvas recipe export --name rain-director --to "D:\创作\rain-director.export.json"
zcanvas recipe import --file "D:\创作\rain-director.export.json"
zcanvas recipe verify
zcanvas ask "把这段剧本做成30秒竖屏短片" --recipe rain-director
```

A recipe JSON uses `t8-creator-recipe-v1`. It may define `kind`, `defaults` (duration, ratio, profile, template, locks, and separate model/provider defaults), `guidance` (director style, character/product bible, shot grammar, negative rules), `stages`, `reviewDimensions`, and Desktop compatibility. The project store versions and pins each save. An invalid digest/signature or unknown recipe stops planning.

The first mutating command creates a desktop approval preview. After the user approves it, rerun the same command. The CLI completes the stored approval and does not create a second plan. Use `--plan-only` to stop before approval.

## Compare and continue

Use:

```text
zcanvas iterate compare --node <candidateNodeId>
zcanvas iterate review --node <candidateNodeId> --file <absolute-visual-review.json>
zcanvas iterate accept --node <candidateNodeId> --lock identity,wardrobe
zcanvas iterate lock --node <candidateNodeId> --lock identity,wardrobe,background
zcanvas iterate branch --node <candidateNodeId> --label "冷色探索"
zcanvas iterate rollback --node <candidateNodeId>
zcanvas story inspect --story <storyNodeId>
zcanvas story analyze --story <storyNodeId>
zcanvas story import --story <storyNodeId> --file "D:\创作\唐人街巷战.plan.json"
zcanvas story bind-asset --story <storyNodeId> --asset <projectAssetId> --to <storyAssetId>
zcanvas story compile --story <storyNodeId>
zcanvas story plan-previews --story <storyNodeId>
zcanvas story adopt-preview --story <storyNodeId> --shot <shotId> --candidate <acceptedImageNodeId>
zcanvas director inspect --story <storyNodeId>
zcanvas director materialize --story <storyNodeId>
zcanvas video-edit compose --node <directorNodeId>
zcanvas video-edit deliver --node <videoEditNodeId>
```

`compare` returns a media contact sheet with safe result references, creative directions, Prompt summaries, size/quality metadata, locks, technical QA, actual-media review coverage, and hard-gate failures. If `requiresVisualReview` is true, inspect the real media before discussing quality. `iterate review` accepts a bounded JSON object with `schema: t8-creative-review-v1`, `source: visual-inspection`, matching URL/assetId/contentHash evidence, and per-dimension `pass|warn|fail|unknown`; it cannot be filled from Prompt or model names. `iterate accept` automatically adds relevant continuity locks, while explicit `--lock` adds more. `inspect` and `deliver` are read-only. Other commands require an authoritative preview and approval. Story materialization reuses stable shot IDs and patches an existing Director/VideoEdit node instead of duplicating it.

`story import` accepts a UTF-8 JSON object with editable `scenes`, `shots`, and `assets`. Each shot should keep a stable `id`, the exact `sourceText` it covers, a clear visual description, duration, and referenced asset IDs. Importing does not call a model or generate media. It preserves locked fields and already-backed assets, and invalidates only content whose meaning changed.

`story bind-asset` connects an existing project image to a Story character, scene, prop, or costume. `story plan-previews` creates up to three different 1K shot previews; it does not mean three variations of one shot. After an image node is generated and accepted, `story adopt-preview` turns it into a locked Story keyframe asset for that shot.

Pass an accepted image candidate node ID or project asset ID through `create image --asset <id>` when identity, wardrobe, product, or scene continuity matters. An unaccepted candidate, cross-project asset, non-image asset, or missing persistent result is rejected rather than silently ignored.

Place an already persisted project asset on the canvas without importing or generating it:

```text
zcanvas asset inspect --asset <assetId>
zcanvas asset place --asset <assetId> [--x 120 --y 240 --target <nodeId> --target-handle <port>]
zcanvas asset place-apply
```

`asset place` creates an L1 preview containing the deterministic node, position, optional edge, stable asset/content hash, and lineage source. It performs no Provider call, external file read, or asset transfer. After the canvas user approves that exact preview, `place-apply` completes the stored request; an exact retry recovers the same result instead of adding another node.

## Run and verify

Use:

```text
zcanvas run plan --node <nodeId>
zcanvas run start --plan <planId>
zcanvas run watch --intent <intentId>
zcanvas run resume --intent <intentId> --cursor <lastCursor>
zcanvas run retry --intent <intentId> --only-failed
zcanvas run cancel --intent <intentId>
```

Provider transfer and generation require a separate confirmation. `watch` follows the durable intent by default, emits each changed durable state immediately with a cursor and stage, and can resume after interruption. A completed provider task is not a successful creative result until each managed file is opened safely, re-hashed, magic/MIME checked, parser evidence inspected, and linked to the exact run, node run, attempt, canvas revision, source node, and shot when present.

Collect and package cross-media delivery:

```text
zcanvas delivery collect --scope canvas
zcanvas delivery collect --scope project
zcanvas delivery package --scope project --to "D:\交付\项目名-v1"
zcanvas delivery apply
zcanvas delivery verify --from "D:\交付\项目名-v1" --digest <packageDigest-returned-by-apply>
```

`collect` reads and hashes only persistent project assets. `package`/`download` creates one L2 preview containing the exact asset IDs, hashes, destination basename, rendition roles, and license status; after approval, `apply` atomically creates a new directory without overwriting. Save the returned `packageDigest` outside the package. `verify` requires that pinned digest, rejects extra files/directories/links, re-enumerates the exact allowlist, re-hashes every file, and recomputes item/byte totals without downloading again. Unproven master/proxy/license metadata stays `unknown`; do not infer it.

Advanced graph changes remain preview-first:

```text
zcanvas graph add --type image [--x 120 --y 240 --file "D:\创作\image-node.json"]
zcanvas graph add --type text --prompt "建立角色一致性参考"
zcanvas graph connect --source <nodeId> --target <nodeId>
zcanvas graph disconnect --edge <edgeId>
zcanvas graph group --nodes <nodeId,nodeId> --name "角色参考"
zcanvas graph batch --file <patch.json>
```

`graph add` accepts only creator-visible node types from the authoritative
Canvas Node Schema. Initial JSON must be an absolute, regular, non-symlink
file containing one bounded object. Schema-marked generatable nodes accept
only their declared generation fields; other visible nodes are created empty
for configuration in the node UI. Planning and preview make no write, and the
approved apply is reversible L1. Adding a node does not run it, verify it, or
call a Provider.

Use `asset inspect|version|lineage|place|place-apply|import|download|apply`, `delivery collect|package|apply|verify`, `patch preview|apply|history|revert`, and `browser status|open|focus|highlight|screenshot|inspect-visible-error` for evidence and handoff. Browser responses are handoffs with `executed:false`; a host Chrome capability must perform and prove the visible action.

## Composition rules

- Parse stdout as JSON or line-delimited JSON; never parse progress text.
- Read stderr only for progress and diagnostics.
- Do not run parallel producers into one shared NDJSON pipe.
- Pass prompts, paths, node names, and IDs as argv values; never interpolate them into a shell command.
- Re-inspect the revision after another Agent or the creator changes the canvas.
