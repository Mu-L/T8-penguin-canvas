import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, Loader2, Music, Sparkles, Square, Upload, X } from 'lucide-react';
import {
  submitAudio,
  queryAudio,
  submitSeedAudio,
  querySeedAudio,
  uploadAudioForSuno,
  uploadFile as uploadLocalFile,
  type AudioMode,
  type AudioProviderMode,
} from '../../services/generation';
import { SUNO_VERSIONS, DEFAULT_SUNO_VERSION } from '../../providers/models';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useHasAutoOutput } from './useHasAutoOutput';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { hasReusableGenerationResult, shouldReuseGenerationResult } from '../../utils/reuseGenerationResult';
import type { RunNodeLifecycleReporter } from '../../types/project';
import { logBus } from '../../stores/logs';
import { PORT_COLOR } from '../../config/portTypes';
import { useThemeStore } from '../../stores/theme';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';
import { useOrderedMaterials } from './useOrderedMaterials';
import MaterialPreviewSection from './MaterialPreviewSection';
import ReuseResultToggle from './ReuseResultToggle';
import MentionPromptInput from './MentionPromptInput';
import { resolveMediaMentions, type MediaMention } from './mediaMentions';
import { useDragMaterialStore, type MaterialPayload } from '../../stores/dragMaterial';
import { useMaterialDropTarget } from '../../hooks/useMaterialDropTarget';
import { taskCompletionSound } from '../../stores/taskCompletionSound';
import {
  countExcludedMaterials,
  excludeMaterialId,
  filterExcludedMaterials,
  normalizeExcludedMaterialIds,
} from '../../utils/materialExclusion';
import { LocalNodeAddonSlot } from 'virtual:t8-local-extensions';

/**
 * AudioNode - Suno (generate / cover / extend) — 完全对齐 gpt-image-2-web
 * 参考: gpt-image-2-web/index.html runSuno (L3979) / runSunoCover (L4282) / runSunoExtend (L4313) / pollSuno (L4015) / _sunoUploadAudio (L4210)
 * 该节点不提供 FAL 模式。
 */

const MODES: Array<{ id: AudioMode; label: string }> = [
  { id: 'generate', label: '生成' },
  { id: 'cover', label: '翻唱(Cover)' },
  { id: 'extend', label: '续写(Extend)' },
];

const SUNO_POLL_INTERVAL_MS = 3000;
const SUNO_POLL_TIMEOUT_SECONDS = 3600;
const SUNO_MAX_POLL = Math.ceil((SUNO_POLL_TIMEOUT_SECONDS * 1000) / SUNO_POLL_INTERVAL_MS);

const AudioNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const hasAutoOutput = useHasAutoOutput(id);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const src = `audio:${id.slice(0, 6)}`;

  // 主题适配
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = themeStyle === 'pixel';

  const d = data as any;
  const providerParams = (d?.providerParams && typeof d.providerParams === 'object') ? d.providerParams : {};
  const audioProviderMode: AudioProviderMode = d?.audioProviderMode === 'seed-audio' ? 'seed-audio' : 'suno';
  const isSeedAudio = audioProviderMode === 'seed-audio';
  const mode: AudioMode = d?.mode || 'generate';
  const version: string = d?.version || DEFAULT_SUNO_VERSION;
  const title: string = d?.title || '';
  const tags: string = d?.tags || '';
  const localPrompt: string = d?.prompt || '';
  const promptMentions: MediaMention[] = Array.isArray(d?.promptMentions) ? d.promptMentions : [];
  const seed: number = typeof d?.seed === 'number' ? d.seed : 0;
  const continueAt: number = d?.continueAt ?? 28;
  const seedAudioSpeaker: string = d?.seedAudioSpeaker || '';
  const seedAudioFormat: 'wav' | 'mp3' | 'pcm' | 'ogg_opus' = ['wav', 'mp3', 'pcm', 'ogg_opus'].includes(d?.seedAudioFormat) ? d.seedAudioFormat : 'wav';
  const seedAudioSampleRate: '8000' | '16000' | '24000' | '32000' | '44100' = ['8000', '16000', '24000', '32000', '44100'].includes(String(d?.seedAudioSampleRate)) ? String(d.seedAudioSampleRate) as any : '24000';
  const seedAudioSpeechRate: number = Number.isInteger(d?.seedAudioSpeechRate) ? d.seedAudioSpeechRate : 0;
  const seedAudioLoudnessRate: number = Number.isInteger(d?.seedAudioLoudnessRate) ? d.seedAudioLoudnessRate : 0;
  const seedAudioPitchRate: number = Number.isInteger(d?.seedAudioPitchRate) ? d.seedAudioPitchRate : 0;
  // 预传 clipId(手动调起 _sunoUploadAudio 后保存)
  const uploadedClipId: string = d?.uploadedClipId || '';
  const uploadedFilename: string = d?.uploadedFilename || '';

  const status: 'idle' | 'submitting' | 'polling' | 'success' | 'error' = d?.status || 'idle';
  const taskId: string | undefined = d?.taskId;
  const tracks: Array<{ id?: string; clipId?: string; audioUrl: string; remoteUrl?: string; imageUrl?: string; title?: string; tags?: string }>
    = d?.tracks || [];
  const pollProgress: string = d?.progress || '';

  const stopPoll = () => {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };
  useEffect(() => () => stopPoll(), []);

  // === 上游素材聚合 (跨节点统一机制) ===
  const upstream = useUpstreamMaterials(id);
  const excludedMaterialIds = useMemo(
    () => normalizeExcludedMaterialIds(d?.excludedMaterialIds),
    [d?.excludedMaterialIds],
  );
  const visibleUpstreamTexts = useMemo(
    () => filterExcludedMaterials(upstream.texts, excludedMaterialIds),
    [upstream.texts, excludedMaterialIds],
  );
  const visibleUpstreamImages = useMemo(
    () => filterExcludedMaterials(upstream.images, excludedMaterialIds),
    [upstream.images, excludedMaterialIds],
  );
  const visibleUpstreamAudios = useMemo(
    () => filterExcludedMaterials(upstream.audios, excludedMaterialIds),
    [upstream.audios, excludedMaterialIds],
  );
  const excludedUpstreamCount = useMemo(
    () => countExcludedMaterials(excludedMaterialIds, [...upstream.texts, ...upstream.images, ...upstream.audios]),
    [excludedMaterialIds, upstream.texts, upstream.images, upstream.audios],
  );
  const materialOrder: string[] = Array.isArray(d?.materialOrder) ? d.materialOrder : [];
  const orderedTexts = useOrderedMaterials(visibleUpstreamTexts, materialOrder);
  const orderedImages = useOrderedMaterials(visibleUpstreamImages, materialOrder);
  const orderedAudios = useOrderedMaterials(visibleUpstreamAudios, materialOrder);
  const setMaterialOrder = (newOrder: string[]) => update({ materialOrder: newOrder });
  const handleExcludeUpstreamMaterial = (m: Material) => {
    if (m.origin !== 'upstream') return;
    update({
      excludedMaterialIds: excludeMaterialId(excludedMaterialIds, m.id),
      materialOrder: materialOrder.filter((itemId) => itemId !== m.id),
    });
  };
  const handleRestoreExcludedMaterials = () => update({ excludedMaterialIds: [] });

  // === 本地拖入参考音频 (跨节点 Ctrl 拖拽) ===
  const localRefAudio: string = typeof d?.localRefAudio === 'string' ? d.localRefAudio : '';
  const localRefImage: string = typeof d?.localRefImage === 'string' ? d.localRefImage : '';
  const localRefAudioMaterials: Material[] = useMemo(
    () =>
      localRefAudio
        ? [{
            id: `local::audio-ref:${localRefAudio}`,
            kind: 'audio' as const,
            url: localRefAudio,
            sourceNodeId: id,
            origin: 'local' as const,
            label: '本地参考音频',
          }]
        : [],
    [localRefAudio, id],
  );
  const mentionMaterials = useMemo(
    () => isSeedAudio
      ? [...orderedImages.slice(0, 1), ...orderedAudios.slice(0, 3), ...localRefAudioMaterials]
      : [...orderedAudios, ...localRefAudioMaterials],
    [isSeedAudio, orderedImages, orderedAudios, localRefAudioMaterials],
  );
  
  // 分组动态跟随模式: generate 只要文本, cover/extend 需要参考音频
  const previewGroups = useMemo<ReadonlyArray<'text' | 'image' | 'video' | 'audio'>>(
    () => isSeedAudio ? ['text', 'image', 'audio'] : (mode === 'generate' ? ['text'] : ['text', 'audio']),
    [isSeedAudio, mode],
  );
  
  // 收集上游: prompt + audioUrl(cover/extend 兼底, 取 ordered 首个, 后补本地拖入)
  const collectUpstream = (): { prompt: string; audioUrl: string; imageUrls: string[]; audioUrls: string[] } => {
    const prompt = orderedTexts.map((t) => t.url).filter((s) => !!s).join('\n').trim();
    const audioUrl = orderedAudios[0]?.url || localRefAudio || '';
    const imageUrls = [...orderedImages.map((item) => item.url), localRefImage].filter(Boolean).slice(0, 1);
    const audioUrls = [...orderedAudios.map((item) => item.url), localRefAudio].filter((value, index, values) => !!value && values.indexOf(value) === index).slice(0, 3);
    return { prompt, audioUrl, imageUrls, audioUrls };
  };

  // 上传本地音频 → 获取 clipId
  const uploadFile = async (file: File): Promise<string> => {
      setUploading(true);
    try {
      logBus.info(`上传音频: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, src);
      const r = await uploadAudioForSuno(file, providerParams);
      update({ uploadedClipId: r.clipId, uploadedFilename: r.filename });
      logBus.success(`上传成功, clipId=${r.clipId}`, src);
      return r.clipId;
    } finally {
      setUploading(false);
    }
  };

  // 将 URL 抓为 File 后上传(上游节点传入 audioUrl 时)
  const fetchUrlAndUpload = async (url: string): Promise<string> => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载上游音频失败: ${resp.status}`);
    const blob = await resp.blob();
    const ext = (url.match(/\.(mp3|wav|m4a|ogg|flac|aac)/i)?.[1] || 'mp3').toLowerCase();
    const file = new File([blob], `upstream_audio.${ext}`, { type: blob.type || 'audio/mpeg' });
    return await uploadFile(file);
  };

  const onSelectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    try {
      if (isSeedAudio) {
        setUploading(true);
        const uploaded = await uploadLocalFile(f);
        update({ localRefAudio: uploaded.url, uploadedClipId: '', uploadedFilename: f.name });
        logBus.success(`Seed Audio 参考音频已加入: ${f.name}`, src);
      } else {
        await uploadFile(f);
      }
    } catch (err: any) {
      setError(err?.message || '上传失败');
      logBus.error(err?.message || '上传失败', src);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearUpload = () => update({ uploadedClipId: '', uploadedFilename: '' });

  // 轮询: 3000ms × 1200 次 = 3600s，避免 Suno 长任务 3 分钟提前超时。
  // v1.2.9.11: 返回 Promise，调用方 await 直到任务成功/失败/超时才 resolve/reject。
  //   原设计中 startPolling 启动 setInterval 后立即返回 → handleGenerate 提交成功后也立即返回→
  //   useRunTrigger 认为 runFn 完成 markDone(true)。 但实际任务 audioUrl 还未赋值 → LoopNode awaitNode
  //   立即继续 → extractFromNode 读不到 audioUrl → result=null → failCount++。
  //   修复后: 轮询完成才 resolve，handleGenerate await 它，什么时候 markDone 什么时候任务真正结束。
  const startPolling = (clipIds: string[], reporter?: RunNodeLifecycleReporter): Promise<void> => {
    stopPoll();
    return new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      const POLL_INT = SUNO_POLL_INTERVAL_MS;
      const MAX = SUNO_MAX_POLL;
      pollTimer.current = window.setInterval(async () => {
        elapsed += 1;
        if (elapsed > MAX) {
          stopPoll();
          update({ status: 'error', error: '轮询超时 (60min)' });
          setError('轮询超时 (60min)');
          logBus.error('轮询超时', src);
          reject(new Error('轮询超时 (60min)'));
          return;
        }
        try {
          const r = await queryAudio(clipIds, true);
          await reporter?.polling({
            provider: 'suno',
            model: version,
            taskIds: clipIds,
            requestId: r.requestId,
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
            httpStatusSource: 'local-backend',
            pollCount: elapsed,
            pollLimit: MAX,
            status: r.status,
            completed: r.completed,
            total: r.total,
          });
          if (r.status === 'SUCCESS' && r.tracks.length > 0) {
            stopPoll();
            // 双输出口: audioUrl=轨1, audioUrl_1=轨2
            update({
              status: 'success',
              tracks: r.tracks,
              audioUrl: r.tracks[0]?.audioUrl || '',
              audioUrl_1: r.tracks[1]?.audioUrl || '',
              progress: `${r.completed}/${r.total}`,
              provider: 'suno',
              model: version,
              requestId: r.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
            });
            await reporter?.providerResponse({
              provider: 'suno',
              model: version,
              requestId: r.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
              status: 'succeeded',
              httpStatusSource: 'local-backend',
            });
            logBus.success(`完成 ${r.tracks.length} 轨: ${r.tracks.map((t) => t.audioUrl).join(' | ')}`, src);
            taskCompletionSound.notifyComplete(id, 'audio');
            resolve();
          } else {
            update({ status: 'polling', progress: `${r.completed}/${r.total} · #${elapsed}` });
            if (elapsed % 3 === 0) logBus.info(`轮询 #${elapsed} · ${r.completed}/${r.total}`, src);
          }
        } catch (e: any) {
          logBus.warn(`轮询出错: ${e?.message}`, src);
        }
      }, POLL_INT);
    });
  };

  const startSeedAudioPolling = (tid: string, reporter?: RunNodeLifecycleReporter): Promise<void> => {
    stopPoll();
    return new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      pollTimer.current = window.setInterval(async () => {
        elapsed += 1;
        if (elapsed > SUNO_MAX_POLL) {
          stopPoll();
          const message = 'Seed Audio 轮询超时 (60min)';
          setError(message);
          update({ status: 'error', error: message });
          reject(new Error(message));
          return;
        }
        try {
          const result = await querySeedAudio(tid);
          const normalizedStatus = String(result.status || '').trim().toLowerCase();
          const currentProgress = String(result.progress ?? '');
          await reporter?.polling({
            provider: 'seedance-nz',
            model: 'doubao-seed-audio-1.0',
            taskId: tid,
            requestId: result.requestId,
            transportHttpStatus: result.transportHttpStatus,
            upstreamHttpStatus: result.upstreamHttpStatus,
            usage: result.usage,
            httpStatusSource: 'local-backend',
            pollCount: elapsed,
            pollLimit: SUNO_MAX_POLL,
            status: normalizedStatus,
            progress: currentProgress,
          });
          if (normalizedStatus === 'succeeded' && result.audioUrl) {
            stopPoll();
            const seedTrack = {
              id: tid,
              clipId: tid,
              audioUrl: result.audioUrl,
              remoteUrl: result.remoteAudioUrl || undefined,
              title: 'Seed Audio',
            };
            update({
              status: 'success',
              tracks: [seedTrack],
              audioUrl: result.audioUrl,
              audioUrl_1: '',
              progress: '100%',
              provider: 'seedance-nz',
              model: 'doubao-seed-audio-1.0',
              taskId: tid,
              requestId: result.requestId,
              transportHttpStatus: result.transportHttpStatus,
              upstreamHttpStatus: result.upstreamHttpStatus,
              usage: result.usage,
              pollCount: elapsed,
            });
            await reporter?.providerResponse({
              provider: 'seedance-nz',
              model: 'doubao-seed-audio-1.0',
              upstreamTaskId: tid,
              requestId: result.requestId,
              transportHttpStatus: result.transportHttpStatus,
              upstreamHttpStatus: result.upstreamHttpStatus,
              usage: result.usage,
              pollCount: elapsed,
              status: 'succeeded',
              httpStatusSource: 'local-backend',
            });
            logBus.success(`Seed Audio 完成 → ${result.audioUrl}`, src);
            taskCompletionSound.notifyComplete(id, 'audio');
            resolve();
          } else if (normalizedStatus === 'failed') {
            stopPoll();
            const message = result.failReason || 'Seed Audio 生成失败';
            await reporter?.providerResponse({
              provider: 'seedance-nz',
              model: 'doubao-seed-audio-1.0',
              upstreamTaskId: tid,
              requestId: result.requestId,
              transportHttpStatus: result.transportHttpStatus,
              upstreamHttpStatus: result.upstreamHttpStatus,
              usage: result.usage,
              pollCount: elapsed,
              status: 'failed',
              error: { message },
              httpStatusSource: 'local-backend',
            });
            setError(message);
            update({ status: 'error', error: message });
            reject(new Error(message));
          } else {
            update({ status: 'polling', progress: currentProgress || `#${elapsed}` });
          }
        } catch (pollError: any) {
          logBus.warn(`Seed Audio 轮询出错: ${pollError?.message || pollError}`, src);
        }
      }, 4000);
    });
  };

  const handleGenerate = async (reporter?: RunNodeLifecycleReporter) => {
    setError(null);
    const upstream = collectUpstream();
    const resolvedLocalPrompt = resolveMediaMentions(localPrompt, promptMentions, mentionMaterials);
    const finalPrompt = (upstream.prompt || resolvedLocalPrompt || '').trim();
    if (!finalPrompt) {
      setError(isSeedAudio ? '请填写音频提示词' : '请填写歌词 / 提示词');
      return;
    }
    if (isSeedAudio && (finalPrompt.length < 5 || finalPrompt.length > 2048)) {
      setError('Seed Audio 提示词长度必须为 5-2048 字符');
      return;
    }
    const traceProvider = isSeedAudio ? 'seedance-nz' : 'suno';
    const traceModel = isSeedAudio ? 'doubao-seed-audio-1.0' : version;
    await reporter?.providerRequest({ provider: traceProvider, model: traceModel });
    taskCompletionSound.primeAudio();
    update({ status: 'submitting', error: null, tracks: [], audioUrl: undefined });
    try {
      if (isSeedAudio) {
        const hasSpeaker = !!seedAudioSpeaker.trim();
        const hasImage = upstream.imageUrls.length > 0;
        const hasAudio = upstream.audioUrls.length > 0;
        if ([hasSpeaker, hasImage, hasAudio].filter(Boolean).length > 1) {
          throw new Error('Seed Audio 的音色 ID、参考图和参考音频只能选择一种；请移除多余素材或清空音色 ID');
        }
        logBus.info(
          `提交 Seed Audio: doubao-seed-audio-1.0 · ${seedAudioFormat}/${seedAudioSampleRate} · 图${upstream.imageUrls.length}/音${upstream.audioUrls.length}`,
          src,
        );
        const result = await submitSeedAudio({
          model: 'doubao-seed-audio-1.0',
          prompt: finalPrompt,
          speaker: seedAudioSpeaker.trim() || undefined,
          outputFormat: seedAudioFormat,
          sampleRate: seedAudioSampleRate,
          speechRate: seedAudioSpeechRate,
          loudnessRate: seedAudioLoudnessRate,
          pitchRate: seedAudioPitchRate,
          images: upstream.imageUrls.length ? upstream.imageUrls : undefined,
          audioUrls: upstream.audioUrls.length ? upstream.audioUrls : undefined,
        });
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: finalPrompt, progress: '0%' });
        logBus.info(`Seed Audio 任务 ${result.taskId} 已提交，开始轮询`, src);
        await startSeedAudioPolling(result.taskId, reporter);
        return;
      }
      // cover/extend: 如预传 clipId 为空但上游有 audioUrl, 则自动上传
      let clipIdForRef = uploadedClipId;
      if ((mode === 'cover' || mode === 'extend') && !clipIdForRef && upstream.audioUrl) {
        logBus.info('检测到上游音频 URL, 自动上传 Suno...', src);
        clipIdForRef = await fetchUrlAndUpload(upstream.audioUrl);
      }
      if ((mode === 'cover' || mode === 'extend') && !clipIdForRef) {
        throw new Error(`${mode === 'cover' ? '翻唱' : '续写'}模式需先上传参考音频 (或连接上游音频节点)`);
      }

      logBus.info(`提交 Suno ${version} (${mode})...`, src);
      const r = await submitAudio({
        mode,
        prompt: finalPrompt,
        title: title || '',
        tags: tags || '',
        version,
        seed: seed > 0 ? seed : undefined,
        cover_clip_id: mode === 'cover' ? clipIdForRef : undefined,
        continue_clip_id: mode === 'extend' ? clipIdForRef : undefined,
        continue_at: mode === 'extend' ? continueAt : undefined,
        providerParams,
      });
      await reporter?.providerSubmitted({
        provider: traceProvider,
        model: traceModel,
        upstreamTaskId: r.taskId,
        requestId: r.requestId,
        transportHttpStatus: r.transportHttpStatus,
        upstreamHttpStatus: r.upstreamHttpStatus,
        usage: r.usage,
        httpStatusSource: 'local-backend',
      });
      logBus.success(`taskId=${r.taskId} clips=${(r.clipIds || []).join(',') || '?'}`, src);
      update({ status: 'polling', taskId: r.taskId, clipIds: r.clipIds, lastPrompt: finalPrompt, progress: '0/?' });
      const idsToPoll = r.clipIds && r.clipIds.length > 0 ? r.clipIds : [r.taskId];
      // v1.2.9.11: await 轮询 —— 让 useRunTrigger 等到任务真正完成才 markDone，LoopNode awaitNode 才能拿到 audioUrl
      await startPolling(idsToPoll, reporter);
    } catch (e: any) {
      const msg = e?.message || '提交失败';
      await reporter?.providerResponse({
        provider: traceProvider,
        model: traceModel,
        requestId: e?.requestId,
        transportHttpStatus: e?.transportHttpStatus,
        upstreamHttpStatus: e?.upstreamHttpStatus,
        status: 'failed',
        error: { message: msg, code: e?.code },
        httpStatusSource: 'local-backend',
      });
      setError(msg);
      logBus.error(msg, src);
      update({ status: 'error', error: msg });
    }
  };

  const handleStop = () => {
    stopPoll();
    update({ status: 'idle' });
  };

  // 接入运行总线
  useRunTrigger(id, async (reporter) => {
    if (status === 'submitting' || status === 'polling') return;
    await handleGenerate(reporter);
  }, 'audio', {
    lifecycleAware: true,
    shouldReuseResult: (nodeData) => shouldReuseGenerationResult('audio', nodeData),
  });

  // === 跨节点拖拽: source (输出 tracks 可拖出) ===
  const startDrag = useDragMaterialStore((s) => s.start);
  const beginMaterialDrag = (e: React.MouseEvent, payload: MaterialPayload) => {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    startDrag(payload, e.clientX, e.clientY);
  };

  // === 跨节点拖拽: target (Seed Audio additionally accepts one reference image) ===
  const handleDrop = (payload: MaterialPayload) => {
    if (payload.kind === 'audio' && payload.url) {
      update({ localRefAudio: payload.url, uploadedClipId: '', uploadedFilename: '' });
      logBus.info('已接受拖入参考音频, 生成时将自动上传', src);
    } else if (isSeedAudio && payload.kind === 'image' && payload.url) {
      update({ localRefImage: payload.url });
      logBus.info('已接受 Seed Audio 参考图', src);
    } else if (payload.kind === 'text' && typeof payload.text === 'string') {
      update({ prompt: payload.text });
    }
  };
  const { dropProps, isAccepting } = useMaterialDropTarget({
    id,
    accepts: isSeedAudio ? ['image', 'audio', 'text'] : ['audio', 'text'],
    onDrop: handleDrop,
  });

  const isBusy = status === 'submitting' || status === 'polling';
  const showRefArea = !isSeedAudio && (mode === 'cover' || mode === 'extend');
  const audioColor = PORT_COLOR.audio;

  return (
    <div
      {...dropProps}
      className={`relative rounded-xl border-2 transition-all w-[320px] ${
        selected ? 'border-violet-400 shadow-2xl shadow-violet-500/20' : isAccepting ? 'border-emerald-400' : 'border-white/15 hover:border-white/30'
      }`}
      style={{
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        boxShadow: isAccepting ? '0 0 0 2px rgba(52,211,153,.45), 0 12px 30px rgba(52,211,153,.18)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: audioColor, border: 0 }} />
      {/* 双输出口: 轨道 1 / 轨道 2 */}
      <Handle type="source" id="audio-0" position={Position.Right} style={{ background: audioColor, border: 0, top: '48%' }} />
      <Handle type="source" id="audio-1" position={Position.Right} style={{ background: audioColor, border: 0, top: '52%' }} />
      {/* 轨道标签 */}
      <div className="absolute right-[-2px] text-[8px] font-bold text-violet-300/70 pointer-events-none" style={{ top: '48%', transform: 'translateX(100%) translateY(-50%)' }}>♪1</div>
      <div className="absolute right-[-2px] text-[8px] font-bold text-violet-300/70 pointer-events-none" style={{ top: '52%', transform: 'translateX(100%) translateY(-50%)' }}>♪2</div>

      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <div
          className="w-6 h-6 rounded flex items-center justify-center"
          style={{ background: 'rgba(139,92,246,.2)', color: audioColor, boxShadow: 'inset 0 0 0 1px rgba(139,92,246,.45)' }}
        >
          <Music size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">音频 · {isSeedAudio ? 'Seed Audio' : 'Suno'}</div>
          <div className="text-[10px] text-white/40 truncate">
            {isSeedAudio ? 'doubao-seed-audio-1.0 · 国内平价工坊' : `${version} · ${MODES.find((m) => m.id === mode)?.label}`}
          </div>
        </div>
      </div>

      <div className="p-2.5 space-y-2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="grid grid-cols-2 gap-1 rounded border border-white/10 bg-black/15 p-1">
          {([
            { value: 'suno', label: 'Suno' },
            { value: 'seed-audio', label: 'Seed Audio' },
          ] as const).map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => update({ audioProviderMode: item.value, status: 'idle', error: null })}
              className={`rounded px-2 py-1 text-[11px] font-semibold transition-colors ${audioProviderMode === item.value ? 'bg-violet-400/25 text-violet-100 ring-1 ring-violet-300/50' : 'text-white/45 hover:bg-white/5 hover:text-white/75'}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {!isSeedAudio && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-white/50 block mb-1">模式</label>
            <select
              value={mode}
              onChange={(e) => update({ mode: e.target.value })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id} className="bg-zinc-900">
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-white/50 block mb-1">版本</label>
            <select
              value={version}
              onChange={(e) => update({ version: e.target.value })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {SUNO_VERSIONS.map((v) => (
                <option key={v.value} value={v.value} className="bg-zinc-900">
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        )}

        <LocalNodeAddonSlot
          nodeId={id}
          nodeType="audio"
          data={d}
          update={update}
          context={{
            providerSource: isSeedAudio ? 'seedance-nz' : 'zhenzhen',
            model: isSeedAudio ? 'doubao-seed-audio-1.0' : version,
            apiModel: isSeedAudio ? 'doubao-seed-audio-1.0' : `suno-${version}`,
            providerKind: isSeedAudio ? 'seed-audio' : 'suno',
          }}
        />

        {!isSeedAudio && (
        <>
        <div>
          <label className="text-[10px] text-white/50 block mb-1">标题</label>
          <input
            type="text"
            value={title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="My Song"
            className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30 placeholder:text-white/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/50 block mb-1">风格 Tags</label>
          <input
            type="text"
            value={tags}
            onChange={(e) => update({ tags: e.target.value })}
            placeholder="pop, electronic, female vocal"
            className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30 placeholder:text-white/30"
          />
        </div>
        </>
        )}
        <div>
          <label className="text-[10px] text-white/50 block mb-1">{isSeedAudio ? '音频提示词' : '歌词 / 提示词'}</label>
          <MentionPromptInput
            title="音频歌词 / 提示词"
            value={localPrompt}
            mentions={promptMentions}
            materials={mentionMaterials}
            onChange={(value, mentions) => update({ prompt: value, promptMentions: mentions })}
            placeholder={isSeedAudio ? '例如：雨夜城市街道，轻柔雨声与远处车流，无人声' : '[Verse]...'}
            isDark={isDark}
            isPixel={isPixel}
            promptTemplateKind="video"
            className="w-full h-16 resize-none rounded bg-white/5 border border-white/10 px-2 py-1 text-[11px] text-white outline-none focus:border-white/30 placeholder:text-white/30"
          />
        </div>

        {isSeedAudio && (
          <div className="rounded border border-cyan-300/20 bg-cyan-400/[0.05] p-2 space-y-2">
            <div>
              <label className="text-[10px] text-white/50 block mb-1">音色 ID（可选）</label>
              <input
                value={seedAudioSpeaker}
                onChange={(e) => update({ seedAudioSpeaker: e.target.value })}
                placeholder="与参考图 / 参考音频互斥"
                className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-cyan-300/40 placeholder:text-white/25"
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">格式</label>
                <select value={seedAudioFormat} onChange={(e) => update({ seedAudioFormat: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none">
                  {['wav', 'mp3', 'pcm', 'ogg_opus'].map((item) => <option key={item} value={item} className="bg-zinc-900">{item}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">采样率</label>
                <select value={seedAudioSampleRate} onChange={(e) => update({ seedAudioSampleRate: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none">
                  {['8000', '16000', '24000', '32000', '44100'].map((item) => <option key={item} value={item} className="bg-zinc-900">{item} Hz</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { label: '语速', field: 'seedAudioSpeechRate', value: seedAudioSpeechRate, min: -50, max: 100 },
                { label: '音量', field: 'seedAudioLoudnessRate', value: seedAudioLoudnessRate, min: -50, max: 100 },
                { label: '音高', field: 'seedAudioPitchRate', value: seedAudioPitchRate, min: -12, max: 12 },
              ].map((item) => (
                <div key={item.field}>
                  <label className="text-[10px] text-white/50 block mb-1">{item.label}</label>
                  <input type="number" min={item.min} max={item.max} value={item.value} onChange={(e) => update({ [item.field]: Number(e.target.value) || 0 })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none" />
                </div>
              ))}
            </div>
            <div className="text-[10px] leading-relaxed text-white/40">
              参考方式三选一：音色 ID、1 张参考图或最多 3 段参考音频；混用时会在提交前阻止。
            </div>
          </div>
        )}

        {!isSeedAudio && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-white/50 block mb-1">Seed (0=随机)</label>
            <input
              type="number"
              value={seed}
              onChange={(e) => update({ seed: parseInt(e.target.value) || 0 })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            />
          </div>
          {mode === 'extend' && (
            <div>
              <label className="text-[10px] text-white/50 block mb-1">续点 (s)</label>
              <input
                type="number"
                value={continueAt}
                onChange={(e) => update({ continueAt: parseInt(e.target.value) || 28 })}
                className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
              />
            </div>
          )}
        </div>
        )}

        {/* 上游素材聚合预览区 (generate=仅文本, cover/extend=文本+音频) */}
        <MaterialPreviewSection
          texts={orderedTexts}
          images={orderedImages}
          audios={orderedAudios}
          order={materialOrder}
          onReorder={setMaterialOrder}
          onExcludeUpstream={handleExcludeUpstreamMaterial}
          excludedCount={excludedUpstreamCount}
          onRestoreExcluded={handleRestoreExcludedMaterials}
          selected={!!selected}
          isDark={isDark}
          isPixel={isPixel}
          groups={previewGroups}
          title={isSeedAudio ? '上游素材 · Seed Audio 参考' : mode === 'generate' ? '上游素材 · 歌词提示' : '上游素材 · 参考音频'}
        />

        {isSeedAudio && (localRefImage || localRefAudio) && (
          <div className="rounded border border-cyan-300/20 bg-cyan-400/[0.05] p-2 space-y-1">
            <div className="flex items-center justify-between gap-2 text-[10px] text-cyan-100/75">
              <span>本地参考素材</span>
              <button type="button" onClick={() => update({ localRefImage: '', localRefAudio: '' })} className="text-white/40 hover:text-white" title="清除本地参考素材"><X size={11} /></button>
            </div>
            {localRefImage && <div className="truncate text-[10px] text-white/50">参考图：{localRefImage.split('/').pop()}</div>}
            {localRefAudio && <div className="truncate text-[10px] text-white/50">参考音频：{localRefAudio.split('/').pop()}</div>}
          </div>
        )}

        {isSeedAudio && (
          <div className="flex gap-1.5">
            <input ref={fileInputRef} type="file" accept="audio/*,.mp3,.wav,.flac,.ogg" className="hidden" onChange={onSelectFile} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex-1 flex items-center justify-center gap-1 rounded bg-white/5 py-1 text-[10px] text-cyan-100 hover:bg-white/10 disabled:opacity-50">
              {uploading ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />}
              {uploading ? '导入中…' : '导入参考音频'}
            </button>
          </div>
        )}

        {showRefArea && (
          <div className="rounded border border-violet-400/30 bg-violet-500/5 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-violet-200/80">
                {mode === 'cover' ? '参考音频 (Cover)' : '参考音频 (Extend)'}
              </span>
              {(uploadedClipId || localRefAudio) && (
                <button
                  onClick={() => {
                    clearUpload();
                    if (localRefAudio) update({ localRefAudio: '' });
                  }}
                  className="text-violet-300/60 hover:text-violet-100"
                  title="清除"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            {uploadedClipId ? (
              <div className="text-[10px] text-violet-100/90 truncate">
                🎵 {uploadedFilename || uploadedClipId.slice(0, 12)}
                <span className="text-white/40 ml-1">({uploadedClipId.slice(0, 8)}…)</span>
              </div>
            ) : localRefAudio ? (
              <div className="text-[10px] text-emerald-200/90 truncate">
                📥 本地拖入: {localRefAudio.split('/').pop()}
                <span className="text-white/40 ml-1">(生成时上传)</span>
              </div>
            ) : (
              <div className="text-[10px] text-white/40">未上传 · 连接上游音频节点可自动拉取</div>
            )}
            <div className="flex gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={onSelectFile}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex-1 flex items-center justify-center gap-1 py-1 rounded bg-white/5 hover:bg-white/10 text-violet-100 text-[10px] disabled:opacity-50"
              >
                {uploading ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />}
                {uploading ? '上传中…' : '上传本地音频'}
              </button>
            </div>
          </div>
        )}

        <ReuseResultToggle
          checked={d?.reuseResult === true}
          hasResult={hasReusableGenerationResult('audio', d)}
          onChange={(checked) => update({ reuseResult: checked })}
          accentColor="#a78bfa"
        />

        {!isBusy ? (
          <button
            onClick={() => requestCanvasNodeRun(id)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 text-xs font-medium transition-colors"
          >
            <Sparkles size={12} /> 生成音频
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-zinc-500/20 hover:bg-zinc-500/30 text-zinc-200 text-xs font-medium transition-colors"
          >
            <Square size={11} /> 停止
          </button>
        )}

        {isBusy && (
          <div className="flex items-center gap-1 text-[10px] text-violet-200/80">
            <Loader2 size={11} className="animate-spin" />
            {status === 'submitting' ? '提交任务...' : `轮询中 ${pollProgress}`}
            {taskId && <span className="ml-auto text-white/30">{taskId.slice(0, 10)}…</span>}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1 text-[10px] text-red-300 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
      </div>

      {tracks.length > 0 && !hasAutoOutput && (
        <div className="border-t border-white/10 p-2 space-y-2">
          {tracks.map((t, i) => (
            <div key={t.id || i} className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] text-white/60">
                <span className="text-violet-200">#{i + 1}</span>
                {t.title && <span className="truncate">🎵 {t.title}</span>}
                {t.clipId && <span className="ml-auto text-white/30">{t.clipId.slice(0, 8)}…</span>}
              </div>
              <audio
                src={t.audioUrl}
                controls
                className="w-full h-8"
                data-drag-source
                data-drag-kind="audio"
                data-drag-url={t.audioUrl}
                data-drag-preview={t.audioUrl}
                data-drag-node-id={id}
                data-resource-title={t.title || t.audioUrl.split('/').pop() || '生成音频'}
                data-prompt-template-kind="video"
                data-prompt-template-category="video-music-audio"
                data-prompt-template-prompt={d?.lastPrompt || localPrompt}
                onMouseDown={(e) => beginMaterialDrag(e, { kind: 'audio', url: t.audioUrl, sourceNodeId: id, previewUrl: t.audioUrl })}
                title="按住 Ctrl 拖拽到其他节点"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(AudioNode);
