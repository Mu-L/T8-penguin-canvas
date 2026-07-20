# T8 Node Map Planning Notes

> Planning-only notes for future node and canvas interaction work. This file records design direction; it is not an implementation checklist unless the user explicitly starts development.

## 2026-07-07 - Photoshop Link Plugin And Canvas Interaction Mode

### Current Request Boundary

- Goal: plan a Photoshop linkage plugin and matching T8 canvas interaction mode.
- Status: planning only; no feature development in this round.
- Reference project: `E:\PenguinPravite\Infinite-Canvas\tools\photoshop-asset-connector`.
- Subagent review completed: Infinite-Canvas uses a Photoshop UXP panel plus backend REST/WebSocket bridge, not CEP and not an embedded canvas inside Photoshop.

### What Infinite-Canvas Already Does

Infinite-Canvas Photoshop connector has four top-level tabs:

- Assets: browse image assets, canvas assets, and local materials; place selected images into Photoshop; export the current Photoshop document/layer back to the backend.
- Generate: API / ModelScope / RunningHub / ComfyUI generation surface.
- Agent: chat-based generation and image editing surface.
- Settings: backend host, realtime sync, and export scope.

Important finding: Infinite-Canvas is not only a send-image plugin. It has generation-related code:

- `js/generate.js` loads image providers through `/api/providers` and `/api/image-params`, submits API/ModelScope jobs through `/api/canvas-image-tasks`, supports RunningHub workflows through `/api/runninghub/workflow-submit` and `/api/runninghub/query`, supports ComfyUI workflows through `/api/workflows` and `/api/canvas-comfy-tasks`, and places generated results into Photoshop layers.
- `js/agent.js` uses `/api/chat/agent` for conversation, image generation, and image editing; generated images can be automatically placed into Photoshop layers.
- `README.md` still marks the Generate/Workflow direction as roadmap-like work, so the implementation should be treated as a reference/prototype until verified with the matching backend and real workflows.

### T8 Direction

T8 should not copy the Infinite-Canvas connector wholesale. T8 already has better local bridge precedents:

- Figma bridge: local queue bridge, plugin import instructions, auto-start, and claim/complete flow.
- VibeX/Web Image bridge: external result queue, payload normalization, and canvas-side pending drain that creates material nodes.

Recommended T8 architecture:

```text
Photoshop UXP panel
  -> HTTP local bridge / polling / upload
T8 backend /api/photoshop-bridge
  -> pending queues / media library / upload handling
T8 canvas PS interaction mode
  -> node creation / selected material sending / resource save options
T8 workflow nodes
```

### MVP Scope

First release should focus on a stable image round trip:

- T8 to Photoshop: browse recent outputs, upload materials, and resource-library images; place selected image into Photoshop as a layer or new document.
- Photoshop to T8: export current document or current active layer as PNG; upload to T8; create an output material node on the current canvas.
- Canvas mode: add a PS link panel/drawer showing connection status, current document summary, import destination, and recent Photoshop imports.
- Send actions: add "Send to Photoshop" from output/upload/resource material surfaces after the bridge is stable.
- Security: default to `127.0.0.1`; no open LAN mode in MVP unless a pairing token and explicit setting are added.

MVP should not include:

- Full Photoshop layer tree sync.
- Layer position round-trip between Photoshop and T8.
- Video placement.
- Default LAN access with `network.domains: "all"` behavior.
- Generate/Agent panels inside the Photoshop plugin.

### Generation As Phase 2+

Because Infinite-Canvas already has Generate and Agent surfaces, T8 should reserve this as a later phase instead of ignoring it:

- Phase 2: add a lightweight "Generate from Photoshop" tab that reuses T8 backend provider settings and image schemas instead of duplicating provider configuration in the plugin.
- Phase 2 behavior: prompt/reference image from current PS layer -> T8 generation route -> generated result appears as a PS layer and optionally as a T8 output node.
- Phase 3: Agent-style chat/editing, where the current PS document/layer can be attached as context, and returned images can be inserted into PS plus saved back to T8.
- Guardrail: generation in the Photoshop plugin should remain a thin client. All model keys, provider routing, task polling, and file persistence should stay in the T8 backend.

### Proposed Backend Contracts

- `GET /api/photoshop-bridge/status`: bridge health, plugin version, pending counts.
- `GET /api/photoshop-bridge/library`: T8 image material feed for the plugin.
- `POST /api/photoshop-bridge/upload-base64`: receive exported Photoshop PNG data without a small JSON body limit.
- `POST /api/photoshop-bridge/messages`: Photoshop to T8 event queue.
- `GET /api/photoshop-bridge/pending`: canvas drains Photoshop-originated imports.
- Later: `POST /api/photoshop-bridge/commands` and `POST /api/photoshop-bridge/claim` for T8 to Photoshop push commands.

### Proposed Files When Development Starts

- `tools/photoshop-bridge/plugin/manifest.json`
- `tools/photoshop-bridge/plugin/index.html`
- `tools/photoshop-bridge/plugin/style.css`
- `tools/photoshop-bridge/plugin/js/state.js`
- `tools/photoshop-bridge/plugin/js/net.js`
- `tools/photoshop-bridge/plugin/js/ps.js`
- `tools/photoshop-bridge/plugin/js/app.js`
- `backend/src/routes/photoshopBridge.js`
- `src/utils/photoshopBridge.ts`
- Canvas integration in `src/components/Canvas.tsx`
- Send modal/resource/output surface integration after the base bridge is stable
- Electron packaging entry under `package.json` `build.extraResources`
- Post-build verification in `electron/_post_build.cjs`

### Verification Plan When Development Starts

- Static route tests for `photoshopBridge`.
- Payload normalization tests for Photoshop imports.
- Canvas pending-drain tests that create output material nodes from Photoshop payloads.
- Packaging tests ensuring the UXP plugin is included in Electron resources.
- Manual Photoshop UXP smoke through UDT: load plugin, connect to T8, place T8 image into PS, export active layer back to T8.

### 2026-07-07 Development Follow-up

- Status: implementation started after the later "开工" instruction.
- T8 Photoshop plugin scope was adjusted from the original MVP: the plugin now includes `资产 / 生成 / 设置` tabs, still deliberately excluding Agent.
- Generate tab is a thin client over T8 backend provider settings and `/api/photoshop-bridge/image`; it supports text-to-image and current-layer image editing, then can place results back into Photoshop and optionally sync output nodes to the current T8 canvas.
- Backend bridge now owns provider routing, output saving, pending queue messages, and base64 upload handling; API keys stay in T8 settings and are not stored by the UXP plugin.
