import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type {
  FaceChannel,
  FaceExpression3DState,
  FaceExpressionOutputSettings,
} from '../../utils/faceExpression3D';
import { FACE_CHANNELS, normalizeFaceExpressionState } from '../../utils/faceExpression3D';

export interface FaceModelCompatibilityReport {
  source: 'builtin' | 'gltf';
  morphTargetCount: number;
  mappedChannels: FaceChannel[];
  missingChannels: FaceChannel[];
  hasHeadBone: boolean;
  hasNeckBone: boolean;
  eyeBoneCount: number;
  warnings: string[];
}

export interface FaceExpressionSceneOptions {
  interactive?: boolean;
  onCameraChange?: (camera: Pick<FaceExpression3DState['camera'], 'position' | 'target'>) => void;
  onCompatibility?: (report: FaceModelCompatibilityReport) => void;
  onError?: (message: string) => void;
}

interface CustomModelParts {
  kind: 'builtin' | 'custom';
  root: THREE.Object3D;
  morphMeshes: Array<THREE.Mesh & { morphTargetDictionary?: Record<string, number>; morphTargetInfluences?: number[] }>;
  mapping: Map<FaceChannel, Array<{ mesh: CustomModelParts['morphMeshes'][number]; index: number }>>;
  headBone: THREE.Object3D | null;
  neckBone: THREE.Object3D | null;
  leftEyeBone: THREE.Object3D | null;
  rightEyeBone: THREE.Object3D | null;
  baseRotations: Map<THREE.Object3D, THREE.Euler>;
  baseRootPosition: THREE.Vector3;
  baseRootRotation: THREE.Euler;
  baseRootScale: THREE.Vector3;
}

const BUILTIN_FACE_MODEL_URL = '/assets/face-expression/t8-ict-neutral-head-v1.glb';

const NORMALIZED_CHANNELS = new Map(FACE_CHANNELS.map((channel) => [normalizeName(channel), channel]));
const MORPH_ALIASES: Partial<Record<FaceChannel, string[]>> = {
  eyeBlinkLeft: ['blinkleft', 'leftblink', 'eyeclosedleft'],
  eyeBlinkRight: ['blinkright', 'rightblink', 'eyeclosedright'],
  mouthSmileLeft: ['smileleft', 'leftsmile'],
  mouthSmileRight: ['smileright', 'rightsmile'],
  mouthFrownLeft: ['frownleft', 'leftfrown'],
  mouthFrownRight: ['frownright', 'rightfrown'],
  jawOpen: ['mouthopen', 'openmouth', 'jawopen'],
  mouthPucker: ['pucker', 'kiss'],
  browInnerUp: ['browup', 'innerbrowraiser'],
};

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^blendshape/, '').replace(/^arkit/, '');
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const value = object as THREE.Mesh;
    value.geometry?.dispose?.();
    const mats = Array.isArray(value.material) ? value.material : value.material ? [value.material] : [];
    for (const mat of mats) {
      const record = mat as THREE.Material & Record<string, any>;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'envMap']) {
        record[key]?.dispose?.();
      }
      mat.dispose?.();
    }
  });
}

function lightPosition(azimuth: number, elevation: number, distance = 6): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuth);
  const el = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el) * distance,
    Math.sin(el) * distance,
    Math.cos(az) * Math.cos(el) * distance,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function findBone(root: THREE.Object3D, names: string[]): THREE.Object3D | null {
  const needles = names.map(normalizeName);
  let result: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (result) return;
    const name = normalizeName(object.name || '');
    if (needles.some((needle) => name === needle || name.endsWith(needle))) result = object;
  });
  return result;
}

