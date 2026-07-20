import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Music2,
  Palette,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  BUILT_IN_THEME_TEMPLATES,
  dragonBallShenronHiddenMusicUrl,
  dragonBallThemeMusicUrl,
  evaThemeMusicUrl,
  gardenDefenseThemeMusicUrl,
  getTemplateMode,
  resolveThemeTemplate,
  narutoThemeMusicUrl,
  rhHiddenThemeMusicUrl,
  rhThemeMusicUrl,
  saintSeiyaHadesThemeMusicUrl,
  saintSeiyaThemeMusicUrl,
  slamdunkThemeMusicUrl,
  soccerThemeMusicUrl,
} from '../theme/defaultTemplates';
import { getThemeContrastWarnings } from '../theme/validateTheme';
import type {
  LegacyThemeStyle,
  ThemeMode,
  ThemeMusic,
  ThemeMusicPreset,
  ThemeTemplate,
  ThemeTokens,
  ThemeVisuals,
} from '../theme/types';
import { useThemeStore } from '../stores/theme';
import { requestGardenThemeMusicAutoplay } from '../theme/musicAutoplay';

interface ThemeTemplateManagerProps {
  open: boolean;
  onClose: () => void;
}

const COLOR_FIELDS: Array<[keyof ThemeTokens, string]> = [
  ['appBg', '应用背景'],
  ['canvasBg', '画布背景'],
  ['panelBg', '面板'],
  ['panelBgElevated', '浮层'],
  ['panelBgMuted', '弱背景'],
  ['nodeBg', '节点'],
  ['nodeHeaderBg', '节点标题'],
  ['textMain', '主文字'],
  ['textMuted', '次文字'],
  ['textDim', '弱文字'],
  ['border', '边框'],
  ['borderStrong', '强边框'],
  ['accent', '主色'],
  ['accentHover', '主色悬停'],
  ['accentText', '主按钮文字'],
  ['secondary', '副色'],
  ['warning', '警告'],
  ['danger', '危险'],
  ['success', '成功'],
  ['gridDot', '网格点'],
  ['edge', '连线'],
  ['edgeSelected', '选中连线'],
  ['portText', '文本端口'],
  ['portImage', '图片端口'],
  ['portVideo', '视频端口'],
  ['portAudio', '音频端口'],
];

const TEXT_FIELDS: Array<[keyof ThemeTokens, string]> = [
  ['shadowPanel', '面板阴影'],
  ['shadowButton', '按钮阴影'],
  ['shadowStrong', '强阴影'],
  ['radiusPanel', '面板圆角'],
  ['radiusButton', '按钮圆角'],
  ['radiusNode', '节点圆角'],
  ['fontFamily', '正文字体'],
  ['displayFont', '标题字体'],
];

const VISUAL_STYLE_OPTIONS = [
  { value: 'plain', label: '基础语义' },
  { value: 'tech', label: '科技视觉' },
  { value: 'pixel', label: '像素糖果' },
  { value: 'op', label: 'OP 航海' },
  { value: 'rh', label: 'RH 工作台' },
  { value: 'naruto', label: '火影忍者' },
  { value: 'eva', label: 'EVA 指挥' },
  { value: 'yyh', label: '幽游白书' },
  { value: 'slamdunk', label: '灌篮高手' },
  { value: 'soccer-hero', label: '足球小将' },
  { value: 'dragon-ball', label: '七龙珠' },
  { value: 'saint-seiya', label: '圣斗士' },
  { value: 'tetris', label: '俄罗斯方块' },
  { value: 'farm-story', label: '牧场物语' },
  { value: 'garden-defense', label: '庭院守卫' },
] as const;

const VISUAL_INTENSITY_OPTIONS = [
  { value: 'subtle', label: '轻量' },
  { value: 'medium', label: '标准' },
  { value: 'strong', label: '强识别' },
] as const;

