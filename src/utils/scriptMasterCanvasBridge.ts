import type { CanvasPatchDraft } from './workflowDoctor';
import type { CanvasPatch, CanvasPatchApplyResult, CanvasPatchPreview } from '../types/project';

export const SCRIPT_MASTER_CANVAS_PATCH_REQUEST_EVENT = 't8:script-master-canvas-patch-request';

export type ScriptMasterCanvasPatchPreviewResult = {
  patch: CanvasPatch;
  preview: CanvasPatchPreview;
};

export type ScriptMasterCanvasPatchRequestDetail =
  | {
    action: 'preview';
    draft: CanvasPatchDraft;
    resolve: (result: ScriptMasterCanvasPatchPreviewResult) => void;
    reject: (error: Error) => void;
  }
  | {
    action: 'apply';
    patch: CanvasPatch;
    preview: CanvasPatchPreview;
    resolve: (result: CanvasPatchApplyResult) => void;
    reject: (error: Error) => void;
  };

function dispatchScriptMasterCanvasPatchRequest<T>(
  detail: Omit<Extract<ScriptMasterCanvasPatchRequestDetail, { action: 'preview' }>, 'resolve' | 'reject'>
    | Omit<Extract<ScriptMasterCanvasPatchRequestDetail, { action: 'apply' }>, 'resolve' | 'reject'>,
): Promise<T> {
  if (typeof window === 'undefined') return Promise.reject(new Error('当前环境无法访问画布补丁服务'));
  return new Promise<T>((resolve, reject) => {
    window.dispatchEvent(new CustomEvent<ScriptMasterCanvasPatchRequestDetail>(
      SCRIPT_MASTER_CANVAS_PATCH_REQUEST_EVENT,
      {
        detail: {
          ...detail,
          resolve: resolve as (value: never) => void,
          reject: (error: Error) => reject(error instanceof Error ? error : new Error(String(error))),
        } as ScriptMasterCanvasPatchRequestDetail,
      },
    ));
  });
}

export function previewScriptMasterCanvasPatch(draft: CanvasPatchDraft) {
  return dispatchScriptMasterCanvasPatchRequest<ScriptMasterCanvasPatchPreviewResult>({ action: 'preview', draft });
}

export function applyScriptMasterCanvasPatch(patch: CanvasPatch, preview: CanvasPatchPreview) {
  return dispatchScriptMasterCanvasPatchRequest<CanvasPatchApplyResult>({ action: 'apply', patch, preview });
}
