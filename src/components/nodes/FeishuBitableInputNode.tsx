import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, CheckCircle2, Database, Loader2, RefreshCw, Settings2, Table2 } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { PORT_COLOR } from '../../config/portTypes';
import * as api from '../../services/api';
import {
  normalizeFeishuBitableRecord,
  normalizeFeishuFields,
  parseFeishuBitableLink,
  resolveFeishuBitableLocation,
  type FeishuBitableFieldInfo,
} from '../../utils/feishuBitable';

function fieldName(field: any): string {
  return String(field?.field_name || field?.name || field?.fieldName || '').trim();
}

function short(value: string, len = 46): string {
  const s = String(value || '').trim();
  return s.length > len ? `${s.slice(0, len - 1)}…` : s;
}

const FeishuBitableInputNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const d = (data as any) || {};
  const [busy, setBusy] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [localError, setLocalError] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');

  const link = String(d.feishuLink || '');
  const appToken = String(d.feishuAppToken || '');
  const tableId = String(d.feishuTableId || '');
  const viewId = String(d.feishuViewId || '');
  const apiBase = String(d.feishuApiBase || 'https://open.feishu.cn');
  const textField = String(d.feishuTextField || '');
  const recordLimit = Number(d.feishuRecordLimit || 20);
  const rawFields = Array.isArray(d.feishuFields) ? d.feishuFields : [];
  const fields = useMemo(() => normalizeFeishuFields(rawFields), [rawFields]);
  const resolvedLocation = useMemo(
    () => resolveFeishuBitableLocation({ link, appToken, tableId, viewId }),
    [appToken, link, tableId, viewId],
  );
  const rows = Array.isArray(d.feishuBitableRows) ? d.feishuBitableRows : Array.isArray(d.feishuRows) ? d.feishuRows : [];
  const status = String(d.feishuStatus || '');
  const configured = Boolean(d.feishuHasAppId && d.feishuHasAppSecret);

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
      feishuAppToken: parsed.appToken || appToken,
      feishuTableId: parsed.tableId || tableId,
      feishuViewId: parsed.viewId || viewId,
      feishuStatus: parsed.appToken || parsed.tableId ? '已解析链接' : '未识别到 app/table，请手动填写',
    });
    setLocalError('');
  }, [appToken, link, tableId, update, viewId]);

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
      feishuStatus: '飞书连接配置已保存',
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
    if (resolvedLocation.appToken && resolvedLocation.tableId) {
      const fieldsRes = await api.getFeishuBitableFields({
        appToken: resolvedLocation.appToken,
        tableId: resolvedLocation.tableId,
        apiBase,
      });
      setBusy(false);
      if (!fieldsRes.success) {
        setLocalError(fieldsRes.error || '飞书凭证正常，但当前表格不可访问');
        update({
          ...connectionPatch,
          feishuStatus: '飞书凭证正常，但当前表格不可访问',
        });
        return;
      }
      const normalized = normalizeFeishuFields(fieldsRes.data.items || []);
      update({
        ...connectionPatch,
        feishuFields: fieldsRes.data.items || [],
        feishuAppToken: appToken || resolvedLocation.appToken,
        feishuTableId: tableId || resolvedLocation.tableId,
        feishuViewId: viewId || resolvedLocation.viewId,
        feishuStatus: `飞书连接正常，表格可访问（${normalized.length} 个字段）`,
      });
      return;
    }
    setBusy(false);
    update({
      ...connectionPatch,
      feishuStatus: '飞书连接正常',
    });
  }, [apiBase, appToken, resolvedLocation.appToken, resolvedLocation.tableId, resolvedLocation.viewId, tableId, update, viewId]);

  const loadFields = useCallback(async (): Promise<FeishuBitableFieldInfo[]> => {
    if (!resolvedLocation.appToken || !resolvedLocation.tableId) throw new Error('请先填写 appToken 和 tableId，或粘贴飞书多维表格链接');
    setBusy(true);
    setLocalError('');
    const res = await api.getFeishuBitableFields({
      appToken: resolvedLocation.appToken,
      tableId: resolvedLocation.tableId,
      apiBase,
    });
    setBusy(false);
    if (!res.success) throw new Error(res.error || '字段加载失败');
    const normalized = normalizeFeishuFields(res.data.items || []);
    update({
      feishuFields: res.data.items || [],
      feishuAppToken: appToken || resolvedLocation.appToken,
      feishuTableId: tableId || resolvedLocation.tableId,
      feishuViewId: viewId || resolvedLocation.viewId,
      feishuStatus: `已加载 ${normalized.length} 个字段`,
    });
    return normalized;
  }, [apiBase, appToken, resolvedLocation.appToken, resolvedLocation.tableId, resolvedLocation.viewId, tableId, update, viewId]);

  const fetchRecords = useCallback(async () => {
    try {
      if (!resolvedLocation.appToken || !resolvedLocation.tableId) throw new Error('请先填写 appToken 和 tableId，或粘贴飞书多维表格链接');
      setBusy(true);
      setLocalError('');
      const activeFields = fields.length > 0 ? fields : await loadFields();
      setBusy(true);
      const res = await api.searchFeishuBitableRecords({
        appToken: resolvedLocation.appToken,
        tableId: resolvedLocation.tableId,
        viewId: resolvedLocation.viewId || undefined,
        apiBase,
        pageSize: Math.min(Math.max(recordLimit, 1), 100),
        limit: Math.min(Math.max(recordLimit, 1), 500),
      });
      if (!res.success) {
        setBusy(false);
        throw new Error(res.error || '记录拉取失败');
      }
      const normalized = (res.data.items || []).map((record) => normalizeFeishuBitableRecord({
        appToken: resolvedLocation.appToken,
        tableId: resolvedLocation.tableId,
        record,
        fields: activeFields,
      }));
      const downloadErrors: string[] = [];
      for (const record of normalized) {
        for (const item of record.media) {
          if (!item.fileToken) continue;
          const downloaded = await api.downloadFeishuBitableMedia({
            fileToken: item.fileToken,
            name: item.name,
            apiBase,
          });
          if (downloaded.success) {
            item.url = downloaded.data.url;
            item.name = item.name || downloaded.data.name;
          } else {
            downloadErrors.push(`${item.name}: ${downloaded.error}`);
          }
        }
      }
      setBusy(false);
      const texts = normalized
        .map((record) => {
          if (textField) {
            const value = record.rowData[textField];
            return typeof value === 'string' ? value : JSON.stringify(value ?? '');
          }
          return record.texts.join('\n');
        })
        .map((x) => x.trim())
        .filter(Boolean);
      const media = normalized.flatMap((record) => record.media);
      const imageUrls = media.filter((item) => item.kind === 'image' && item.url).map((item) => item.url as string);
      const videoUrls = media.filter((item) => item.kind === 'video' && item.url).map((item) => item.url as string);
      const audioUrls = media.filter((item) => item.kind === 'audio' && item.url).map((item) => item.url as string);
      const feishuBitableMeta = {
        appToken: resolvedLocation.appToken,
        tableId: resolvedLocation.tableId,
        viewId: resolvedLocation.viewId || undefined,
        rows: normalized,
        recordIds: normalized.map((record) => record.recordId).filter(Boolean),
      };
      update({
        feishuAppToken: appToken || resolvedLocation.appToken,
        feishuTableId: tableId || resolvedLocation.tableId,
        feishuViewId: viewId || resolvedLocation.viewId,
        feishuRows: normalized,
        feishuBitableRows: normalized,
        feishuRecordIds: feishuBitableMeta.recordIds,
        feishuRecords: res.data.items || [],
        feishuStatus: downloadErrors.length
          ? `已拉取 ${normalized.length} 条记录，${downloadErrors.length} 个附件未下载`
          : `已拉取 ${normalized.length} 条记录`,
        feishuDownloadErrors: downloadErrors,
        prompt: texts.join('\n\n'),
        textSegments: texts,
        texts,
        imageUrl: imageUrls[0] || '',
        imageUrls,
        videoUrl: videoUrls[0] || '',
        videoUrls,
        audioUrl: audioUrls[0] || '',
        audioUrls,
        outputText: texts.join('\n\n'),
        reply: texts.join('\n\n'),
        metadata: {
          ...(d.metadata && typeof d.metadata === 'object' ? d.metadata : {}),
          feishuBitable: feishuBitableMeta,
        },
      });
    } catch (e: any) {
      setBusy(false);
      const message = e?.message || '飞书记录拉取失败';
      setLocalError(message);
      update({ feishuStatus: message });
      throw e;
    }
  }, [apiBase, appToken, d.metadata, fields, loadFields, recordLimit, resolvedLocation.appToken, resolvedLocation.tableId, resolvedLocation.viewId, tableId, textField, update, viewId]);

  useRunTrigger(id, fetchRecords, 'feishu-bitable-input');

  const textFields = fields.filter((field) => field.type !== 'attachment');

  return (
    <div
      className="t8-node w-[520px] overflow-hidden"
      data-feishu-bitable-input-node
      style={{
        borderColor: selected ? '#22c55e' : 'var(--t8-border-strong)',
        boxShadow: selected ? '0 0 0 2px rgba(34,197,94,.25)' : undefined,
      }}
    >
      <Handle type="source" position={Position.Right} id="text" style={{ top: '36%', background: PORT_COLOR.text, border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} id="image" style={{ top: '46%', background: PORT_COLOR.image, border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} id="video" style={{ top: '56%', background: PORT_COLOR.video, border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} id="audio" style={{ top: '66%', background: PORT_COLOR.audio, border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} id="metadata" style={{ top: '76%', background: PORT_COLOR.metadata, border: '1px solid var(--t8-bg-node)' }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: '#dcfce7', color: '#166534' }}>
          <Table2 size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">飞书多维表格输入</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            {rows.length ? `${rows.length} 条记录 · ${d.textSegments?.length || 0} 段文本` : '读取多维表格记录并输出素材'}
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
            onChange={(event) => update({ feishuLink: event.target.value })}
            placeholder="粘贴飞书多维表格链接"
          />
          <button type="button" className="t8-btn min-h-8 px-2 text-xs" onClick={commitParsedLink}>
            解析
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <input className="t8-input px-2 py-1.5 text-xs" value={appToken} onChange={(event) => update({ feishuAppToken: event.target.value })} placeholder="appToken" />
          <input className="t8-input px-2 py-1.5 text-xs" value={tableId} onChange={(event) => update({ feishuTableId: event.target.value })} placeholder="tableId" />
          <input className="t8-input px-2 py-1.5 text-xs" value={viewId} onChange={(event) => update({ feishuViewId: event.target.value })} placeholder="viewId 可选" />
        </div>

        <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) 72px 84px' }}>
          <select className="t8-select w-full px-2 py-1.5 text-xs" value={textField} onChange={(event) => update({ feishuTextField: event.target.value })}>
            <option value="">文本字段：自动</option>
            {textFields.map((field) => (
              <option key={field.id} value={field.name}>{field.name}</option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={500}
            className="t8-input px-2 py-1.5 text-xs"
            value={recordLimit}
            onChange={(event) => update({ feishuRecordLimit: Number(event.target.value) || 20 })}
            title="拉取数量"
          />
          <button type="button" className="t8-btn min-h-8 px-2 text-xs" onClick={() => setCredentialsOpen((v) => !v)}>
            <Settings2 size={13} />
            连接
          </button>
        </div>

        {credentialsOpen && (
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
            <div className="mb-2 text-[11px] font-bold">飞书应用凭证</div>
            <div className="mb-2 rounded px-2 py-1 text-[10px]" style={{ background: 'var(--t8-bg-node)', color: 'var(--t8-text-muted)' }}>
              需要开通 bitable:app / bitable:table / drive:file 权限，并把应用添加为多维表格协作者。
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
              <select className="t8-select px-2 py-1.5 text-xs" value={apiBase} onChange={(event) => update({ feishuApiBase: event.target.value })}>
                <option value="https://open.feishu.cn">飞书中国区</option>
                <option value="https://open.larksuite.com">Lark 国际区</option>
              </select>
              <button type="button" className="t8-btn min-h-8 px-2 text-xs" onClick={() => void testConnection()} disabled={busy}>
                测试连接
              </button>
              <input className="t8-input px-2 py-1.5 text-xs" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="App ID，只保存到本机后端" />
              <input className="t8-input px-2 py-1.5 text-xs" type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder="App Secret，不写入画布" />
            </div>
            <button type="button" className="t8-btn mt-2 min-h-8 w-full text-xs" onClick={() => void saveCredentials()} disabled={busy}>
              保存凭证
            </button>
          </div>
        )}

        <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" className="t8-btn min-h-9 text-xs" onClick={() => void loadFields().catch((e) => setLocalError(e?.message || '字段加载失败'))} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Database size={13} />}
            加载字段
          </button>
          <button type="button" className="t8-btn t8-btn-primary min-h-9 text-xs" onClick={() => requestCanvasNodeRun(id)} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            拉取记录
          </button>
        </div>

        {(localError || d.error) && (
          <div className="rounded-md border px-2 py-1.5 text-[11px]" style={{ borderColor: '#ef444466', color: '#ef4444' }}>
            {localError || d.error}
          </div>
        )}

        <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
          <div className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            <span>最近记录</span>
            <span>{status || '等待拉取'}</span>
          </div>
          <div className="max-h-36 space-y-1 overflow-auto pr-1">
            {rows.length === 0 ? (
              <div className="rounded border border-dashed px-2 py-5 text-center text-[11px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-dim)' }}>
                粘贴飞书多维表格链接后拉取记录
              </div>
            ) : rows.slice(0, 8).map((row: any, index: number) => (
              <div key={row.recordId || index} className="rounded px-2 py-1 text-[11px]" style={{ background: 'var(--t8-bg-soft)' }}>
                <div className="font-bold" style={{ color: 'var(--t8-text-main)' }}>{row.recordId || `记录 ${index + 1}`}</div>
                <div className="truncate" style={{ color: 'var(--t8-text-muted)' }}>{short((row.texts || []).join(' / ') || JSON.stringify(row.rowData || {}))}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(FeishuBitableInputNode);