const MUSIC_PRESET_OPTIONS: Array<{ value: ThemeMusicPreset; label: string }> = [
  { value: 'tech-pulse', label: '科技脉冲' },
  { value: 'pixel-pop', label: '像素弹跳' },
  { value: 'grand-line-adventure', label: '航海冒险' },
  { value: 'rh-pulse', label: 'RH 脉冲' },
  { value: 'shinobi-flame', label: '忍者火焰' },
  { value: 'eva-sync', label: 'EVA 同步' },
  { value: 'spirit-gun', label: '灵丸脉冲' },
  { value: 'buzzer-beater', label: '压哨热血' },
  { value: 'golden-goal', label: '黄金进球' },
  { value: 'ki-burst', label: '气功波雷达' },
  { value: 'shenron-aura', label: '神龙青焰' },
  { value: 'pegasus-cosmos', label: '天马小宇宙' },
  { value: 'hades-eclipse', label: '冥界日蚀' },
  { value: 'block-drop', label: '落块冲刺' },
  { value: 'farm-breeze', label: '牧场微风' },
  { value: 'garden-march', label: '庭院守卫进行曲' },
];

const MAX_THEME_AUDIO_SIZE = 20 * 1024 * 1024;

function fallbackVisuals(legacyStyle: LegacyThemeStyle): ThemeVisuals {
  return {
    style: legacyStyle === 'tech' ? 'tech' : 'pixel',
    intensity: 'medium',
    iconPack: 'default',
    canvasPattern: legacyStyle === 'tech' ? 'circuit' : 'dots',
    nodeFrame: legacyStyle === 'tech' ? 'glass' : 'sticker',
    headerMark: '',
  };
}

function visualDefaultsFor(style: ThemeVisuals['style'], legacyStyle: LegacyThemeStyle, prev?: ThemeVisuals): ThemeVisuals {
  if (style === 'op') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'op',
      canvasPattern: 'map',
      nodeFrame: 'wanted',
      headerMark: prev?.headerMark || 'ONE PIECE',
    };
  }
  if (style === 'rh') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'default',
      canvasPattern: 'hub',
      nodeFrame: 'hub-card',
      headerMark: prev?.headerMark || 'RH',
    };
  }
  if (style === 'naruto') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'naruto',
      canvasPattern: 'chakra',
      nodeFrame: 'shinobi-scroll',
      headerMark: prev?.headerMark || 'KONOHA',
    };
  }
  if (style === 'eva') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'eva',
      canvasPattern: 'eva-grid',
      nodeFrame: 'eva-panel',
      headerMark: prev?.headerMark || 'EVA',
    };
  }
  if (style === 'yyh') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'yyh',
      canvasPattern: 'spirit-map',
      nodeFrame: 'spirit-case',
      headerMark: prev?.headerMark || 'REI GUN',
    };
  }
  if (style === 'slamdunk') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'slamdunk',
      canvasPattern: 'court',
      nodeFrame: 'scoreboard-card',
      headerMark: prev?.headerMark || 'BUZZER BEATER',
    };
  }
  if (style === 'soccer-hero') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'soccer',
      canvasPattern: 'pitch',
      nodeFrame: 'match-card',
      headerMark: prev?.headerMark || 'GOLDEN GOAL',
    };
  }
  if (style === 'dragon-ball') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'dragon-ball',
      canvasPattern: 'dragon-radar',
      nodeFrame: 'capsule-card',
      headerMark: prev?.headerMark || 'DRAGON RADAR',
    };
  }
  if (style === 'saint-seiya') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'saint-seiya',
      canvasPattern: 'sanctuary-zodiac',
      nodeFrame: 'cloth-box-card',
      headerMark: prev?.headerMark || 'SANCTUARY',
    };
  }
  if (style === 'tetris') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'tetromino-well',
      canvasPattern: 'tetris-stack',
      nodeFrame: 'arcade-cabinet-card',
      headerMark: prev?.headerMark || 'TETRIS STACK',
    };
  }
  if (style === 'farm-story') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'farm-tools',
      canvasPattern: 'pasture-map',
      nodeFrame: 'farm-sign-card',
      headerMark: prev?.headerMark || 'FARM STORY',
    };
  }
  if (style === 'garden-defense') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'garden-guard',
      canvasPattern: 'defense-lawn',
      nodeFrame: 'garden-card',
      headerMark: prev?.headerMark || 'GARDEN GUARD',
    };
  }
  if (style === 'tech') {
    return {
      ...fallbackVisuals(legacyStyle),
      ...(prev || {}),
      style,
      iconPack: 'default',
      canvasPattern: 'circuit',
      nodeFrame: 'glass',
    };
  }
  return {
    ...fallbackVisuals(legacyStyle),
    ...(prev || {}),
    style,
    iconPack: 'default',
    canvasPattern: style === 'plain' ? 'none' : 'dots',
    nodeFrame: style === 'plain' ? 'plain' : 'sticker',
  };
}

