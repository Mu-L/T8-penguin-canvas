import type { AdvancedProviderConfig } from '../types/canvas';
import { generateExternalImage, type GenerateExternalImageRequest } from './generation';
import {
  getComfyProviderBaseUrl,
  negativeFromComfyParams,
  paramsToProviderParams,
  promptFromComfyParams,
  sizeFromComfyParams,
  type ComfyAppDefinition,
} from '../utils/comfyuiApps';

export interface RunComfyuiAppOptions {
  provider: AdvancedProviderConfig;
  app: ComfyAppDefinition;
  inputs?: {
    texts?: string[];
    images?: string[];
    videos?: string[];
    audios?: string[];
  };
  userParams?: Record<string, any>;
}

export interface RunComfyuiAppResult {
  imageUrls: string[];
  remoteImageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  outputKinds: Array<'image' | 'video' | 'audio' | 'text'>;
  primaryKind: 'image' | 'video' | 'audio' | 'text';
  outputSaveErrors?: Array<{ kind: string; url: string; error: string }>;
  text?: string;
  taskId?: string;
  raw?: any;
}

export async function runComfyuiApp(options: RunComfyuiAppOptions): Promise<RunComfyuiAppResult> {
  const { provider, app } = options;
  const inputs = options.inputs || {};
  const userParams = options.userParams || {};
  const providerParams = paramsToProviderParams(app, userParams);
  const prompt = promptFromComfyParams(app, userParams, inputs.texts || []);
  const negativePrompt = negativeFromComfyParams(app, userParams);
  const size = sizeFromComfyParams(app, userParams);

  const runnableProvider: AdvancedProviderConfig = {
    ...provider,
    id: provider.id || 'comfyui',
    protocol: 'comfyui',
    enabled: true,
    baseUrl: getComfyProviderBaseUrl(provider),
    comfyuiConfig: {
      ...(provider.comfyuiConfig || {}),
      instances: provider.comfyuiConfig?.instances?.length
        ? provider.comfyuiConfig.instances
        : [getComfyProviderBaseUrl(provider)],
      workflows: [
        {
          id: app.id,
          name: app.title,
          workflowJson: app.workflowJson,
          fields: app.fields,
        },
      ],
    },
  };

  const request: GenerateExternalImageRequest = {
    providerId: runnableProvider.id,
    provider: runnableProvider,
    providerModel: app.id,
    model: app.id,
    size,
    images: inputs.images || [],
    videos: inputs.videos || [],
    audios: inputs.audios || [],
    seed: Number(providerParams.seed) || undefined,
    providerParams,
  };
  if (prompt) request.prompt = prompt;
  if (negativePrompt) {
    request.negativePrompt = negativePrompt;
    request.negative = negativePrompt;
  }

  const result = await generateExternalImage(request);

  const imageUrls = result.imageUrls || [];
  const videoUrls = result.videoUrls || [];
  const audioUrls = result.audioUrls || [];
  const text = result.text || '';
  const outputKinds = result.outputKinds?.length
    ? result.outputKinds
    : [
      ...(imageUrls.length ? ['image' as const] : []),
      ...(videoUrls.length ? ['video' as const] : []),
      ...(audioUrls.length ? ['audio' as const] : []),
      ...(text.trim() ? ['text' as const] : []),
    ];
  const primaryKind = result.primaryKind || outputKinds[0] || 'image';

  return {
    imageUrls,
    remoteImageUrls: result.remoteImageUrls,
    taskId: result.taskId,
    raw: result.raw,
    videoUrls,
    audioUrls,
    text,
    outputKinds,
    primaryKind,
    outputSaveErrors: result.outputSaveErrors,
  };
}
