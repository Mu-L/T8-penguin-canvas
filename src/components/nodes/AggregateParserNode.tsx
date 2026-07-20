import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Save,
  SearchCheck,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { placeSingleNode } from '../../utils/nodePlacement';
import { getAggregateParserStatus, resolveAggregateMedia, type AggregateParserMedia, type AggregateParserMode, type AggregateParserResult, type AggregateParserStatus } from '../../services/parseHub';
import { buildCookieGuide, detectParseAuthProfile, hasUsableCookie, normalizeCookieInput } from '../../utils/parseAuth';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials } from './useUpstreamMaterials';

const COLOR = '#f472b6';

const PLATFORM_HINTS = [
  '抖音',
  'TikTok',
  '小红书',
  'Bilibili',
  '微博',
  'YouTube',
  'X / Twitter',
  'Instagram',
  '快手',
  'Threads',
  'Facebook',
  '贴吧',
  '公众号',
];

const KIND_LABEL: Record<string, string> = {
  image: '图像',
  video: '视频',
  audio: '音频',
  file: '文件',
  text: '文本',
};

function shortText(value: string, max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function asMode(value: unknown, userSet = false): AggregateParserMode {
  return value === 'parse' && userSet ? 'parse' : 'download';
}

function mediaUrls(media: AggregateParserMedia[], kind: AggregateParserMedia['kind']) {
  return media.filter((item) => item.kind === kind).map((item) => item.url).filter(Boolean);
}

function copyText(text: string) {
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
  navigator.clipboard.writeText(text).catch(() => undefined);
}

function openUrl(url: string) {
  if (!url || typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function friendlyParseError(error: any, platformLabel?: string) {
  const text = String(error?.message || error || '解析失败').trim() || '解析失败';
  const hint = String(error?.hint || '').trim();
  const code = String(error?.code || '').trim();
  if (hint) return `${text}。${hint}`;
  if (code === 'login_required') {
    return `${text}。建议使用${platformLabel ? `「${platformLabel}」` : ''}授权助手重新登录，或手动粘贴最新 Cookie。`;
  }
  if (code === 'proxy_required') {
    return `${text}。请检查代理地址、网络访问和目标平台是否可打开。`;
  }
  if (code === 'rate_limited') {
    return `${text}。平台可能触发限流或验证，请稍后重试。`;
  }
  if (code === 'unsupported_platform') {
    return `${text}。请确认链接平台是否在 ParseHub 支持范围内，或复制完整分享文案再试。`;
  }
  if (/cookie|登录|授权|login|auth|401|403|forbidden|unauthorized/i.test(text)) {
    return `${text}。建议使用${platformLabel ? `「${platformLabel}」` : ''}授权助手重新登录，或手动粘贴最新 Cookie。`;
  }
  if (/超时|timeout|timed out/i.test(text)) {
    return `${text}。可以稍后重试，或检查代理、平台登录态和分享链接是否仍可访问。`;
  }
  if (/不支持|unsupported|UnknownPlatform/i.test(text)) {
    return `${text}。请确认链接平台是否在 ParseHub 支持范围内，或复制完整分享文案再试。`;
  }
  return text;
}

const AggregateParserNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const rf = useReactFlow();
  const upstream = useUpstreamMaterials(p.id);
  const d = (p.data as any) || {};

  const [checking, setChecking] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [savedAuth, setSavedAuth] = useState<T8ParseAuthSavedRecord | null>(null);
  const [authStoreEncryptionAvailable, setAuthStoreEncryptionAvailable] = useState(true);
  const [runtimeStatus, setRuntimeStatus] = useState<AggregateParserStatus | null>(null);
  const [message, setMessage] = useState('');

  const inputText = typeof d.aggregateParserInput === 'string' ? d.aggregateParserInput : '';
  const proxy = typeof d.aggregateParserProxy === 'string' ? d.aggregateParserProxy : '';
  const persistedCookie = typeof d.aggregateParserCookie === 'string' ? d.aggregateParserCookie : '';
  const [cookieInput, setCookieInput] = useState(persistedCookie);
  const modeUserSet = d.aggregateParserModeUserSet === true;
  const mode = asMode(d.aggregateParserMode, modeUserSet);
  const acceptedCompliance = Boolean(d.aggregateParserAcceptedCompliance);
  const preferUpstream = d.aggregateParserPreferUpstream !== false;
  const status = String(d.status || 'idle');
  const savedError = typeof d.error === 'string' ? d.error : '';
  const result = (d.aggregateParserResult || null) as AggregateParserResult | null;
  const upstreamText = useMemo(() => upstream.texts.map((item) => item.url).join('\n\n').trim(), [upstream.texts]);
  const effectiveInput = preferUpstream && upstreamText ? upstreamText : inputText.trim();
  const authProfile = useMemo(() => detectParseAuthProfile(effectiveInput || inputText), [effectiveInput, inputText]);
  const electronParseAuth = typeof window !== 'undefined' ? window.t8pc?.parseAuth : undefined;
  const normalizedCookie = useMemo(() => normalizeCookieInput(cookieInput), [cookieInput]);
  const cookieReady = useMemo(() => hasUsableCookie(cookieInput), [cookieInput]);
  const desktopAuthAvailable = Boolean(electronParseAuth?.login && electronParseAuth?.getCookie);
  const authModeLabel = cookieReady
    ? 'Cookie 已就绪'
    : savedAuth
      ? '本机有授权'
      : desktopAuthAvailable
        ? '桌面自动模式'
        : '浏览器手动模式';
  const authModeHint = desktopAuthAvailable
    ? `自动模式：先点“打开授权窗口”登录 ${authProfile?.label || '平台'}，登录完成后回到本节点点“检测授权”，节点会自动读取 Cookie。`
    : `浏览器手动模式：127.0.0.1 页面不能跨站读取 ${authProfile?.label || '平台'} Cookie。要自动获取，请使用 Electron 桌面端；当前只能按指南手动复制 Cookie 后粘贴。`;
  const openAuthButtonLabel = desktopAuthAvailable ? '打开授权窗口' : '打开平台官网';
  const detectAuthButtonLabel = desktopAuthAvailable ? '检测授权' : '检查已粘贴 Cookie';
  const isRunning = status === 'generating' || status === 'running';
  const authSteps = desktopAuthAvailable
    ? [
      { label: '打开官方登录页', active: Boolean(authProfile) && !cookieReady },
      { label: '登录后检测授权', active: Boolean(authProfile) && !cookieReady },
      { label: '解析或保存授权', active: cookieReady },
    ]
    : [
      { label: '打开平台官网', active: Boolean(authProfile) && !cookieReady },
      { label: '按指南复制 Cookie', active: Boolean(authProfile) && !cookieReady },
      { label: '粘贴后解析', active: cookieReady },
    ];

  useEffect(() => {
    if (persistedCookie) {
      update({ aggregateParserCookie: '' });
    }
  }, [persistedCookie, update]);

  useEffect(() => {
    if (d.aggregateParserMode === 'parse' && d.aggregateParserModeUserSet !== true) {
      update({ aggregateParserMode: 'download' });
    }
  }, [d.aggregateParserMode, d.aggregateParserModeUserSet, update]);

  const refreshSavedAuth = useCallback(async () => {
    if (!authProfile || !electronParseAuth?.listSaved) {
      setSavedAuth(null);
      return;
    }
    try {
      const res = await electronParseAuth.listSaved(authProfile.id);
      const data: any = res?.data;
      setAuthStoreEncryptionAvailable(data?.encryptionAvailable !== false);
      const record = Array.isArray(data?.records) ? data.records[0] : null;
      setSavedAuth(record || null);
    } catch {
      setSavedAuth(null);
    }
  }, [authProfile, desktopAuthAvailable, electronParseAuth]);

  useEffect(() => {
    void refreshSavedAuth();
  }, [refreshSavedAuth]);

  const upsertTextOutput = useCallback((text: string) => {
    const finalText = text.trim();
    if (!finalText) return;
    const nodes = rf.getNodes();
    const edges = rf.getEdges();
    const downstreamOutputIds = new Set(
      edges
        .filter((edge) => edge.source === p.id)
        .map((edge) => nodes.find((node) => node.id === edge.target))
        .filter((node): node is Node => Boolean(node && node.type === 'output'))
        .map((node) => node.id),
    );
    if (downstreamOutputIds.size > 0) {
      rf.setNodes((nds) =>
        nds.map((node) => {
          if (!downstreamOutputIds.has(node.id)) return node;
          const nd = (node.data as any) || {};
          return {
            ...node,
            data: {
              ...nd,
              directOutputText: finalText,
              directTextSegments: [finalText],
              textSegments: [finalText],
            },
          };
        }),
      );
      return;
    }

    const me = rf.getNode(p.id);
    const myW = (me as any)?.measured?.width || (me as any)?.width || 620;
    const baseX = (me?.position?.x ?? 0) + myW + 80;
    const baseY = me?.position?.y ?? 0;
    const pos = placeSingleNode(baseX, baseY, 'output', nodes, { source: `placement:aggregate-parser-output:${p.id}` });
    const ts = Date.now();
    const newId = `output-auto-aggregate-parser-${p.id}-${ts}-${Math.random().toString(36).slice(2, 6)}`;
    const newNode: Node = {
      id: newId,
      type: 'output',
      position: pos,
      data: {
        directOutputText: finalText,
        directTextSegments: [finalText],
        textSegments: [finalText],
      },
      selected: false,
    } as Node;
    const newEdge: Edge = {
      id: `e-auto-aggregate-parser-${newId}`,
      source: p.id,
      target: newId,
      type: 'deletable',
    } as Edge;
    rf.addNodes(newNode);
    rf.setEdges((eds) => [...eds, newEdge]);
  }, [p.id, rf]);

  const handleCheckRuntime = useCallback(async () => {
    setChecking(true);
    setMessage('');
    try {
      const data = await getAggregateParserStatus();
      setRuntimeStatus(data);
      setMessage(data.available
        ? data.embeddedRuntimePending
          ? '内置 ParseHub 运行时归档可用；首次解析会准备到本机缓存。'
          : 'ParseHub 运行时可用'
        : data.error || 'ParseHub 运行时不可用');
    } catch (err: any) {
      setRuntimeStatus({
        ok: false,
        available: false,
        error: err?.message || '运行时检查失败',
        platforms: [],
        supportedPlatforms: PLATFORM_HINTS,
      });
      setMessage(err?.message || '运行时检查失败');
    } finally {
      setChecking(false);
    }
  }, []);

  const handleOpenAuthWindow = useCallback(async () => {
    if (!authProfile) {
      setMessage(`请先粘贴短链或分享文案，节点会识别平台后再${desktopAuthAvailable ? '打开授权窗口' : '打开平台官网'}`);
      return;
    }
    if (!electronParseAuth?.login) {
      openUrl(authProfile.authUrl);
      setMessage(`当前是浏览器手动模式，已打开 ${authProfile.label} 官网；网页登录后本节点仍无法自动读取 Cookie。请按“复制获取指南”手动复制 Cookie 后粘贴，或改用 Electron 桌面端自动授权。`);
      return;
    }
    setAuthBusy(true);
    try {
      const res = await electronParseAuth.login(authProfile.id);
      setMessage(res?.message || (res?.success
        ? `已打开 ${authProfile.label} 官方登录窗口。登录完成后回到本节点点击“检测授权”，不需要手动复制 Cookie。`
        : '授权窗口打开失败'));
    } catch (err: any) {
      setMessage(err?.message || '授权窗口打开失败');
    } finally {
      setAuthBusy(false);
    }
  }, [authProfile, electronParseAuth]);

  const handleReadAuthCookie = useCallback(async () => {
    if (!authProfile) {
      setMessage('请先粘贴短链或分享文案，节点会识别平台后再检测授权');
      return;
    }
    if (!electronParseAuth?.getCookie) {
      setMessage(cookieReady
        ? `手动 Cookie 格式看起来可用，长度 ${normalizedCookie.length}；解析时会随本次请求发送。`
        : '当前是浏览器手动模式，不能自动读取平台官网 Cookie；请先把 Cookie 粘贴到下方输入框。要自动检测，请在 Electron 桌面端打开画布。');
      return;
    }
    setAuthBusy(true);
    try {
      const res = await electronParseAuth.getCookie(authProfile.id);
      const data = (res?.data && 'cookie' in res.data) ? res.data : null;
      if (res?.success && data?.cookie) {
        setCookieInput(data.cookie);
        update({ aggregateParserCookie: '' });
        const domainText = Array.isArray(data.domains) && data.domains.length ? ` · ${data.domains.join(' / ')}` : '';
        setMessage(`${data.label || authProfile.label} 已授权：${data.count || 0} 个 Cookie，长度 ${data.length || data.cookie.length}${domainText}。现在可以直接解析，也可以点击“保存授权”供下次使用。`);
      } else {
        setMessage(res?.message || `没有检测到 ${authProfile.label} Cookie。请确认授权窗口里已经登录账号，并停留在 ${authProfile.label} 官方页面，再回来点“检测授权”。`);
      }
    } catch (err: any) {
      setMessage(err?.message || '检测授权失败');
    } finally {
      setAuthBusy(false);
    }
  }, [authProfile, cookieReady, electronParseAuth, normalizedCookie.length, update]);

  const handleSaveAuth = useCallback(async () => {
    if (!authProfile) {
      setMessage('请先粘贴短链或分享文案，节点会识别平台后再保存授权');
      return;
    }
    if (!electronParseAuth?.save) {
      setMessage('当前是浏览器手动模式，没有桌面端本机授权库；粘贴 Cookie 后可直接用于本次解析，无需保存。要保存授权请用 Electron 桌面端。');
      return;
    }
    if (!cookieReady || !normalizedCookie) {
      setMessage('请先通过授权窗口检测 Cookie，或手动粘贴有效 Cookie 后再保存。');
      return;
    }
    if (!authStoreEncryptionAvailable) {
      setMessage('系统加密能力不可用，不能把 Cookie 保存到本机授权库；仍可只用于本次解析。');
      return;
    }
    setAuthBusy(true);
    try {
      const res = await electronParseAuth.save(authProfile.id, normalizedCookie, {
        domains: authProfile.domains,
      });
      setMessage(res?.message || (res?.success ? '授权已保存' : '授权保存失败'));
      await refreshSavedAuth();
    } catch (err: any) {
      setMessage(err?.message || '授权保存失败');
    } finally {
      setAuthBusy(false);
    }
  }, [authProfile, authStoreEncryptionAvailable, cookieReady, desktopAuthAvailable, electronParseAuth, normalizedCookie, refreshSavedAuth]);

  const handleLoadSavedAuth = useCallback(async () => {
    if (!authProfile) {
      setMessage('请先粘贴短链或分享文案，节点会识别平台后再载入授权');
      return;
    }
    if (!electronParseAuth?.load) {
      setMessage('当前是浏览器手动模式，没有桌面端本机授权库；请手动粘贴 Cookie。');
      return;
    }
    if (!savedAuth) {
      setMessage(`本机还没有保存 ${authProfile.label} 授权，请先检测或粘贴 Cookie 后保存。`);
      return;
    }
    setAuthBusy(true);
    try {
      const res = await electronParseAuth.load(authProfile.id);
      const data: any = res?.data;
      if (res?.success && data?.cookie) {
        setCookieInput(data.cookie);
        update({ aggregateParserCookie: '' });
        setMessage(res.message || `已载入 ${authProfile.label} 本机授权`);
        await refreshSavedAuth();
      } else {
        setMessage(res?.message || '没有可用的本机授权');
      }
    } catch (err: any) {
      setMessage(err?.message || '载入本机授权失败');
    } finally {
      setAuthBusy(false);
    }
  }, [authProfile, electronParseAuth, refreshSavedAuth, savedAuth, update]);

  const handleClearAuth = useCallback(async () => {
    setCookieInput('');
    update({ aggregateParserCookie: '' });
    if (!authProfile || !electronParseAuth?.clear) {
      setMessage('已清空节点内 Cookie');
      return;
    }
    setAuthBusy(true);
    try {
      const res = await electronParseAuth.clear(authProfile.id);
      setMessage(res?.message || '已清空授权 Cookie');
      await refreshSavedAuth();
    } catch (err: any) {
      setMessage(err?.message || '节点 Cookie 已清空；Electron 授权缓存清理失败');
    } finally {
      setAuthBusy(false);
    }
  }, [authProfile, electronParseAuth, refreshSavedAuth, update]);

  const handleCopyGuide = useCallback(() => {
    copyText(buildCookieGuide(authProfile));
    setMessage('已复制手动 Cookie 获取指南。Cookie 等同登录凭证，只在可信本机使用。');
  }, [authProfile]);

  const handleRun = useCallback(async () => {
    if (!acceptedCompliance) {
      const msg = '请先勾选合规确认，再开始解析';
      update({ status: 'error', error: msg });
      throw new Error(msg);
    }
    const input = effectiveInput.trim();
    if (!input) {
      const msg = '请粘贴短链、作品链接、分享码，或连接上游文本节点';
      update({ status: 'error', error: msg });
      throw new Error(msg);
    }

    update({ status: 'generating', error: '', aggregateParserLastRunAt: Date.now() });
    setMessage(mode === 'download' ? '正在解析并保存到本地输出目录...' : '正在解析远端媒体地址...');
    try {
      const data = await resolveAggregateMedia({
        input,
        mode,
        proxy: proxy.trim() || undefined,
        cookie: normalizedCookie || undefined,
        acceptedCompliance,
      });
      const imageUrls = mediaUrls(data.media || [], 'image');
      const videoUrls = mediaUrls(data.media || [], 'video');
      const audioUrls = mediaUrls(data.media || [], 'audio');
      const outputText = data.outputText || '';
      update({
        status: 'success',
        error: '',
        prompt: outputText,
        text: outputText,
        outputText,
        textSegments: outputText ? [outputText] : [],
        aggregateParserInput: input,
        aggregateParserResult: data,
        aggregateParserMedia: data.media || [],
        aggregateParserResolvedAt: Date.now(),
        imageUrl: imageUrls[0] || '',
        imageUrls,
        urls: imageUrls,
        videoUrl: videoUrls[0] || '',
        videoUrls,
        audioUrl: audioUrls[0] || '',
        audioUrls,
      });
      upsertTextOutput(outputText);
      setMessage(data.media?.length
        ? mode === 'download'
          ? `已保存到输出目录：${data.media.length} 个媒体文件`
          : `解析完成：${data.media.length} 个远端地址。平台 CDN 地址可能会过期或 403，建议改用“保存到输出目录”。`
        : '解析完成：未发现可下载媒体，已输出文本结果');
    } catch (err: any) {
      const msg = friendlyParseError(err, authProfile?.label);
      update({ status: 'error', error: msg });
      setMessage(msg);
      throw err;
    }
  }, [acceptedCompliance, authProfile, effectiveInput, mode, normalizedCookie, proxy, update, upsertTextOutput]);

  useRunTrigger(p.id, handleRun);

  const allLinks = useMemo(() => (result?.media || []).map((item) => item.url).filter(Boolean), [result]);
  const runtimeAvailable = runtimeStatus?.available;
  const noticeText = message || savedError;
  const noticeIsError = !message && status === 'error';

  return (
    <div
      className="t8-node relative transition-all"
      style={{
        width: 620,
        borderColor: p.selected ? COLOR : undefined,
        boxShadow: p.selected ? `0 0 0 2px ${COLOR}, var(--t8-shadow-strong, 0 18px 36px rgba(0,0,0,.22))` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: COLOR, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: COLOR, border: 0 }} />

      <div className="relative z-10">
        <div className="t8-node-header flex items-center gap-2 px-3 py-2">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ background: 'color-mix(in srgb, var(--t8-accent) 18%, transparent)', color: 'var(--t8-accent)' }}
          >
            <Link2 size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-[var(--t8-text-main)]">聚合解析</div>
            <div className="text-[10px] text-[var(--t8-text-muted)]">
              ParseHub · 短链 / 分享码 / 分享文案
            </div>
          </div>
          {status === 'success' && <CheckCircle2 size={16} className="text-emerald-300" />}
          {isRunning && <Loader2 size={16} className="animate-spin text-pink-300" />}
        </div>

        <div
          className="nodrag nopan nowheel space-y-3 p-3"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onWheelCapture={(e) => e.stopPropagation()}
        >
          <div className="rounded-lg border border-amber-400/35 bg-amber-400/10 p-2 text-[11px] leading-relaxed text-[var(--t8-text-main)]">
            <div className="mb-1 flex items-center gap-1.5 font-bold text-amber-200">
              <ShieldAlert size={14} />
              合规使用确认
            </div>
            <div className="text-[var(--t8-text-muted)]">
              仅解析本人拥有版权、已获授权，或平台明确允许保存的公开内容；不得用于搬运、售卖、骚扰、绕过付费/DRM 或抓取私密内容。
            </div>
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11px] font-bold">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 accent-pink-400"
                checked={acceptedCompliance}
                onChange={(e) => update({ aggregateParserAcceptedCompliance: e.target.checked })}
              />
              <span>我确认内容来源合法并承担使用责任</span>
            </label>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-bold text-[var(--t8-text-main)]">短链 / 分享码</label>
              {upstreamText && (
                <label className="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--t8-text-muted)]">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-pink-400"
                    checked={preferUpstream}
                    onChange={(e) => update({ aggregateParserPreferUpstream: e.target.checked })}
                  />
                  优先使用上游文本
                </label>
              )}
            </div>
            <textarea
              className="t8-input nodrag nowheel h-24 w-full resize-none text-xs"
              value={inputText}
              placeholder="粘贴平台分享文案、短链或作品链接。例：复制抖音/小红书/B站/YouTube 分享文本后直接放这里。"
              onChange={(e) => update({ aggregateParserInput: e.target.value })}
            />
            {preferUpstream && upstreamText && (
              <div className="flex items-start gap-1 rounded-md border border-pink-300/20 bg-pink-300/10 px-2 py-1 text-[10px] text-[var(--t8-text-muted)]">
                <Info size={12} className="mt-0.5 shrink-0 text-pink-200" />
                <span>当前会使用上游文本：{shortText(upstreamText, 96)}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px] font-bold text-[var(--t8-text-main)]">
              <span>解析模式</span>
              <select
                className="t8-select nodrag nowheel w-full text-xs"
                value={mode}
                onChange={(e) => {
                  const nextMode = e.target.value === 'parse' ? 'parse' : 'download';
                  update({ aggregateParserMode: nextMode, aggregateParserModeUserSet: true });
                }}
              >
                <option value="download">保存到输出目录</option>
                <option value="parse">只解析远端地址</option>
              </select>
              <span className="block text-[10px] font-normal leading-relaxed text-[var(--t8-text-muted)]">
                {mode === 'download'
                  ? '推荐：保存为本地输出文件，下游节点和浏览器预览更稳定。'
                  : '远端 CDN 链接可能需要平台请求头、Cookie 或时效签名，直接打开可能 403。'}
              </span>
            </label>
            <div className="space-y-1 text-[11px] font-bold text-[var(--t8-text-main)]">
              <span>运行时</span>
              <button
                type="button"
                className="t8-btn w-full min-h-9 text-xs"
                onClick={handleCheckRuntime}
                disabled={checking}
              >
                {checking ? <Loader2 size={14} className="animate-spin" /> : <SearchCheck size={14} />}
                {runtimeStatus ? (runtimeAvailable ? (runtimeStatus.embeddedRuntimePending ? '待准备' : '可用') : '不可用') : '检查'}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-pink-300/25 bg-pink-300/10 p-2 text-[11px] text-[var(--t8-text-main)]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 font-bold">
                  <KeyRound size={13} className="text-pink-200" />
                  <span>{authProfile ? `${authProfile.label} 授权助手` : 'Cookie 授权助手'}</span>
                  <span className="rounded bg-pink-300/15 px-1 py-0.5 text-[10px] text-[var(--t8-text-muted)]">
                    {authModeLabel}
                  </span>
                </div>
                <div className="mt-1 leading-relaxed text-[var(--t8-text-muted)]">
                  {authProfile
                    ? authProfile.cookieHint
                    : '粘贴平台短链后会自动识别平台；公开内容优先直接解析，只有需要登录态时再使用 Cookie。'}
                </div>
                <div
                  className={`mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[10px] leading-relaxed ${
                    desktopAuthAvailable
                      ? 'border-emerald-400/25 bg-emerald-400/10 text-[var(--t8-text-main)]'
                      : 'border-amber-400/35 bg-amber-400/10 text-[var(--t8-text-main)]'
                  }`}
                >
                  <Info size={12} className="mt-0.5 shrink-0" />
                  <span>{authModeHint}</span>
                </div>
                {authProfile && (
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {authSteps.map((step, index) => (
                      <div
                        key={step.label}
                        className={`rounded-md border px-2 py-1 text-[10px] leading-tight ${
                          step.active
                            ? 'border-emerald-400/35 bg-emerald-400/10 text-[var(--t8-text-main)]'
                            : 'border-[var(--t8-border)] bg-[var(--t8-bg-panel)] text-[var(--t8-text-muted)]'
                        }`}
                      >
                        <strong className="mr-1">{index + 1}</strong>{step.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {authProfile && (
                <button
                  type="button"
                  className="t8-btn min-h-7 px-2 text-[10px]"
                  onClick={() => openUrl(authProfile.authUrl)}
                  title="打开平台官网"
                >
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <button
                type="button"
                className="t8-btn min-h-8 text-[11px]"
                disabled={authBusy}
                onClick={handleOpenAuthWindow}
                title={desktopAuthAvailable ? '打开隔离的平台官网登录窗口' : '浏览器模式只能打开平台官网，不能自动读取 Cookie'}
              >
                {authBusy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                {openAuthButtonLabel}
              </button>
              <button
                type="button"
                className="t8-btn min-h-8 text-[11px]"
                disabled={authBusy}
                onClick={handleReadAuthCookie}
                title={desktopAuthAvailable ? '读取授权窗口里的平台 Cookie' : '检查下方是否已经粘贴可用 Cookie'}
              >
                {authBusy ? <Loader2 size={13} className="animate-spin" /> : <SearchCheck size={13} />}
                {detectAuthButtonLabel}
              </button>
              <button
                type="button"
                className="t8-btn min-h-8 text-[11px]"
                disabled={authBusy}
                onClick={handleSaveAuth}
                title={authStoreEncryptionAvailable ? '加密保存到本机授权库' : '系统加密不可用，不能保存 Cookie'}
              >
                <Save size={13} />
                保存授权
              </button>
              <button
                type="button"
                className="t8-btn min-h-8 text-[11px]"
                disabled={authBusy}
                onClick={handleLoadSavedAuth}
              >
                <Download size={13} />
                载入授权
              </button>
              <button
                type="button"
                className="t8-btn min-h-8 text-[11px]"
                onClick={handleCopyGuide}
              >
                <Copy size={13} />
                复制获取指南
              </button>
              <button
                type="button"
                className="t8-btn min-h-8 text-[11px]"
                onClick={handleClearAuth}
                disabled={authBusy}
              >
                <Trash2 size={13} />
                清除 Cookie
              </button>
            </div>
            {savedAuth && (
              <div className="mt-2 rounded-md border border-sky-300/25 bg-sky-300/10 px-2 py-1 text-[10px] text-[var(--t8-text-muted)]">
                本机已保存 {savedAuth.label} 授权：{savedAuth.count || 0} 个 Cookie，长度 {savedAuth.length || 0}
                {savedAuth.updatedAt ? ` · ${new Date(savedAuth.updatedAt).toLocaleString()}` : ''}
              </div>
            )}
            {cookieReady && (
              <div className="mt-2 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] text-[var(--t8-text-muted)]">
                已有本次解析 Cookie，长度 {normalizedCookie.length}。不会在节点结果和日志中展示明文。
              </div>
            )}
          </div>

          <details className="rounded-lg border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] p-2">
            <summary className="cursor-pointer text-[11px] font-bold text-[var(--t8-text-main)]">可选：代理 / Cookie</summary>
            <div className="mt-2 space-y-2">
              <input
                className="t8-input nodrag nowheel w-full text-xs"
                value={proxy}
                placeholder="代理地址，例如 http://127.0.0.1:7890"
                onChange={(e) => update({ aggregateParserProxy: e.target.value })}
              />
              <textarea
                className="t8-input nodrag nowheel h-16 w-full resize-none text-xs"
                value={cookieInput}
                placeholder="可粘贴 Cookie、Cookie: 请求头、curl、JSON Cookie 数组或 Netscape Cookie 文本；仅本次解析使用。"
                onChange={(e) => {
                  setCookieInput(e.target.value);
                  if (persistedCookie) update({ aggregateParserCookie: '' });
                }}
              />
              <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[10px] leading-relaxed text-[var(--t8-text-muted)]">
                Cookie 等同登录凭证。不要把它分享给他人，也不要用于绕过付费、DRM、私密内容或平台权限。
              </div>
            </div>
          </details>

          <div className="flex flex-wrap gap-1">
            {PLATFORM_HINTS.map((name) => (
              <span key={name} className="rounded-md border border-pink-300/20 bg-pink-300/10 px-1.5 py-0.5 text-[10px] text-[var(--t8-text-muted)]">
                {name}
              </span>
            ))}
          </div>

          <button
            type="button"
            className="t8-btn t8-btn-primary w-full min-h-10 text-xs"
            onClick={() => requestCanvasNodeRun(p.id)}
            disabled={isRunning}
          >
            {isRunning ? <Loader2 size={15} className="animate-spin" /> : mode === 'download' ? <Download size={15} /> : <Clipboard size={15} />}
            {mode === 'download' ? '解析并保存到输出目录' : '解析远端地址'}
          </button>

          {noticeText && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[11px] leading-relaxed ${
                noticeIsError
                  ? 'border-red-400/35 bg-red-400/10 text-red-200'
                  : 'border-emerald-400/25 bg-emerald-400/10 text-[var(--t8-text-main)]'
              }`}
            >
              {noticeIsError ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <Info size={14} className="mt-0.5 shrink-0" />}
              <span>{noticeText}</span>
            </div>
          )}

          {runtimeStatus && (
            <div className="rounded-lg border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] p-2 text-[11px] text-[var(--t8-text-muted)]">
              {runtimeStatus.available ? (
                <span>ParseHub {runtimeStatus.parsehubVersion || 'unknown'} · Python {runtimeStatus.pythonVersion || 'unknown'} · 平台 {runtimeStatus.platforms?.length || '17+'}</span>
              ) : (
                <span>运行时不可用：{runtimeStatus.error || '未找到 parsehub 依赖'}</span>
              )}
            </div>
          )}

          {result && (
            <div className="space-y-2 rounded-lg border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-[var(--t8-text-main)]" title={result.title || result.contentPreview || '解析结果'}>
                    {result.title || result.contentPreview || '解析结果'}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--t8-text-muted)]">
                    {result.platformName || result.platform || '未知平台'} · {result.type || 'media'} · {result.mode === 'download' ? '已保存' : '远端地址'}
                  </div>
                </div>
                <button
                  type="button"
                  className="t8-btn min-h-8 px-2 text-[11px]"
                  onClick={() => copyText(result.outputText || '')}
                  title="复制解析摘要"
                >
                  <Copy size={13} />
                </button>
              </div>

              {result.contentPreview && (
                <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel)] px-2 py-1 text-[11px] leading-relaxed text-[var(--t8-text-muted)]">
                  {result.contentPreview}
                </div>
              )}

              {result.mode !== 'download' && (
                <div className="flex items-start gap-1.5 rounded-md border border-amber-400/35 bg-amber-400/10 px-2 py-1.5 text-[10px] leading-relaxed text-[var(--t8-text-main)]">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>远端地址可能带平台防盗链或临时签名，浏览器直接打开出现 403 不一定是解析失败；需要稳定使用时请选择“保存到输出目录”。</span>
                </div>
              )}

              {allLinks.length > 0 ? (
                <div className="space-y-1.5">
                  {result.media.map((item, index) => (
                    <div key={`${item.kind}-${item.url}-${index}`} className="flex items-center gap-2 rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel)] px-2 py-1.5">
                      <span className="shrink-0 rounded bg-pink-300/15 px-1.5 py-0.5 text-[10px] font-bold text-pink-200">
                        {KIND_LABEL[item.kind] || item.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--t8-text-muted)]" title={item.url}>
                        {item.label ? `${item.label} · ` : ''}{item.url}
                      </span>
                      <button type="button" className="t8-btn min-h-7 px-2 text-[10px]" onClick={() => copyText(item.url)} title="复制地址">
                        <Copy size={12} />
                      </button>
                      {/^https?:/i.test(item.url) && (
                        <button type="button" className="t8-btn min-h-7 px-2 text-[10px]" onClick={() => openUrl(item.url)} title="打开地址">
                          <ExternalLink size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button type="button" className="t8-btn w-full min-h-8 text-[11px]" onClick={() => copyText(allLinks.join('\n'))}>
                    <Copy size={13} />
                    复制全部地址
                  </button>
                </div>
              ) : (
                <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel)] px-2 py-2 text-[11px] text-[var(--t8-text-muted)]">
                  没有解析到媒体文件。部分平台文章只返回正文，或需要 Cookie/代理才能访问。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(AggregateParserNode);