function fallbackMusic(legacyStyle: LegacyThemeStyle, visuals?: ThemeVisuals): ThemeMusic {
  const visualStyle = visuals?.style;
  if (visualStyle === 'op') {
    return {
      title: 'Grand Line Adventure Loop',
      preset: 'grand-line-adventure',
      source: 'synth',
      volume: 0.16,
      bpm: 96,
      copyrightNote: '原创航海冒险风循环；可替换为已授权音频 URL。',
    };
  }
  if (visualStyle === 'rh') {
    return {
      title: '潮鸣',
      preset: 'rh-pulse',
      source: 'url',
      url: rhThemeMusicUrl,
      hiddenTitle: '沙耶之歌',
      hiddenUrl: rhHiddenThemeMusicUrl,
      hiddenVolume: 0.2,
      volume: 0.16,
      bpm: 104,
      copyrightNote: 'RH 风格默认音乐；隐藏模式会自动切换隐藏主题音乐。',
    };
  }
  if (visualStyle === 'naruto') {
    return {
      title: '形势逆转',
      preset: 'shinobi-flame',
      source: 'url',
      url: narutoThemeMusicUrl,
      volume: 0.16,
      bpm: 146,
      copyrightNote: '火影忍者风格默认音乐文件，可在主题模板中上传替换。',
    };
  }
  if (visualStyle === 'eva') {
    return {
      title: 'Decisive Battle',
      preset: 'eva-sync',
      source: 'url',
      url: evaThemeMusicUrl,
      volume: 0.16,
      bpm: 152,
      copyrightNote: 'EVA 风格默认音乐文件，可在主题模板中上传替换。',
    };
  }
  if (visualStyle === 'yyh') {
    return {
      title: 'Spirit Gun Pulse',
      preset: 'spirit-gun',
      source: 'synth',
      volume: 0.16,
      bpm: 138,
      copyrightNote: '原创灵界侦探氛围合成循环；可替换为已授权音频 URL。',
    };
  }
  if (visualStyle === 'slamdunk') {
    return {
      title: '想大声说喜欢你',
      preset: 'buzzer-beater',
      source: 'url',
      url: slamdunkThemeMusicUrl,
      volume: 0.18,
      bpm: 142,
      copyrightNote: '灌篮高手风格默认音乐文件，可在主题模板中上传替换。公开分发前请确认音乐授权边界。',
    };
  }
  if (visualStyle === 'soccer-hero') {
    return {
      title: '足球小将主题歌（燃烧英雄）',
      preset: 'golden-goal',
      source: 'url',
      url: soccerThemeMusicUrl,
      volume: 0.18,
      bpm: 150,
      copyrightNote: '足球小将风格默认 MIDI 音乐文件；若公开分发请确认音乐授权边界，golden-goal 仅作为兜底 preset。',
    };
  }
  if (visualStyle === 'dragon-ball') {
    return {
      title: '摩诃不思议 Adventure',
      preset: 'ki-burst',
      source: 'url',
      url: dragonBallThemeMusicUrl,
      hiddenTitle: 'CHA-LA HEAD-CHA-LA',
      hiddenUrl: dragonBallShenronHiddenMusicUrl,
      hiddenVolume: 0.2,
      volume: 0.18,
      bpm: 156,
      copyrightNote: '七龙珠第一部开场曲默认音乐文件；神龙隐藏模式会切换到 CHA-LA HEAD-CHA-LA，可在主题模板中上传替换。公开分发前请确认音乐授权边界。',
    };
  }
  if (visualStyle === 'saint-seiya') {
    return {
      title: '天马幻想',
      preset: 'pegasus-cosmos',
      source: 'url',
      url: saintSeiyaThemeMusicUrl,
      hiddenTitle: '冥界篇 · 最后的圣战',
      hiddenUrl: saintSeiyaHadesThemeMusicUrl,
      hiddenVolume: 0.2,
      volume: 0.18,
      bpm: 148,
      copyrightNote: '圣域篇默认使用天马幻想；冥界篇开启后切换最后的圣战，可替换为已授权音频 URL。',
    };
  }
  if (visualStyle === 'tetris') {
    return {
      title: 'Block Drop Sprint',
      preset: 'block-drop',
      source: 'synth',
      volume: 0.15,
      bpm: 148,
      copyrightNote: '原创 falling-block 合成循环；可替换为已授权音频 URL。',
    };
  }
  if (visualStyle === 'farm-story') {
    return {
      title: 'Farm Breeze',
      preset: 'farm-breeze',
      source: 'synth',
      volume: 0.14,
      bpm: 96,
      copyrightNote: '原创轻量牧场合成循环；后续可替换为已授权季节音乐。',
    };
  }
  if (visualStyle === 'garden-defense') {
    return {
      title: '植物大战僵尸白天（Grasswalk）',
      preset: 'garden-march',
      source: 'url',
      url: gardenDefenseThemeMusicUrl,
      volume: 0.16,
      bpm: 112,
      copyrightNote: '庭院守卫主题默认音乐文件；garden-march 保留为合成备选。公开分发前请确认音乐授权边界。',
    };
  }
  if (legacyStyle === 'tech' || visualStyle === 'tech') {
    return {
      title: 'Neon Circuit Pulse',
      preset: 'tech-pulse',
      source: 'synth',
      volume: 0.16,
      bpm: 112,
      copyrightNote: '原创合成循环。',
    };
  }
  return {
    title: 'Candy Bit Bounce',
    preset: 'pixel-pop',
    source: 'synth',
    volume: 0.15,
    bpm: 128,
    copyrightNote: '原创 8-bit 风格循环。',
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function cleanId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function makeCustomCopy(template: ThemeTemplate): ThemeTemplate {
  const id = cleanId(`${template.id}-custom-${Date.now().toString(36)}`);
  return {
    ...deepClone(template),
    id,
    name: `${template.name} 副本`,
    builtIn: false,
    author: template.author || 'T8',
  };
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取音频失败'));
    reader.readAsDataURL(file);
  });
}

