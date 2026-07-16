import type { AssetMetadata, AssetRef } from '../types/project';

export type InteractiveAssetModelFormat = 'glb' | 'obj' | 'stl';
export const MAX_INTERACTIVE_MODEL_BYTES = 64 * 1024 * 1024;
export const MAX_INTERACTIVE_MODEL_VERTICES = 300_000;
export const MAX_INTERACTIVE_MODEL_TRIANGLES = 600_000;

export type InteractiveModelDecision =
  | { allowed: true; format: InteractiveAssetModelFormat; url: string }
  | { allowed: false; reason: string };

function normalizeFormat(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/^\./, '');
}

function hasExternalReferences(metadata: AssetMetadata, format: InteractiveAssetModelFormat): boolean {
  const references = Array.isArray(metadata.references) ? metadata.references : [];
  if (format === 'stl') return references.length > 0;
  if (format === 'obj') return references.length > 0;
  return references.some((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    const reference = String((entry as { reference?: unknown }).reference || '');
    const embedded = (entry as { embedded?: unknown }).embedded === true;
    return !embedded && !/^data:(?:embedded|[^,]*,)/i.test(reference);
  });
}

export function resolveSameOriginAssetUrl(url: string | undefined, pageUrl: string): string | null {
  if (!url) return null;
  try {
    const page = new URL(pageUrl);
    const resolved = new URL(url, page);
    if (!/^https?:$/.test(page.protocol) || !/^https?:$/.test(resolved.protocol)
      || resolved.origin !== page.origin || resolved.username || resolved.password) return null;
    return resolved.href;
  } catch {
    return null;
  }
}

export function decideInteractiveAssetModel(
  url: string | undefined,
  metadata: AssetMetadata,
  pageUrl: string,
  availability: AssetRef['availability'],
  contentHash: string | undefined,
): InteractiveModelDecision {
  const format = normalizeFormat(metadata.format);
  if (format === 'gltf' || format === 'fbx' || format === 'usd' || format === 'usda' || format === 'usdc' || format === 'usdz') {
    return { allowed: false, reason: '该格式可能引用外部资源，仅显示后端生成的静态预览。' };
  }
  if (format !== 'glb' && format !== 'obj' && format !== 'stl') {
    return { allowed: false, reason: '仅经后端验证的自包含 GLB、OBJ、STL 支持交互预览。' };
  }
  if (availability !== 'available') {
    return { allowed: false, reason: '模型源文件状态不安全，仅显示静态预览。' };
  }
  if (!/^[a-f0-9]{64}$/i.test(String(contentHash || ''))) {
    return { allowed: false, reason: '模型缺少可验证的内容哈希，仅显示静态预览。' };
  }
  if (metadata.previewStatus !== 'ready' || !resolveSameOriginAssetUrl(String(metadata.modelPreviewUrl || ''), pageUrl)) {
    return { allowed: false, reason: '模型尚未通过后端安全解析，仅显示静态预览。' };
  }
  const health = normalizeFormat(metadata.health);
  // STL metadata has no dependency graph; a ready static preview means the
  // bounded backend geometry parser has validated it. Other formats must carry
  // the explicit healthy metadata state from the indexer.
  if (health !== 'ok' && !(format === 'stl' && health === 'unverified')) {
    return { allowed: false, reason: '模型健康检查未通过，仅显示静态预览。' };
  }
  const size = Number(metadata.size);
  if (!Number.isFinite(size) || size < 1 || size > MAX_INTERACTIVE_MODEL_BYTES) {
    return { allowed: false, reason: '模型缺少可信大小或超过交互预览规模上限，仅显示静态预览。' };
  }
  if (format !== 'stl') {
    const vertices = Number(metadata.vertices);
    const triangles = Number(metadata.triangles);
    if (!Number.isFinite(vertices) || vertices < 1 || vertices > MAX_INTERACTIVE_MODEL_VERTICES
      || !Number.isFinite(triangles) || triangles < 1 || triangles > MAX_INTERACTIVE_MODEL_TRIANGLES) {
      return { allowed: false, reason: '模型几何规模缺失或超过交互预览上限，仅显示静态预览。' };
    }
  }
  if (hasExternalReferences(metadata, format)) {
    return { allowed: false, reason: '模型包含外部材质、贴图或缓冲区引用，仅显示静态预览。' };
  }
  if (format === 'glb') {
    const textureCount = Number(metadata.textures);
    const references = Array.isArray(metadata.references) ? metadata.references : [];
    if (!Number.isSafeInteger(textureCount) || textureCount !== 0 || references.length !== 0) {
      return { allowed: false, reason: '交互 GLB 必须无图片、纹理和资源 URI，以避免解码或 GPU 资源风险。' };
    }
  }
  if (!url) return { allowed: false, reason: '没有同源模型地址，仅显示静态预览。' };

  const safeUrl = resolveSameOriginAssetUrl(url, pageUrl);
  if (!safeUrl) return { allowed: false, reason: '远程、跨端口或无效模型地址禁止交互加载，仅显示静态预览。' };
  return { allowed: true, format, url: safeUrl };
}