function buildCustomParts(root: THREE.Object3D, kind: CustomModelParts['kind']): CustomModelParts {
  const morphMeshes: CustomModelParts['morphMeshes'] = [];
  const mapping = new Map<FaceChannel, Array<{ mesh: CustomModelParts['morphMeshes'][number]; index: number }>>();
  root.traverse((object) => {
    const value = object as CustomModelParts['morphMeshes'][number];
    if (!value.isMesh || !value.morphTargetDictionary || !value.morphTargetInfluences) return;
    morphMeshes.push(value);
    for (const [rawName, index] of Object.entries(value.morphTargetDictionary)) {
      const normalized = normalizeName(rawName);
      let channel = NORMALIZED_CHANNELS.get(normalized);
      if (!channel) {
        for (const [candidate, aliases] of Object.entries(MORPH_ALIASES) as Array<[FaceChannel, string[]]>) {
          if (aliases.some((alias) => normalized.includes(normalizeName(alias)))) {
            channel = candidate;
            break;
          }
        }
      }
      if (!channel) continue;
      const list = mapping.get(channel) || [];
      list.push({ mesh: value, index });
      mapping.set(channel, list);
    }
  });
  const headBone = findBone(root, ['head', 'headbone', 'mixamorighead']);
  const neckBone = findBone(root, ['neck', 'neckbone', 'mixamorigneck']);
  const leftEyeBone = findBone(root, ['lefteye', 'eyeleft', 'mixamoriglefteye']);
  const rightEyeBone = findBone(root, ['righteye', 'eyeright', 'mixamorigrighteye']);
  const baseRotations = new Map<THREE.Object3D, THREE.Euler>();
  for (const bone of [headBone, neckBone, leftEyeBone, rightEyeBone]) {
    if (bone) baseRotations.set(bone, bone.rotation.clone());
  }
  return {
    kind,
    root,
    morphMeshes,
    mapping,
    headBone,
    neckBone,
    leftEyeBone,
    rightEyeBone,
    baseRotations,
    baseRootPosition: root.position.clone(),
    baseRootRotation: root.rotation.clone(),
    baseRootScale: root.scale.clone(),
  };
}

function channelValue(state: FaceExpression3DState, channel: FaceChannel): number {
  return state.expression.channels[channel] * state.expression.strength;
}

function applyCustomState(parts: CustomModelParts, state: FaceExpression3DState) {
  for (const mesh of parts.morphMeshes) mesh.morphTargetInfluences?.fill(0);
  const applyMapped = (channel: FaceChannel, value: number) => {
    for (const target of parts.mapping.get(channel) || []) {
      if (!target.mesh.morphTargetInfluences) continue;
      target.mesh.morphTargetInfluences[target.index] = Math.max(target.mesh.morphTargetInfluences[target.index] || 0, clamp(value, 0, 1));
    }
  };
  for (const channel of FACE_CHANNELS) {
    applyMapped(channel, channelValue(state, channel));
  }
  parts.root.position.copy(parts.baseRootPosition);
  parts.root.rotation.copy(parts.baseRootRotation);
  parts.root.scale.copy(parts.baseRootScale);
  const reset = (object: THREE.Object3D | null) => {
    if (!object) return;
    const base = parts.baseRotations.get(object);
    if (base) object.rotation.copy(base);
  };
  for (const object of [parts.headBone, parts.neckBone, parts.leftEyeBone, parts.rightEyeBone]) reset(object);
  if (parts.headBone) {
    parts.headBone.rotation.x += THREE.MathUtils.degToRad(state.pose.head.pitch);
    parts.headBone.rotation.y += THREE.MathUtils.degToRad(state.pose.head.yaw);
    parts.headBone.rotation.z += THREE.MathUtils.degToRad(state.pose.head.roll);
  }
  if (!parts.headBone) {
    parts.root.rotation.order = 'YXZ';
    parts.root.rotation.x += THREE.MathUtils.degToRad(state.pose.head.pitch);
    parts.root.rotation.y += THREE.MathUtils.degToRad(state.pose.head.yaw);
    parts.root.rotation.z += THREE.MathUtils.degToRad(state.pose.head.roll);
  }
  if (parts.neckBone) {
    parts.neckBone.rotation.x += THREE.MathUtils.degToRad(state.pose.head.pitch * state.pose.head.neckFollow);
    parts.neckBone.rotation.y += THREE.MathUtils.degToRad(state.pose.head.yaw * state.pose.head.neckFollow);
    parts.neckBone.rotation.z += THREE.MathUtils.degToRad(state.pose.head.roll * state.pose.head.neckFollow);
  }
  const applyEye = (eye: THREE.Object3D | null, gaze: [number, number]) => {
    if (!eye) return;
    eye.rotation.y += gaze[0] * 0.36;
    eye.rotation.x -= gaze[1] * 0.3;
  };
  applyEye(parts.leftEyeBone, state.pose.eyes.left);
  applyEye(parts.rightEyeBone, state.pose.eyes.right);
  if (!parts.leftEyeBone || !parts.rightEyeBone) {
    const x = (state.pose.eyes.left[0] + state.pose.eyes.right[0]) * 0.5;
    const y = (state.pose.eyes.left[1] + state.pose.eyes.right[1]) * 0.5;
    if (x < 0) {
      applyMapped('eyeLookOutLeft', -x);
      applyMapped('eyeLookInRight', -x);
    } else {
      applyMapped('eyeLookInLeft', x);
      applyMapped('eyeLookOutRight', x);
    }
    if (y < 0) {
      applyMapped('eyeLookDownLeft', -y);
      applyMapped('eyeLookDownRight', -y);
    } else {
      applyMapped('eyeLookUpLeft', y);
      applyMapped('eyeLookUpRight', y);
    }
  }
  parts.root.traverse((object) => {
    if (/hair/i.test(object.name)) object.visible = state.model.visibleParts.hair !== false;
    if (parts.kind !== 'builtin') return;
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const candidate of materials) {
      const value = candidate as THREE.MeshStandardMaterial;
      if (!value.color) continue;
      if (/M_(Face|BackHead)/i.test(value.name)) value.color.set(state.model.skinColor);
      else if (/M_Iris/i.test(value.name)) value.color.set(state.model.irisColor);
      else if (/M_Sclera/i.test(value.name)) value.color.set('#E7E7E1');
      else if (/M_Teeth/i.test(value.name)) value.color.set('#DDDCD5');
      value.needsUpdate = true;
    }
  });
}