function downloadJson(template: ThemeTemplate) {
  const blob = new Blob([JSON.stringify({ ...template, builtIn: false }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${template.id || 't8-theme'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function makePreviewStyle(tokens: ThemeTokens): CSSProperties {
  return {
    '--t8-bg-app': tokens.appBg,
    '--t8-bg-canvas': tokens.canvasBg,
    '--t8-bg-panel': tokens.panelBg,
    '--t8-bg-panel-elevated': tokens.panelBgElevated,
    '--t8-bg-panel-muted': tokens.panelBgMuted,
    '--t8-bg-node': tokens.nodeBg,
    '--t8-bg-node-header': tokens.nodeHeaderBg,
    '--t8-text-main': tokens.textMain,
    '--t8-text-muted': tokens.textMuted,
    '--t8-text-dim': tokens.textDim,
    '--t8-border': tokens.border,
    '--t8-border-strong': tokens.borderStrong,
    '--t8-accent': tokens.accent,
    '--t8-accent-hover': tokens.accentHover,
    '--t8-accent-text': tokens.accentText,
    '--t8-secondary': tokens.secondary,
    '--t8-warning': tokens.warning,
    '--t8-danger': tokens.danger,
    '--t8-success': tokens.success,
    '--t8-grid-dot': tokens.gridDot,
    '--t8-edge': tokens.edge,
    '--t8-edge-selected': tokens.edgeSelected,
    '--t8-port-text': tokens.portText,
    '--t8-port-image': tokens.portImage,
    '--t8-port-video': tokens.portVideo,
    '--t8-port-audio': tokens.portAudio,
    '--t8-shadow-panel': tokens.shadowPanel,
    '--t8-shadow-button': tokens.shadowButton,
    '--t8-shadow-strong': tokens.shadowStrong,
    '--t8-radius-panel': tokens.radiusPanel,
    '--t8-radius-button': tokens.radiusButton,
    '--t8-radius-node': tokens.radiusNode,
    '--t8-font-family': tokens.fontFamily,
    '--t8-display-font': tokens.displayFont,
  } as CSSProperties;
}

export default function ThemeTemplateManager({ open, onClose }: ThemeTemplateManagerProps) {
  const {
    theme,
    templateId,
    customTemplates,
    templatesPath,
    templatesError,
    setTemplate,
    setTheme,
    loadCustomTemplates,
    importTemplate,
    saveCustomTemplate,
    deleteCustomTemplate,
  } = useThemeStore();
  const allTemplates = useMemo(() => [...BUILT_IN_THEME_TEMPLATES, ...customTemplates], [customTemplates]);
  const activeTemplate = resolveThemeTemplate(templateId, customTemplates);
  const [mode, setMode] = useState<ThemeMode>(theme);
  const [selectedId, setSelectedId] = useState(activeTemplate.id);
  const [editor, setEditor] = useState<ThemeTemplate>(() => deepClone(activeTemplate));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const musicFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    loadCustomTemplates();
  }, [open, loadCustomTemplates]);

  useEffect(() => {
    if (!open) return;
    const tpl = allTemplates.find((item) => item.id === selectedId);
    if (!tpl) return;
    setEditor(deepClone(tpl));
    setMode(theme);
  }, [open, selectedId, allTemplates, theme]);

  if (!open) return null;

  const selectedBuiltIn = !!editor.builtIn || BUILT_IN_THEME_TEMPLATES.some((tpl) => tpl.id === editor.id);
  const tokens = getTemplateMode(editor, mode).tokens;
  const visuals = editor.visuals || fallbackVisuals(editor.legacyStyle);
  const music = editor.music || fallbackMusic(editor.legacyStyle, visuals);
  const warnings = getThemeContrastWarnings(editor, mode);
  const currentModeActive = activeTemplate.id === editor.id && theme === mode;

  const setToken = (key: keyof ThemeTokens, value: string) => {
    setEditor((prev) => ({
      ...prev,
      modes: {
        ...prev.modes,
        [mode]: {
          tokens: {
            ...prev.modes[mode].tokens,
            [key]: value,
          },
        },
      },
    }));
  };

  const setVisual = <K extends keyof ThemeVisuals>(key: K, value: ThemeVisuals[K]) => {
    setEditor((prev) => ({
      ...prev,
      visuals: {
        ...fallbackVisuals(prev.legacyStyle),
        ...(prev.visuals || {}),
        [key]: value,
      },
    }));
  };

  const setMusic = (patch: Partial<ThemeMusic>) => {
    setEditor((prev) => {
      const baseVisuals = prev.visuals || fallbackVisuals(prev.legacyStyle);
      return {
        ...prev,
        music: {
          ...fallbackMusic(prev.legacyStyle, baseVisuals),
          ...(prev.music || {}),
          ...patch,
        },
      };
    });
  };

  const handleApply = () => {
    requestGardenThemeMusicAutoplay(editor);
    setTemplate(editor.id, mode);
    setTheme(mode);
    setMessage('已应用主题');
    window.setTimeout(() => setMessage(''), 1200);
  };

  const handleDuplicate = () => {
    const copy = makeCustomCopy(editor);
    setEditor(copy);
    setSelectedId(copy.id);
    setMessage('已复制为自定义模板，保存后生效');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const withVisuals = { ...editor, visuals: editor.visuals || fallbackVisuals(editor.legacyStyle) };
      const withDefaults = { ...withVisuals, music: editor.music || fallbackMusic(editor.legacyStyle, withVisuals.visuals) };
      const payload = selectedBuiltIn ? makeCustomCopy(withDefaults) : { ...withDefaults, builtIn: false };
      const saved = await saveCustomTemplate(payload);
      setSelectedId(saved.id);
      setEditor(deepClone(saved));
      setMessage('主题已保存');
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (selectedBuiltIn) return;
    if (!window.confirm(`删除自定义主题「${editor.name}」？`)) return;
    setSaving(true);
    setError('');
    try {
      await deleteCustomTemplate(editor.id);
      setSelectedId(activeTemplate.id === editor.id ? BUILT_IN_THEME_TEMPLATES[1].id : activeTemplate.id);
      setMessage('主题已删除');
    } catch (e: any) {
      setError(e?.message || '删除失败');
    } finally {
      setSaving(false);
    }
  };

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    setSaving(true);
    setError('');
    try {
      const raw = JSON.parse(await file.text());
      const saved = await importTemplate(raw);
      setSelectedId(saved.id);
      setEditor(deepClone(saved));
      setMessage('主题已导入并应用');
    } catch (e: any) {
      setError(e?.message || '导入失败');
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleMusicFile = async (file?: File) => {
    if (!file) return;
    setError('');
    setMessage('');
    if (!file.type.startsWith('audio/')) {
      setError('请选择音频文件');
      if (musicFileInputRef.current) musicFileInputRef.current.value = '';
      return;
    }
    if (file.size > MAX_THEME_AUDIO_SIZE) {
      setError('音频文件请控制在 20MB 以内');
      if (musicFileInputRef.current) musicFileInputRef.current.value = '';
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setMusic({
        title: file.name.replace(/\.[^.]+$/, '') || music.title,
        source: 'upload',
        url: dataUrl,
        copyrightNote: `用户上传音频：${file.name}`,
      });
      setMessage('音乐已上传，保存模板后生效');
      window.setTimeout(() => setMessage(''), 1800);
    } catch (e: any) {
      setError(e?.message || '读取音频失败');
    } finally {
      if (musicFileInputRef.current) musicFileInputRef.current.value = '';
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm px-modal-mask"
      style={{ zIndex: 10000 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[min(1120px,94vw)] h-[min(760px,92vh)] t8-panel overflow-hidden flex flex-col">
        <div className="shrink-0 flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--t8-border)' }}>
          <Palette size={18} />
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold">主题模板</div>
            <div className="text-[11px]" style={{ color: 'var(--t8-text-muted)' }}>
              {templatesPath || 'D:\\zhenzhen\\theme-templates'}
            </div>
          </div>
          {message && (
            <span className="t8-chip px-2 py-1 text-[11px]">
              <Check size={12} /> {message}
            </span>
          )}
          <button className="t8-btn px-2 py-2" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[250px_1fr_310px]">
          <aside className="border-r p-3 overflow-y-auto" style={{ borderColor: 'var(--t8-border)' }}>
            <div className="text-[11px] font-bold mb-2" style={{ color: 'var(--t8-text-muted)' }}>内置模板</div>
            {BUILT_IN_THEME_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                className={`w-full text-left px-3 py-2 mb-2 t8-card ${selectedId === tpl.id ? 'ring-2' : ''}`}
                style={{ borderColor: selectedId === tpl.id ? 'var(--t8-border-strong)' : undefined }}
                onClick={() => setSelectedId(tpl.id)}
              >
                <div className="text-sm font-bold">{tpl.name}</div>
                <div className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--t8-text-muted)' }}>{tpl.description}</div>
              </button>
            ))}
            <div className="text-[11px] font-bold mt-4 mb-2" style={{ color: 'var(--t8-text-muted)' }}>自定义模板</div>
            {customTemplates.length === 0 && (
              <div className="text-[11px] px-3 py-2 rounded" style={{ color: 'var(--t8-text-dim)', background: 'var(--t8-bg-panel-muted)' }}>
                暂无自定义模板
              </div>
            )}
            {customTemplates.map((tpl) => (
              <button
                key={tpl.id}
                className={`w-full text-left px-3 py-2 mb-2 t8-card ${selectedId === tpl.id ? 'ring-2' : ''}`}
                style={{ borderColor: selectedId === tpl.id ? 'var(--t8-border-strong)' : undefined }}
                onClick={() => setSelectedId(tpl.id)}
              >
                <div className="text-sm font-bold">{tpl.name}</div>
                <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--t8-text-muted)' }}>{tpl.id}</div>
              </button>
            ))}
          </aside>

          <main className="p-4 overflow-y-auto">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold">
                模板名称
                <input
                  className="t8-input mt-1 w-full px-3 py-2 text-sm"
                  value={editor.name}
                  onChange={(e) => setEditor((prev) => ({ ...prev, name: e.target.value }))}
                />
              </label>
              <label className="text-xs font-bold">
                兼容风格
                <select
                  className="t8-select mt-1 w-full px-3 py-2 text-sm"
                  value={editor.legacyStyle}
                  onChange={(e) => {
                    const legacyStyle = e.target.value === 'tech' ? 'tech' : 'pixel';
                    setEditor((prev) => ({
                      ...prev,
                      legacyStyle,
                      music: prev.music || fallbackMusic(legacyStyle, prev.visuals),
                    }));
                  }}
                >
                  <option value="tech">科技风组件兼容</option>
                  <option value="pixel">像素风组件兼容</option>
                </select>
              </label>
              <label className="text-xs font-bold">
                视觉语言
                <select
                  className="t8-select mt-1 w-full px-3 py-2 text-sm"
                  value={visuals.style}
                  onChange={(e) => {
                    const style = e.target.value as ThemeVisuals['style'];
                    setEditor((prev) => {
                      const nextVisuals = visualDefaultsFor(style, prev.legacyStyle, prev.visuals);
                      return {
                        ...prev,
                        visuals: nextVisuals,
                        music: fallbackMusic(prev.legacyStyle, nextVisuals),
                      };
                    });
                  }}
                >
                  {VISUAL_STYLE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-bold">
                装饰强度
                <select
                  className="t8-select mt-1 w-full px-3 py-2 text-sm"
                  value={visuals.intensity || 'medium'}
                  onChange={(e) => setVisual('intensity', e.target.value as ThemeVisuals['intensity'])}
                >
                  {VISUAL_INTENSITY_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-bold col-span-2">
                描述
                <input
                  className="t8-input mt-1 w-full px-3 py-2 text-sm"
                  value={editor.description || ''}
                  onChange={(e) => setEditor((prev) => ({ ...prev, description: e.target.value }))}
                />
              </label>
            </div>

            <div className="mt-4 t8-card p-3">
              <div className="mb-3 flex items-center gap-2 text-xs font-bold">
                <Music2 size={14} />
                默认音乐主题
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold">
                  音乐名称
                  <input
                    className="t8-input mt-1 w-full px-3 py-2 text-sm"
                    value={music.title}
                    onChange={(e) => setMusic({ title: e.target.value })}
                  />
                </label>
                <label className="text-xs font-bold">
                  音乐预设
                  <select
                    className="t8-select mt-1 w-full px-3 py-2 text-sm"
                    value={music.preset}
                    onChange={(e) => setMusic({ preset: e.target.value as ThemeMusicPreset })}
                  >
                    {MUSIC_PRESET_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-bold">
                  播放来源
                  <select
                    className="t8-select mt-1 w-full px-3 py-2 text-sm"
                    value={music.source || 'synth'}
                    onChange={(e) => {
                      const source = e.target.value as ThemeMusic['source'];
                      setMusic({ source: source === 'url' || source === 'upload' ? source : 'synth' });
                    }}
                  >
                    <option value="synth">内置合成循环</option>
                    <option value="url">授权音频 URL</option>
                    <option value="upload">上传音乐</option>
                  </select>
                </label>
                <label className="text-xs font-bold">
                  音量
                  <input
                    className="mt-2 w-full"
                    type="range"
                    min="0"
                    max="0.5"
                    step="0.01"
                    value={music.volume ?? 0.16}
                    onChange={(e) => setMusic({ volume: Number(e.target.value) })}
                  />
                </label>
                {music.source === 'url' && (
                  <label className="text-xs font-bold col-span-2">
                    授权音频 URL
                    <input
                      className="t8-input mt-1 w-full px-3 py-2 text-sm"
                      value={music.url || ''}
                      onChange={(e) => setMusic({ url: e.target.value })}
                      placeholder="https://..."
                    />
                  </label>
                )}
                <div className="text-xs font-bold col-span-2">
                  上传音乐
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="t8-btn px-3 py-2 text-xs"
                      onClick={() => musicFileInputRef.current?.click()}
                    >
                      <Upload size={13} /> 选择音频
                    </button>
                    {music.source === 'upload' && music.url && (
                      <span className="t8-chip px-2 py-1 text-[11px]">已上传：{music.title}</span>
                    )}
                    <span className="text-[11px]" style={{ color: 'var(--t8-text-muted)' }}>
                      支持 mp3 / wav / ogg / m4a，20MB 内
                    </span>
                  </div>
                </div>
                <label className="text-xs font-bold col-span-2">
                  版权备注
                  <input
                    className="t8-input mt-1 w-full px-3 py-2 text-sm"
                    value={music.copyrightNote || ''}
                    onChange={(e) => setMusic({ copyrightNote: e.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-4">
              {(['light', 'dark'] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  className={`t8-btn px-3 py-1.5 text-xs ${mode === m ? 't8-btn-primary' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'light' ? '白天模式' : '黑夜模式'}
                </button>
              ))}
              {currentModeActive && <span className="t8-chip px-2 py-1 text-[11px]">当前应用中</span>}
            </div>

            {warnings.length > 0 && (
              <div className="mt-4 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--t8-warning)', background: 'var(--t8-bg-panel-muted)' }}>
                <div className="font-bold flex items-center gap-1 mb-1"><AlertTriangle size={13} /> 可读性提醒</div>
                {warnings.map((w) => <div key={w} style={{ color: 'var(--t8-text-muted)' }}>{w}</div>)}
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 gap-3">
              {COLOR_FIELDS.map(([key, label]) => (
                <label key={key} className="text-[11px] font-bold">
                  {label}
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="color"
                      value={String(tokens[key]).startsWith('#') ? String(tokens[key]) : '#000000'}
                      onChange={(e) => setToken(key, e.target.value)}
                      className="w-9 h-9 rounded overflow-hidden border"
                      style={{ borderColor: 'var(--t8-border)' }}
                    />
                    <input
                      className="t8-input flex-1 px-2 py-2 text-xs font-mono"
                      value={String(tokens[key])}
                      onChange={(e) => setToken(key, e.target.value)}
                    />
                  </div>
                </label>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              {TEXT_FIELDS.map(([key, label]) => (
                <label key={key} className="text-[11px] font-bold">
                  {label}
                  <input
                    className="t8-input mt-1 w-full px-2 py-2 text-xs font-mono"
                    value={String(tokens[key])}
                    onChange={(e) => setToken(key, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </main>

          <aside className="border-l p-4 overflow-y-auto" style={{ borderColor: 'var(--t8-border)' }}>
            <div className="text-xs font-bold mb-3">预览</div>
            <div
              className="t8-theme-preview t8-card p-3"
              data-theme-style={editor.legacyStyle}
              data-theme-mode={mode}
              data-theme-visual={visuals.style}
              data-theme-intensity={visuals.intensity || 'medium'}
              data-theme-node-frame={visuals.nodeFrame || 'plain'}
              style={{ ...makePreviewStyle(tokens), background: tokens.canvasBg }}
            >
              <div className="t8-panel p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm">{editor.name}</span>
                  <span className="t8-chip px-2 py-1 text-[10px]">{mode === 'light' ? '白天' : '黑夜'}</span>
                </div>
                <div className="mt-3 t8-node overflow-hidden">
                  <div className="t8-node-header px-3 py-2 text-xs font-bold">示例节点</div>
                  <div className="p-3 space-y-2">
                    <input className="t8-input w-full px-2 py-2 text-xs" placeholder="输入框文字" />
                    <div className="flex gap-2">
                      <button className="t8-btn t8-btn-primary px-3 py-1.5 text-xs">运行</button>
                      <button className="t8-btn px-3 py-1.5 text-xs">取消</button>
                    </div>
                    <div className="flex gap-2">
                      {[
                        ['image', tokens.portImage],
                        ['video', tokens.portVideo],
                        ['audio', tokens.portAudio],
                      ].map(([label, color]) => (
                        <span key={label} className="t8-chip px-2 py-1 text-[10px]" style={{ background: color as string }}>
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
            {templatesError && <div className="mt-3 text-xs text-amber-400">{templatesError}</div>}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="t8-btn t8-btn-primary px-3 py-2 text-xs" onClick={handleApply}>
                <Check size={14} /> 应用
              </button>
              <button className="t8-btn px-3 py-2 text-xs" onClick={handleDuplicate}>
                <Copy size={14} /> 复制
              </button>
              <button className="t8-btn px-3 py-2 text-xs" onClick={handleSave} disabled={saving}>
                <Save size={14} /> 保存
              </button>
              <button className="t8-btn px-3 py-2 text-xs" onClick={() => downloadJson({ ...editor, visuals, music })}>
                <Download size={14} /> 导出
              </button>
              <button className="t8-btn px-3 py-2 text-xs" onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} /> 导入
              </button>
              <button
                className="t8-btn px-3 py-2 text-xs"
                onClick={handleDelete}
                disabled={selectedBuiltIn || saving}
                title={selectedBuiltIn ? '内置模板不可删除' : '删除自定义模板'}
              >
                <Trash2 size={14} /> 删除
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => handleImportFile(e.target.files?.[0])}
            />
            <input
              ref={musicFileInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.ogg,.m4a"
              className="hidden"
              onChange={(e) => handleMusicFile(e.target.files?.[0])}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
