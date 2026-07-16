import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CircleUserRound, GitFork, Loader2, MessageSquare, Play, RefreshCw, Send, Shield, Upload, Users, X } from 'lucide-react';
import type { VersionedCanvasData, WorkspaceCapability, WorkspaceRole } from '../types/project';
import type { SubflowDefinition } from '../utils/subflows';
import CollaborationAssetUpload from './CollaborationAssetUpload';

interface Session {
  id?: string;
  projectId: string;
  memberId: string;
  displayName: string;
  role: WorkspaceRole;
  capabilities: WorkspaceCapability[];
}

interface CanvasSummary { id: string; name: string; revision?: number }
interface ReviewThread { id: string; anchor: { kind: string; nodeId?: string }; status: string; severity: string; comments?: Array<{ id: string; body: string; createdBy: string; createdAt: number }> }
interface Presence { memberId: string; displayName: string; cursor?: { x: number; y: number }; selectedNodeIds?: string[] }
interface SharedRunAsset { id: string; kind: string; filename: string; mimeType: string; mediaUrl: string | null }
interface SharedRunState {
  id: string;
  status: string;
  initiatorId?: string;
  createdAt?: number;
  updatedAt?: number;
  assets: SharedRunAsset[];
  nodeStates: Record<string, string>;
}
interface SubflowPublicationDraft {
  definition: SubflowDefinition;
  baseRevision: number;
  name: string;
  description: string;
  changeSummary: string;
  conflict?: { revision: number; latestVersion: number; definition: SubflowDefinition };
}

async function collabRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
  return data.data as T;
}

function displayNode(node: Node): Node {
  const originalType = String(node.type || 'unknown');
  const data = (node.data || {}) as Record<string, unknown>;
  const label = String(data.label || data.title || data.name || `${originalType} · ${node.id.slice(-8)}`);
  return {
    ...node,
    type: 'default',
    data: { ...data, label, __collaborationOriginalType: originalType },
    style: {
      width: Math.max(180, Number(node.width || node.measured?.width || 220)),
      minHeight: 64,
      border: '2px solid var(--border-primary)',
      borderRadius: 6,
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
      fontSize: 12,
      ...(node.style || {}),
    },
  };
}

