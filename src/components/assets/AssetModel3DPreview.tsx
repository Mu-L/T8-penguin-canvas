import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  MAX_INTERACTIVE_MODEL_BYTES,
  type InteractiveAssetModelFormat,
} from '../../utils/assetModelPreviewSecurity';

const MAX_INTERACTIVE_GLB_JSON_BYTES = 4 * 1024 * 1024;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : '3D 模型加载失败';
}

function fallbackMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.58, metalness: 0.04, side: THREE.DoubleSide });
}

function ensureMaterials(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    // OBJ is intentionally parsed without MTL loading, so it cannot request a
    // material library or texture after the primary same-origin response.
    if (!mesh.material || (Array.isArray(mesh.material) && !mesh.material.length)) mesh.material = fallbackMaterial();
  });
}

function createEmbeddedOnlyLoadingManager(): THREE.LoadingManager {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((resourceUrl) => {
    if (/^(?:blob:|data:)/i.test(resourceUrl)) return resourceUrl;
    throw new Error('3D 模型包含被禁止的外部资源请求');
  });
  return manager;
}

async function fetchSameOriginModel(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const page = new URL(window.location.href);
  const resolved = new URL(url, page);
  if (!/^https?:$/.test(resolved.protocol) || resolved.origin !== page.origin || resolved.username || resolved.password) {
    throw new Error('3D 交互预览只允许当前应用同源地址');
  }
  const response = await fetch(resolved.href, {
    credentials: 'same-origin',
    redirect: 'error',
    signal,
    headers: { Accept: 'model/gltf-binary, model/obj, model/stl, application/octet-stream' },
  });
  if (!response.ok) throw new Error(`3D 模型读取失败（HTTP ${response.status}）`);
  const declaredBytes = Number(response.headers.get('content-length') || 0);
  if (declaredBytes > MAX_INTERACTIVE_MODEL_BYTES) throw new Error('3D 模型超过交互预览大小上限');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('当前环境不支持有界读取 3D 模型');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_INTERACTIVE_MODEL_BYTES) {
      try { await reader.cancel('3D 模型超过交互预览大小上限'); } catch { /* the explicit size error remains authoritative */ }
      throw new Error('3D 模型超过交互预览大小上限');
    }
    chunks.push(value);
  }
  if (totalBytes < 1) throw new Error('3D 模型为空');
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes.buffer;
}

async function verifyContentHash(bytes: ArrayBuffer, expectedContentHash: string): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境无法验证模型内容哈希');
  const digest = await subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expectedContentHash.toLowerCase()) throw new Error('模型内容已变化，请重新索引后再交互预览');
  return bytes;
}

function assertTexturelessSelfContainedGlb(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 20) throw new Error('GLB 文件头无效');
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error('GLB 文件头或长度无效');
  }
  let document: Record<string, unknown> | null = null;
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('GLB chunk header 被截断');
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) throw new Error('GLB chunk 数据越界');
    if (chunkType === 0x4e4f534a && !document) {
      if (chunkLength > MAX_INTERACTIVE_GLB_JSON_BYTES) throw new Error('GLB JSON 超过交互预览上限');
      const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start, end)).replace(/[\0\s]+$/g, '');
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('GLB JSON 无效');
      document = parsed as Record<string, unknown>;
    }
    offset = end;
  }
  if (!document) throw new Error('GLB 缺少 JSON chunk');
  const images = document.images;
  const textures = document.textures;
  if (images != null && !Array.isArray(images) || textures != null && !Array.isArray(textures)) throw new Error('GLB 图片或纹理清单无效');
  if ((Array.isArray(images) && images.length) || (Array.isArray(textures) && textures.length)) {
    throw new Error('交互 GLB 禁止图片或纹理资源');
  }
  const buffers = document.buffers;
  if (!Array.isArray(buffers) || buffers.length !== 1 || buffers.some((entry) => entry && typeof entry === 'object' && 'uri' in entry)) {
    throw new Error('交互 GLB 的几何缓冲区必须内嵌且不能声明 URI');
  }
}

async function parseSelfContainedModel(bytes: ArrayBuffer, format: InteractiveAssetModelFormat): Promise<THREE.Object3D> {
  if (format === 'glb') {
    assertTexturelessSelfContainedGlb(bytes);
    const result = await new GLTFLoader(createEmbeddedOnlyLoadingManager()).parseAsync(bytes, '');
    return result.scene;
  }
  if (format === 'obj') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const root = new OBJLoader(createEmbeddedOnlyLoadingManager()).parse(text);
    ensureMaterials(root);
    return root;
  }
  const geometry = new STLLoader(createEmbeddedOnlyLoadingManager()).parse(bytes);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, fallbackMaterial());
}