function compatibilityForCustom(parts: CustomModelParts): FaceModelCompatibilityReport {
  const mappedChannels = FACE_CHANNELS.filter((channel) => parts.mapping.has(channel));
  const morphTargetCount = parts.morphMeshes.reduce((sum, value) => sum + Object.keys(value.morphTargetDictionary || {}).length, 0);
  const warnings: string[] = [];
  if (!morphTargetCount) warnings.push('模型没有 morph target，只能调整头部、视线、相机和灯光');
  if (mappedChannels.length < 8 && morphTargetCount) warnings.push(`仅识别 ${mappedChannels.length} 个语义表情通道，可在后续适配器中补充映射`);
  if (parts.kind === 'custom' && !parts.headBone) warnings.push('未识别头部骨骼，将使用模型根节点控制头部姿态');
  if (parts.kind === 'custom' && (!parts.leftEyeBone || !parts.rightEyeBone)) warnings.push('未完整识别左右眼骨骼，将使用眼神 morph 控制视线');
  return {
    source: parts.kind === 'builtin' ? 'builtin' : 'gltf',
    morphTargetCount,
    mappedChannels,
    missingChannels: FACE_CHANNELS.filter((channel) => !parts.mapping.has(channel)),
    hasHeadBone: parts.kind === 'builtin' || Boolean(parts.headBone),
    hasNeckBone: parts.kind === 'builtin' || Boolean(parts.neckBone),
    eyeBoneCount: parts.kind === 'builtin' ? 2 : Number(Boolean(parts.leftEyeBone)) + Number(Boolean(parts.rightEyeBone)),
    warnings,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('背景图片加载失败，可能没有允许跨域读取'));
    image.src = url;
  });
}

