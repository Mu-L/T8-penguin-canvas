import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, FileDiff, Loader2, RotateCcw, X } from 'lucide-react';

function remainingSeconds(expiresAt: string, now: number) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

function changeLabel(change: NonNullable<T8AgentControlPatchPreview['changes']>[number]) {
  const target = [change.targetType, change.targetId].filter(Boolean).join(' ');
  const fields = Array.isArray(change.fields) && change.fields.length ? ` · ${change.fields.join(', ')}` : '';
  return `${change.type || '修改'} · ${target || '画布'}${fields}`;
}

export default function AgentControlApprovalModal() {
  const [items, setItems] = useState<T8AgentControlApproval[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const item = items[0] || null;

  const refresh = useCallback(async () => {
    const bridge = window.t8pc?.agentControl;
    if (!bridge) return;
    try {
      const result = await bridge.listPendingApprovals();
      if (!result.success) {
        setError(result.message || '无法读取 Agent 操作确认请求');
        return;
      }
      setItems(Array.isArray(result.data) ? result.data : []);
    } catch {
      setError('无法读取 Agent 操作确认请求');
    }
  }, []);

  useEffect(() => {
    if (!window.t8pc?.agentControl) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    setConfirmed(false);
    setError('');
  }, [item?.approvalRequestId]);

  const preview = item?.preview;
  const changes = useMemo(() => (Array.isArray(preview?.changes) ? preview!.changes!.slice(0, 30) : []), [preview]);
  if (!item || !preview) return null;

  const decide = async (decision: 'approve' | 'deny') => {
    if (busy || (decision === 'approve' && !confirmed)) return;
    setBusy(decision);
    setError('');
    try {
      const bridge = window.t8pc!.agentControl!;
      const result = decision === 'approve'
        ? await bridge.approveOperation(item.approvalRequestId)
        : await bridge.denyOperation(item.approvalRequestId);
      if (!result.success) {
        setError(result.message || '处理确认请求失败');
        return;
      }
      setItems((current) => current.filter((entry) => entry.approvalRequestId !== item.approvalRequestId));
    } catch {
      setError('处理确认请求失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  };

  const isRevert = item.action === 'patch.revert';
  const isAssetPlace = item.action === 'asset.place';
  const isAssetImport = item.action === 'asset.import';
  const isAssetDownload = item.action === 'asset.download';
  const isAssetTransfer = isAssetImport || isAssetDownload;
  const isDeliveryPackage = item.action === 'delivery.package';
  const isRun = item.action === 'run.start' || item.action === 'run.retry';
  const isCreative = item.action === 'creative.apply';
  const approvalBinding = item.approvalBinding?.schema === 't8-agent-control-approval-binding-v1'
    ? item.approvalBinding
    : null;
  const providerSelections = Array.isArray(approvalBinding?.boundary.providerSelections)
    ? approvalBinding.boundary.providerSelections.filter((selection) => selection.provider || selection.model)
    : [];
  const digestLabel = (digest?: string | null) => digest ? `${digest.slice(0, 10)}…${digest.slice(-6)}` : '无';
  const actionTitle = isRevert
    ? 'Agent 请求撤销画布修改'
    : isAssetPlace
      ? 'Agent 请求把已保存素材放到画布'
    : isAssetImport
      ? 'Agent 请求导入本机素材'
      : isAssetDownload
        ? 'Agent 请求导出项目素材'
        : isDeliveryPackage
          ? 'Agent 请求创建交付包'
        : item.action === 'run.retry'
          ? 'Agent 请求只重试失败范围'
          : item.action === 'run.start'
            ? 'Agent 请求启动生成任务'
            : isCreative
              ? 'Agent 请求创建或迭代创作工作流'
      : 'Agent 请求应用画布修改';
  const approvalVerb = isRevert
    ? '创建新的撤销 revision'
    : isAssetPlace
      ? '创建一个可精确撤回的素材节点和可选连线'
    : isAssetImport
      ? '把以上文件复制到当前项目素材中心'
      : isAssetDownload
        ? '把以上项目素材复制到你选择的本机目录'
        : isDeliveryPackage
          ? '把以上已校验素材写入新的交付目录'
        : isRun
          ? '把以上精确范围加入持久运行队列'
          : isCreative
            ? '把以上创作计划写入当前画布（不会自动生成）'
      : '提交以上变更';
  return (
    <div className="fixed inset-0 z-[10010] grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-operation-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-amber-400/30 bg-[#13140f] text-zinc-100 shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-400/15 text-amber-300">
            {isRevert ? <RotateCcw size={20} /> : <FileDiff size={20} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="agent-operation-title" className="text-base font-semibold">
              {actionTitle}
            </h2>
            <p className="mt-1 text-xs text-zinc-400">
              {item.clientName} · {item.canvasId}
              {preview.currentRevision ? ` · 当前 r${preview.currentRevision}` : ''}
              {items.length > 1 ? ` · 还有 ${items.length - 1} 个请求` : ''}
            </p>
          </div>
          <div className="text-right text-[11px] text-zinc-500">
            {remainingSeconds(item.expiresAt, now)} 秒后过期
          </div>
          <button type="button" onClick={() => void decide('deny')} className="rounded-lg p-2 hover:bg-white/10" aria-label="拒绝">
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-sm font-semibold">{preview.summary || item.patchId}</div>
            {isAssetPlace ? (
              <div className="mt-2 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                <span>素材：{preview.assetPlacement?.asset?.filename || preview.assetId || '未知素材'}</span>
                <span>类型：{preview.assetPlacement?.asset?.kind || '未知'}</span>
                <span>节点：{preview.assetPlacement?.nodeType || 'upload'} · {preview.assetPlacement?.nodeId || '待创建'}</span>
                <span>
                  位置：{Math.round(Number(preview.assetPlacement?.position?.x) || 0)}
                  ，{Math.round(Number(preview.assetPlacement?.position?.y) || 0)}
                </span>
                <span className="sm:col-span-2">
                  连线：{preview.assetPlacement?.targetNodeId
                    ? preview.assetPlacement.nodeId + ' → ' + preview.assetPlacement.targetNodeId
                      + (preview.assetPlacement.targetHandle ? ' · 端口 ' + preview.assetPlacement.targetHandle : '')
                    : '只放置节点，不自动连线'}
                </span>
                <span className="truncate sm:col-span-2" title={preview.assetPlacement?.asset?.contentHash}>
                  来源：{preview.assetPlacement?.lineage?.assetId || preview.assetId || '未知'}
                  {' · '}r{preview.assetPlacement?.lineage?.contentRevision || 1}
                  {' · '}{preview.assetPlacement?.asset?.contentHash || '哈希未知'}
                </span>
              </div>
            ) : isAssetTransfer || isDeliveryPackage ? (
              <div className="mt-2 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                {isDeliveryPackage ? (
                  <>
                    <span>素材：{preview.operationCount ?? preview.affectedNodeIds?.length ?? 0} 项</span>
                    <span>风险：{preview.riskLevel || 'L2'}</span>
                    <span className="sm:col-span-2">目标：{preview.destination || '新的交付目录'}</span>
                  </>
                ) : (
                  <>
                    <span>文件：{preview.file?.name || '未知'}</span>
                    <span>类型：{preview.file?.kind || '未知'} · {preview.file?.mimeType || '未知'}</span>
                    <span>大小：{Number(preview.file?.size || 0).toLocaleString()} bytes</span>
                    <span>目标：{preview.destination || '当前项目素材中心'}</span>
                    <span className="truncate sm:col-span-2" title={preview.file?.sha256}>
                      SHA-256：{preview.file?.sha256 || '未知'}
                    </span>
                  </>
                )}
              </div>
            ) : isRun ? (
              <div className="mt-2 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                <span>节点：{preview.run?.authorizedNodeIds?.length ?? 0}</span>
                <span>范围：{preview.run?.mode || '精确范围'}</span>
                <span className="sm:col-span-2">
                  费用：{preview.cost?.known
                    ? `${preview.cost.amount ?? 0} ${preview.cost.currency || ''}`
                    : '平台未提供估算（不阻断；仍按本次明确范围授权）'}
                </span>
                <span className="truncate sm:col-span-2" title={preview.run?.planDigest}>
                  计划摘要：{preview.run?.planDigest || '未知'}
                </span>
              </div>
            ) : isCreative ? (
              <div className="mt-2 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                <span>模式：{preview.creator?.profileLabel || preview.creator?.profile || '平衡创作'}</span>
                <span>候选：{preview.creator?.candidateCount || 1}</span>
                <span>画幅：{preview.creator?.ratio || '沿用画布默认'}</span>
                <span>时长：{preview.creator?.durationSec ? `${preview.creator.durationSec}s` : '不适用'}</span>
                <span className="sm:col-span-2">目标：{preview.creator?.goal || preview.summary}</span>
                <span className="sm:col-span-2">生成范围：{preview.creator?.generateScope || '缺失、失败、未锁定项'}</span>
                {(['llm', 'image', 'video'] as const).map((kind) => {
                  const selection = preview.creator?.models?.[kind];
                  if (!selection?.provider && !selection?.model) return null;
                  const label = kind === 'llm' ? '语言' : kind === 'image' ? '图像' : '视频';
                  return (
                    <span key={kind} className="sm:col-span-2">
                      {label}：{selection.provider || '默认平台'} · {selection.model || '平台默认模型'}
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-zinc-400 sm:grid-cols-4">
                <span>Patch：{item.patchId}</span>
                <span>基准：r{preview.baseRevision ?? preview.currentRevision}</span>
                <span>节点：{preview.affectedNodeIds?.length ?? 0}</span>
                <span>连线：{preview.affectedEdgeIds?.length ?? 0}</span>
              </div>
            )}
          </div>

          {approvalBinding && (
            <div
              data-agent-approval-binding={approvalBinding.bindingDigest}
              className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3 text-xs leading-relaxed text-cyan-50"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>本次确认绑定的版本与边界</strong>
                <span
                  className="font-mono text-[10px] text-cyan-200/65"
                  title={approvalBinding.bindingDigest}
                >
                  回执 {digestLabel(approvalBinding.bindingDigest)}
                </span>
              </div>
              <div className="mt-2 grid gap-1.5 text-cyan-100/80 sm:grid-cols-2">
                <span title={approvalBinding.planDigest}>计划版本：{digestLabel(approvalBinding.planDigest)}</span>
                <span title={approvalBinding.modelDecisionDigest || undefined}>
                  模型选择：{digestLabel(approvalBinding.modelDecisionDigest)}
                </span>
                <span className="sm:col-span-2">
                  平台 / 模型：{providerSelections.length
                    ? providerSelections.map((selection) => [
                      selection.kind || '任务',
                      selection.provider || '默认平台',
                      selection.model || '平台默认模型',
                    ].join(' · ')).join('；')
                    : '本次回执没有声明外部 Provider'}
                </span>
                <span className="sm:col-span-2">
                  费用边界：{approvalBinding.boundary.costTier?.status === 'known'
                    ? approvalBinding.boundary.costTier.message || '已由当前回执声明'
                    : approvalBinding.boundary.costTier?.message || '未知；系统不会猜测费用'}
                </span>
                <span className="sm:col-span-2">
                  隐私边界：{approvalBinding.boundary.privacyBoundary?.status === 'known'
                    ? approvalBinding.boundary.privacyBoundary.message || '已由当前回执声明'
                    : approvalBinding.boundary.privacyBoundary?.message || '未知；系统不会猜测数据驻留范围'}
                </span>
                <span className="sm:col-span-2 text-cyan-200/65">
                  计划、平台、模型或边界发生变化后，这个确认会自动失效，必须重新核对。
                </span>
              </div>
            </div>
          )}
          {(isAssetPlace || isAssetTransfer || isDeliveryPackage || isRun || isCreative) && (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/5 p-3 text-xs leading-relaxed text-emerald-100">
              <div>{preview.providerTransfer?.message || (isRun ? '批准前不会向 Provider 提交任务。' : '本次不会把文件发送给 AI Provider。')}</div>
              <div className="mt-1 text-emerald-200/70">
                费用：{preview.cost?.known ? `${preview.cost.amount ?? 0} ${preview.cost.currency || ''}` : '未提供估算（不作为阻断）'}
                {' · '}风险：{preview.riskLevel || 'L2'}
              </div>
            </div>
          )}

          {changes.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-zinc-300">变更预览（{changes.length}）</div>
              <div className="space-y-2">
                {changes.map((change, index) => (
                  <div key={`${change.operationIndex ?? index}-${change.targetId ?? index}`} className="rounded-lg border border-white/10 px-3 py-2">
                    <div className="text-xs font-medium text-zinc-200">{changeLabel(change)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(preview.warnings) && preview.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-3 text-xs text-amber-100">
              {preview.warnings.map((warning, index) => (
                <div key={index} className="flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-lime-400/20 bg-lime-400/5 p-3 text-xs leading-relaxed">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 accent-lime-400"
            />
            <span>
              我已核对{
                isAssetPlace
                  ? '素材版本、目标节点、位置、端口、连线和来源'
                  : isAssetTransfer
                  ? '文件名称、类型、哈希、目标和外发范围'
                  : isDeliveryPackage
                    ? '素材集合、哈希、许可状态和目标目录'
                  : isRun
                    ? '节点范围、Provider、模型、版本边界和 revision'
                    : isCreative
                      ? '创作目标、候选数、连续性策略、变更范围、版本边界和 revision'
                    : '变更摘要、目标和 revision'
              }，确认让 Agent {approvalVerb}。
            </span>
          </label>

          {error && <div role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">{error}</div>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void decide('deny')}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
          >
            拒绝
          </button>
          <button
            type="button"
            disabled={!confirmed || Boolean(busy)}
            onClick={() => void decide('approve')}
            className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-[#102000] hover:bg-lime-300 disabled:opacity-40"
          >
            {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {isRevert ? '批准撤销' : isAssetImport ? '批准导入' : isAssetDownload ? '批准导出' : isDeliveryPackage ? '批准创建交付包' : isRun ? '批准运行' : isCreative ? '批准创作计划' : '批准修改'}
          </button>
        </footer>
      </section>
    </div>
  );
}
