import {
  runRhImageCapabilityBatch,
  type RunRhImageCapabilityBatchResult,
} from '../services/rhToolboxCapabilities';
import type { RunNodeLifecycleReporter } from '../types/project';
import { extractRunProviderTrace } from './runProviderTrace';
import type { SecondaryProviderActionEnvelope } from './secondaryProviderAction';

type RhImageEditorCutoutAction = Extract<
  SecondaryProviderActionEnvelope,
  { actionId: 'rh-image.editor-cutout' }
>;

export interface ExecuteRhImageEditorCutoutOptions {
  assertTargetCurrent: () => unknown | Promise<unknown>;
  onProgress?: (progress: {
    stage?: string;
    message?: string;
    taskId?: string;
    pollCount?: number;
  }) => void;
  onComplete: (result: RunRhImageCapabilityBatchResult) => void | Promise<void>;
}

export async function executeRhImageEditorCutoutAction(
  action: RhImageEditorCutoutAction,
  reporter: RunNodeLifecycleReporter,
  options: ExecuteRhImageEditorCutoutOptions,
) {
  if (action.actionId !== 'rh-image.editor-cutout' || action.target !== 'editor-cutout') {
    throw new Error('RH 编辑器抠图 action 不在固定白名单内');
  }
  const params = action.params;
  let providerRequested = false;
  let providerResponded = false;

  await options.assertTargetCurrent();
  try {
    await reporter.providerRequest({
      provider: 'runninghub',
      model: params.preferredToolId,
      actionId: action.actionId,
      actionTarget: action.target,
      surface: params.surface,
      editorSessionId: params.editorSessionId,
      targetId: params.targetId,
      itemCount: 1,
    });
    providerRequested = true;
    const result = await runRhImageCapabilityBatch({
      capability: params.capability,
      preferredToolId: params.preferredToolId,
      imageUrls: [params.imageUrl],
      retryCount: params.retryCount,
      retryDelayMs: params.retryDelayMs,
      continueOnError: false,
      onProgress: (progress) => {
        options.onProgress?.(progress);
        if (progress.taskId) {
          void reporter.providerPolling({
            provider: 'runninghub',
            model: params.preferredToolId,
            upstreamTaskId: progress.taskId,
            pollCount: progress.pollCount,
          });
        }
      },
    });
    const trace = extractRunProviderTrace(result.results[0]?.result || result.results[0] || result);
    await reporter.providerResponse({
      provider: 'runninghub',
      model: params.preferredToolId,
      upstreamTaskId: result.taskIds[0],
      ...trace,
      status: result.cancelled ? 'stopped' : 'succeeded',
    });
    providerResponded = true;
    if (result.cancelled) throw new Error('RH 编辑器抠图已取消');

    // Provider 可能运行较久；回写前再次确认绑定的编辑会话、目标和源图没有变化。
    await options.assertTargetCurrent();
    await options.onComplete(result);
    await reporter.output({
      status: 'succeeded',
      assets: result.imageUrls.map((url) => ({ kind: 'image', sourceUrl: url })),
    });
    return result;
  } catch (error) {
    if (providerRequested && !providerResponded) {
      await reporter.providerResponse({
        provider: 'runninghub',
        model: params.preferredToolId,
        status: 'failed',
      });
    }
    throw error;
  }
}