function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [canvasId, setCanvasId] = useState('');
  const [document, setDocument] = useState<VersionedCanvasData | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [reviews, setReviews] = useState<ReviewThread[]>([]);
  const [comment, setComment] = useState('');
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [sharedRuns, setSharedRuns] = useState<Record<string, SharedRunState>>({});
  const [subflows, setSubflows] = useState<SubflowDefinition[]>([]);
  const [subflowDraft, setSubflowDraft] = useState<SubflowPublicationDraft | null>(null);
  const [status, setStatus] = useState('正在连接协作网关…');
  const [busy, setBusy] = useState(true);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('t8-collab-display-name') || `访客-${Math.random().toString(36).slice(2, 6)}`);
  const webSocketRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(1);
  const pointerSentAtRef = useRef(0);
  const canEdit = session?.capabilities.includes('editGraph') || false;
  const canPublishSubflow = session?.capabilities.includes('publishSubflow') || false;
  const canComment = session?.capabilities.includes('comment') || false;
  const canRun = session?.capabilities.includes('runWorkflow') || false;
  const canApprove = session?.capabilities.includes('approve') || false;
  const canUploadAsset = session?.capabilities.includes('uploadAsset') || false;

  const loadCanvas = useCallback(async (id: string) => {
    if (!id) return;
    setBusy(true);
    try {
      const next = await collabRequest<VersionedCanvasData>(`/api/collab/canvases/${encodeURIComponent(id)}`);
      setDocument(next);
      setNodes((next.nodes || []).map(displayNode));
      setCanvasId(id);
      setSharedRuns({});
      setSelectedNodeId('');
      setReviews(await collabRequest<ReviewThread[]>(`/api/collab/reviews?canvasId=${encodeURIComponent(id)}`));
      setStatus(`已同步 revision ${next.revision}`);
      if (webSocketRef.current?.readyState === WebSocket.OPEN) {
        webSocketRef.current.send(JSON.stringify({ type: 'canvas.join', canvasId: id }));
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, []);

  const loadSubflows = useCallback(async () => {
    setSubflows(await collabRequest<SubflowDefinition[]>('/api/collab/subflows'));
  }, []);

  const bootstrap = useCallback(async () => {
    setBusy(true);
    try {
      let nextSession: Session;
      try {
        nextSession = await collabRequest<Session>('/api/collab/session');
      } catch {
        const invite = new URLSearchParams(location.search).get('invite');
        if (!invite) throw new Error('邀请链接缺少 invite 参数');
        localStorage.setItem('t8-collab-display-name', displayName.trim() || '访客');
        nextSession = await collabRequest<Session>('/api/collab/invites/redeem', {
          method: 'POST',
          body: JSON.stringify({ code: invite, displayName: displayName.trim() || '访客' }),
        });
      }
      setSession(nextSession);
      const [nextCanvases, nextSubflows] = await Promise.all([
        collabRequest<CanvasSummary[]>('/api/collab/canvases'),
        collabRequest<SubflowDefinition[]>('/api/collab/subflows'),
      ]);
      setCanvases(nextCanvases);
      setSubflows(nextSubflows);
      if (nextCanvases[0]) await loadCanvas(nextCanvases[0].id);
      else setStatus('项目中还没有可访问画布');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, [displayName, loadCanvas, loadSubflows]);

  useEffect(() => { void bootstrap(); }, []); // 邀请只兑换一次，避免输入昵称时重复消耗次数

  useEffect(() => {
    if (!session) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/collab`);
    webSocketRef.current = socket;
    socket.onopen = () => { if (canvasId) socket.send(JSON.stringify({ type: 'canvas.join', canvasId })); };
    socket.onmessage = (event) => {
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'canvas.operations' && message.canvasId === canvasId) void loadCanvas(canvasId);
      if (message.type === 'subflow.published') {
        void loadSubflows();
        const publication = message.publication || {};
        setStatus(`${publication.publishedBy || '协作者'} 已发布 ${publication.name || publication.id} v${publication.version} / revision ${publication.revision}`);
      }
      if (message.type === 'review.created' || message.type === 'review.updated' || message.type === 'review.comment') {
        if (canvasId) void collabRequest<ReviewThread[]>(`/api/collab/reviews?canvasId=${encodeURIComponent(canvasId)}`).then(setReviews);
      }
      if (message.type === 'run.intent-state' && message.intent?.canvasId === canvasId) {
        const intent = message.intent;
        setStatus(`运行请求 ${String(intent.id).slice(0, 8)}：${intent.status}${intent.runId ? ` · Run ${String(intent.runId).slice(0, 8)}` : ''}`);
      }
      if (message.type === 'run.state' && message.run?.canvasId === canvasId) {
        const run = message.run;
        setSharedRuns((current) => ({
          ...current,
          [run.id]: {
            ...(current[run.id] || { assets: [], nodeStates: {} }),
            id: run.id,
            status: run.status,
            initiatorId: run.initiatorId,
            createdAt: run.createdAt,
            updatedAt: message.timestamp,
          },
        }));
        setStatus(`主机 Run ${String(run.id).slice(0, 8)}：${run.status}`);
      }
      if (message.type === 'run.node-state' && message.runId && message.node?.id) {
        setSharedRuns((current) => {
          const existing = current[message.runId] || { id: message.runId, status: 'running', assets: [], nodeStates: {} };
          return { ...current, [message.runId]: { ...existing, nodeStates: { ...existing.nodeStates, [message.node.id]: message.node.status }, updatedAt: message.timestamp } };
        });
      }
      if (message.type === 'run.output' && message.runId && Array.isArray(message.assets)) {
        setSharedRuns((current) => {
          const existing = current[message.runId] || { id: message.runId, status: 'running', assets: [], nodeStates: {} };
          const assets = [...existing.assets];
          for (const asset of message.assets as SharedRunAsset[]) {
            if (!assets.some((item) => item.id === asset.id)) assets.push(asset);
          }
          return { ...current, [message.runId]: { ...existing, assets, updatedAt: message.timestamp } };
        });
      }
      if (message.type === 'presence.update' && message.memberId !== session.memberId) setPresence((current) => ({ ...current, [message.memberId]: { memberId: message.memberId, displayName: message.displayName, ...message.presence } }));
      if (message.type === 'presence.left') setPresence((current) => { const next = { ...current }; delete next[message.memberId]; return next; });
    };
    return () => { socket.close(); webSocketRef.current = null; };
  }, [canvasId, loadCanvas, loadSubflows, session]);

  const sendOperations = useCallback(async (operations: Array<{ type: string; payload: Record<string, unknown> }>) => {
    if (!document || !canvasId || !session) return;
    const prepared = operations.map((operation) => ({
      ...operation,
      opId: `${session.memberId}:${Date.now()}:${seqRef.current}`,
      timestamp: Date.now(),
      clientSeq: seqRef.current++,
    }));
    try {
      const result = await collabRequest<{ document: VersionedCanvasData }>(`/api/collab/canvases/${encodeURIComponent(canvasId)}/operations`, {
        method: 'POST', body: JSON.stringify({ baseRevision: document.revision, operations: prepared }),
      });
      setDocument(result.document);
      setNodes(result.document.nodes.map(displayNode));
      setStatus(`已保存 revision ${result.document.revision}`);
    } catch (error: any) {
      if (error?.status === 409) { setStatus('画布已被其他成员更新，正在重新同步…'); await loadCanvas(canvasId); }
      else setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [canvasId, document, loadCanvas, session]);

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const onNodeDragStop: NodeMouseHandler = useCallback((_event, node) => {
    if (!canEdit) return;
    void sendOperations([{ type: 'node.move', payload: { nodeId: node.id, position: node.position } }]);
  }, [canEdit, sendOperations]);

  const selectedThreads = useMemo(() => reviews.filter((thread) => thread.anchor?.nodeId === selectedNodeId), [reviews, selectedNodeId]);
  const submitComment = () => {
    if (!canComment || !comment.trim() || !canvasId) return;
    void collabRequest<ReviewThread>('/api/collab/reviews', { method: 'POST', body: JSON.stringify({ canvasId, anchor: { kind: selectedNodeId ? 'node' : 'canvas', nodeId: selectedNodeId || undefined }, body: comment.trim(), severity: 'normal' }) })
      .then(() => collabRequest<ReviewThread[]>(`/api/collab/reviews?canvasId=${encodeURIComponent(canvasId)}`)).then(setReviews).then(() => setComment('')).catch((error) => setStatus(error.message));
  };

  const updateReview = (threadId: string, nextStatus: 'approved' | 'changes_requested' | 'resolved') => {
    void collabRequest(`/api/collab/reviews/${encodeURIComponent(threadId)}`, {
      method: 'PATCH', body: JSON.stringify({ status: nextStatus }),
    }).then(() => collabRequest<ReviewThread[]>(`/api/collab/reviews?canvasId=${encodeURIComponent(canvasId)}`)).then(setReviews).catch((error) => setStatus(error.message));
  };

  const requestRun = () => {
    if (!canRun || !document) return;
    const selected = nodes.filter((node) => node.selected).map((node) => node.id);
    void collabRequest('/api/collab/run-intents', { method: 'POST', body: JSON.stringify({ canvasId: document.canvasId, canvasRevision: document.revision, nodeIds: selected, idempotencyKey: `remote:${session?.memberId}:${Date.now()}` }) })
      .then(() => setStatus('运行请求已发送给画布所有者')).catch((error) => setStatus(error.message));
  };

  const startSubflowPublication = (definition: SubflowDefinition) => {
    setSubflowDraft({
      definition: typeof structuredClone === 'function' ? structuredClone(definition) : JSON.parse(JSON.stringify(definition)),
      baseRevision: Math.max(1, Number(definition.revision || definition.version) || 1),
      name: definition.name,
      description: definition.description || '',
      changeSummary: '',
    });
  };

  const publishSubflow = async () => {
    if (!canPublishSubflow || !subflowDraft?.name.trim() || !subflowDraft.changeSummary.trim()) return;
    setBusy(true);
    try {
      const saved = await collabRequest<SubflowDefinition>(`/api/collab/subflows/${encodeURIComponent(subflowDraft.definition.id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: subflowDraft.baseRevision,
          changeSummary: subflowDraft.changeSummary.trim(),
          definition: {
            ...subflowDraft.definition,
            name: subflowDraft.name.trim(),
            description: subflowDraft.description.trim(),
          },
        }),
      });
      setSubflowDraft(null);
      await loadSubflows();
      setStatus(`已发布 ${saved.name} v${saved.version} / revision ${saved.revision}`);
    } catch (error: any) {
      const current = error?.status === 409 ? error?.data?.data : null;
      if (current?.definition) {
        setSubflowDraft((draft) => draft ? {
          ...draft,
          conflict: {
            revision: Math.max(1, Number(current.revision) || 1),
            latestVersion: Math.max(1, Number(current.latestVersion) || 1),
            definition: current.definition as SubflowDefinition,
          },
        } : draft);
        setStatus(`发布冲突：服务器已到 v${current.latestVersion} / revision ${current.revision}，当前草稿未丢失`);
      } else setStatus(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const loadLatestSubflowConflict = () => setSubflowDraft((draft) => {
    if (!draft?.conflict) return draft;
    const latest = draft.conflict.definition;
    return {
      definition: typeof structuredClone === 'function' ? structuredClone(latest) : JSON.parse(JSON.stringify(latest)),
      baseRevision: draft.conflict.revision,
      name: latest.name,
      description: latest.description || '',
      changeSummary: '',
    };
  });

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]" onPointerMove={(event) => {
      if (!webSocketRef.current || Date.now() - pointerSentAtRef.current < 90) return;
      pointerSentAtRef.current = Date.now();
      webSocketRef.current.send(JSON.stringify({ type: 'presence.update', presence: { cursor: { x: event.clientX, y: event.clientY }, selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id) } }));
    }}>
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 md:h-14 md:flex-nowrap md:gap-3 md:px-4 md:py-0">
        <Shield size={19} className="text-[var(--accent-primary)]" /><div className="min-w-0 flex-1"><h1 className="text-sm font-bold">T8 协作画布</h1><p className="truncate text-[10px] text-[var(--text-secondary)]">{status}</p></div>
        <select value={canvasId} className="order-3 h-9 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-xs md:order-none md:max-w-56 md:flex-none" onChange={(event) => void loadCanvas(event.target.value)}>{canvases.map((canvas) => <option key={canvas.id} value={canvas.id}>{canvas.name}</option>)}</select>
        <button type="button" className="grid h-9 w-9 place-items-center rounded border border-[var(--border-primary)]" title="重新同步" onClick={() => void loadCanvas(canvasId)}><RefreshCw size={15} /></button>
        {canRun && <button type="button" className="flex h-9 items-center gap-2 rounded bg-[var(--accent-primary)] px-3 text-xs font-bold text-white" onClick={requestRun}><Play size={14} />请求运行</button>}
        <div className="flex min-w-0 max-w-44 items-center gap-2 text-xs"><CircleUserRound size={16} className="shrink-0" /><span className="truncate">{session?.displayName || displayName}</span><span className="shrink-0 opacity-55">{session?.role}</span></div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="relative min-w-0 flex-1">
          {busy && <div className="absolute inset-0 z-20 grid place-items-center bg-black/15"><Loader2 size={26} className="animate-spin" /></div>}
          <ReactFlow nodes={nodes} edges={document?.edges || []} nodesDraggable={canEdit} nodesConnectable={false} elementsSelectable onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onNodeClick={(_event, node) => setSelectedNodeId(node.id)} fitView minZoom={0.05} maxZoom={2}><Background /><Controls /><MiniMap pannable zoomable /></ReactFlow>
          {Object.values(presence).map((member) => member.cursor && <div key={member.memberId} className="pointer-events-none fixed z-30 rounded bg-[var(--accent-primary)] px-2 py-1 text-[10px] font-bold text-white" style={{ left: member.cursor.x + 8, top: member.cursor.y + 8 }}>{member.displayName}</div>)}
        </main>
        <aside className="h-[40vh] w-full shrink-0 overflow-auto border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 md:h-auto md:w-80 md:border-l md:border-t-0">
          <div className="mb-4 flex items-center gap-2"><Users size={16} /><h2 className="text-sm font-bold">协作与审阅</h2><span className="ml-auto text-[10px] opacity-55">{Object.keys(presence).length + 1} 在线</span></div>
          <div className="mb-5 text-xs leading-5 text-[var(--text-secondary)]">{selectedNodeId ? `当前节点：${selectedNodeId}` : '点击节点后可留下锚定评论。'}</div>
          {canUploadAsset && <CollaborationAssetUpload onStatus={(message) => setStatus(message)} />}
          <section className="mb-5 border-y border-[var(--border-primary)] py-4">
            <div className="mb-3 flex items-center gap-2"><Play size={15} /><h3 className="text-xs font-bold">主机权威运行</h3><span className="ml-auto text-[10px] opacity-55">{Object.keys(sharedRuns).length}</span></div>
            <div className="space-y-2">{Object.values(sharedRuns).sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0)).slice(0, 20).map((run) => <article key={run.id} className="rounded border border-[var(--border-primary)] p-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-bold">Run {run.id.slice(0, 12)}</span><span className="shrink-0 text-[10px]">{run.status}</span></div><div className="mt-1 text-[9px] opacity-55">{Object.keys(run.nodeStates).length} 节点状态 · {run.assets.length} 个产物</div>{run.assets.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{run.assets.map((asset) => asset.mediaUrl ? <a key={asset.id} href={asset.mediaUrl} target="_blank" rel="noreferrer" className="max-w-full truncate rounded border border-[var(--border-primary)] px-2 py-1 text-[9px] text-[var(--accent-primary)]">{asset.filename}</a> : <span key={asset.id} title="当前权限仅允许查看素材记录" className="max-w-full truncate rounded border border-[var(--border-primary)] px-2 py-1 text-[9px] opacity-55">{asset.filename}</span>)}</div>}</article>)}{!Object.keys(sharedRuns).length && <div className="py-3 text-center text-[10px] opacity-55">运行状态与产物只接受主机广播</div>}</div>
          </section>
          <section className="mb-5 border-y border-[var(--border-primary)] py-4">
            <div className="mb-3 flex items-center gap-2"><GitFork size={15} /><h3 className="text-xs font-bold">子工作流版本</h3><span className="ml-auto text-[10px] opacity-55">{subflows.length}</span></div>
            <div className="space-y-2">{subflows.map((definition) => <article key={`${definition.id}-${definition.version}`} className="rounded border border-[var(--border-primary)] p-2"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold">{definition.name}</div><div className="mt-1 text-[9px] opacity-55">v{definition.version} · revision {definition.revision || definition.version}</div>{definition.changeSummary && <div className="mt-1 line-clamp-2 text-[10px] text-[var(--text-secondary)]">{definition.changeSummary}</div>}</div>{canPublishSubflow && <button type="button" className="h-8 shrink-0 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold" onClick={() => startSubflowPublication(definition)}>编辑新版本</button>}</div></article>)}{!subflows.length && <div className="py-3 text-center text-[10px] opacity-55">项目暂无子工作流</div>}</div>
            {subflowDraft && (
              <div className="mt-3 rounded border border-[var(--accent-primary)]/50 bg-[var(--bg-primary)] p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-bold">基于 revision {subflowDraft.baseRevision}</span>
                  <button type="button" className="grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)]" aria-label="关闭子工作流草稿" onClick={() => setSubflowDraft(null)}><X size={13} /></button>
                </div>
                <label className="block text-[10px] font-semibold">
                  名称
                  <input value={subflowDraft.name} maxLength={100} className="mt-1 h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-xs" onChange={(event) => setSubflowDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)} />
                </label>
                <label className="mt-2 block text-[10px] font-semibold">
                  说明
                  <textarea value={subflowDraft.description} maxLength={2000} rows={2} className="mt-1 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 text-xs" onChange={(event) => setSubflowDraft((draft) => draft ? { ...draft, description: event.target.value } : draft)} />
                </label>
                <label className="mt-2 block text-[10px] font-semibold">
                  变更说明（必填）
                  <textarea value={subflowDraft.changeSummary} maxLength={500} rows={2} className="mt-1 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 text-xs" onChange={(event) => setSubflowDraft((draft) => draft ? { ...draft, changeSummary: event.target.value } : draft)} />
                </label>
                {subflowDraft.conflict && (
                  <div role="alert" className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[10px] leading-4 text-amber-600">
                    服务器已到 v{subflowDraft.conflict.latestVersion} / revision {subflowDraft.conflict.revision}，草稿未覆盖他人版本。
                    <button type="button" className="mt-2 h-7 w-full rounded border border-amber-500/50 font-bold" onClick={loadLatestSubflowConflict}>放弃草稿并载入最新版本</button>
                  </div>
                )}
                <button type="button" className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-xs font-bold text-white disabled:opacity-40" disabled={busy || !subflowDraft.name.trim() || !subflowDraft.changeSummary.trim()} onClick={() => void publishSubflow()}><Upload size={13} />发布不可变新版本</button>
              </div>
            )}
          </section>
          {canComment && <div className="mb-5"><textarea value={comment} rows={4} maxLength={5000} className="w-full resize-none rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-xs" placeholder="写下修改意见" onChange={(event) => setComment(event.target.value)} /><button type="button" className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-xs font-bold text-white disabled:opacity-40" disabled={!comment.trim()} onClick={submitComment}><Send size={13} />发布评论</button></div>}
          <div className="space-y-3">{selectedThreads.map((thread) => <article key={thread.id} className="border-b border-[var(--border-primary)] pb-3"><div className="mb-2 flex items-center gap-2 text-xs font-bold"><MessageSquare size={13} />{thread.status}</div>{thread.comments?.map((item) => <p key={item.id} className="mb-2 whitespace-pre-wrap text-xs leading-5">{item.body}</p>)}{canApprove && thread.status === 'open' && <div className="mt-2 flex gap-2"><button type="button" className="h-8 rounded bg-green-600 px-3 text-[10px] font-bold text-white" onClick={() => updateReview(thread.id, 'approved')}>批准</button><button type="button" className="h-8 rounded border border-[var(--border-primary)] px-3 text-[10px] font-bold" onClick={() => updateReview(thread.id, 'changes_requested')}>请求修改</button></div>}</article>)}{selectedNodeId && !selectedThreads.length && <div className="py-8 text-center text-xs opacity-55">该节点暂无评论</div>}</div>
        </aside>
      </div>
    </div>
  );
}

export default function CollaborationWorkspace() {
  return <ReactFlowProvider><Workspace /></ReactFlowProvider>;
}
