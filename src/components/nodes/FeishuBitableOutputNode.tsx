import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, useNodeConnections, useNodesData, type NodeProps } from '@xyflow/react';
import { AlertCircle, CheckCircle2, Loader2, Send, Settings2, TableProperties } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { PORT_COLOR } from '../../config/portTypes';
import { useUpstreamMaterials } from './useUpstreamMaterials';
import * as api from '../../services/api';
import {
  buildFeishuRecordFieldsFromMappings,
  collectFeishuBitableRowsFromNodeData,
  createFeishuBitableWriteRecords,
  normalizeFeishuFields,
  parseFeishuBitableLink,
  resolveFeishuBitableLocation,
  type FeishuBitableFieldMapping,
  type FeishuBitableWriteMedia,
} from '../../utils/feishuBitable';

function previewJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

const FeishuBitableOutputNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const upstream = useUpstreamMaterials(id);
  const d = (data as any) || {};
  const [busy, setBusy] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [localError, setLocalError] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');

  const link = String(d.feishuOutputLink || d.feishuLink || '');
  const appToken = String(d.feishuOutputAppToken || d.feishuAppToken || '');
  const tableId = String(d.feishuOutputTableId || d.feishuTableId || '');
  const recordId = String(d.feishuOutputRecordId || '');
  const apiBase = String(d.feishuApiBase || 'https://open.feishu.cn');
  const modeSetting = (d.feishuWriteMode === 'create' || d.feishuWriteMode === 'update' ? d.feishuWriteMode : 'auto') as 'auto' | 'create' | 'update';
  const textField = String(d.feishuWriteTextField || 'T8文本');
  const attachmentField = String(d.feishuWriteAttachmentField || 'T8附件');
  const statusField = String(d.feishuWriteStatusField || 'T8状态');
  const writeAttachments = d.feishuWriteAttachments !== false;
  const rawFields = Array.isArray(d.feishuFields) ? d.feishuFields : [];
  const fields = useMemo(() => normalizeFeishuFields(rawFields), [rawFields]);
  const linkLocation = useMemo(
    () => resolveFeishuBitableLocation({ link, appToken, tableId }),
    [appToken, link, tableId],
  );
  const configured = Boolean(d.feishuHasAppId && d.feishuHasAppSecret);
  const mediaCount = upstream.images.length + upstream.videos.length + upstream.audios.length;
  const connections = useNodeConnections({ id, handleType: 'target' });
  const upstreamIds = useMemo(
    () => Array.from(new Set(connections.map((connection) => connection.source).filter(Boolean))),
    [connections],
  );
  const upstreamNodes = useNodesData(upstreamIds);
  const upstreamFeishuRows = useMemo(() => {
    const rows = collectFeishuBitableRowsFromNodeData(d, {
      appToken: linkLocation.appToken,
      tableId: linkLocation.tableId,
    });
    const list = Array.isArray(upstreamNodes) ? upstreamNodes : [];
    for (const node of list) {
      rows.push(...collectFeishuBitableRowsFromNodeData((node as any)?.data || {}, {
        appToken: linkLocation.appToken,
        tableId: linkLocation.tableId,
      }));
    }
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.appToken || ''}:${row.tableId || ''}:${row.recordId || JSON.stringify(row.rowData)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [d, linkLocation.appToken, linkLocation.tableId, upstreamNodes]);
  const resolvedAppToken = linkLocation.appToken || upstreamFeishuRows[0]?.appToken || '';
  const resolvedTableId = linkLocation.tableId || upstreamFeishuRows[0]?.tableId || '';
  const effectiveMode = (modeSetting === 'update' || (modeSetting === 'auto' && (upstreamFeishuRows.length > 0 || recordId))) ? 'update' : 'create';
  const autoRecordLabel = effectiveMode === 'update' && upstreamFeishuRows.length > 0
    ? `自动写回原记录 ${upstreamFeishuRows.length} 条`
    : effectiveMode === 'update' && recordId
      ? '手动更新 1 条记录'
      : '新增记录';

  useEffect(() => {
    let cancelled = false;
    api.getFeishuBitableStatus().then((res) => {
      if (cancelled || !res.success) return;
      update({
        feishuApiBase: res.data.apiBase,
        feishuHasAppId: res.data.hasAppId,
        feishuHasAppSecret: res.data.hasAppSecret,
      });
    });
    return () => { cancelled = true; };
  }, [update]);

  const commitParsedLink = useCallback(() => {
    const parsed = parseFeishuBitableLink(link);
    update({
      feishuOutputAppToken: parsed.appToken || appToken,
      feishuOutputTableId: parsed.tableId || tableId,
      feishuOutputStatus: parsed.appToken || parsed.tableId ? '已解析链接' : '未识别到 app/table，请手动填写',
    });
    setLocalError('');
  }, [appToken, link, tableId, update]);

  const saveCredentials = useCallback(async () => {
    setBusy(true);
    setLocalError('');
    const payload: { apiBase?: string; appId?: string; appSecret?: string } = { apiBase };
    if (appId.trim()) payload.appId = appId.trim();
    if (appSecret.trim()) payload.appSecret = appSecret.trim();
    const res = await api.saveFeishuBitableSettings(payload);
    setBusy(false);
    if (!res.success) {
      setLocalError(res.error || '飞书连接配置保存失败');
      return;
    }
    setAppId('');
    setAppSecret('');
    update({
      feishuApiBase: res.data.apiBase,
      feishuHasAppId: res.data.hasAppId,
      feishuHasAppSecret: res.data.hasAppSecret,
      feishuOutputStatus: '飞书连接配置已保存',
    });
  }, [apiBase, appId, appSecret, update]);

  const testConnection = useCallback(async () => {
    setBusy(true);
    setLocalError('');
    const res = await api.testFeishuBitableConnection({ apiBase });
    if (!res.success) {
      setBusy(false);
      setLocalError(res.error || '飞书连接测试失败');
      return;
    }
    const connectionPatch = {
      feishuApiBase: res.data.apiBase,
      feishuHasAppId: res.data.hasAppId,
      feishuHasAppSecret: res.data.hasAppSecret,
    };
    if (resolvedAppToken && resolvedTableId) {
      const fieldsRes = await api.getFeishuBitableFields({ appToken: resolvedAppToken, tableId: resolvedTableId, apiBase });
      setBusy(false);
      if (!fieldsRes.success) {
        setLocalError(fieldsRes.error || '飞书凭证正常，但当前表格不可访问');
        update({
          ...connectionPatch,
          feishuOutputStatus: '飞书凭证正常，但当前表格不可访问',
        });
        return;
      }
      const normalized = normalizeFeishuFields(fieldsRes.data.items || []);
      update({
        ...connectionPatch,
        feishuFields: fieldsRes.data.items || [],
        feishuOutputAppToken: appToken || resolvedAppToken,
        feishuOutputTableId: tableId || resolvedTableId,
        feishuOutputStatus: `飞书连接正常，表格可访问（${normalized.length} 个字段）`,
      });
      return;
    }
    setBusy(false);
    update({
      ...connectionPatch,
      feishuOutputStatus: '飞书连接正常',
    });
  }, [apiBase, appToken, resolvedAppToken, resolvedTableId, tableId, update]);

  const loadFields = useCallback(async () => {
    try {
      if (!resolvedAppToken || !resolvedTableId) throw new Error('请先填写 appToken 和 tableId，或连接飞书输入节点自动继承');
      setBusy(true);
      setLocalError('');
      const res = await api.getFeishuBitableFields({ appToken: resolvedAppToken, tableId: resolvedTableId, apiBase });
      setBusy(false);
      if (!res.success) throw new Error(res.error || '字段加载失败');
      update({
        feishuFields: res.data.items || [],
        feishuOutputAppToken: appToken || resolvedAppToken,
        feishuOutputTableId: tableId || resolvedTableId,
        feishuOutputStatus: `已加载 ${res.data.items?.length || 0} 个字段`,
      });
    } catch (e: any) {
      setBusy(false);
      setLocalError(e?.message || '字段加载失败');
    }
  }, [apiBase, appToken, resolvedAppToken, resolvedTableId, tableId, update]);

  const collectWriteInputs = useCallback(() => {
    const texts = upstream.texts.map((item) => item.url).filter(Boolean);
    const media: FeishuBitableWriteMedia[] = [
      ...upstream.images.map((item) => ({ kind: 'image' as const, url: item.url, name: item.label || item.url.split('/').pop() || 'image' })),
      ...upstream.videos.map((item) => ({ kind: 'video' as const, url: item.url, name: item.label || item.url.split('/').pop() || 'video' })),
      ...upstream.audios.map((item) => ({ kind: 'audio' as const, url: item.url, name: item.label || item.url.split('/').pop() || 'audio' })),
    ];
    const mappings: FeishuBitableFieldMapping[] = [];
    if (textField.trim()) mappings.push({ targetField: textField.trim(), targetType: 'text', source: 'allText' as const });
    if (writeAttachments && attachmentField.trim() && media.length > 0) {
      mappings.push({ targetField: attachmentField.trim(), targetType: 'attachment', source: 'allMedia' as const });
    }
    if (statusField.trim()) mappings.push({ targetField: statusField.trim(), targetType: 'text', source: 'status' as const });
    return { texts, media, mappings };
  }, [attachmentField, statusField, textField, upstream.audios, upstream.images, upstream.texts, upstream.videos, writeAttachments]);

  const buildFields = useCallback(() => {
    const { texts, media, mappings } = collectWriteInputs();
    return buildFeishuRecordFieldsFromMappings({
      mappings,
      texts,
      media,
      status: 'success',
      allowLocalAttachmentPlaceholders: true,
    });
  }, [collectWriteInputs]);

  const buildRecordDrafts = useCallback((allowLocalAttachmentPlaceholders: boolean) => {
    const { texts, media, mappings } = collectWriteInputs();
    return createFeishuBitableWriteRecords({
      rows: upstreamFeishuRows,
      mappings,
      texts,
      media,
      status: 'success',
      mode: effectiveMode,
      recordId: recordId || undefined,
      allowLocalAttachmentPlaceholders,
    });
  }, [collectWriteInputs, effectiveMode, recordId, upstreamFeishuRows]);

  const dryRun = useCallback(() => {
    try {
      const drafts = buildRecordDrafts(true);
      const fieldsPayload = drafts.length === 1 ? drafts[0].fields : { records: drafts };
      update({
        feishuWritePreview: fieldsPayload,
        feishuOutputStatus: effectiveMode === 'update'
          ? `预检完成，将更新 ${drafts.length} 条原记录`
          : '预检完成，将新增记录',
        outputText: previewJson(fieldsPayload),
      });
      setLocalError('');
    } catch (e: any) {
      setLocalError(e?.message || '预检失败');
    }
  }, [buildRecordDrafts, effectiveMode, update]);

  const writeRecords = useCallback(async () => {
    try {
      if (!resolvedAppToken || !resolvedTableId) throw new Error('请先填写 appToken 和 tableId，或连接飞书输入节点自动继承');
      if (effectiveMode === 'update' && !recordId && upstreamFeishuRows.length === 0) throw new Error('更新模式需要 recordId，或连接飞书输入节点自动写回原记录');
      const drafts = buildRecordDrafts(true);
      if (effectiveMode === 'update' && drafts.some((record) => !record.recordId)) {
        throw new Error('更新飞书记录需要 recordId，或连接带原记录的飞书输入节点');
      }
      setBusy(true);
      setLocalError('');
      const res = await api.writeFeishuBitableRecords({
        appToken: resolvedAppToken,
        tableId: resolvedTableId,
        apiBase,
        mode: effectiveMode,
        recordId: recordId || undefined,
        records: drafts,
      });
      setBusy(false);
      if (!res.success) throw new Error(res.error || '写回飞书失败');
      const written = res.data.items || [];
      const preview = drafts.length === 1 ? drafts[0].fields : { records: drafts };
      update({
        feishuWritePreview: preview,
        feishuWriteResult: written,
        feishuOutputStatus: effectiveMode === 'update'
          ? `已更新 ${written.length || drafts.length || 1} 条原记录`
          : `已新增 ${written.length || drafts.length || 1} 条记录`,
        outputText: `飞书写回成功：${written.length || 1} 条记录`,
        metadata: {
          ...(d.metadata && typeof d.metadata === 'object' ? d.metadata : {}),
          feishuBitableWrite: {
            appToken: resolvedAppToken,
            tableId: resolvedTableId,
            mode: effectiveMode,
            recordIds: drafts.map((draft) => draft.recordId).filter(Boolean),
          },
        },
      });
    } catch (e: any) {
      setBusy(false);
      const message = e?.message || '写回飞书失败';
      setLocalError(message);
      update({ feishuOutputStatus: message, outputText: message });
      throw e;
    }
  }, [apiBase, buildRecordDrafts, d.metadata, effectiveMode, recordId, resolvedAppToken, resolvedTableId, update, upstreamFeishuRows.length]);

  useRunTrigger(id, writeRecords, 'feishu-bitable-output');

  return (
    <div
      className="t8-node w-[500px] overflow-hidden"
      data-feishu-bitable-output-node
      style={{
        borderColor: selected ? '#0ea5e9' : 'var(--t8-border-strong)',
        boxShadow: selected ? '0 0 0 2px rgba(14,165,233,.25)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: PORT_COLOR.any, border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} id="text" style={{ top: '45%', background: PORT_COLOR.text, border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} id="metadata" style={{ top: '58%', background: PORT_COLOR.metadata, border: '1px solid var(--t8-bg-node)' }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: '#e0f2fe', color: '#075985' }}>
          <TableProperties size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">飞书多维表格输出</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            上游 {upstream.texts.length} 文本 · {mediaCount} 媒体 · {autoRecordLabel}
          </div>
        </div>
        <div className="flex items-center gap-1 text-[10px]" style={{ color: configured ? '#16a34a' : '#f59e0b' }}>
          {configured ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          {configured ? '已配置' : '待配置'}
        </div>
      </div>

      <div
        className="nodrag nowheel space-y-2 p-3"
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) 86px' }}>
          <input
            className="t8-input w-full px-2 py-1.5 text-xs"
            value={link}
            onChange={(event) => update({ feishuOutputLink: event.target.value })}
            placeholder="粘贴飞书多维表格链接"
          />
          <button type="button" className="t8-btn min-h-8 px-2 text-xs" onClick={commitParsedLink}>
            解析
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <input className="t8-input px-2 py-1.5 text-xs" value={appToken} onChange={(event) => update({ feishuOutputAppToken: event.target.value })} placeholder={upstreamFeishuRows[0]?.appToken ? `继承 ${upstreamFeishuRows[0].appToken}` : 'appToken'} />
          <input className="t8-input px-2 py-1.5 text-xs" value={tableId} onChange={(event) => update({ feishuOutputTableId: event.target.value })} placeholder={upstreamFeishuRows[0]?.tableId ? `继承 ${upstreamFeishuRows[0].tableId}` : 'tableId'} />
          <input className="t8-input px-2 py-1.5 text-xs" value={recordId} onChange={(event) => update({ feishuOutputRecordId: event.target.value })} placeholder="recordId 更新用" />
        </div>

        <div className="grid gap-2" style={{ gridTemplateColumns: '96px minmax(0,1fr) 84px' }}>
          <select className="t8-select px-2 py-1.5 text-xs" value={modeSetting} onChange={(event) => update({ feishuWriteMode: event.target.value })}>
            <option value="auto">自动</option>
            <option value="create">新增</option>
            <option value="update">更新</option>
          </select>
          <select className="t8-select px-2 py-1.5 text-xs" value={apiBase} onChange={(event) => update({ feishuApiBase: event.target.value })}>
            <option value="https://open.feishu.cn">飞书中国区</option>
            <option value="https://open.larksuite.com">Lark 国际区</option>
          </select>
          <button type="button" className="t8-btn min-h-8 px-2 text-xs" onClick={() => setCredentialsOpen((v) => !v)}>
            <Settings2 size={13} />
            连接
          </button>
        </div>

        {credentialsOpen && (
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
            <div className="mb-2 rounded px-2 py-1 text-[10px]" style={{ background: 'var(--t8-bg-node)', color: 'var(--t8-text-muted)' }}>
              可粘贴链接或继承上游表格；需要开通 bitable:app / bitable:table / drive:file 权限，并把应用添加为多维表格协作者。
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) 78px' }}>
              <input className="t8-input px-2 py-1.5 text-xs" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="App ID，只保存到本机后端" />
              <input className="t8-input px-2 py-1.5 text-xs" type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder="App Secret，不写入画布" />
              <button type="button" className="t8-btn min-h-8 px-2 text-xs" onClick={() => void saveCredentials()} disabled={busy}>保存</button>
            </div>
            <button type="button" className="t8-btn mt-2 min-h-8 w-full text-xs" onClick={() => void testConnection()} disabled={busy}>
              测试连接
            </button>
          </div>
        )}

        <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
          <div className="mb-2 flex items-center justify-between text-[11px] font-bold">
            <span>字段映射</span>
            <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={() => void loadFields()} disabled={busy}>
              加载字段
            </button>
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
            <input list={`feishu-fields-${id}`} className="t8-input px-2 py-1.5 text-xs" value={textField} onChange={(event) => update({ feishuWriteTextField: event.target.value })} placeholder="文本写入字段" />
            <input list={`feishu-fields-${id}`} className="t8-input px-2 py-1.5 text-xs" value={attachmentField} onChange={(event) => update({ feishuWriteAttachmentField: event.target.value })} placeholder="附件写入字段" />
            <input list={`feishu-fields-${id}`} className="t8-input px-2 py-1.5 text-xs" value={statusField} onChange={(event) => update({ feishuWriteStatusField: event.target.value })} placeholder="状态字段" />
            <label className="flex min-h-8 items-center gap-2 rounded-md border px-2 text-xs" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
              <input type="checkbox" checked={writeAttachments} onChange={(event) => update({ feishuWriteAttachments: event.target.checked })} />
              写入附件
            </label>
          </div>
          <div className="mt-2 rounded-md px-2 py-1 text-[10px]" style={{ background: 'var(--t8-bg-soft)', color: 'var(--t8-text-muted)' }}>
            {effectiveMode === 'update'
              ? `自动写回原记录：${upstreamFeishuRows.length ? `已匹配 ${upstreamFeishuRows.length} 条上游记录` : '可手动填写 recordId'}`
              : '新增模式：会创建新的飞书记录，不覆盖原记录'}
          </div>
          <div className="mt-1 rounded-md px-2 py-1 text-[10px]" style={{ background: 'var(--t8-bg-soft)', color: 'var(--t8-text-muted)' }}>
            附件写回会通过飞书 upload_all 上传本地 input/output 文件；飞书单文件上限 20MB，超出请关闭附件或写入云端链接字段。
          </div>
          <datalist id={`feishu-fields-${id}`}>
            {fields.map((field) => <option key={field.id} value={field.name} />)}
          </datalist>
        </div>

        <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" className="t8-btn min-h-9 text-xs" onClick={dryRun} disabled={busy}>
            预检
          </button>
          <button type="button" className="t8-btn t8-btn-primary min-h-9 text-xs" onClick={() => requestCanvasNodeRun(id)} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            写回飞书
          </button>
        </div>

        {(localError || d.error) && (
          <div className="rounded-md border px-2 py-1.5 text-[11px]" style={{ borderColor: '#ef444466', color: '#ef4444' }}>
            {localError || d.error}
          </div>
        )}

        <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
          <div className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            <span>写回预览</span>
            <span>{String(d.feishuOutputStatus || '待预检')}</span>
          </div>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[10px]" style={{ background: 'var(--t8-bg-soft)', color: 'var(--t8-text-main)' }}>
            {previewJson(d.feishuWritePreview || { [textField || 'T8文本']: upstream.texts[0]?.url || '', [attachmentField || 'T8附件']: mediaCount ? `${mediaCount} 个上游媒体` : '' })}
          </pre>
        </div>
      </div>
    </div>
  );
};

export default memo(FeishuBitableOutputNode);