function disposeMaterial(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value && typeof value === 'object' && 'isTexture' in value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
  });
  material.dispose();
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMaterial);
    else if (mesh.material) disposeMaterial(mesh.material);
  });
}

export default function AssetModel3DPreview({
  url,
  format,
  expectedContentHash,
  fallbackImageUrl,
}: {
  url: string;
  format: InteractiveAssetModelFormat;
  expectedContentHash: string;
  fallbackImageUrl?: string;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('安全读取 3D 模型中…');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const controller = new AbortController();
    let disposed = false;
    let released = false;
    let modelRoot: THREE.Object3D | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let scene: THREE.Scene | null = null;
    let grid: THREE.GridHelper | null = null;

    const render = () => {
      if (!disposed && !released && renderer && scene) renderer.render(scene, scene.userData.camera as THREE.Camera);
    };
    const releaseRuntime = () => {
      if (released) return;
      released = true;
      resizeObserver?.disconnect();
      controls?.removeEventListener('change', render);
      controls?.dispose();
      if (modelRoot) disposeObject(modelRoot);
      modelRoot = null;
      if (grid) disposeObject(grid);
      grid = null;
      renderer?.dispose();
      try { renderer?.forceContextLoss(); } catch { /* explicit context loss is optional */ }
      renderer = null;
      mount.replaceChildren();
    };

    setState('loading');
    setMessage('安全读取 3D 模型中…');
    void fetchSameOriginModel(url, controller.signal)
      .then((bytes) => verifyContentHash(bytes, expectedContentHash))
      .then((bytes) => parseSelfContainedModel(bytes, format))
      .then((root) => {
        if (disposed) {
          disposeObject(root);
          return;
        }
        modelRoot = root;
        try {
          scene = new THREE.Scene();
          const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
          scene.userData.camera = camera;
          scene.add(new THREE.AmbientLight(0xffffff, 1.25));
          const key = new THREE.DirectionalLight(0xffffff, 2.1);
          key.position.set(3, 4, 5);
          const fill = new THREE.DirectionalLight(0x7dd3fc, 0.75);
          fill.position.set(-4, 1, -3);
          scene.add(key, fill, root);
          grid = new THREE.GridHelper(4, 16, 0x94a3b8, 0x334155);
          (grid.material as THREE.Material).transparent = true;
          (grid.material as THREE.Material).opacity = 0.18;
          scene.add(grid);

          renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.setClearColor(0x000000, 0);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          renderer.domElement.tabIndex = 0;
          renderer.domElement.setAttribute('aria-label', '可旋转、缩放和平移的 3D 素材预览');
          mount.replaceChildren(renderer.domElement);
          controls = new OrbitControls(camera, renderer.domElement);
          controls.enableDamping = false;
          controls.addEventListener('change', render);

          const box = new THREE.Box3().setFromObject(root);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          if ([center.x, center.y, center.z].every(Number.isFinite)) root.position.sub(center);
          const rawMax = Math.max(size.x, size.y, size.z);
          const maxDimension = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 1;
          camera.near = Math.max(0.001, maxDimension / 200);
          camera.far = maxDimension * 200;
          camera.position.set(maxDimension * 1.35, maxDimension * 0.9, maxDimension * 1.65);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0);
          controls.update();
          grid.scale.setScalar(Math.max(maxDimension / 2, 1));

          const resize = () => {
            if (!renderer) return;
            const width = Math.max(1, mount.clientWidth);
            const height = Math.max(1, mount.clientHeight);
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            render();
          };
          resize();
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(resize);
            resizeObserver.observe(mount);
          }
          setState('ready');
          setMessage('拖动旋转，滚轮缩放，右键拖动平移');
          render();
        } catch (error) {
          releaseRuntime();
          setState('error');
          setMessage(`交互预览不可用：${errorMessage(error)}`);
        }
      })
      .catch((error) => {
        if (disposed || error instanceof DOMException && error.name === 'AbortError') return;
        releaseRuntime();
        setState('error');
        setMessage(`安全限制：${errorMessage(error)}；仅显示静态预览`);
      });

    return () => {
      disposed = true;
      controller.abort();
      releaseRuntime();
    };
  }, [expectedContentHash, format, url]);

  return <div className="relative h-full w-full overflow-hidden" data-asset-model-interactive-preview>
    <div ref={mountRef} className="h-full w-full" />
    {state !== 'ready' && fallbackImageUrl && <img src={fallbackImageUrl} alt="3D 素材渲染预览" className="absolute inset-0 h-full w-full object-contain" />}
    <div className={`pointer-events-none absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1 text-center text-[9px] text-white ${state === 'error' ? 'text-red-200' : ''}`}>{message}</div>
  </div>;
}