async function backgroundTexture(output: FaceExpressionOutputSettings, width: number, height: number): Promise<THREE.Texture | THREE.Color | null> {
  if (output.transparent || output.background.kind === 'transparent') return null;
  if (output.background.kind !== 'image' || !output.background.value) return new THREE.Color(output.background.value || '#E7EDF2');
  const image = await loadImage(output.background.value);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Color('#E7EDF2');
  ctx.fillStyle = '#E7EDF2';
  ctx.fillRect(0, 0, width, height);
  const scale = output.background.fit === 'contain'
    ? Math.min(width / image.naturalWidth, height / image.naturalHeight)
    : Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  ctx.save();
  if (output.background.blur > 0) ctx.filter = `blur(${output.background.blur}px)`;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class FaceExpressionScene {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private perspectiveCamera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  private orthographicCamera = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, 0.01, 100);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspectiveCamera;
  private readonly controls: OrbitControls;
  private builtin: CustomModelParts | null = null;
  private custom: CustomModelParts | null = null;
  private readonly lights = new Map<string, THREE.Light>();
  private state: FaceExpression3DState;
  private width = 640;
  private height = 640;
  private disposed = false;
  private loadToken = 0;
  private previewBackground: THREE.Texture | THREE.Color | null = null;
  private readonly options: FaceExpressionSceneOptions;

  constructor(private readonly mount: HTMLDivElement, initial: FaceExpression3DState, options: FaceExpressionSceneOptions = {}) {
    this.options = options;
    this.state = normalizeFaceExpressionState(initial);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.mount.appendChild(this.renderer.domElement);
    this.createLights();
    this.perspectiveCamera.position.set(...this.state.camera.position);
    this.orthographicCamera.position.set(...this.state.camera.position);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Event-driven rendering keeps canvas nodes light and avoids a permanent animation loop.
    this.controls.enableDamping = false;
    this.controls.enablePan = true;
    this.controls.enabled = options.interactive !== false;
    this.controls.target.set(...this.state.camera.target);
    this.controls.addEventListener('change', this.handleControlsChange);
    this.controls.addEventListener('end', this.handleControlsEnd);
    this.setSize(this.mount.clientWidth || 640, this.mount.clientHeight || 640);
    void this.setState(this.state);
  }

  private handleControlsChange = () => {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  };

  private handleControlsEnd = () => {
    this.options.onCameraChange?.({
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    });
  };

  private createLights() {
    for (const id of ['ambient', 'key', 'fill', 'rim'] as const) {
      const light = id === 'ambient' ? new THREE.HemisphereLight(0xffffff, 0x334155, 1) : new THREE.DirectionalLight(0xffffff, 1);
      light.name = `FaceLight-${id}`;
      if (light instanceof THREE.DirectionalLight) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.camera.near = 0.1;
        light.shadow.camera.far = 30;
      }
      this.lights.set(id, light);
      this.scene.add(light);
    }
  }

  private configureCamera(state: FaceExpression3DState, aspect = this.width / Math.max(this.height, 1)) {
    const desired = state.camera.projection === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
    if (desired !== this.camera) {
      this.controls.object = desired;
      this.camera = desired;
    }
    this.camera.position.set(...state.camera.position);
    this.controls.target.set(...state.camera.target);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.fov = state.camera.fov;
      this.camera.aspect = aspect;
    } else {
      const span = 2.25;
      this.camera.left = -span * aspect;
      this.camera.right = span * aspect;
      this.camera.top = span;
      this.camera.bottom = -span;
      this.camera.zoom = 1;
    }
    this.camera.lookAt(...state.camera.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private updateLights(state: FaceExpression3DState) {
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = state.lighting.exposure;
    for (const config of state.lighting.lights) {
      const light = this.lights.get(config.id);
      if (!light) continue;
      light.color.set(config.color);
      light.intensity = config.intensity * state.lighting.environmentIntensity;
      if (light instanceof THREE.DirectionalLight) {
        light.position.copy(lightPosition(config.azimuth, config.elevation));
        light.castShadow = config.shadows;
        light.target.position.set(0, -0.2, 0);
        if (!light.target.parent) this.scene.add(light.target);
      }
    }
  }

  private async updatePreviewBackground(state: FaceExpression3DState) {
    const previous = this.previewBackground;
    try {
      this.previewBackground = await backgroundTexture(state.output, Math.max(512, this.width), Math.max(512, this.height));
      this.scene.background = this.previewBackground;
      if (previous instanceof THREE.Texture) previous.dispose();
    } catch (error) {
      this.scene.background = new THREE.Color(state.output.background.value || '#E7EDF2');
      this.options.onError?.(error instanceof Error ? error.message : '背景加载失败');
    }
  }

  private async loadModel(url: string, kind: CustomModelParts['kind']) {
    const token = ++this.loadToken;
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      if (this.disposed || token !== this.loadToken) {
        disposeObject(gltf.scene);
        return;
      }
      const previous = kind === 'builtin' ? this.builtin : this.custom;
      if (previous) {
        this.scene.remove(previous.root);
        disposeObject(previous.root);
      }
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 2.8 / maxDim;
      gltf.scene.scale.setScalar(scale);
      gltf.scene.position.copy(center).multiplyScalar(-scale);
      gltf.scene.updateMatrixWorld(true);
      const parts = buildCustomParts(gltf.scene, kind);
      if (kind === 'builtin') this.builtin = parts;
      else this.custom = parts;
      this.scene.add(gltf.scene);
      if (this.builtin) this.builtin.root.visible = kind === 'builtin';
      if (this.custom) this.custom.root.visible = kind === 'custom';
      this.options.onCompatibility?.(compatibilityForCustom(parts));
      applyCustomState(parts, this.state);
      this.render();
    } catch (error) {
      if (kind === 'builtin') this.builtin = null;
      else this.custom = null;
      this.options.onError?.(error instanceof Error ? error.message : `${kind === 'builtin' ? '内置白模' : 'GLB/GLTF 模型'}加载失败`);
      this.render();
    }
  }

  async setState(next: FaceExpression3DState) {
    if (this.disposed) return;
    const previousModelUrl = this.state.model.sourceUrl;
    const previousSource = this.state.model.source;
    this.state = normalizeFaceExpressionState(next);
    this.configureCamera(this.state);
    this.updateLights(this.state);
    await this.updatePreviewBackground(this.state);
    if (this.state.model.source === 'upstream' && this.state.model.sourceUrl) {
      const formatOk = /\.(glb|gltf)(?:\?|#|$)/i.test(this.state.model.sourceUrl) || /^data:model\/gltf/i.test(this.state.model.sourceUrl);
      if (!formatOk) {
        this.options.onError?.('表情编辑仅支持带 morph target 的 GLB/GLTF；其他格式可继续使用 3D模型预览节点');
        this.state.model.source = 'procedural';
      } else if (this.state.model.sourceUrl !== previousModelUrl || previousSource !== 'upstream' || !this.custom) {
        await this.loadModel(this.state.model.sourceUrl, 'custom');
      }
    }
    if (this.state.model.source !== 'upstream' || !this.state.model.sourceUrl) {
      if (!this.builtin) await this.loadModel(BUILTIN_FACE_MODEL_URL, 'builtin');
      if (this.custom) this.custom.root.visible = false;
      if (this.builtin) {
        this.builtin.root.visible = true;
        applyCustomState(this.builtin, this.state);
        this.options.onCompatibility?.(compatibilityForCustom(this.builtin));
      }
    } else if (this.custom) {
      this.custom.root.visible = true;
      if (this.builtin) this.builtin.root.visible = false;
      applyCustomState(this.custom, this.state);
    }
    this.render();
  }

  setSize(width: number, height: number) {
    this.width = Math.max(2, Math.round(width));
    this.height = Math.max(2, Math.round(height));
    this.renderer.setSize(this.width, this.height, false);
    this.configureCamera(this.state, this.width / this.height);
    this.render();
  }

  resetCamera() {
    this.configureCamera(this.state);
    this.render();
  }

  render() {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  async exportImage(output: FaceExpressionOutputSettings = this.state.output): Promise<string> {
    if (this.disposed) throw new Error('3D 表情场景已关闭');
    const settings = { ...output, background: { ...output.background } };
    const width = Math.round(clamp(settings.width, 256, 4096));
    const height = Math.round(clamp(settings.height, 256, 4096));
    const exportRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    exportRenderer.outputColorSpace = THREE.SRGBColorSpace;
    exportRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    exportRenderer.toneMappingExposure = this.state.lighting.exposure;
    exportRenderer.shadowMap.enabled = true;
    exportRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    exportRenderer.setPixelRatio(1);
    exportRenderer.setSize(width, height, false);

    const exportCamera = this.camera.clone() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (exportCamera instanceof THREE.PerspectiveCamera) exportCamera.aspect = width / height;
    else {
      const span = 2.25;
      exportCamera.left = -span * (width / height);
      exportCamera.right = span * (width / height);
      exportCamera.top = span;
      exportCamera.bottom = -span;
    }
    exportCamera.updateProjectionMatrix();
    const oldBackground = this.scene.background;
    let temporaryBackground: THREE.Texture | THREE.Color | null = null;
    try {
      temporaryBackground = await backgroundTexture(settings, width, height);
      this.scene.background = temporaryBackground;
      exportRenderer.setClearColor(0x000000, settings.transparent ? 0 : 1);
      exportRenderer.render(this.scene, exportCamera);
      const mime = settings.format === 'jpeg' ? 'image/jpeg' : settings.format === 'webp' ? 'image/webp' : 'image/png';
      return exportRenderer.domElement.toDataURL(mime, settings.format === 'jpeg' ? 0.94 : 0.96);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '3D 表情图片导出失败');
    } finally {
      this.scene.background = oldBackground;
      if (temporaryBackground instanceof THREE.Texture && temporaryBackground !== oldBackground) temporaryBackground.dispose();
      exportRenderer.dispose();
      exportRenderer.forceContextLoss();
    }
  }

  getCompatibilityReport(): FaceModelCompatibilityReport {
    if (this.state.model.source === 'upstream' && this.custom) return compatibilityForCustom(this.custom);
    if (this.builtin) return compatibilityForCustom(this.builtin);
    return {
      source: 'builtin', morphTargetCount: 0, mappedChannels: [], missingChannels: [...FACE_CHANNELS],
      hasHeadBone: false, hasNeckBone: false, eyeBoneCount: 0, warnings: ['内置中性人类白模正在加载'],
    };
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken += 1;
    this.controls.removeEventListener('change', this.handleControlsChange);
    this.controls.removeEventListener('end', this.handleControlsEnd);
    this.controls.dispose();
    if (this.previewBackground instanceof THREE.Texture) this.previewBackground.dispose();
    if (this.builtin) disposeObject(this.builtin.root);
    if (this.custom) disposeObject(this.custom.root);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentNode === this.mount) this.mount.removeChild(this.renderer.domElement);
  }
}
