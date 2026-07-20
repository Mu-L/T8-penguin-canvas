import { memo, useMemo, useState, type CSSProperties } from 'react';
import {
  Handle,
  Position,
  useNodeConnections,
  useNodesData,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Aperture,
  Box,
  Camera,
  Clapperboard,
  Compass,
  Copy,
  Crosshair,
  Download,
  Film,
  FolderOpen,
  Palette,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { placeSingleNode } from '../../utils/nodePlacement';
import { useUpdateNodeData } from './useUpdateNodeData';

/**
 * ToolboxParamNode - 参数提供节点
 * 提供预设的 prompt 片段或运动模板,作为下游节点的提示词来源。
 *
 * 通过 data.kind 区分:
 *   - 'cinematic' = 电影感组合器(风格 / 镜头 / 光影 / 调色 / 质感)
 *   - 'video-motion' = 视频运镜组合器(场景 / 动作 / 路径 / 节奏 / 稳定 / 主体)
 *   - 'multi-angle-visual' = 可视化多角度(方位 / 俯仰 / 远近 → Qwen 多角度 prompt)
 *
 * 输出:data.prompt(下游通过 prompt 收集消费)
 */

type PromptLanguage = 'en' | 'zh';
type MultiAnglePromptMode = 'qwen' | 'general' | 'dual';
type MultiAngleBatchMode = 'single' | 'three' | 'four' | 'eight' | 'custom';

interface Preset {
  id: string;
  label: string;
  text: string;
  zhText: string;
}

interface CinematicGroup {
  id: CinematicField;
  label: string;
  icon: React.ReactNode;
  items: Preset[];
}

interface MotionGroup {
  id: MotionField;
  label: string;
  icon: React.ReactNode;
  items: Preset[];
  columns?: number;
}

interface MultiAnglePreset {
  id: string;
  label: string;
  azimuth: number;
  elevation: number;
  distance: number;
}

interface MultiAngleFavorite extends MultiAnglePreset {
  createdAt?: number;
}

type MultiAnglePatch = Partial<{
  multiAngleAzimuth: string | number;
  multiAngleElevation: string | number;
  multiAngleDistance: string | number;
  multiAnglePromptMode: string;
  multiAngleLanguage: string;
  multiAngleBatchMode: string;
  multiAngleBatchCustomAngles: string;
  multiAnglePrefix: string;
  multiAngleSuffix: string;
  multiAngleCustom: string;
  multiAngleFavorites: MultiAngleFavorite[];
}>;

type CinematicField =
  | 'cinematicPresetId'
  | 'cinematicShotId'
  | 'cinematicLightId'
  | 'cinematicColorId'
  | 'cinematicTextureId';

interface CinematicFavorite {
  id: string;
  label: string;
  cinematicPresetId?: string;
  cinematicShotId?: string;
  cinematicLightId?: string;
  cinematicColorId?: string;
  cinematicTextureId?: string;
  cinematicStrength?: string;
  cinematicCustom?: string;
  cinematicLanguage?: PromptLanguage;
  createdAt?: number;
}

type CinematicPatch = Partial<{
  cinematicPresetId: string;
  cinematicShotId: string;
  cinematicLightId: string;
  cinematicColorId: string;
  cinematicTextureId: string;
  cinematicStrength: string;
  cinematicCustom: string;
  cinematicLanguage: PromptLanguage;
  cinematicFavorites: CinematicFavorite[];
}>;

type MotionField =
  | 'motionSceneId'
  | 'motionActionId'
  | 'motionPathId'
  | 'motionTempoId'
  | 'motionStabilityId'
  | 'motionSubjectId';

interface MotionFavorite {
  id: string;
  label: string;
  motionSceneId?: string;
  motionActionId?: string;
  motionPathId?: string;
  motionTempoId?: string;
  motionStabilityId?: string;
  motionSubjectId?: string;
  motionCustom?: string;
  motionLanguage?: PromptLanguage;
  createdAt?: number;
}

type MotionPatch = Partial<{
  motionSceneId: string;
  motionActionId: string;
  motionPathId: string;
  motionTempoId: string;
  motionStabilityId: string;
  motionSubjectId: string;
  motionCustom: string;
  motionLanguage: PromptLanguage;
  motionFavorites: MotionFavorite[];
}>;

const CINEMATIC_PRESETS: Preset[] = [
  { id: 'soft-light', label: '柔光', text: 'soft cinematic lighting, golden hour, gentle shadows', zhText: '柔和电影光线，黄金时刻，温柔阴影' },
  { id: 'noir', label: '黑色电影', text: 'film noir style, high contrast, hard shadows, monochrome', zhText: '黑色电影风格，高反差，硬朗阴影，黑白影调' },
  { id: 'dreamy', label: '梦幻', text: 'dreamy soft focus, pastel palette, ethereal glow', zhText: '梦幻柔焦，粉彩色调，轻盈发光氛围' },
  { id: 'epic', label: '史诗', text: 'epic cinematic shot, dramatic lighting, ultra wide, IMAX', zhText: '史诗电影镜头，戏剧化光影，超宽画幅，IMAX 气势' },
  { id: 'vintage', label: '复古胶片', text: 'vintage 35mm film grain, faded colors, kodak portra', zhText: '复古 35mm 胶片颗粒，褪色色彩，柯达人像胶片感' },
  { id: 'cyberpunk', label: '赛博朋克', text: 'cyberpunk neon city, rain reflections, blade runner mood', zhText: '赛博朋克霓虹城市，雨夜反光，银翼杀手式氛围' },
  { id: 'japanese-film', label: '日影清透', text: 'Japanese cinema still, clean natural light, quiet emotional realism', zhText: '日系电影剧照，清透自然光，安静真实的情绪感' },
  { id: 'hongkong', label: '港风霓虹', text: 'Hong Kong cinema mood, neon signs, wet streets, rich urban atmosphere', zhText: '港风电影氛围，霓虹招牌，湿润街道，浓郁城市感' },
  { id: 'commercial', label: '广告大片', text: 'premium commercial film look, polished lighting, clean high-end composition', zhText: '高级广告片质感，精致布光，干净高级构图' },
  { id: 'dark-fantasy', label: '暗黑奇幻', text: 'dark fantasy cinematic atmosphere, mysterious shadows, painterly drama', zhText: '暗黑奇幻电影氛围，神秘阴影，绘画般戏剧张力' },
  { id: 'documentary', label: '纪录片', text: 'documentary film still, natural texture, authentic candid realism', zhText: '纪录片电影剧照，自然质地，真实抓拍感' },
  { id: 'romance', label: '浪漫暖调', text: 'romantic cinematic mood, warm backlight, soft glow, intimate atmosphere', zhText: '浪漫电影氛围，温暖逆光，柔和光晕，亲密感' },
  { id: 'western', label: '西部片', text: 'modern western film look, dusty sunlight, rugged cinematic atmosphere', zhText: '现代西部片质感，尘土阳光，粗粝电影氛围' },
  { id: 'suspense', label: '悬疑', text: 'suspense thriller atmosphere, tense framing, uneasy shadows', zhText: '悬疑惊悚氛围，紧张构图，不安阴影' },
  { id: 'sci-fi', label: '科幻', text: 'high-end science fiction film still, futuristic production design, clean cinematic scale', zhText: '高级科幻电影剧照，未来感美术设计，干净宏大的电影尺度' },
  { id: 'minimalist', label: '极简', text: 'minimalist art film look, quiet negative space, restrained visual language', zhText: '极简艺术电影感，安静留白，克制视觉语言' },
  { id: 'fashion-editorial', label: '时装大片', text: 'fashion editorial cinema look, sculpted poses, premium magazine lighting', zhText: '时装大片电影感，姿态雕塑感，高级杂志布光' },
  { id: 'arthouse', label: '艺术片', text: 'arthouse cinema mood, poetic framing, subtle emotional ambiguity', zhText: '艺术片氛围，诗意构图，含蓄暧昧的情绪' },
  { id: 'wuxia', label: '武侠', text: 'wuxia cinematic atmosphere, poetic movement, misty ancient landscape', zhText: '武侠电影氛围，诗意动作，雾气古风场景' },
  { id: 'anime-film', label: '动画电影', text: 'animated feature film mood, expressive colors, clean cinematic staging', zhText: '动画电影氛围，色彩表现力强，电影化调度干净' },
  { id: 'korean-drama', label: '韩剧', text: 'K-drama cinematic romance, soft close emotion, polished everyday beauty', zhText: '韩剧电影浪漫感，柔和近距离情绪，精致日常美感' },
  { id: 'nordic-cold', label: '北欧冷调', text: 'Nordic cold cinema look, pale daylight, quiet restrained atmosphere', zhText: '北欧冷调电影感，浅淡日光，安静克制氛围' },
  { id: 'desert-epic', label: '沙漠史诗', text: 'desert epic cinema, vast dunes, harsh sunlight, mythic scale', zhText: '沙漠史诗电影感，辽阔沙丘，强烈阳光，神话尺度' },
  { id: 'ocean-adventure', label: '海洋冒险', text: 'ocean adventure film look, sea breeze, sunlit water, heroic journey mood', zhText: '海洋冒险电影感，海风与水面阳光，英雄旅程氛围' },
  { id: 'urban-night', label: '都市夜景', text: 'urban night cinema, layered street lights, reflective modern loneliness', zhText: '都市夜景电影感，街灯层次丰富，现代孤独反光' },
  { id: 'slice-of-life', label: '生活流', text: 'slice-of-life film still, warm ordinary moments, gentle natural realism', zhText: '生活流电影剧照，温暖日常瞬间，柔和自然真实感' },
  { id: 'music-video', label: 'MV', text: 'music video cinematic style, rhythmic framing, bold stylish atmosphere', zhText: 'MV 电影风格，节奏化构图，大胆时髦氛围' },
  { id: 'sports-commercial', label: '运动广告', text: 'sports commercial film look, kinetic energy, crisp heroic highlights', zhText: '运动广告电影感，动势强烈，利落英雄高光' },
  { id: 'magical-realism', label: '魔幻现实', text: 'magical realism cinema, ordinary world with subtle impossible wonder', zhText: '魔幻现实电影感，日常世界中带有微妙奇迹' },
  { id: 'retro-future', label: '复古未来', text: 'retro-futurist film look, analog technology, nostalgic futuristic design', zhText: '复古未来电影感，模拟科技，怀旧未来设计' },
  { id: 'crime-thriller', label: '犯罪片', text: 'crime thriller film look, tense urban shadows, morally complex atmosphere', zhText: '犯罪惊悚电影感，紧张城市阴影，道德复杂氛围' },
  { id: 'road-movie', label: '公路片', text: 'road movie cinema, open highways, drifting freedom, sunlit melancholy', zhText: '公路片电影感，开阔公路，漂泊自由，阳光忧郁' },
  { id: 'coming-of-age', label: '青春成长', text: 'coming-of-age film mood, tender memory, youthful light and emotional discovery', zhText: '青春成长电影氛围，柔软记忆，年轻光线与情感发现' },
  { id: 'family-drama', label: '家庭剧', text: 'family drama cinema, intimate interiors, layered everyday emotion', zhText: '家庭剧电影感，亲密室内空间，层次日常情绪' },
  { id: 'war-film', label: '战争片', text: 'war film atmosphere, smoke, grit, urgent human stakes, desaturated realism', zhText: '战争片氛围，烟尘粗粝，人性紧迫感，低饱和真实主义' },
  { id: 'disaster', label: '灾难片', text: 'disaster movie scale, chaotic spectacle, dramatic danger and survival tension', zhText: '灾难片尺度，混乱奇观，危险戏剧性与求生张力' },
  { id: 'heist', label: '盗窃片', text: 'heist film style, precise planning mood, sleek suspense and controlled tension', zhText: '盗窃片风格，精密计划氛围，利落悬念与控制张力' },
  { id: 'courtroom', label: '法庭', text: 'courtroom drama cinema, formal composition, moral pressure, focused faces', zhText: '法庭剧电影感，正式构图，道德压力，面部焦点清晰' },
  { id: 'medical-drama', label: '医疗剧', text: 'medical drama film look, clean clinical light, urgent intimate realism', zhText: '医疗剧电影感，干净临床光，紧迫亲密真实感' },
  { id: 'space-opera', label: '太空歌剧', text: 'space opera cinematic scale, grand cosmic design, heroic science-fiction drama', zhText: '太空歌剧电影尺度，宏大宇宙设计，英雄式科幻戏剧' },
  { id: 'post-apocalyptic', label: '末世', text: 'post-apocalyptic film look, ruined world, survival dust, lonely vastness', zhText: '末世电影感，废墟世界，求生尘土，孤独辽阔' },
  { id: 'surrealist', label: '超现实', text: 'surrealist cinema, dream logic, impossible spaces, unsettling beauty', zhText: '超现实电影感，梦境逻辑，不可能空间，不安美感' },
  { id: 'gothic', label: '哥特', text: 'gothic cinema atmosphere, old architecture, deep shadows, romantic dread', zhText: '哥特电影氛围，古老建筑，深阴影，浪漫恐惧感' },
  { id: 'steampunk', label: '蒸汽朋克', text: 'steampunk film look, brass machinery, smoky industrial fantasy', zhText: '蒸汽朋克电影感，黄铜机械，烟雾工业幻想' },
  { id: 'fairy-tale', label: '童话', text: 'fairy-tale cinema, enchanted softness, storybook colors, gentle wonder', zhText: '童话电影感，魔法柔和，绘本色彩，温柔奇幻感' },
  { id: 'silent-film', label: '默片', text: 'silent film inspired style, theatrical gestures, vintage frame language', zhText: '默片灵感风格，戏剧化肢体，复古画框语言' },
  { id: 'neo-realism', label: '新现实', text: 'neorealist cinema, available light, ordinary people, honest street texture', zhText: '新现实主义电影感，可用光，普通人物，真实街头质地' },
  { id: 'food-film', label: '美食片', text: 'food cinema mood, tactile close details, warm appetite and sensory richness', zhText: '美食电影氛围，触感细节，温暖食欲与感官丰富度' },
  { id: 'travelogue', label: '旅行纪实', text: 'travelogue film look, discovered places, documentary warmth, open horizon', zhText: '旅行纪实电影感，被发现的地点，纪录片暖意，开阔地平线' },
  { id: 'museum-drama', label: '美术馆', text: 'museum drama film look, quiet gallery space, curated light, refined stillness', zhText: '美术馆电影感，安静展厅空间，策展式光线，精致静谧' },
];

const CINEMATIC_GROUPS: CinematicGroup[] = [
  {
    id: 'cinematicShotId',
    label: '镜头',
    icon: <Camera size={12} />,
    items: [
      { id: 'extreme-close', label: '大特写', text: 'extreme close-up shot, intense detail, intimate emotion', zhText: '大特写镜头，细节强烈，情绪贴近' },
      { id: 'close-up', label: '特写', text: 'close-up portrait shot, expressive face, shallow depth of field', zhText: '人物特写，表情突出，浅景深' },
      { id: 'medium-shot', label: '半身', text: 'medium shot, character-focused framing, cinematic blocking', zhText: '半身镜头，人物主体明确，电影化调度' },
      { id: 'full-body', label: '全身', text: 'full body shot, clear silhouette, balanced character composition', zhText: '全身镜头，轮廓清晰，人物构图平衡' },
      { id: 'wide-shot', label: '远景', text: 'wide establishing shot, strong environment storytelling', zhText: '远景建立镜头，环境叙事强' },
      { id: 'ultra-wide', label: '超广角', text: 'ultra wide angle shot, expansive space, dramatic perspective', zhText: '超广角镜头，空间开阔，透视戏剧化' },
      { id: 'low-angle', label: '低角度', text: 'low angle shot, heroic perspective, powerful presence', zhText: '低角度镜头，英雄视角，存在感强' },
      { id: 'high-angle', label: '高角度', text: 'high angle shot, vulnerable mood, elegant composition', zhText: '高角度镜头，脆弱氛围，构图优雅' },
      { id: 'top-down', label: '俯拍', text: 'overhead top-down shot, graphic composition', zhText: '垂直俯拍，图形化构图' },
      { id: 'over-shoulder', label: '过肩', text: 'over-the-shoulder shot, conversational framing, cinematic depth', zhText: '过肩镜头，对话式构图，层次有深度' },
      { id: 'pov', label: '中景', text: 'medium shot, balanced subject and environment, clear narrative context', zhText: '中景镜头，人物与环境比例平衡，叙事空间清晰' },
      { id: 'dutch', label: '倾斜', text: 'Dutch angle shot, uneasy energy, stylized tension', zhText: '倾斜镜头，不稳定能量，风格化紧张感' },
      { id: 'macro', label: '微距', text: 'macro cinematic shot, tactile detail, shallow focus', zhText: '微距电影镜头，触感细节，浅焦' },
      { id: 'long-lens', label: '长焦', text: 'telephoto lens compression, creamy background separation', zhText: '长焦压缩空间，背景柔滑分离' },
      { id: 'symmetry', label: '对称', text: 'centered symmetrical composition, precise cinematic framing', zhText: '居中对称构图，精准电影画框' },
      { id: 'establishing', label: '建立镜头', text: 'establishing shot, clearly introduce the location and story scale', zhText: '建立镜头，清晰交代地点和故事尺度' },
      { id: 'cowboy-shot', label: '牛仔景别', text: 'cowboy shot, framed from mid-thigh upward, strong character stance', zhText: '牛仔景别，从大腿中部向上构图，角色站姿有力量' },
      { id: 'two-shot', label: '双人镜头', text: 'two-shot composition, relationship-focused blocking, balanced screen presence', zhText: '双人镜头，关系导向调度，画面存在感平衡' },
      { id: 'group-shot', label: '群像', text: 'group shot, ensemble staging, readable character hierarchy', zhText: '群像镜头，群体调度，角色层级清晰' },
      { id: 'profile', label: '侧脸', text: 'profile shot, clean side silhouette, contemplative cinematic mood', zhText: '侧脸镜头，侧面轮廓干净，沉思电影氛围' },
      { id: 'three-quarter', label: '四分之三', text: 'three-quarter view shot, natural depth and flattering face angle', zhText: '四分之三视角，自然纵深，脸部角度耐看' },
      { id: 'reverse-shot', label: '反打', text: 'reverse shot, conversational counter-angle, narrative continuity', zhText: '反打镜头，对话反向角度，叙事连续' },
      { id: 'insert-shot', label: '插入镜头', text: 'insert shot, meaningful object detail, precise storytelling emphasis', zhText: '插入镜头，关键物件细节，叙事强调精准' },
      { id: 'cutaway', label: '切出镜头', text: 'cutaway shot, environmental reaction detail, broaden the scene context', zhText: '切出镜头，环境反应细节，扩展场景语境' },
      { id: 'tracking-shot', label: '跟移', text: 'tracking shot composition, camera follows the subject with smooth momentum', zhText: '跟移镜头构图，相机平滑跟随主体运动' },
      { id: 'handheld-frame', label: '手持感', text: 'handheld cinematic framing, intimate documentary energy, slight instability', zhText: '手持电影构图，亲密纪录能量，轻微不稳定感' },
      { id: 'crane-shot', label: '摇臂', text: 'crane shot perspective, graceful vertical movement, expansive reveal', zhText: '摇臂视角，优雅垂直运动，开阔揭示' },
      { id: 'drone-shot', label: '航拍', text: 'drone aerial shot, elevated geography, grand spatial relationship', zhText: '航拍镜头，高处地理视角，空间关系宏大' },
      { id: 'reflection-shot', label: '反射', text: 'reflection shot, mirror or glass framing, layered poetic composition', zhText: '反射镜头，镜面或玻璃构图，层次诗意' },
      { id: 'split-diopter', label: '分焦', text: 'split diopter style, foreground and background both sharp, surreal depth', zhText: '分焦镜头风格，前景和背景同时清晰，纵深超现实' },
      { id: 'close-detail', label: '细节特写', text: 'detail close-up shot, isolate a meaningful small element, precise emphasis', zhText: '细节特写，隔离关键小元素，强调精准' },
      { id: 'wide-low', label: '低广角', text: 'low wide-angle shot, exaggerated scale, powerful spatial distortion', zhText: '低机位广角，尺度夸张，空间变形有力量' },
      { id: 'telephoto-close', label: '长焦近景', text: 'telephoto close shot, compressed background, intimate cinematic separation', zhText: '长焦近景，背景压缩，亲密电影分离感' },
      { id: 'foreground-frame', label: '前景框景', text: 'foreground-framed shot, layered depth, subject seen through near objects', zhText: '前景框景，层次纵深，通过近处物体看见主体' },
      { id: 'doorway-frame', label: '门框构图', text: 'doorway framed composition, architectural border, quiet narrative distance', zhText: '门框构图，建筑边框，安静叙事距离' },
      { id: 'silhouette-shot', label: '剪影', text: 'silhouette shot, graphic subject outline, strong backlit mood', zhText: '剪影镜头，主体轮廓图形化，强逆光氛围' },
      { id: 'negative-space', label: '留白', text: 'negative space composition, small subject in open frame, contemplative mood', zhText: '留白构图，开放画面中的小主体，沉思氛围' },
      { id: 'rack-focus', label: '转焦', text: 'rack focus shot, attention shifts between planes, cinematic reveal', zhText: '转焦镜头，注意力在层次间移动，电影化揭示' },
      { id: 'birds-eye', label: '鸟瞰', text: 'bird’s-eye view, elevated map-like composition, clean spatial pattern', zhText: '鸟瞰视角，高处地图式构图，空间图案干净' },
      { id: 'worms-eye', label: '蚁视', text: 'worm’s-eye view, extreme upward perspective, monumental subject presence', zhText: '蚁视角，极端仰视透视，主体纪念碑感强' },
      { id: 'mirror-over', label: '镜中过肩', text: 'over-the-shoulder mirror shot, reflection dialogue, layered identity framing', zhText: '镜中过肩镜头，反射式对话，身份层次构图' },
      { id: 'crowd-perspective', label: '人群视角', text: 'crowd perspective shot, subject glimpsed through people, alive documentary energy', zhText: '人群视角，从人群缝隙看主体，鲜活纪录能量' },
      { id: 'long-take', label: '长镜头', text: 'long take framing, continuous action space, immersive cinematic rhythm', zhText: '长镜头构图，连续动作空间，沉浸电影节奏' },
      { id: 'locked-off', label: '固定机位', text: 'locked-off static frame, deliberate composition, quiet observational tension', zhText: '固定机位静态画框，构图克制，安静观察张力' },
      { id: 'push-in-frame', label: '推近构图', text: 'push-in composition, gradually intensify emotion and subject presence', zhText: '推近构图，逐渐强化情绪和主体存在感' },
      { id: 'pull-back-frame', label: '拉远构图', text: 'pull-back composition, reveal context around the subject, widening story scale', zhText: '拉远构图，揭示主体周围语境，扩大故事尺度' },
      { id: 'panorama-wide', label: '横向全景', text: 'panoramic wide frame, sweeping horizontal space, cinematic scope', zhText: '横向全景画框，横向空间铺展，电影范围感强' },
      { id: 'low-profile', label: '低侧面', text: 'low profile side shot, sleek silhouette, grounded dynamic perspective', zhText: '低机位侧面镜头，轮廓利落，贴地动态视角' },
      { id: 'back-view', label: '背影', text: 'back view shot, character facing the world, emotional distance and mystery', zhText: '背影镜头，角色面向世界，情绪距离与神秘感' },
      { id: 'front-center', label: '正面居中', text: 'frontal centered shot, direct presence, iconic symmetrical portrait energy', zhText: '正面居中镜头，直接存在感，标志性对称肖像能量' },
    ],
  },
  {
    id: 'cinematicLightId',
    label: '光影',
    icon: <Sun size={12} />,
    items: [
      { id: 'window', label: '窗光', text: 'soft window light, gentle falloff, natural indoor shadows', zhText: '柔和窗光，渐变自然，室内阴影真实' },
      { id: 'rim', label: '轮廓光', text: 'strong rim light, glowing edge highlights, cinematic silhouette', zhText: '强轮廓光，边缘高光发亮，电影化剪影' },
      { id: 'volumetric', label: '体积光', text: 'volumetric light beams, visible haze, atmospheric depth', zhText: '体积光束，可见薄雾，空间氛围深' },
      { id: 'hard-shadow', label: '硬阴影', text: 'hard directional light, bold shadow shapes, dramatic contrast', zhText: '硬质方向光，大块阴影形状，戏剧反差' },
      { id: 'neon', label: '霓虹', text: 'neon practical lights, colored reflections, night city ambience', zhText: '霓虹实景光，彩色反射，夜城氛围' },
      { id: 'overcast', label: '阴天柔光', text: 'overcast soft light, muted shadows, calm cinematic realism', zhText: '阴天柔光，阴影低调，平静真实电影感' },
      { id: 'candle', label: '烛光', text: 'warm candlelight, flickering highlights, intimate low-key mood', zhText: '温暖烛光，跳动高光，亲密低调氛围' },
      { id: 'backlight', label: '逆光', text: 'strong backlight, glowing atmosphere, translucent edges', zhText: '强逆光，空气发亮，边缘通透' },
      { id: 'spotlight', label: '聚光', text: 'single spotlight, theatrical focus, deep surrounding shadows', zhText: '单一聚光，舞台焦点，周围深暗' },
      { id: 'golden-hour', label: '金时刻', text: 'golden hour sunlight, long warm shadows, cinematic glow', zhText: '黄金时刻阳光，温暖长阴影，电影光晕' },
      { id: 'blue-hour', label: '蓝时刻', text: 'blue hour ambient light, cool dusk tone, soft city glow', zhText: '蓝调时刻环境光，冷色黄昏，城市微光' },
      { id: 'moonlight', label: '月光', text: 'moonlit night scene, cool silver highlights, quiet shadows', zhText: '月光夜景，冷银高光，安静阴影' },
      { id: 'practical', label: '实景灯', text: 'practical lights inside the frame, motivated cinematic lighting', zhText: '画面内实景灯光，有动机的电影布光' },
      { id: 'chiaroscuro', label: '明暗法', text: 'chiaroscuro lighting, sculpted face, deep painterly contrast', zhText: '明暗对照光，脸部雕塑感，深沉绘画反差' },
      { id: 'softbox', label: '柔光箱', text: 'large softbox lighting, clean skin highlights, controlled studio falloff', zhText: '大柔光箱布光，皮肤高光干净，棚拍渐变可控' },
      { id: 'sunset-backlight', label: '夕阳逆光', text: 'sunset backlight, warm flare, glowing hair rim and long shadows', zhText: '夕阳逆光，温暖眩光，发丝边缘发亮，长阴影' },
      { id: 'overexposed', label: '过曝', text: 'intentional overexposure, blooming highlights, dreamy washed atmosphere', zhText: '刻意过曝，高光扩散，梦幻褪色氛围' },
      { id: 'underlit', label: '底光', text: 'underlit dramatic light, mysterious upward shadows, unsettling mood', zhText: '底部戏剧光，向上阴影神秘，氛围不安' },
      { id: 'top-light', label: '顶光', text: 'top light, sculptural facial shadows, theatrical isolation', zhText: '顶光，面部阴影雕塑感，舞台式孤立' },
      { id: 'side-light', label: '侧光', text: 'strong side light, half-lit face, graphic contrast', zhText: '强侧光，半明半暗面部，图形化反差' },
      { id: 'bounce-light', label: '反射补光', text: 'soft bounce light, gentle fill, natural skin detail', zhText: '柔和反射补光，填光温柔，皮肤细节自然' },
      { id: 'fluorescent', label: '荧光灯', text: 'fluorescent practical light, clinical green cast, urban realism', zhText: '荧光实景灯，临床绿色偏色，都市真实感' },
      { id: 'sodium-vapor', label: '钠灯', text: 'sodium vapor street light, amber night glow, gritty exterior mood', zhText: '钠灯街景，琥珀夜光，粗粝外景氛围' },
      { id: 'strobe', label: '频闪', text: 'strobe light, frozen motion accents, energetic music-video rhythm', zhText: '频闪光，冻结运动重音，MV 节奏能量' },
      { id: 'firelight', label: '火光', text: 'firelight illumination, warm flicker, primal dramatic shadows', zhText: '火光照明，温暖跳动，原始戏剧阴影' },
      { id: 'projector', label: '投影光', text: 'projector light across the subject, patterned illumination, cinematic texture', zhText: '投影光掠过主体，图案化照明，电影纹理' },
      { id: 'underwater-light', label: '水下光', text: 'underwater caustic light, rippling highlights, floating atmosphere', zhText: '水下焦散光，波纹高光，漂浮氛围' },
      { id: 'lightning', label: '闪电', text: 'lightning flash, sudden high contrast, stormy cinematic drama', zhText: '闪电瞬间光，突发高反差，风暴电影戏剧性' },
      { id: 'headlights', label: '车灯', text: 'car headlights as key light, night road tension, hard frontal beams', zhText: '车灯作为主光，夜路紧张感，硬质正面光束' },
      { id: 'lantern', label: '灯笼', text: 'lantern light, warm localized glow, intimate traditional atmosphere', zhText: '灯笼光，局部温暖发光，亲密传统氛围' },
      { id: 'dappled', label: '树影斑驳', text: 'dappled sunlight through leaves, patterned moving shadows, natural poetic light', zhText: '树叶间斑驳阳光，移动影纹，自然诗意光线' },
      { id: 'venetian-blinds', label: '百叶窗', text: 'venetian blind shadows, striped noir light, graphic interior tension', zhText: '百叶窗阴影，条纹黑色电影光，室内图形张力' },
      { id: 'god-rays', label: '圣光', text: 'god rays through haze, spiritual shafts of light, majestic atmosphere', zhText: '薄雾中的圣光光束，精神性光柱，庄严氛围' },
      { id: 'rain-reflection', label: '雨夜反光', text: 'rainy night reflections, wet pavement glow, layered neon highlights', zhText: '雨夜反光，湿路面发亮，霓虹高光层次丰富' },
      { id: 'snow-light', label: '雪地反光', text: 'snow-reflected daylight, bright soft fill, clean winter ambience', zhText: '雪地反射日光，明亮柔和补光，干净冬日氛围' },
      { id: 'pool-light', label: '池水反光', text: 'pool-reflected light, shimmering caustics, relaxed nocturnal luxury', zhText: '泳池反射光，闪烁焦散，松弛夜间奢华感' },
      { id: 'stage-color', label: '舞台彩光', text: 'colored stage lighting, theatrical saturation, performance energy', zhText: '舞台彩光，戏剧化饱和度，表演能量' },
      { id: 'police-lights', label: '警灯', text: 'red and blue police lights, urgent flashing contrast, thriller tension', zhText: '红蓝警灯，紧急闪烁反差，惊悚张力' },
      { id: 'tv-glow', label: '屏幕光', text: 'television glow as key light, soft flicker, late-night intimate mood', zhText: '电视屏幕光作为主光，柔和闪动，深夜亲密氛围' },
      { id: 'phone-glow', label: '手机光', text: 'phone screen glow on the face, small modern light source, private mood', zhText: '手机屏幕光照亮脸部，小型现代光源，私密氛围' },
      { id: 'sunny-noon', label: '正午硬光', text: 'hard noon sunlight, crisp short shadows, unforgiving realism', zhText: '正午硬阳光，短促清晰阴影，不留情面的真实感' },
      { id: 'morning-haze', label: '晨雾光', text: 'morning haze light, pale softness, fresh atmospheric diffusion', zhText: '晨雾光，淡雅柔和，新鲜空气扩散感' },
      { id: 'dusty-light', label: '尘埃光', text: 'dusty shafts of light, visible particles, warm abandoned-room atmosphere', zhText: '尘埃光束，颗粒可见，温暖废弃房间氛围' },
      { id: 'blacklight', label: '紫外光', text: 'blacklight ultraviolet glow, fluorescent edges, stylized nightlife mood', zhText: '紫外黑光，荧光边缘，风格化夜生活氛围' },
      { id: 'laser', label: '激光', text: 'laser beam lighting, sharp colored lines, futuristic concert energy', zhText: '激光束照明，彩色锐线，未来演出能量' },
      { id: 'fairy-lights', label: '小灯串', text: 'fairy lights, tiny warm bokeh, cozy romantic sparkle', zhText: '小灯串，细小暖色焦外，舒适浪漫闪光' },
      { id: 'campfire', label: '篝火', text: 'campfire light, warm flickering faces, outdoor storytelling intimacy', zhText: '篝火光，温暖跳动的面孔，户外叙事亲密感' },
      { id: 'subway-light', label: '地铁光', text: 'subway carriage light, fluorescent rhythm, urban transit realism', zhText: '地铁车厢光，荧光节奏，都市通勤真实感' },
      { id: 'warehouse-skylight', label: '天窗光', text: 'warehouse skylight beams, industrial overhead daylight, dusty depth', zhText: '仓库天窗光束，工业顶部日光，尘埃纵深' },
      { id: 'eclipse', label: '日食光', text: 'eclipse-like dim daylight, uncanny shadow tone, cosmic unease', zhText: '日食般昏暗日光，诡异阴影色调，宇宙不安感' },
    ],
  },
  {
    id: 'cinematicColorId',
    label: '调色',
    icon: <Palette size={12} />,
    items: [
      { id: 'teal-orange', label: '青橙', text: 'teal and orange color grade, cinematic skin tones', zhText: '青橙电影调色，肤色电影感' },
      { id: 'muted', label: '低饱和', text: 'muted color palette, restrained contrast, elegant film grade', zhText: '低饱和色彩，克制反差，优雅电影调色' },
      { id: 'warm', label: '暖金', text: 'warm golden color grade, sunlit highlights, soft amber tone', zhText: '暖金色调，阳光高光，柔和琥珀色' },
      { id: 'cool', label: '冷蓝', text: 'cool blue color grade, crisp shadows, clean cinematic contrast', zhText: '冷蓝色调，阴影清爽，电影反差干净' },
      { id: 'pastel', label: '粉彩', text: 'pastel color grade, soft highlights, delicate dreamy palette', zhText: '粉彩调色，高光柔软，精致梦幻色盘' },
      { id: 'bleach', label: '银漂', text: 'bleach bypass look, desaturated colors, strong contrast', zhText: '银漂效果，低饱和色彩，强反差' },
      { id: 'kodak-warm', label: '柯达暖', text: 'Kodak warm film grade, rich reds, creamy highlights', zhText: '柯达暖调胶片，红色浓郁，高光奶油感' },
      { id: 'moody-green', label: '冷绿', text: 'moody green shadows, cinematic cyan midtones, mysterious tone', zhText: '冷绿色阴影，青色中间调，神秘气质' },
      { id: 'candy', label: '糖果色', text: 'vibrant candy color grade, playful saturation, clean contrast', zhText: '鲜明糖果调色，活泼饱和，反差干净' },
      { id: 'monochrome', label: '黑白', text: 'fine monochrome film grade, rich grayscale, elegant contrast', zhText: '精致黑白胶片调色，灰阶丰富，反差优雅' },
      { id: 'sepia', label: '棕褐', text: 'sepia vintage tone, aged warmth, nostalgic atmosphere', zhText: '棕褐复古调，温暖旧时感，怀旧氛围' },
      { id: 'cyber-neon', label: '电光', text: 'electric neon color grade, saturated magenta and cyan, glossy night mood', zhText: '电光霓虹调色，高饱和品红与青色，光泽夜景' },
      { id: 'autumn', label: '秋色', text: 'autumn film palette, amber leaves, warm earthy tones', zhText: '秋季电影色盘，琥珀叶色，温暖大地色' },
      { id: 'silver-blue', label: '银蓝', text: 'silver blue color grade, cool metallic highlights, premium sci-fi tone', zhText: '银蓝调色，冷金属高光，高级科幻质感' },
      { id: 'high-key', label: '明亮', text: 'high-key bright color grade, airy whites, clean optimistic tone', zhText: '高调明亮调色，空气感白色，干净乐观氛围' },
      { id: 'earth-tone', label: '大地色', text: 'earth tone color grade, warm browns, grounded natural palette', zhText: '大地色调，温暖棕色，自然稳重色盘' },
      { id: 'desert-gold', label: '沙金', text: 'desert gold palette, sun-bleached highlights, dry cinematic warmth', zhText: '沙金色盘，日晒褪色高光，干燥电影暖意' },
      { id: 'forest-green', label: '森林绿', text: 'forest green grade, deep botanical shadows, organic natural mood', zhText: '森林绿色调，深植物阴影，有机自然氛围' },
      { id: 'ocean-teal', label: '海青', text: 'ocean teal grade, cool marine shadows, clean water highlights', zhText: '海青色调，冷海洋阴影，水面高光干净' },
      { id: 'lavender', label: '薰衣草', text: 'lavender color grade, soft violet atmosphere, gentle romantic haze', zhText: '薰衣草调色，柔和紫色氛围，温柔浪漫薄雾' },
      { id: 'rose-gold', label: '玫瑰金', text: 'rose gold color grade, warm pink highlights, elegant beauty tone', zhText: '玫瑰金调色，温暖粉色高光，优雅美妆感' },
      { id: 'crimson', label: '猩红', text: 'crimson cinematic grade, deep reds, intense dramatic identity', zhText: '猩红电影调色，深红色强烈，戏剧识别度高' },
      { id: 'tungsten', label: '钨丝暖', text: 'tungsten warm interior grade, amber practical lights, cozy shadows', zhText: '钨丝暖室内调色，琥珀实景灯，舒适阴影' },
      { id: 'cyan-magenta', label: '青品红', text: 'cyan and magenta split color grade, glossy stylized nightlife', zhText: '青色与品红分离调色，光泽风格化夜生活' },
      { id: 'acid-green', label: '酸绿', text: 'acid green stylized grade, toxic modern edge, bold contrast', zhText: '酸绿色风格调色，有毒现代锋芒，反差大胆' },
      { id: 'steel-gray', label: '钢灰', text: 'steel gray color grade, industrial coolness, restrained metallic mood', zhText: '钢灰色调，工业冷感，克制金属氛围' },
      { id: 'milk-white', label: '奶白', text: 'milky white grade, soft lifted blacks, clean gentle highlights', zhText: '奶白调色，黑位轻抬，高光干净温柔' },
      { id: 'sunset-gradient', label: '落日渐变', text: 'sunset gradient palette, orange to violet sky tones, warm cinematic transition', zhText: '落日渐变色盘，橙到紫天空色，温暖电影过渡' },
      { id: 'faded-print', label: '旧印刷', text: 'faded print color grade, slightly shifted inks, nostalgic poster tone', zhText: '旧印刷调色，油墨轻微偏移，怀旧海报感' },
      { id: 'deep-red', label: '深红', text: 'deep red and shadow grade, luxurious tension, velvet cinematic mood', zhText: '深红暗影调色，奢华张力，天鹅绒电影氛围' },
      { id: 'chrome-silver', label: '铬银', text: 'chrome silver color grade, reflective cool highlights, polished future luxury', zhText: '铬银调色，冷反射高光，抛光未来奢华感' },
      { id: 'peach-cream', label: '蜜桃奶油', text: 'peach cream palette, soft warm skin tones, sweet gentle brightness', zhText: '蜜桃奶油色盘，柔暖肤色，甜美温柔明亮感' },
      { id: 'icy-cyan', label: '冰青', text: 'icy cyan color grade, pale cool highlights, frozen clean atmosphere', zhText: '冰青调色，苍白冷高光，冰冻干净氛围' },
      { id: 'midnight-blue', label: '午夜蓝', text: 'midnight blue grade, deep cool shadows, quiet nocturnal elegance', zhText: '午夜蓝调色，深冷阴影，安静夜间优雅' },
      { id: 'coffee-brown', label: '咖啡棕', text: 'coffee brown palette, roasted warmth, intimate low-contrast mood', zhText: '咖啡棕色盘，烘焙暖意，亲密低反差氛围' },
      { id: 'olive-drab', label: '橄榄', text: 'olive drab grade, military earthy restraint, grounded dramatic realism', zhText: '橄榄调色，军装大地色克制，稳重戏剧真实感' },
      { id: 'neon-purple', label: '霓虹紫', text: 'neon purple grade, electric violet glow, stylized night fantasy', zhText: '霓虹紫调色，电光紫色发亮，风格化夜间幻想' },
      { id: 'mint-fresh', label: '薄荷', text: 'fresh mint color grade, clean pastel coolness, light optimistic mood', zhText: '清新薄荷调色，干净粉彩冷感，轻盈乐观氛围' },
      { id: 'blood-orange', label: '血橙', text: 'blood orange color grade, bold warm reds, passionate cinematic heat', zhText: '血橙调色，大胆暖红，热烈电影温度' },
      { id: 'warm-monochrome', label: '暖黑白', text: 'warm monochrome grade, sepia-tinted grayscale, nostalgic portrait depth', zhText: '暖黑白调色，棕褐灰阶，怀旧肖像深度' },
      { id: 'cool-monochrome', label: '冷黑白', text: 'cool monochrome grade, silver grayscale, crisp modern contrast', zhText: '冷黑白调色，银色灰阶，利落现代反差' },
      { id: 'ink-wash', label: '水墨', text: 'ink wash inspired palette, soft black gradients, poetic minimal color', zhText: '水墨灵感色盘，柔和墨色渐变，诗意极简色彩' },
      { id: 'porcelain-blue', label: '青花', text: 'porcelain blue palette, white ceramic highlights, elegant traditional coolness', zhText: '青花色盘，白瓷高光，优雅传统冷感' },
      { id: 'pop-art', label: '波普', text: 'pop art color grade, bold primaries, graphic playful contrast', zhText: '波普调色，大胆原色，图形化趣味反差' },
      { id: 'vaporwave', label: '蒸汽波', text: 'vaporwave palette, pink cyan nostalgia, retro digital sunset mood', zhText: '蒸汽波色盘，粉青怀旧，复古数字落日氛围' },
      { id: 'dusty-pink', label: '灰粉', text: 'dusty pink grade, muted rosy highlights, tender restrained romance', zhText: '灰粉调色，柔和玫瑰高光，克制温柔浪漫' },
      { id: 'champagne', label: '香槟', text: 'champagne color grade, pale gold elegance, refined celebration tone', zhText: '香槟色调，浅金优雅，精致庆典质感' },
      { id: 'emerald', label: '翡翠', text: 'emerald green grade, jewel-toned shadows, luxurious mysterious depth', zhText: '翡翠绿色调，宝石阴影，奢华神秘深度' },
      { id: 'charcoal', label: '炭黑', text: 'charcoal color grade, smoky blacks, restrained graphic contrast', zhText: '炭黑调色，烟熏黑位，克制图形反差' },
      { id: 'pearl', label: '珍珠', text: 'pearl color grade, iridescent whites, soft luminous elegance', zhText: '珍珠调色，虹彩白色，柔亮优雅' },
    ],
  },
  {
    id: 'cinematicTextureId',
    label: '质感',
    icon: <Aperture size={12} />,
    items: [
      { id: '35mm', label: '35mm', text: 'shot on 35mm film, subtle film grain, organic texture', zhText: '35mm 胶片拍摄，细腻颗粒，有机质感' },
      { id: 'imax', label: 'IMAX', text: 'IMAX cinematic clarity, grand scale, high dynamic range', zhText: 'IMAX 电影清晰度，宏大尺度，高动态范围' },
      { id: 'kodak', label: '柯达', text: 'Kodak Portra inspired film stock, soft contrast, warm skin tones', zhText: '柯达 Portra 胶片感，反差柔和，肤色温暖' },
      { id: 'fuji', label: '富士', text: 'Fujifilm Eterna inspired film stock, smooth highlights, cinematic greens', zhText: '富士 Eterna 胶片感，高光顺滑，绿色电影感' },
      { id: 'anamorphic', label: '变宽银幕', text: 'anamorphic lens look, oval bokeh, subtle horizontal lens flare', zhText: '变宽银幕镜头感，椭圆焦外，轻微横向眩光' },
      { id: 'grain', label: '颗粒', text: 'fine film grain, natural texture, handcrafted cinematic finish', zhText: '细腻胶片颗粒，自然纹理，手作电影质感' },
      { id: 'clean-digital', label: '数字清晰', text: 'clean digital cinema look, crisp detail, controlled noise', zhText: '干净数字电影质感，细节清晰，噪点可控' },
      { id: 'vhs', label: 'VHS', text: 'subtle VHS texture, analog softness, nostalgic scanline feeling', zhText: '轻微 VHS 质感，模拟柔化，怀旧扫描线感' },
      { id: '16mm', label: '16mm', text: '16mm film texture, visible grain, intimate indie cinema mood', zhText: '16mm 胶片质感，颗粒可见，独立电影亲密感' },
      { id: 'matte', label: '哑光', text: 'matte cinematic finish, soft black levels, restrained highlights', zhText: '哑光电影质感，黑位柔和，高光克制' },
      { id: 'glossy', label: '高光泽', text: 'glossy premium finish, polished reflections, luxury commercial texture', zhText: '高光泽高级质感，反射精致，奢华广告片质地' },
      { id: 'halation', label: '光晕', text: 'film halation around highlights, glowing red-orange bloom', zhText: '胶片高光晕影，红橙色发光扩散' },
      { id: 'bokeh', label: '焦外', text: 'cinematic bokeh, creamy out-of-focus background, lens character', zhText: '电影焦外，奶油般虚化背景，镜头性格明显' },
      { id: 'lens-flare', label: '眩光', text: 'subtle lens flare, realistic glass reflections, cinematic optics', zhText: '轻微镜头眩光，真实玻璃反射，电影镜头光学感' },
      { id: 'hdr', label: 'HDR', text: 'HDR cinematic finish, rich highlight detail, deep shadow recovery', zhText: 'HDR 电影质感，高光细节丰富，暗部层次深' },
      { id: 'arri-alexa', label: 'ARRI', text: 'ARRI Alexa cinema camera texture, soft highlight rolloff, natural color science', zhText: 'ARRI Alexa 电影机质感，高光过渡柔和，色彩科学自然' },
      { id: 'red-camera', label: 'RED', text: 'RED cinema camera sharpness, detailed shadows, modern digital texture', zhText: 'RED 电影机锐度，暗部细节丰富，现代数字质感' },
      { id: 'vintage-lens', label: '老镜头', text: 'vintage lens character, gentle aberration, imperfect nostalgic glass', zhText: '老镜头性格，轻微像差，不完美怀旧玻璃感' },
      { id: 'pro-mist', label: '柔焦滤镜', text: 'black pro-mist diffusion, softened highlights, dreamy skin glow', zhText: '黑柔焦滤镜，高光柔化，皮肤梦幻发光' },
      { id: 'diffusion', label: '扩散', text: 'cinematic diffusion filter, low contrast bloom, velvety softness', zhText: '电影扩散滤镜，低反差光晕，天鹅绒般柔和' },
      { id: 'wet-plate', label: '湿版', text: 'wet plate photographic texture, antique contrast, handmade imperfections', zhText: '湿版摄影质感，古董反差，手工瑕疵' },
      { id: 'polaroid', label: '拍立得', text: 'Polaroid instant film texture, soft edges, nostalgic color shift', zhText: '拍立得即时胶片质感，边缘柔和，怀旧偏色' },
      { id: 'newsprint', label: '报纸颗粒', text: 'newsprint halftone texture, printed dot pattern, graphic editorial finish', zhText: '报纸半调质感，印刷网点，平面编辑质地' },
      { id: 'hand-painted', label: '手绘', text: 'hand-painted cinematic texture, visible brush softness, crafted illustration feel', zhText: '手绘电影质感，可见笔触柔度，手作插画感' },
      { id: 'oil-paint', label: '油画', text: 'oil painting surface texture, thick painterly depth, museum-like finish', zhText: '油画表面质感，厚重绘画纵深，博物馆级质地' },
      { id: 'cel-animation', label: '赛璐璐', text: 'cel animation texture, clean ink lines, flat painted color fields', zhText: '赛璐璐动画质感，墨线干净，平涂色块' },
      { id: 'clay', label: '黏土', text: 'claymation tactile texture, handmade miniature surface, soft physical imperfections', zhText: '黏土动画触感，手工微缩表面，柔和实体瑕疵' },
      { id: 'velvet', label: '天鹅绒', text: 'velvet soft texture, deep plush shadows, luxurious tactile finish', zhText: '天鹅绒柔软质感，深绒阴影，奢华触感' },
      { id: 'metallic', label: '金属', text: 'metallic reflective texture, polished specular highlights, futuristic finish', zhText: '金属反射质感，抛光镜面高光，未来感表面' },
      { id: 'rain-glass', label: '雨玻璃', text: 'rain-streaked glass texture, refracted highlights, moody wet atmosphere', zhText: '雨痕玻璃质感，折射高光，潮湿情绪氛围' },
      { id: 'super-8', label: 'Super 8', text: 'Super 8 home movie texture, soft jitter, nostalgic amateur film warmth', zhText: 'Super 8 家庭电影质感，轻微抖动，怀旧业余胶片暖意' },
      { id: 'photochemical', label: '光化学', text: 'photochemical film finish, organic color response, rich analog depth', zhText: '光化学胶片完成感，有机色彩响应，丰富模拟深度' },
      { id: 'cinemascope', label: 'CinemaScope', text: 'CinemaScope widescreen finish, grand horizontal frame, classic theatrical scale', zhText: 'CinemaScope 宽银幕质感，宏大横向画框，经典影院尺度' },
      { id: 'technicolor', label: '特艺彩色', text: 'Technicolor-inspired finish, saturated vintage color, theatrical richness', zhText: '特艺彩色灵感质感，饱和复古色，剧场式丰富度' },
      { id: 'cross-process', label: '交叉冲洗', text: 'cross-processed film texture, shifted colors, edgy analog contrast', zhText: '交叉冲洗胶片质感，色彩偏移，锋利模拟反差' },
      { id: 'push-process', label: '增感冲洗', text: 'push-processed film grain, deeper contrast, low-light analog intensity', zhText: '增感冲洗胶片颗粒，更深反差，低光模拟强度' },
      { id: 'expired-film', label: '过期胶片', text: 'expired film texture, unpredictable color shifts, nostalgic imperfections', zhText: '过期胶片质感，不可预测偏色，怀旧瑕疵' },
      { id: 'contact-sheet', label: '接触印相', text: 'contact sheet texture, archival film edges, photographer’s selection mood', zhText: '接触印相质感，档案胶片边缘，摄影师选片氛围' },
      { id: 'glass-prism', label: '玻璃棱镜', text: 'glass prism texture, refracted light splits, dreamy optical distortion', zhText: '玻璃棱镜质感，折射光分离，梦幻光学变形' },
      { id: 'soft-grain', label: '柔颗粒', text: 'soft fine grain, gentle analog surface, clean cinematic tactility', zhText: '柔细颗粒，温和模拟表面，干净电影触感' },
      { id: 'coarse-grain', label: '粗颗粒', text: 'coarse film grain, gritty tactile surface, raw documentary finish', zhText: '粗胶片颗粒，粗粝触感表面，原始纪录片质地' },
      { id: 'low-fi-digital', label: '低保真', text: 'lo-fi digital texture, compressed edges, imperfect early-video character', zhText: '低保真数字质感，压缩边缘，早期视频不完美性格' },
      { id: 'high-speed', label: '高速摄影', text: 'high-speed photography finish, crisp frozen motion, premium slow-motion clarity', zhText: '高速摄影质感，清晰冻结运动，高级慢动作清晰度' },
      { id: 'tilt-shift', label: '移轴', text: 'tilt-shift lens texture, miniature depth, selective plane of focus', zhText: '移轴镜头质感，微缩纵深，选择性焦平面' },
      { id: 'infrared', label: '红外', text: 'infrared photographic texture, pale foliage, surreal spectral contrast', zhText: '红外摄影质感，苍白植被，超现实光谱反差' },
      { id: 'xerox', label: '复印', text: 'xerox copy texture, harsh duplicated contrast, graphic paper artifacts', zhText: '复印质感，硬质复制反差，图形纸面痕迹' },
      { id: 'embossed', label: '浮雕', text: 'embossed surface texture, raised tactile edges, sculptural graphic finish', zhText: '浮雕表面质感，凸起触感边缘，雕塑化图形完成感' },
      { id: 'paper-fiber', label: '纸纤维', text: 'paper fiber texture, matte absorbent surface, tactile printed softness', zhText: '纸纤维质感，哑光吸墨表面，有触感的印刷柔度' },
      { id: 'cracked-paint', label: '裂纹漆', text: 'cracked paint texture, aged surface detail, weathered cinematic patina', zhText: '裂纹漆质感，老化表面细节，风化电影包浆' },
      { id: 'frosted-glass', label: '磨砂玻璃', text: 'frosted glass texture, diffused detail, translucent soft separation', zhText: '磨砂玻璃质感，细节扩散，半透明柔和分离' },
    ],
  },
];

const STRENGTH_PRESETS: Preset[] = [
  { id: 'subtle', label: '轻微', text: 'subtle cinematic enhancement, keep the original subject and realism', zhText: '轻微电影化增强，保留原主体和真实感' },
  { id: 'balanced', label: '标准', text: 'balanced cinematic look, polished but natural', zhText: '标准电影化质感，精致但自然' },
  { id: 'strong', label: '强烈', text: 'strong cinematic stylization, bold atmosphere and dramatic visual identity', zhText: '强烈电影风格化，氛围鲜明，视觉识别度高' },
];

const MOTION_SCENE_PRESETS: Preset[] = [
  { id: 'character-entry', label: '角色登场', text: 'cinematic character entrance, reveal the subject with confident movement', zhText: '角色登场镜头，用有气势的运动逐步揭示主体' },
  { id: 'product-showcase', label: '产品展示', text: 'premium product showcase movement, clean controlled camera path', zhText: '高级产品展示运镜，路径干净可控' },
  { id: 'emotion-push', label: '情绪推近', text: 'emotional push-in, gradually intensify the character feeling', zhText: '情绪推近，逐步强化人物情绪' },
  { id: 'orbit-reveal', label: '环绕展示', text: 'hero orbit reveal, show the subject from a dynamic surrounding angle', zhText: '主角式环绕展示，从动态角度呈现主体' },
  { id: 'world-reveal', label: '环境揭示', text: 'environment reveal shot, start intimate then open into the wider scene', zhText: '环境揭示镜头，从局部逐渐打开到更大场景' },
  { id: 'impact-action', label: '战斗冲击', text: 'impactful action camera move, energetic but readable motion', zhText: '战斗冲击运镜，有能量但画面可读' },
  { id: 'dream-drift', label: '梦幻漂移', text: 'dreamlike drifting camera, floating graceful movement', zhText: '梦幻漂移镜头，漂浮而优雅的运动' },
  { id: 'architecture-tour', label: '建筑巡游', text: 'architectural tour movement, glide through space with clear depth', zhText: '建筑巡游运镜，平滑穿行并展示空间层次' },
  { id: 'food-detail', label: '美食细节', text: 'food detail camera move, macro glide with appetizing focus', zhText: '美食细节运镜，微距滑动并突出诱人焦点' },
  { id: 'travel-drone', label: '旅行航拍', text: 'travel drone reveal, cinematic aerial movement over the scene', zhText: '旅行航拍揭示镜头，从空中电影化展示场景' },
  { id: 'dialogue-follow', label: '对话跟随', text: 'dialogue follow camera, natural human movement and stable framing', zhText: '对话跟随镜头，自然移动并保持构图稳定' },
  { id: 'transition-whip', label: '转场甩镜', text: 'whip pan transition energy, fast directional motion for a scene change', zhText: '甩镜转场能量，用快速方向运动衔接场景' },
  { id: 'fashion-walk', label: '时尚走秀', text: 'fashion runway camera move, elegant pacing and confident subject reveal', zhText: '时尚走秀运镜，节奏优雅并自信揭示主体' },
  { id: 'music-video', label: 'MV 镜头', text: 'music video camera movement, stylish rhythm and expressive visual energy', zhText: '音乐 MV 运镜，节奏风格化，视觉能量强' },
  { id: 'romantic-meet', label: '浪漫相遇', text: 'romantic meeting camera move, soft reveal and gentle emotional distance', zhText: '浪漫相遇运镜，柔和揭示并保持温柔情绪距离' },
  { id: 'suspense-search', label: '悬疑搜寻', text: 'suspense search movement, cautious camera exploration with hidden tension', zhText: '悬疑搜寻运镜，谨慎探索并保留隐藏张力' },
  { id: 'horror-creep', label: '惊悚逼近', text: 'horror creeping camera move, slow uneasy approach with growing dread', zhText: '惊悚逼近运镜，缓慢不安地接近并增强恐惧' },
  { id: 'sci-fi-launch', label: '科幻启动', text: 'sci-fi launch sequence movement, precise futuristic reveal and scale', zhText: '科幻启动序列运镜，精准未来感揭示与尺度' },
  { id: 'fantasy-magic', label: '魔法降临', text: 'fantasy magic reveal, graceful camera motion around a supernatural moment', zhText: '魔法降临揭示，围绕超自然瞬间优雅运动' },
  { id: 'vehicle-chase', label: '车辆追逐', text: 'vehicle chase camera movement, fast readable motion with kinetic tension', zhText: '车辆追逐运镜，快速但可读，动势紧张' },
  { id: 'sports-highlight', label: '运动高光', text: 'sports highlight camera move, emphasize impact, speed, and heroic action', zhText: '运动高光运镜，强调冲击、速度和英雄感动作' },
  { id: 'dance-performance', label: '舞蹈表演', text: 'dance performance camera movement, follow choreography with smooth rhythm', zhText: '舞蹈表演运镜，顺着编舞平滑跟随节奏' },
  { id: 'pet-moment', label: '宠物瞬间', text: 'pet moment camera move, playful gentle framing with clear expression', zhText: '宠物瞬间运镜，轻松可爱并保持表情清晰' },
  { id: 'nature-macro', label: '自然微距', text: 'nature macro camera move, slow delicate glide across tiny textures', zhText: '自然微距运镜，缓慢细腻滑过微小纹理' },
  { id: 'city-night', label: '城市夜行', text: 'city night camera move, glide through neon streets with atmospheric depth', zhText: '城市夜行运镜，穿过霓虹街道并保留氛围深度' },
  { id: 'rain-street', label: '雨街漫步', text: 'rainy street walk movement, reflective surfaces and gentle emotional drift', zhText: '雨街漫步运镜，突出反光地面和轻柔情绪漂移' },
  { id: 'battle-standoff', label: '对峙开场', text: 'battle standoff opening move, frame opposing forces with dramatic pressure', zhText: '对峙开场运镜，用戏剧压力呈现双方力量' },
  { id: 'costume-reveal', label: '服装展示', text: 'costume reveal camera move, show silhouette, fabric, and styling details', zhText: '服装展示运镜，呈现轮廓、面料和造型细节' },
  { id: 'makeup-beauty', label: '美妆特写', text: 'beauty close-up movement, gentle macro motion for skin and makeup detail', zhText: '美妆特写运镜，以柔和微距呈现皮肤和妆面细节' },
  { id: 'room-tour', label: '室内巡游', text: 'interior room tour movement, reveal layout, light, and atmosphere smoothly', zhText: '室内巡游运镜，平滑揭示布局、光线和氛围' },
  { id: 'workspace-process', label: '工作流程', text: 'creative workflow camera move, follow hands, tools, and process clearly', zhText: '创作流程运镜，清楚跟随双手、工具和步骤' },
  { id: 'tutorial-demo', label: '教程演示', text: 'tutorial demonstration camera move, stable framing for clear step-by-step action', zhText: '教程演示运镜，稳定构图呈现清晰步骤' },
  { id: 'before-after', label: '前后对比', text: 'before and after reveal movement, compare transformation with clean continuity', zhText: '前后对比揭示运镜，用干净连续性展示变化' },
  { id: 'social-vlog', label: '生活 Vlog', text: 'casual vlog movement, friendly handheld energy with readable framing', zhText: '生活 Vlog 运镜，亲切手持感并保持构图可读' },
  { id: 'festival-crowd', label: '节庆人群', text: 'festival crowd movement, move through celebration with layered atmosphere', zhText: '节庆人群运镜，穿过庆典并呈现层次氛围' },
  { id: 'concert-stage', label: '演唱舞台', text: 'concert stage camera move, dynamic performance reveal with light and crowd energy', zhText: '演唱舞台运镜，动态揭示表演、灯光和人群能量' },
  { id: 'museum-piece', label: '展品巡览', text: 'museum object tour, slow respectful camera move around the exhibit', zhText: '展品巡览运镜，缓慢克制地围绕展品展示' },
  { id: 'game-trailer', label: '游戏预告', text: 'game trailer camera move, bold heroic framing and energetic reveal', zhText: '游戏预告运镜，大胆英雄构图和高能揭示' },
  { id: 'anime-opening', label: '动漫开场', text: 'anime opening style camera move, iconic pose reveal with rhythmic motion', zhText: '动漫开场式运镜，用有节奏运动揭示标志姿态' },
  { id: 'comic-panel', label: '漫画分镜', text: 'comic panel inspired camera move, graphic framing and staged reveal', zhText: '漫画分镜灵感运镜，图形化构图和舞台式揭示' },
  { id: 'luxury-ad', label: '奢侈广告', text: 'luxury advertisement movement, polished controlled reveal with premium restraint', zhText: '奢侈广告运镜，精致可控并保持高级克制' },
  { id: 'documentary-observe', label: '纪录观察', text: 'documentary observation movement, natural camera presence without overdirecting', zhText: '纪录观察运镜，自然在场不过度导演' },
  { id: 'mystery-reveal', label: '神秘揭示', text: 'mystery reveal movement, hide and disclose key details with tension', zhText: '神秘揭示运镜，带张力地隐藏并展示关键细节' },
  { id: 'ocean-voyage', label: '海上航行', text: 'ocean voyage camera movement, wide drifting motion with wind and scale', zhText: '海上航行运镜，宽阔漂移并表现风和尺度' },
  { id: 'forest-explore', label: '森林探索', text: 'forest exploration movement, weave through natural layers with depth', zhText: '森林探索运镜，穿过自然层次并表现纵深' },
  { id: 'desert-crossing', label: '沙漠穿越', text: 'desert crossing camera move, slow expansive travel through heat and distance', zhText: '沙漠穿越运镜，缓慢开阔地穿过热浪和距离感' },
  { id: 'space-approach', label: '太空靠近', text: 'space approach movement, quiet grand motion toward a cosmic subject', zhText: '太空靠近运镜，安静宏大地靠近宇宙主体' },
  { id: 'classroom-scene', label: '教室场景', text: 'classroom scene movement, natural reveal of people, desks, and atmosphere', zhText: '教室场景运镜，自然揭示人物、桌面和氛围' },
  { id: 'cafe-moment', label: '咖啡馆日常', text: 'cafe slice-of-life camera move, warm intimate motion around daily details', zhText: '咖啡馆日常运镜，温暖亲密地围绕生活细节移动' },
  { id: 'transformation', label: '变身展示', text: 'transformation reveal movement, build from ordinary detail into dramatic final form', zhText: '变身展示运镜，从普通细节推进到戏剧最终形态' },
];

const MOTION_ACTION_PRESETS: Preset[] = [
  { id: 'static', label: '静止', text: 'static locked-off shot, no camera movement', zhText: '固定机位，无镜头运动' },
  { id: 'zoom-in', label: '推近', text: 'slow dolly in toward the subject', zhText: '镜头缓慢向主体推进' },
  { id: 'zoom-out', label: '拉远', text: 'slow dolly out, revealing more of the scene', zhText: '镜头缓慢拉远，展示更多场景' },
  { id: 'pan-l', label: '左摇', text: 'smooth pan to the left', zhText: '镜头平滑向左摇动' },
  { id: 'pan-r', label: '右摇', text: 'smooth pan to the right', zhText: '镜头平滑向右摇动' },
  { id: 'tilt-up', label: '上摇', text: 'smooth tilt up, revealing height and scale', zhText: '镜头平滑上摇，揭示高度和尺度' },
  { id: 'tilt-down', label: '下摇', text: 'smooth tilt down, revealing the subject from above', zhText: '镜头平滑下摇，从上方揭示主体' },
  { id: 'orbit', label: '环绕', text: 'orbit around the subject with a clear circular camera move', zhText: '围绕主体环绕，运动轨迹清晰' },
  { id: 'tracking', label: '跟拍', text: 'tracking shot following the subject movement', zhText: '跟拍主体移动，保持连续跟随' },
  { id: 'dolly', label: '滑轨', text: 'smooth dolly track through the scene', zhText: '滑轨式平滑穿过场景' },
  { id: 'pedestal', label: '升降', text: 'vertical pedestal camera move, rising or descending smoothly', zhText: '垂直升降运镜，平滑上升或下降' },
  { id: 'aerial', label: '航拍', text: 'aerial drone camera movement with cinematic scale', zhText: '航拍镜头，带有电影化空间尺度' },
  { id: 'handheld', label: '手持', text: 'subtle handheld camera motion, alive but controlled', zhText: '轻微手持镜头，有生命感但可控' },
  { id: 'whip', label: '甩镜', text: 'fast whip pan motion with directional blur', zhText: '快速甩镜，带方向性运动模糊' },
  { id: 'crash-zoom', label: '急推', text: 'dramatic crash zoom, sudden emphasis on the subject', zhText: '戏剧化急推，突然强调主体' },
  { id: 'push-pull', label: '推拉', text: 'push-pull camera move, dolly and zoom tension around the subject', zhText: '推拉运镜，在主体周围形成滑轨与变焦张力' },
  { id: 'parallax', label: '视差', text: 'parallax camera move, foreground and background shift with depth', zhText: '视差运镜，让前景和背景产生纵深位移' },
  { id: 'roll-left', label: '左滚转', text: 'controlled camera roll to the left for stylized tension', zhText: '镜头向左可控滚转，增加风格化张力' },
  { id: 'roll-right', label: '右滚转', text: 'controlled camera roll to the right for stylized tension', zhText: '镜头向右可控滚转，增加风格化张力' },
  { id: 'dutch-tilt', label: '荷兰倾斜', text: 'dutch angle camera move, tilted horizon with uneasy drama', zhText: '荷兰倾斜运镜，倾斜地平线带来不安戏剧感' },
  { id: 'boomerang', label: '回弹', text: 'boomerang camera move, move in then rebound out with playful rhythm', zhText: '回弹运镜，推进后回拉，带有轻快节奏' },
  { id: 'snap-zoom', label: '瞬变焦', text: 'snap zoom movement, instant focal jump for comedic or dramatic emphasis', zhText: '瞬间变焦，用焦段跳变制造喜剧或戏剧强调' },
  { id: 'reveal-pan', label: '揭示摇镜', text: 'reveal pan, sweep across the frame to uncover the subject', zhText: '揭示摇镜，横扫画面露出主体' },
  { id: 'crane-down', label: '摇臂下降', text: 'crane down camera move, descend elegantly into the scene', zhText: '摇臂下降运镜，优雅下降进入场景' },
  { id: 'crane-up', label: '摇臂上升', text: 'crane up camera move, rise elegantly from the subject to the world', zhText: '摇臂上升运镜，从主体优雅上升到环境' },
  { id: 'arc-left', label: '左弧绕', text: 'left arc camera move around the subject', zhText: '围绕主体向左弧线移动' },
  { id: 'arc-right', label: '右弧绕', text: 'right arc camera move around the subject', zhText: '围绕主体向右弧线移动' },
  { id: 'spiral-in', label: '螺旋推进', text: 'spiral inward camera move, circular approach toward the subject', zhText: '向内螺旋推进，环绕靠近主体' },
  { id: 'spiral-out', label: '螺旋拉远', text: 'spiral outward camera move, circular pull away from the subject', zhText: '向外螺旋拉远，环绕离开主体' },
  { id: 'elevator-rise', label: '垂直上升', text: 'vertical rising camera move, lift straight upward with clean framing', zhText: '垂直上升运镜，直线上升并保持构图干净' },
  { id: 'elevator-drop', label: '垂直下降', text: 'vertical descending camera move, drop straight down with controlled framing', zhText: '垂直下降运镜，直线下降并保持构图可控' },
  { id: 'shoulder-follow', label: '肩后跟随', text: 'over-the-shoulder follow movement, stay close behind the subject', zhText: '肩后跟随运镜，贴近主体背后移动' },
  { id: 'pov-move', label: '主观移动', text: 'point-of-view camera movement, immersive first-person motion', zhText: '主观视角移动，沉浸式第一人称运镜' },
  { id: 'chase-cam', label: '追逐镜头', text: 'chase camera movement, follow fast action with kinetic urgency', zhText: '追逐镜头，跟随快速动作并带紧迫动势' },
  { id: 'leading-shot', label: '迎面跟拍', text: 'leading camera shot, move backward while facing the subject', zhText: '迎面跟拍，镜头后退并面对主体' },
  { id: 'side-track', label: '侧向跟拍', text: 'side tracking shot, move alongside the subject at matching speed', zhText: '侧向跟拍，与主体并行同速移动' },
  { id: 'top-down-drop', label: '俯冲下降', text: 'top-down drop camera move, dive from above toward the subject', zhText: '俯冲下降运镜，从上方向主体俯冲' },
  { id: 'ground-rise', label: '贴地升起', text: 'ground-level rise, start low then lift into the subject', zhText: '贴地升起，从低位抬升到主体' },
  { id: 'macro-glide', label: '微距滑动', text: 'macro glide camera move, slow close movement over tiny details', zhText: '微距滑动运镜，缓慢贴近细节移动' },
  { id: 'whip-zoom', label: '甩镜变焦', text: 'whip zoom camera move, fast direction change with focal punch', zhText: '甩镜变焦，快速方向变化并加强焦点冲击' },
  { id: 'speed-ramp', label: '变速推进', text: 'speed-ramped camera move, shift between slow and fast motion', zhText: '变速推进，在慢速和快速之间切换' },
  { id: 'handheld-breath', label: '呼吸手持', text: 'breathing handheld camera motion, subtle human micro-movement', zhText: '呼吸感手持运镜，保留细微人体运动' },
  { id: 'float-drift', label: '漂浮移动', text: 'floating drift camera move, weightless and soft motion', zhText: '漂浮移动运镜，轻盈失重且柔和' },
  { id: 'reveal-tilt', label: '倾斜揭示', text: 'tilting reveal move, rotate or tilt into the key subject', zhText: '倾斜揭示运镜，旋转或倾斜进入关键主体' },
  { id: 'push-through', label: '穿越推进', text: 'push through the scene, pass through foreground layers toward the subject', zhText: '穿越推进，穿过前景层次靠近主体' },
  { id: 'pass-by', label: '掠过', text: 'pass-by camera move, sweep near the subject and continue beyond', zhText: '掠过运镜，贴近主体后继续越过' },
  { id: 'reverse-dolly', label: '反向滑轨', text: 'reverse dolly movement, pull the camera opposite the subject motion', zhText: '反向滑轨，镜头与主体运动方向相反' },
  { id: 'bullet-time', label: '子弹时间', text: 'bullet-time inspired move, frozen action with circular camera energy', zhText: '子弹时间灵感运镜，冻结动作并形成环绕能量' },
  { id: 'orbit-zoom', label: '环绕变焦', text: 'orbit with zoom, circle the subject while changing focal distance', zhText: '环绕变焦，围绕主体同时改变焦距距离' },
  { id: 'shake-impact', label: '冲击震动', text: 'impact shake camera move, brief controlled vibration for force', zhText: '冲击震动运镜，用短促可控震动表现力量' },
];

const MOTION_GROUPS: MotionGroup[] = [
  {
    id: 'motionPathId',
    label: '路径',
    icon: <Wand2 size={12} />,
    columns: 3,
    items: [
      { id: 'forward', label: '向前推进', text: 'move forward through the space', zhText: '穿过空间向前推进' },
      { id: 'backward', label: '向后拉开', text: 'pull backward to reveal the wider scene', zhText: '向后拉开，揭示更大场景' },
      { id: 'left-to-right', label: '左到右', text: 'travel from left to right across the frame', zhText: '从画面左侧移动到右侧' },
      { id: 'right-to-left', label: '右到左', text: 'travel from right to left across the frame', zhText: '从画面右侧移动到左侧' },
      { id: 'rise', label: '低处上升', text: 'rise from a low position into a broader view', zhText: '从低处上升到更开阔视角' },
      { id: 'descend', label: '高处下降', text: 'descend from above toward the subject', zhText: '从高处向主体下降' },
      { id: 'clockwise', label: '顺时针', text: 'circle clockwise around the subject', zhText: '顺时针围绕主体运动' },
      { id: 'counter-clockwise', label: '逆时针', text: 'circle counter-clockwise around the subject', zhText: '逆时针围绕主体运动' },
      { id: 'from-cover', label: '遮挡露出', text: 'reveal the subject from behind a foreground obstruction', zhText: '从前景遮挡后露出主体' },
      { id: 'detail-to-wide', label: '细节到全景', text: 'begin on a close detail and open into a wide view', zhText: '从近处细节打开到全景' },
      { id: 'wide-to-detail', label: '全景到细节', text: 'begin wide and move into a specific detail', zhText: '从全景推进到具体细节' },
      { id: 'through-space', label: '穿越空间', text: 'move through layers of the environment with depth', zhText: '穿过环境层次，表现空间深度' },
      { id: 'parallel-follow', label: '平行跟随', text: 'move parallel with the subject at matching speed', zhText: '与主体平行移动并保持速度一致' },
      { id: 'diagonal', label: '斜向推进', text: 'move diagonally toward the subject for dynamic depth', zhText: '斜向推进主体，增加动态纵深' },
      { id: 'arc', label: '弧线移动', text: 'move along a gentle arc path', zhText: '沿柔和弧线路径移动' },
      { id: 's-curve', label: 'S 形路径', text: 'move along an S-curve path for graceful spatial flow', zhText: '沿 S 形路径移动，形成优雅空间流动' },
      { id: 'zigzag', label: '折线路径', text: 'move through a controlled zigzag path with intentional shifts', zhText: '沿可控折线路径移动，带有明确方向变化' },
      { id: 'spiral-in-path', label: '螺旋入', text: 'spiral inward toward the subject', zhText: '向主体螺旋靠近' },
      { id: 'spiral-out-path', label: '螺旋出', text: 'spiral outward away from the subject', zhText: '从主体向外螺旋离开' },
      { id: 'overhead-drop', label: '俯冲落下', text: 'drop from overhead toward the scene', zhText: '从高空俯冲落向场景' },
      { id: 'ground-skimming', label: '贴地掠过', text: 'skim close to the ground before rising into the subject', zhText: '贴近地面掠过后抬升到主体' },
      { id: 'doorway-pass', label: '穿门进入', text: 'pass through a doorway or opening into the scene', zhText: '穿过门洞或开口进入场景' },
      { id: 'window-reveal', label: '窗口揭示', text: 'reveal the subject through a window or framed opening', zhText: '通过窗口或框景揭示主体' },
      { id: 'foreground-wipe', label: '前景擦过', text: 'let foreground elements wipe across the frame during movement', zhText: '移动时让前景元素擦过画面' },
      { id: 'tunnel-through', label: '隧道穿行', text: 'travel through a tunnel-like space with strong depth', zhText: '穿过隧道式空间，形成强纵深' },
      { id: 'stairs-up', label: '随阶上升', text: 'move upward along stairs or stepped layers', zhText: '沿楼梯或层级向上移动' },
      { id: 'stairs-down', label: '随阶下降', text: 'move downward along stairs or stepped layers', zhText: '沿楼梯或层级向下移动' },
      { id: 'figure-eight', label: '8 字路径', text: 'move in a figure-eight path around the subject area', zhText: '围绕主体区域做 8 字路径移动' },
      { id: 'tight-orbit', label: '紧环绕', text: 'circle tightly around the subject', zhText: '贴近主体做紧密环绕' },
      { id: 'wide-orbit', label: '大环绕', text: 'circle widely around the subject to reveal the environment', zhText: '大范围环绕主体并揭示环境' },
      { id: 'push-past', label: '越过主体', text: 'push past the subject and continue into the background', zhText: '推进越过主体并继续进入背景' },
      { id: 'lead-in', label: '迎面靠近', text: 'approach the subject from the front', zhText: '从正面迎向主体靠近' },
      { id: 'lead-out', label: '背向远离', text: 'move away while the subject faces the camera direction', zhText: '主体面向镜头方向时镜头向后远离' },
      { id: 'vertical-arc', label: '垂直弧线', text: 'move along a vertical arc path', zhText: '沿垂直弧线路径移动' },
      { id: 'horizontal-arc', label: '水平弧线', text: 'move along a horizontal arc path', zhText: '沿水平弧线路径移动' },
      { id: 'crane-sweep', label: '摇臂扫过', text: 'sweep across the scene with a crane-like path', zhText: '以摇臂式路径扫过场景' },
      { id: 'from-dark', label: '暗处显现', text: 'move from darkness or shadow into the revealed subject', zhText: '从暗处或阴影中移动并揭示主体' },
      { id: 'cross-screen', label: '横穿画面', text: 'cross the full frame from one side to the other', zhText: '从一侧完整横穿到另一侧' },
      { id: 'diagonal-retreat', label: '斜向后撤', text: 'retreat diagonally away from the subject', zhText: '从主体斜向后撤' },
      { id: 'rising-orbit', label: '上升环绕', text: 'orbit while rising upward', zhText: '环绕主体同时上升' },
      { id: 'descending-orbit', label: '下降环绕', text: 'orbit while descending downward', zhText: '环绕主体同时下降' },
      { id: 'inward-spiral', label: '向心螺旋', text: 'move in a tightening spiral toward the center', zhText: '沿收紧螺旋向中心移动' },
      { id: 'outward-spiral', label: '离心螺旋', text: 'move in an expanding spiral away from the center', zhText: '沿扩张螺旋离开中心' },
      { id: 'follow-behind', label: '身后跟随', text: 'follow from behind the subject', zhText: '从主体身后跟随' },
      { id: 'lead-ahead', label: '前方引导', text: 'move ahead of the subject while guiding the viewer forward', zhText: '位于主体前方，引导观众向前' },
      { id: 'crowd-through', label: '穿过人群', text: 'move through a crowd while preserving the main subject', zhText: '穿过人群并保持主主体可见' },
      { id: 'shelf-slide', label: '货架滑行', text: 'slide along shelves or rows with strong layered depth', zhText: '沿货架或行列滑行，形成层次纵深' },
      { id: 'tabletop', label: '桌面路径', text: 'travel across a tabletop or flat surface', zhText: '沿桌面或平面表面移动' },
      { id: 'skyline-sweep', label: '天际扫过', text: 'sweep across the skyline or distant horizon', zhText: '扫过天际线或远处地平线' },
      { id: 'reflection-reveal', label: '反射揭示', text: 'reveal the subject through mirror, water, or glass reflection', zhText: '通过镜面、水面或玻璃反射揭示主体' },
    ],
  },
  {
    id: 'motionTempoId',
    label: '节奏',
    icon: <Sparkles size={12} />,
    columns: 3,
    items: [
      { id: 'very-slow', label: '极慢', text: 'very slow movement, calm and deliberate', zhText: '极慢运动，安静而克制' },
      { id: 'slow', label: '慢速', text: 'slow cinematic movement', zhText: '慢速电影化运动' },
      { id: 'standard', label: '标准', text: 'natural medium-speed camera movement', zhText: '自然中速运镜' },
      { id: 'fast', label: '快速', text: 'fast energetic camera movement while keeping the subject readable', zhText: '快速有能量的运镜，同时保持主体可读' },
      { id: 'accelerate', label: '加速', text: 'gradually accelerate the camera movement', zhText: '镜头运动逐渐加速' },
      { id: 'decelerate', label: '减速', text: 'gradually slow down into the final frame', zhText: '逐渐减速并落到最终画面' },
      { id: 'ease', label: '缓入缓出', text: 'smooth ease-in and ease-out motion', zhText: '平滑缓入缓出运动' },
      { id: 'sudden-stop', label: '突然停顿', text: 'end with a controlled sudden stop for emphasis', zhText: '以可控的突然停顿强化重点' },
      { id: 'oner', label: '一镜到底', text: 'single continuous take, no cuts', zhText: '一镜到底，不切镜头' },
      { id: 'breathing', label: '呼吸感', text: 'breathing tempo, tiny natural rises and falls', zhText: '呼吸感节奏，带自然细微起伏' },
      { id: 'gentle-pulse', label: '轻脉冲', text: 'gentle pulsing tempo, soft repeated emphasis', zhText: '轻微脉冲节奏，柔和重复强调' },
      { id: 'rhythmic', label: '有节奏', text: 'rhythmic camera movement with clear beat structure', zhText: '有明确拍点结构的节奏运镜' },
      { id: 'music-synced', label: '贴音乐', text: 'music-synced movement, match motion to the soundtrack rhythm', zhText: '贴合音乐节奏，让运动跟随配乐拍点' },
      { id: 'beat-cut', label: '卡点感', text: 'beat-driven motion, accents land on visual beats', zhText: '卡点式运动，重点落在视觉拍点上' },
      { id: 'slow-build', label: '慢铺垫', text: 'slow build tempo, gradually increase emotional pressure', zhText: '慢铺垫节奏，逐步增强情绪压力' },
      { id: 'quick-burst', label: '短爆发', text: 'short burst of fast movement, then return to control', zhText: '短暂快速爆发后回到可控状态' },
      { id: 'whip-fast', label: '甩动快', text: 'very fast whip-like tempo with brief motion blur', zhText: '非常快的甩动节奏，带短暂运动模糊' },
      { id: 'smooth-continuous', label: '连续顺滑', text: 'smooth continuous tempo without visible stops', zhText: '连续顺滑节奏，无明显停顿' },
      { id: 'floating', label: '漂浮慢', text: 'floating slow tempo, weightless and soft', zhText: '漂浮慢节奏，轻盈失重且柔和' },
      { id: 'staccato', label: '断奏', text: 'staccato movement, crisp separated motion beats', zhText: '断奏式节奏，运动拍点清晰分离' },
      { id: 'elastic', label: '弹性', text: 'elastic tempo, stretch and rebound through the move', zhText: '弹性节奏，运动中拉伸并回弹' },
      { id: 'suspense-hold', label: '悬念停留', text: 'suspenseful hold, delay the reveal with patient tension', zhText: '悬念停留，用耐心张力延迟揭示' },
      { id: 'hold-then-move', label: '先停后动', text: 'hold still first, then begin the camera move', zhText: '先保持静止，再开始运镜' },
      { id: 'move-then-hold', label: '先动后停', text: 'move first, then settle into a held final frame', zhText: '先移动，再稳定停在最终画面' },
      { id: 'micro-motion', label: '微运动', text: 'micro movement tempo, barely perceptible camera drift', zhText: '微运动节奏，几乎不可察觉的镜头漂移' },
      { id: 'creeping', label: '缓慢逼近', text: 'creeping tempo, slow tense approach', zhText: '缓慢逼近节奏，带紧张感地靠近' },
      { id: 'gliding', label: '滑行', text: 'gliding tempo, smooth travel with no harsh acceleration', zhText: '滑行节奏，平滑移动且无突兀加速' },
      { id: 'urgent', label: '紧迫', text: 'urgent tempo, fast motivated movement with pressure', zhText: '紧迫节奏，快速且有压力的动机运动' },
      { id: 'heroic', label: '英雄节奏', text: 'heroic tempo, confident build into a strong reveal', zhText: '英雄节奏，自信铺垫到强揭示' },
      { id: 'dreamy', label: '梦境节奏', text: 'dreamy tempo, delayed soft movement with surreal calm', zhText: '梦境节奏，延迟柔软并带超现实宁静' },
      { id: 'playful', label: '俏皮', text: 'playful tempo, light bouncy camera timing', zhText: '俏皮节奏，轻快弹跳的镜头时机' },
      { id: 'mechanical', label: '机械', text: 'mechanical tempo, precise repeated motion with machine-like timing', zhText: '机械节奏，精准重复如机器般计时' },
      { id: 'heartbeat', label: '心跳', text: 'heartbeat tempo, subtle pulse matching emotional tension', zhText: '心跳节奏，轻微脉冲贴合情绪张力' },
      { id: 'ramp-up-down', label: '快慢起伏', text: 'ramp up then down, vary speed within one camera move', zhText: '先加速再减速，在单次运镜中变化速度' },
      { id: 'looped', label: '循环感', text: 'loopable tempo, movement can repeat seamlessly', zhText: '循环感节奏，运动可无缝重复' },
      { id: 'boomerang-tempo', label: '回弹节奏', text: 'boomerang tempo, move out and return with matching rhythm', zhText: '回弹节奏，离开后以相同节奏返回' },
      { id: 'pause-beat', label: '停顿拍', text: 'insert a clear pause beat before the next motion', zhText: '在下一段运动前插入清晰停顿拍' },
      { id: 'reveal-beat', label: '揭示拍', text: 'time the main reveal to a strong visual beat', zhText: '将主揭示落在强视觉拍点上' },
      { id: 'tension-rise', label: '张力递增', text: 'steadily rising tension through controlled pacing', zhText: '通过可控节奏持续提升张力' },
      { id: 'calm-settle', label: '平静落定', text: 'calm settling tempo, gently arrive at the final frame', zhText: '平静落定节奏，温柔到达最终画面' },
      { id: 'action-surge', label: '动作涌动', text: 'surging action tempo, sudden forward energy with readability', zhText: '动作涌动节奏，突然向前但保持可读' },
      { id: 'slow-motion', label: '慢动作感', text: 'slow-motion feeling, stretched time and smooth dramatic emphasis', zhText: '慢动作感，拉伸时间并平滑强化戏剧重点' },
      { id: 'time-lapse', label: '延时感', text: 'time-lapse feeling, compress time while keeping the camera path clear', zhText: '延时感，压缩时间并保持路径清晰' },
      { id: 'freeze-to-move', label: '定格启动', text: 'start from a frozen moment, then ease into motion', zhText: '从定格瞬间开始，再缓慢进入运动' },
      { id: 'drift-stop', label: '漂移停住', text: 'drift gently, then stop cleanly on the subject', zhText: '轻轻漂移，然后干净停在主体上' },
      { id: 'pulse-zoom', label: '脉冲变焦', text: 'pulsing zoom tempo, small repeated focal emphasis', zhText: '脉冲变焦节奏，重复小幅焦点强调' },
      { id: 'silky', label: '丝滑', text: 'silky tempo, ultra-smooth motion with soft acceleration', zhText: '丝滑节奏，超平滑运动和柔和加速度' },
      { id: 'rough-energy', label: '粗粝能量', text: 'rough energetic tempo, raw movement with intentional force', zhText: '粗粝能量节奏，原始运动带明确力量' },
      { id: 'precise', label: '精准', text: 'precise tempo, exact timing and clean motion control', zhText: '精准节奏，时间点准确且运动控制干净' },
      { id: 'controlled-chaos', label: '可控混乱', text: 'controlled chaotic tempo, intense movement that remains readable', zhText: '可控混乱节奏，强烈运动但保持可读' },
    ],
  },
  {
    id: 'motionStabilityId',
    label: '稳定',
    icon: <Aperture size={12} />,
    columns: 3,
    items: [
      { id: 'stabilizer', label: '稳定器', text: 'smooth gimbal-stabilized camera movement', zhText: '稳定器般平滑运镜' },
      { id: 'subtle-handheld', label: '轻手持', text: 'subtle handheld motion, organic and controlled', zhText: '轻微手持感，自然且可控' },
      { id: 'strong-handheld', label: '强手持', text: 'energetic handheld motion with intentional shake', zhText: '强手持运动，有意图的抖动感' },
      { id: 'drone', label: '无人机', text: 'drone-like stabilized aerial motion', zhText: '无人机般稳定的空中运动' },
      { id: 'slider', label: '滑轨', text: 'clean slider movement with precise linear motion', zhText: '干净滑轨运动，线性精准' },
      { id: 'crane', label: '摇臂', text: 'crane-style camera move with elegant vertical sweep', zhText: '摇臂式运镜，优雅纵向扫动' },
      { id: 'telephoto', label: '长焦压缩', text: 'telephoto compression, smooth background separation', zhText: '长焦压缩空间，背景分离平滑' },
      { id: 'wide-angle', label: '广角空间', text: 'wide-angle spatial movement, strong depth and scale', zhText: '广角空间运镜，纵深和尺度强' },
      { id: 'no-shake', label: '无抖动', text: 'no unwanted shake, no jitter, keep motion clean', zhText: '无多余抖动，无跳动，保持运动干净' },
      { id: 'studio-tripod', label: '三脚架', text: 'studio tripod stability, completely locked and composed', zhText: '棚拍三脚架稳定，完全锁定且构图严谨' },
      { id: 'monopod', label: '独脚架', text: 'monopod stability, lightly mobile with vertical steadiness', zhText: '独脚架稳定，轻便移动并保持垂直稳定' },
      { id: 'steadicam', label: '斯坦尼康', text: 'Steadicam-style stability, floating human movement with smooth balance', zhText: '斯坦尼康稳定，漂浮式人体移动且平衡顺滑' },
      { id: 'shoulder-rig', label: '肩扛', text: 'shoulder-rig stability, grounded handheld weight with controlled shake', zhText: '肩扛稳定，手持重量感明确且抖动可控' },
      { id: 'car-mount', label: '车载', text: 'car-mounted stability, smooth travel with road energy', zhText: '车载稳定，平滑移动并保留道路能量' },
      { id: 'bodycam', label: '随身相机', text: 'bodycam stability, immersive movement attached to the performer', zhText: '随身相机稳定，贴近表演者的沉浸运动' },
      { id: 'fpv-drone', label: 'FPV 无人机', text: 'FPV drone stability, fast agile flight with controlled banking', zhText: 'FPV 无人机稳定，快速灵活飞行并可控倾斜' },
      { id: 'cable-cam', label: '索道机位', text: 'cable-cam stability, suspended smooth travel across distance', zhText: '索道机位稳定，悬挂式平滑跨越距离' },
      { id: 'motion-control', label: '机械控轨', text: 'motion-control rig stability, repeatable precise camera path', zhText: '机械控轨稳定，可重复且路径精准' },
      { id: 'robotic-arm', label: '机械臂', text: 'robotic arm stability, precise curved motion with machine control', zhText: '机械臂稳定，机器控制下的精准曲线运动' },
      { id: 'dolly-track', label: '轨道车', text: 'dolly track stability, heavy smooth cinematic travel', zhText: '轨道车稳定，厚重顺滑的电影移动' },
      { id: 'doc-handheld', label: '纪录手持', text: 'documentary handheld stability, natural observational shake', zhText: '纪录手持稳定，自然观察式抖动' },
      { id: 'chaos-handheld', label: '混乱手持', text: 'chaotic handheld stability, intense shake but subject remains readable', zhText: '混乱手持稳定，抖动强烈但主体仍可读' },
      { id: 'underwater', label: '水下', text: 'underwater stability, slow buoyant motion and softened resistance', zhText: '水下稳定，缓慢浮力运动和柔和阻力' },
      { id: 'underwater-float', label: '水中漂浮', text: 'floating underwater stability, suspended calm movement', zhText: '水中漂浮稳定，悬浮而宁静的运动' },
      { id: 'floating-crane', label: '漂浮摇臂', text: 'floating crane stability, elegant elevated movement without harsh stops', zhText: '漂浮摇臂稳定，优雅高位移动且无硬停顿' },
      { id: 'drone-stable', label: '稳定航拍', text: 'highly stabilized drone motion, clean horizon and controlled flight', zhText: '高度稳定航拍，地平线干净且飞行可控' },
      { id: 'micro-jitter', label: '微抖动', text: 'tiny micro-jitter for realism, without distracting shake', zhText: '细小微抖增加真实感，但不干扰画面' },
      { id: 'impact-shake', label: '冲击抖动', text: 'intentional impact shake, brief forceful vibration only on key beats', zhText: '有意冲击抖动，只在关键拍点短促震动' },
      { id: 'vibration-free', label: '无震动', text: 'vibration-free movement, remove mechanical wobble and jitter', zhText: '无震动运动，去除机械晃动和跳动' },
      { id: 'no-rolling-shutter', label: '无果冻', text: 'avoid rolling-shutter wobble, keep vertical lines stable', zhText: '避免果冻效应，保持竖线稳定' },
      { id: 'low-rig', label: '低机位架', text: 'low-rig stability, steady movement close to the ground', zhText: '低机位架稳定，贴近地面的稳定移动' },
      { id: 'high-rig', label: '高机位架', text: 'high-rig stability, steady movement above the subject', zhText: '高机位架稳定，在主体上方稳定移动' },
      { id: 'macro-rail', label: '微距轨道', text: 'macro rail stability, precise tiny movement for close details', zhText: '微距轨道稳定，用精准小运动呈现近距离细节' },
      { id: 'turntable', label: '转台', text: 'turntable stability, subject rotates while framing stays clean', zhText: '转台稳定，主体旋转而构图保持干净' },
      { id: 'virtual-camera', label: '虚拟摄影机', text: 'virtual camera stability, clean impossible movement with no physical shake', zhText: '虚拟摄影机稳定，干净非现实路径且无物理抖动' },
      { id: 'game-camera', label: '游戏镜头', text: 'game camera stability, responsive but readable third-person motion', zhText: '游戏镜头稳定，响应灵敏但第三人称可读' },
      { id: 'security-cam', label: '监控镜头', text: 'security camera stability, fixed observational framing', zhText: '监控镜头稳定，固定观察式构图' },
      { id: 'news-camera', label: '新闻镜头', text: 'news camera stability, practical live-broadcast steadiness', zhText: '新闻镜头稳定，实用直播式稳定感' },
      { id: 'cinema-rig', label: '电影套件', text: 'cinema rig stability, polished professional camera support', zhText: '电影套件稳定，专业支撑带来精致运动' },
      { id: 'vehicle-rig', label: '车辆支架', text: 'vehicle rig stability, attached movement with controlled road vibration', zhText: '车辆支架稳定，附着式移动并控制路面震动' },
      { id: 'bike-rig', label: '骑行支架', text: 'bike rig stability, mobile outdoor movement with gentle vibration', zhText: '骑行支架稳定，户外移动并带轻微震动' },
      { id: 'speed-rig', label: '高速支架', text: 'speed rig stability, fast movement with firm subject tracking', zhText: '高速支架稳定，快速移动并稳固跟踪主体' },
      { id: 'slow-slider', label: '慢滑轨', text: 'slow slider stability, ultra-smooth slow lateral motion', zhText: '慢滑轨稳定，超顺滑慢速横移' },
      { id: 'breathing-handheld', label: '呼吸手持', text: 'breathing handheld stability, soft human presence without losing focus', zhText: '呼吸手持稳定，柔和人体在场且不丢焦点' },
      { id: 'heavy-camera', label: '重机身', text: 'heavy camera stability, weighted movement with cinematic inertia', zhText: '重机身稳定，带电影惯性的厚重移动' },
      { id: 'light-camera', label: '轻机身', text: 'light camera stability, agile motion with controlled responsiveness', zhText: '轻机身稳定，灵活响应且可控' },
      { id: 'stable-telephoto', label: '稳长焦', text: 'stabilized telephoto movement, compressed depth without jitter', zhText: '稳定长焦运动，压缩空间且无跳动' },
      { id: 'stable-wide', label: '稳广角', text: 'stabilized wide-angle movement, strong depth with clean horizon', zhText: '稳定广角运动，强纵深且地平线干净' },
      { id: 'horizon-lock', label: '锁地平线', text: 'horizon-locked stability, keep the horizon level through motion', zhText: '锁定地平线稳定，运动中保持地平线水平' },
      { id: 'subject-lock', label: '锁主体', text: 'subject-locked stability, keep the target fixed in frame during motion', zhText: '锁定主体稳定，移动中保持目标固定在画面里' },
    ],
  },
  {
    id: 'motionSubjectId',
    label: '主体',
    icon: <Camera size={12} />,
    columns: 3,
    items: [
      { id: 'centered', label: '主体居中', text: 'keep the subject centered in frame', zhText: '保持主体居中' },
      { id: 'face-clear', label: '脸部清晰', text: 'keep the face clear and readable', zhText: '保持脸部清晰可读' },
      { id: 'follow-person', label: '跟随人物', text: 'follow the person naturally without losing framing', zhText: '自然跟随人物，不丢失构图' },
      { id: 'surround-subject', label: '围绕主体', text: 'move around the subject while maintaining focus', zhText: '围绕主体移动并保持焦点' },
      { id: 'reveal-background', label: '揭示背景', text: 'reveal the background while keeping the subject important', zhText: '揭示背景，同时保持主体重要性' },
      { id: 'detail-emphasis', label: '强调细节', text: 'emphasize key details with controlled motion', zhText: '用可控运动强调关键细节' },
      { id: 'stable-framing', label: '构图稳定', text: 'keep composition stable and balanced', zhText: '保持构图稳定平衡' },
      { id: 'no-cuts', label: '不切镜', text: 'avoid cuts, keep one continuous camera move', zhText: '避免切镜，保持连续运镜' },
      { id: 'no-warp', label: '不变形', text: 'avoid warping, melting, or drifting subject geometry', zhText: '避免主体变形、融化或漂移' },
      { id: 'eyes-sharp', label: '眼睛清晰', text: 'keep the eyes sharp and expressive throughout the movement', zhText: '运动中保持眼睛清晰且有表现力' },
      { id: 'hands-visible', label: '手部可见', text: 'keep the hands visible and natural when they are important', zhText: '手部重要时保持可见且自然' },
      { id: 'product-label', label: '标签清楚', text: 'keep product labels clear and readable', zhText: '保持产品标签清楚可读' },
      { id: 'logo-readable', label: 'Logo 可读', text: 'keep logos readable without distortion', zhText: '保持 Logo 可读且不变形' },
      { id: 'outfit-consistent', label: '服装一致', text: 'keep clothing and styling consistent through the camera move', zhText: '运镜中保持服装和造型一致' },
      { id: 'full-body-visible', label: '全身完整', text: 'keep the full body visible without cutting off key limbs', zhText: '保持全身完整，不截断关键肢体' },
      { id: 'silhouette-clear', label: '轮廓清晰', text: 'keep the subject silhouette clear against the background', zhText: '保持主体轮廓与背景分离清晰' },
      { id: 'no-face-distort', label: '脸不变形', text: 'avoid face distortion during motion and perspective changes', zhText: '避免运动和透视变化导致脸部变形' },
      { id: 'hair-stable', label: '发丝稳定', text: 'keep hair structure stable with natural motion only', zhText: '保持发丝结构稳定，只保留自然运动' },
      { id: 'background-parallax', label: '背景视差', text: 'use background parallax while keeping the subject dominant', zhText: '使用背景视差，同时保持主体占优' },
      { id: 'foreground-depth', label: '前景层次', text: 'include foreground depth without blocking the subject', zhText: '加入前景层次但不遮挡主体' },
      { id: 'eye-contact', label: '眼神交流', text: 'keep eye contact with the viewer when appropriate', zhText: '合适时保持与观众的眼神交流' },
      { id: 'profile-readable', label: '侧脸可读', text: 'keep the profile readable in side-angle movement', zhText: '侧角度运动中保持侧脸可读' },
      { id: 'hands-no-warp', label: '手不变形', text: 'avoid warped fingers or unnatural hand shapes', zhText: '避免手指扭曲或手型不自然' },
      { id: 'prop-visible', label: '道具可见', text: 'keep important props visible and stable', zhText: '保持重要道具可见且稳定' },
      { id: 'prop-stable', label: '道具稳定', text: 'avoid prop drift, melting, or identity changes', zhText: '避免道具漂移、融化或身份变化' },
      { id: 'text-readable', label: '文字可读', text: 'keep on-screen text readable during the camera move', zhText: '运镜中保持画面文字可读' },
      { id: 'mouth-natural', label: '嘴型自然', text: 'keep mouth shape natural and avoid facial artifacts', zhText: '保持嘴型自然，避免面部瑕疵' },
      { id: 'no-extra-limbs', label: '无多肢', text: 'avoid extra limbs, duplicated hands, or body artifacts', zhText: '避免多余肢体、重复手部或身体瑕疵' },
      { id: 'group-spacing', label: '群像间距', text: 'maintain clear spacing between multiple people', zhText: '多人画面中保持清晰间距' },
      { id: 'multi-subjects', label: '多主体清楚', text: 'keep multiple subjects readable and balanced in frame', zhText: '保持多个主体清楚且画面平衡' },
      { id: 'object-centered', label: '物体居中', text: 'keep the main object centered and stable', zhText: '保持主物体居中且稳定' },
      { id: 'action-clear', label: '动作清楚', text: 'keep the action readable without excessive blur', zhText: '保持动作清楚，不要过度模糊' },
      { id: 'gesture-clear', label: '手势清楚', text: 'keep gestures clear and easy to understand', zhText: '保持手势清楚易懂' },
      { id: 'reflection-consistent', label: '反射一致', text: 'keep reflections consistent with subject motion', zhText: '保持反射与主体运动一致' },
      { id: 'shadow-consistent', label: '阴影一致', text: 'keep shadows consistent with motion and lighting', zhText: '保持阴影与运动和光照一致' },
      { id: 'scale-consistent', label: '比例稳定', text: 'keep subject scale consistent unless the camera intentionally changes distance', zhText: '除非镜头主动变距，否则保持主体比例稳定' },
      { id: 'horizon-stable', label: '地平稳定', text: 'keep the horizon stable and avoid unwanted tilt', zhText: '保持地平线稳定，避免不必要倾斜' },
      { id: 'headroom-balanced', label: '头顶留白', text: 'keep balanced headroom above the subject', zhText: '保持主体头顶留白平衡' },
      { id: 'rule-of-thirds', label: '三分构图', text: 'compose the subject near a rule-of-thirds position', zhText: '将主体安排在三分构图位置附近' },
      { id: 'face-closeup', label: '脸部特写', text: 'protect facial detail in close-up framing', zhText: '近景构图中保护脸部细节' },
      { id: 'wide-context', label: '环境完整', text: 'keep enough environment visible to understand the scene', zhText: '保留足够环境信息以理解场景' },
      { id: 'detail-protection', label: '保护细节', text: 'protect important small details from blur or deformation', zhText: '保护重要小细节，避免模糊或变形' },
      { id: 'fabric-detail', label: '面料细节', text: 'keep fabric texture and folds coherent during movement', zhText: '运动中保持面料纹理和褶皱连贯' },
      { id: 'jewelry-detail', label: '饰品细节', text: 'keep jewelry and small accessories visible and stable', zhText: '保持饰品和小配件可见且稳定' },
      { id: 'vehicle-shape', label: '车体稳定', text: 'keep vehicle shape and proportions stable through motion', zhText: '运镜中保持车体形状和比例稳定' },
      { id: 'architecture-lines', label: '建筑线条', text: 'keep architectural lines straight and coherent', zhText: '保持建筑线条笔直且连贯' },
      { id: 'food-texture', label: '食物质感', text: 'keep food texture appetizing and stable', zhText: '保持食物质感诱人且稳定' },
      { id: 'pet-expression', label: '宠物表情', text: 'keep pet expression clear and charming', zhText: '保持宠物表情清楚可爱' },
      { id: 'color-consistent', label: '色彩稳定', text: 'keep subject color consistent through lighting and motion changes', zhText: '在光照和运动变化中保持主体色彩稳定' },
      { id: 'no-flicker', label: '无闪烁', text: 'avoid flicker, identity shifts, or unstable details', zhText: '避免闪烁、身份漂移或细节不稳定' },
    ],
  },
];

const MULTI_ANGLE_AZIMUTH_PRESETS: MultiAnglePreset[] = [
  { id: 'front', label: '正面', azimuth: 0, elevation: 0, distance: 5 },
  { id: 'front-right', label: '右前 45°', azimuth: 45, elevation: 0, distance: 5 },
  { id: 'right', label: '右侧', azimuth: 90, elevation: 0, distance: 5 },
  { id: 'back-right', label: '右后', azimuth: 135, elevation: 0, distance: 5 },
  { id: 'back', label: '背面', azimuth: 180, elevation: 0, distance: 5 },
  { id: 'back-left', label: '左后', azimuth: 225, elevation: 0, distance: 5 },
  { id: 'left', label: '左侧', azimuth: 270, elevation: 0, distance: 5 },
  { id: 'front-left', label: '左前 45°', azimuth: 315, elevation: 0, distance: 5 },
];

const MULTI_ANGLE_ELEVATION_PRESETS: MultiAnglePreset[] = [
  { id: 'low', label: '仰拍', azimuth: 0, elevation: -30, distance: 5 },
  { id: 'eye', label: '平视', azimuth: 0, elevation: 0, distance: 5 },
  { id: 'elevated', label: '高机位', azimuth: 0, elevation: 30, distance: 5 },
  { id: 'high', label: '俯拍', azimuth: 0, elevation: 60, distance: 5 },
];

const MULTI_ANGLE_DISTANCE_PRESETS: MultiAnglePreset[] = [
  { id: 'wide', label: '远景', azimuth: 0, elevation: 0, distance: 1 },
  { id: 'medium', label: '中景', azimuth: 0, elevation: 0, distance: 5 },
  { id: 'close', label: '特写', azimuth: 0, elevation: 0, distance: 8 },
];

const MULTI_ANGLE_CREATIVE_PRESETS: MultiAnglePreset[] = [
  { id: 'id-front', label: '正面设定', azimuth: 0, elevation: 0, distance: 4 },
  { id: 'product-45', label: '产品 45°', azimuth: 45, elevation: 15, distance: 4 },
  { id: 'hero-low', label: '英雄仰拍', azimuth: 25, elevation: -25, distance: 6.5 },
  { id: 'top-display', label: '俯视展示', azimuth: 0, elevation: 58, distance: 3 },
  { id: 'back-design', label: '背面设定', azimuth: 180, elevation: 0, distance: 5 },
  { id: 'side-model', label: '侧面建模', azimuth: 90, elevation: 0, distance: 5 },
];

const MULTI_ANGLE_BATCH_PRESETS: Array<{ id: MultiAngleBatchMode; label: string; angles: number[] }> = [
  { id: 'single', label: '单条', angles: [] },
  { id: 'three', label: '三视图', angles: [0, 90, 180] },
  { id: 'four', label: '四视图', angles: [0, 90, 180, 270] },
  { id: 'eight', label: '八方位', angles: [0, 45, 90, 135, 180, 225, 270, 315] },
  { id: 'custom', label: '自定义', angles: [] },
];

function findPreset(items: Preset[], id?: string): Preset | undefined {
  if (!id) return undefined;
  return items.find((item) => item.id === id);
}

function presetText(preset: Preset | undefined, lang: PromptLanguage) {
  if (!preset) return '';
  return lang === 'zh' ? preset.zhText : preset.text;
}

function clampNumber(value: any, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeAngle(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

function angleDistance(a: number, b: number) {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, 360 - diff);
}

function roundAngle(value: number) {
  return Math.round(value);
}

function normalizeMultiAngleBatchMode(value: any): MultiAngleBatchMode {
  return value === 'three' || value === 'four' || value === 'eight' || value === 'custom' ? value : 'single';
}

function parseMultiAngleCustomAngles(value: any) {
  if (typeof value !== 'string') return [];
  const seen = new Set<number>();
  return value
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part.replace('°', '')))
    .filter((n) => Number.isFinite(n))
    .map((n) => roundAngle(normalizeAngle(n)))
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
}

function getMultiAngleLabels(azimuth: number, elevation: number, distance: number) {
  const hAngle = normalizeAngle(azimuth);
  let hEn = 'front view';
  let hZh = '正面视角';
  if (hAngle < 22.5 || hAngle >= 337.5) {
    hEn = 'front view';
    hZh = '正面视角';
  } else if (hAngle < 67.5) {
    hEn = 'front-right quarter view';
    hZh = '右前方四分之三视角';
  } else if (hAngle < 112.5) {
    hEn = 'right side view';
    hZh = '右侧视角';
  } else if (hAngle < 157.5) {
    hEn = 'back-right quarter view';
    hZh = '右后方四分之三视角';
  } else if (hAngle < 202.5) {
    hEn = 'back view';
    hZh = '背面视角';
  } else if (hAngle < 247.5) {
    hEn = 'back-left quarter view';
    hZh = '左后方四分之三视角';
  } else if (hAngle < 292.5) {
    hEn = 'left side view';
    hZh = '左侧视角';
  } else {
    hEn = 'front-left quarter view';
    hZh = '左前方四分之三视角';
  }

  let vEn = 'eye-level shot';
  let vZh = '平视镜头';
  if (elevation < -15) {
    vEn = 'low-angle shot';
    vZh = '仰拍镜头';
  } else if (elevation < 15) {
    vEn = 'eye-level shot';
    vZh = '平视镜头';
  } else if (elevation < 45) {
    vEn = 'elevated shot';
    vZh = '高机位镜头';
  } else {
    vEn = 'high-angle shot';
    vZh = '俯拍镜头';
  }

  let zEn = 'medium shot';
  let zZh = '中景';
  if (distance < 2) {
    zEn = 'wide shot';
    zZh = '远景';
  } else if (distance < 6) {
    zEn = 'medium shot';
    zZh = '中景';
  } else {
    zEn = 'close-up';
    zZh = '特写';
  }

  return { hEn, hZh, vEn, vZh, zEn, zZh };
}

function buildSingleMultiAnglePrompt(
  data: any,
  patch: MultiAnglePatch = {},
) {
  const next = { ...data, ...patch };
  const azimuth = normalizeAngle(next.multiAngleAzimuth ?? 0);
  const elevation = clampNumber(next.multiAngleElevation, -30, 60, 0);
  const distance = clampNumber(next.multiAngleDistance, 0, 10, 5);
  const mode: MultiAnglePromptMode =
    next.multiAnglePromptMode === 'general' || next.multiAnglePromptMode === 'dual' ? next.multiAnglePromptMode : 'qwen';
  const lang: PromptLanguage = next.multiAngleLanguage === 'zh' ? 'zh' : 'en';
  const labels = getMultiAngleLabels(azimuth, elevation, distance);
  const custom = typeof next.multiAngleCustom === 'string' ? next.multiAngleCustom.trim() : '';
  const prefix = typeof next.multiAnglePrefix === 'string' ? next.multiAnglePrefix.trim() : '';
  const suffix = typeof next.multiAngleSuffix === 'string' ? next.multiAngleSuffix.trim() : '';
  const qwenParts = lang === 'zh' ? [labels.hZh, labels.vZh, labels.zZh] : [labels.hEn, labels.vEn, labels.zEn];
  const qwenPrompt = [prefix, `<sks> ${qwenParts.join(' ')}`, suffix].filter(Boolean).join(' ');
  const generalPrompt =
    lang === 'zh'
      ? [prefix, labels.hZh, labels.vZh, labels.zZh, '清晰的相机角度参考', custom, suffix].filter(Boolean).join('，')
      : [prefix, labels.hEn, labels.vEn, labels.zEn, 'clear camera angle reference', custom, suffix].filter(Boolean).join(', ');
  if (mode === 'general') return generalPrompt;
  if (mode === 'dual') return `${qwenPrompt}\n${generalPrompt}`;
  return qwenPrompt;
}

function getMultiAngleBatchAngles(data: any) {
  const mode = normalizeMultiAngleBatchMode(data?.multiAngleBatchMode);
  if (mode === 'single') return [];
  if (mode === 'custom') return parseMultiAngleCustomAngles(data?.multiAngleBatchCustomAngles);
  return MULTI_ANGLE_BATCH_PRESETS.find((preset) => preset.id === mode)?.angles ?? [];
}

function buildMultiAnglePrompt(data: any, patch: MultiAnglePatch = {}) {
  const next = { ...data, ...patch };
  const angles = getMultiAngleBatchAngles(next);
  if (angles.length === 0) return buildSingleMultiAnglePrompt(next);
  return angles
    .map((angle, index) => {
      const text = buildSingleMultiAnglePrompt(next, { multiAngleAzimuth: angle });
      return text
        .split('\n')
        .map((line, lineIndex) => (lineIndex === 0 ? `${index + 1}. ${line}` : `   ${line}`))
        .join('\n');
    })
    .join('\n');
}

function buildCinematicPrompt(
  data: any,
  patch: CinematicPatch = {},
) {
  const next = { ...data, ...patch };
  const lang: PromptLanguage = next.cinematicLanguage === 'zh' ? 'zh' : 'en';
  const baseId = next.cinematicPresetId || next.presetId;
  const strengthId = next.cinematicStrength || 'balanced';
  const parts = [
    presetText(findPreset(CINEMATIC_PRESETS, baseId), lang),
    ...CINEMATIC_GROUPS.map((group) => presetText(findPreset(group.items, next[group.id]), lang)),
    presetText(findPreset(STRENGTH_PRESETS, strengthId), lang),
    typeof next.cinematicCustom === 'string' ? next.cinematicCustom.trim() : '',
  ].filter(Boolean);

  return parts.join(lang === 'zh' ? '，' : ', ');
}

function buildMotionPrompt(
  data: any,
  patch: MotionPatch = {},
) {
  const next = { ...data, ...patch };
  const lang: PromptLanguage = next.motionLanguage === 'zh' ? 'zh' : 'en';
  const actionId = next.motionActionId || next.presetId;
  const parts = [
    presetText(findPreset(MOTION_SCENE_PRESETS, next.motionSceneId), lang),
    presetText(findPreset(MOTION_ACTION_PRESETS, actionId), lang),
    ...MOTION_GROUPS.map((group) => presetText(findPreset(group.items, next[group.id]), lang)),
    typeof next.motionCustom === 'string' ? next.motionCustom.trim() : '',
  ].filter(Boolean);

  return parts.join(lang === 'zh' ? '，' : ', ');
}

const chipClass = 't8-btn min-h-7 min-w-0 px-1.5 text-[10px] leading-none whitespace-nowrap overflow-hidden text-ellipsis';
const miniChipClass = 't8-btn min-h-6 min-w-0 px-1 text-[9px] leading-none whitespace-nowrap overflow-hidden text-ellipsis';
const favoriteChipClass = 't8-btn w-full min-h-7 min-w-0 justify-start px-2.5 text-[10px] leading-none text-left';
const compactSelectClass = 't8-select w-full h-8 px-2 text-[11px]';
const miniControlStyle: CSSProperties = {
  width: 28,
  minWidth: 28,
  height: 26,
  minHeight: 26,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1.5px solid var(--t8-border-strong, var(--t8-border))',
  borderRadius: 999,
  background: 'var(--t8-bg-panel-elevated)',
  color: 'var(--t8-text-main)',
  boxShadow: 'none',
  fontSize: 10,
  fontWeight: 800,
  lineHeight: 1,
  letterSpacing: 0,
  cursor: 'pointer',
};
const miniControlActiveStyle: CSSProperties = {
  ...miniControlStyle,
  background: 'var(--t8-accent)',
  color: 'var(--t8-accent-text)',
};
const miniIconControlStyle: CSSProperties = {
  ...miniControlStyle,
  width: 26,
  minWidth: 26,
};

interface MotionPreviewShape {
  d: string;
  dot: [number, number];
  subject: boolean;
}

const MOTION_PREVIEW_GROUPS = {
  static: new Set(['static', 'locked-off']),
  forward: new Set([
    'zoom-in',
    'crash-zoom',
    'push-pull',
    'snap-zoom',
    'macro-glide',
    'push-through',
    'speed-ramp',
    'forward',
    'wide-to-detail',
    'through-space',
    'lead-in',
    'push-past',
    'doorway-pass',
    'tunnel-through',
    'crowd-through',
    'shelf-slide',
    'tabletop',
  ]),
  backward: new Set([
    'zoom-out',
    'backward',
    'detail-to-wide',
    'lead-out',
    'diagonal-retreat',
    'spiral-out',
    'spiral-out-path',
    'outward-spiral',
    'reverse-dolly',
    'boomerang',
    'boomerang-tempo',
  ]),
  left: new Set(['pan-l', 'right-to-left', 'roll-left', 'arc-left']),
  right: new Set(['pan-r', 'left-to-right', 'roll-right', 'arc-right']),
  rise: new Set([
    'tilt-up',
    'pedestal',
    'crane-up',
    'elevator-rise',
    'ground-rise',
    'rise',
    'stairs-up',
    'rising-orbit',
    'ground-skimming',
    'vertical-arc',
  ]),
  descend: new Set([
    'tilt-down',
    'crane-down',
    'elevator-drop',
    'top-down-drop',
    'descend',
    'overhead-drop',
    'stairs-down',
    'descending-orbit',
  ]),
  orbit: new Set([
    'orbit',
    'orbit-zoom',
    'bullet-time',
    'clockwise',
    'counter-clockwise',
    'surround-subject',
    'tight-orbit',
    'wide-orbit',
    'spiral-in',
    'spiral-in-path',
    'inward-spiral',
    'spiral-out',
    'spiral-out-path',
    'outward-spiral',
    'rising-orbit',
    'descending-orbit',
    'figure-eight',
  ]),
  follow: new Set([
    'tracking',
    'dolly',
    'parallel-follow',
    'side-track',
    'shoulder-follow',
    'leading-shot',
    'chase-cam',
    'pov-move',
    'follow-behind',
    'lead-ahead',
    'cross-screen',
  ]),
  diagonal: new Set(['diagonal', 'arc', 'diagonal-retreat', 'horizontal-arc', 'crane-sweep', 'skyline-sweep', 'pass-by', 'parallax']),
  handheld: new Set(['handheld', 'strong-handheld', 'handheld-breath', 'pov-move', 'chase-cam', 'shake-impact']),
  whip: new Set(['whip', 'transition-whip', 'whip-zoom', 'reveal-pan', 'reveal-tilt', 'pass-by']),
  reveal: new Set(['from-cover', 'window-reveal', 'foreground-wipe', 'from-dark', 'reflection-reveal']),
  sCurve: new Set(['s-curve', 'float-drift', 'floating', 'through-space']),
  zigzag: new Set(['zigzag', 'dutch-tilt', 'shake-impact']),
  aerial: new Set(['aerial', 'top-down-drop', 'overhead-drop', 'skyline-sweep']),
};

function motionPreviewShape(key?: string): MotionPreviewShape {
  const id = key || 'forward';
  if (MOTION_PREVIEW_GROUPS.static.has(id)) return { d: 'M108 34 C122 34 138 34 152 34', dot: [152, 34], subject: true };
  if (MOTION_PREVIEW_GROUPS.forward.has(id)) return { d: 'M82 34 C112 34 146 34 178 34', dot: [178, 34], subject: true };
  if (MOTION_PREVIEW_GROUPS.backward.has(id)) return { d: 'M178 34 C146 34 112 34 82 34', dot: [82, 34], subject: true };
  if (MOTION_PREVIEW_GROUPS.left.has(id)) return { d: 'M190 34 C154 30 110 30 72 34', dot: [72, 34], subject: false };
  if (MOTION_PREVIEW_GROUPS.right.has(id)) return { d: 'M72 34 C108 30 152 30 190 34', dot: [190, 34], subject: false };
  if (MOTION_PREVIEW_GROUPS.rise.has(id)) return { d: 'M132 54 C134 42 136 28 138 14', dot: [138, 14], subject: true };
  if (MOTION_PREVIEW_GROUPS.descend.has(id)) return { d: 'M138 14 C136 28 134 42 132 54', dot: [132, 54], subject: true };
  if (MOTION_PREVIEW_GROUPS.orbit.has(id)) return { d: 'M112 34 C126 12 174 12 188 34 C174 56 126 56 112 34', dot: [188, 34], subject: true };
  if (MOTION_PREVIEW_GROUPS.follow.has(id)) return { d: 'M68 40 C108 24 148 44 194 28', dot: [194, 28], subject: true };
  if (MOTION_PREVIEW_GROUPS.diagonal.has(id)) return { d: 'M70 52 C104 18 150 18 194 30', dot: [194, 30], subject: true };
  if (MOTION_PREVIEW_GROUPS.handheld.has(id)) return { d: 'M70 36 C94 20 112 50 136 30 C156 14 168 54 190 34', dot: [190, 34], subject: true };
  if (MOTION_PREVIEW_GROUPS.whip.has(id)) return { d: 'M58 38 C100 18 150 54 204 28', dot: [204, 28], subject: false };
  if (MOTION_PREVIEW_GROUPS.reveal.has(id)) return { d: 'M72 46 C102 46 126 24 158 28 C176 30 190 34 204 34', dot: [204, 34], subject: true };
  if (MOTION_PREVIEW_GROUPS.sCurve.has(id)) return { d: 'M62 42 C92 12 124 58 154 26 C172 8 190 28 206 18', dot: [206, 18], subject: true };
  if (MOTION_PREVIEW_GROUPS.zigzag.has(id)) return { d: 'M62 48 L96 22 L132 48 L168 22 L204 44', dot: [204, 44], subject: true };
  if (MOTION_PREVIEW_GROUPS.aerial.has(id)) return { d: 'M78 54 C104 22 154 18 196 16', dot: [196, 16], subject: true };
  return { d: 'M74 34 C104 34 150 34 190 34', dot: [190, 34], subject: true };
}

function motionPreviewPath(actionId?: string, pathId?: string) {
  const baseKey = actionId || pathId || 'forward';
  const base = motionPreviewShape(baseKey);
  const overlay = actionId && pathId && pathId !== actionId ? motionPreviewShape(pathId) : null;
  return { ...base, overlay };
}

function motionPresetLabel(items: Preset[], id?: string) {
  return id ? items.find((item) => item.id === id)?.label || '' : '';
}

function cinematicGroupItems(id: CinematicField) {
  return CINEMATIC_GROUPS.find((group) => group.id === id)?.items || [];
}

function motionGroupItems(id: MotionField) {
  return MOTION_GROUPS.find((group) => group.id === id)?.items || [];
}

function motionPathLabel(id?: string) {
  return motionPresetLabel(motionGroupItems('motionPathId'), id);
}

function MotionRoutePreview({ actionId, pathId }: { actionId?: string; pathId?: string }) {
  const preview = motionPreviewPath(actionId, pathId);
  const actionLabel = motionPresetLabel(MOTION_ACTION_PRESETS, actionId);
  const pathLabel = motionPathLabel(pathId);
  return (
    <div className="t8-card px-2.5 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
        <Camera size={12} />
        路线预览
        <span className="ml-auto max-w-[150px] truncate text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>
          {[actionLabel || '默认', pathLabel].filter(Boolean).join(' + ')}
        </span>
      </div>
      <svg viewBox="0 0 260 72" className="w-full h-16 block" aria-hidden="true">
        <rect x="7" y="8" width="246" height="56" rx="18" fill="var(--t8-bg-panel-muted)" opacity="0.68" />
        <path
          d="M22 54 C68 14 196 14 238 54"
          fill="none"
          stroke="var(--t8-grid-line)"
          strokeWidth="1"
          strokeDasharray="5 6"
          opacity="0.55"
        />
        {preview.subject && (
          <g opacity="0.95">
            <circle cx="132" cy="34" r="12" fill="var(--t8-bg-panel-elevated)" stroke="var(--t8-border-strong)" strokeWidth="2" />
            <circle cx="132" cy="34" r="4" fill="var(--t8-accent)" />
          </g>
        )}
        <path d={preview.d} fill="none" stroke="var(--t8-accent)" strokeWidth="5" strokeLinecap="round" opacity="0.28" />
        <path d={preview.d} fill="none" stroke="var(--t8-accent)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={preview.dot[0]} cy={preview.dot[1]} r="5" fill="var(--t8-secondary)" stroke="var(--t8-bg-panel)" strokeWidth="2" />
        {preview.overlay && (
          <>
            <path
              d={preview.overlay.d}
              fill="none"
              stroke="var(--t8-secondary)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="7 6"
              opacity="0.22"
            />
            <path
              d={preview.overlay.d}
              fill="none"
              stroke="var(--t8-secondary)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeDasharray="7 6"
              opacity="0.82"
            />
            <circle cx={preview.overlay.dot[0]} cy={preview.overlay.dot[1]} r="4" fill="var(--t8-secondary)" opacity="0.78" />
          </>
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] leading-none" style={{ color: 'var(--t8-text-dim)' }}>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="inline-block h-[2px] w-4 rounded-full" style={{ background: 'var(--t8-accent)' }} />
          动作主线
        </span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--t8-secondary)' }} />
          路径叠加
        </span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="inline-block w-4 border-t border-dashed" style={{ borderColor: 'var(--t8-grid-line)' }} />
          参考轨道
        </span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span
            className="inline-flex h-3 w-3 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--t8-border-strong)', background: 'var(--t8-bg-panel-elevated)' }}
          >
            <span className="h-1 w-1 rounded-full" style={{ background: 'var(--t8-accent)' }} />
          </span>
          主体焦点
        </span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--t8-secondary)' }} />
          运动终点
        </span>
      </div>
    </div>
  );
}

function collectFirstImageUrl(nodesData: any) {
  const list = Array.isArray(nodesData) ? nodesData : nodesData ? [nodesData] : [];
  const pushFrom = (value: any): string => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    return '';
  };
  for (const node of list) {
    const d = node?.data || {};
    const direct = pushFrom(d.imageUrl) || (d.uploadType === 'image' ? pushFrom(d.url) : '');
    if (direct) return direct;
    for (const key of ['imageUrls', 'urls', 'generatedImages'] as const) {
      const arr = d[key];
      if (Array.isArray(arr)) {
        const found = arr.find((item: any) => typeof item === 'string' && item.trim());
        if (found) return found.trim();
      }
    }
    const firstFrame = pushFrom(d.firstFrameUrl) || pushFrom(d.lastFrameUrl);
    if (firstFrame) return firstFrame;
  }
  return '';
}

type MultiAngleControl = 'azimuth' | 'elevation' | 'distance';

function MultiAngleStage({
  azimuth,
  elevation,
  distance,
  imageUrl,
  clipId,
  onChange,
}: {
  azimuth: number;
  elevation: number;
  distance: number;
  imageUrl?: string;
  clipId: string;
  onChange: (patch: Partial<Record<'multiAngleAzimuth' | 'multiAngleElevation' | 'multiAngleDistance', number>>) => void;
}) {
  const [dragControl, setDragControl] = useState<MultiAngleControl | null>(null);
  const labels = getMultiAngleLabels(azimuth, elevation, distance);
  const cx = 178;
  const cy = 138;
  const ringR = 72;
  const azRad = (normalizeAngle(azimuth) * Math.PI) / 180;
  const camX = cx + Math.sin(azRad) * ringR;
  const camY = cy + Math.cos(azRad) * ringR;
  const distX1 = 252;
  const distX2 = 330;
  const distY = 202;
  const distX = distX1 + (clampNumber(distance, 0, 10, 5) / 10) * (distX2 - distX1);
  const elevTop = 58;
  const elevBottom = 218;
  const elevCenter = (elevTop + elevBottom) / 2;
  const safeElevation = clampNumber(elevation, -30, 60, 0);
  const elevY =
    safeElevation >= 0
      ? elevCenter - (safeElevation / 60) * (elevCenter - elevTop)
      : elevCenter + (Math.abs(safeElevation) / 30) * (elevBottom - elevCenter);

  const svgPoint = (e: React.PointerEvent<SVGElement>) => {
    const svg = e.currentTarget instanceof SVGSVGElement ? e.currentTarget : e.currentTarget.ownerSVGElement;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 360,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * 260,
    };
  };

  const applyDrag = (control: MultiAngleControl, e: React.PointerEvent<SVGElement>) => {
    const pt = svgPoint(e);
    if (control === 'azimuth') {
      const deg = normalizeAngle((Math.atan2(pt.x - cx, pt.y - cy) * 180) / Math.PI);
      onChange({ multiAngleAzimuth: Math.round(deg) });
    } else if (control === 'elevation') {
      const y = clampNumber(pt.y, elevTop, elevBottom, elevY);
      const next =
        y <= elevCenter
          ? ((elevCenter - y) / (elevCenter - elevTop)) * 60
          : -((y - elevCenter) / (elevBottom - elevCenter)) * 30;
      onChange({ multiAngleElevation: Math.round(next) });
    } else {
      const x = clampNumber(pt.x, distX1, distX2, distX);
      const next = ((x - distX1) / (distX2 - distX1)) * 10;
      onChange({ multiAngleDistance: Number(next.toFixed(1)) });
    }
  };

  const startDrag = (control: MultiAngleControl, e: React.PointerEvent<SVGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget instanceof SVGSVGElement ? e.currentTarget : e.currentTarget.ownerSVGElement;
    try {
      svg?.setPointerCapture(e.pointerId);
    } catch {}
    setDragControl(control);
    applyDrag(control, e);
  };

  return (
    <div className="t8-card p-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
        <Compass size={12} />
        可视化机位
        <span className="ml-auto text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>
          {roundAngle(azimuth)}° / {roundAngle(elevation)}° / {distance.toFixed(1)}
        </span>
      </div>
      <svg
        viewBox="0 0 360 260"
        className="block w-full h-[230px] cursor-crosshair select-none"
        aria-label="可视化多角度相机控制"
        onPointerMove={(e) => {
          if (dragControl) applyDrag(dragControl, e);
        }}
        onPointerUp={() => setDragControl(null)}
        onPointerLeave={() => setDragControl(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="142" y="89" width="72" height="98" rx="9" />
          </clipPath>
          <linearGradient id={`${clipId}-card`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--t8-bg-panel-elevated)" />
            <stop offset="1" stopColor="var(--t8-bg-panel-muted)" />
          </linearGradient>
        </defs>
        <rect x="8" y="8" width="344" height="244" rx="18" fill="var(--t8-bg-panel-muted)" opacity="0.7" />
        {Array.from({ length: 8 }).map((_, i) => (
          <path
            key={`grid-${i}`}
            d={`M${48 + i * 36} 34 V226`}
            stroke="var(--t8-grid-line)"
            strokeDasharray="2 8"
            opacity="0.42"
          />
        ))}
        {Array.from({ length: 5 }).map((_, i) => (
          <path
            key={`grid-h-${i}`}
            d={`M34 ${58 + i * 38} H326`}
            stroke="var(--t8-grid-line)"
            strokeDasharray="2 8"
            opacity="0.34"
          />
        ))}

        <circle
          cx={cx}
          cy={cy}
          r={ringR}
          fill="none"
          stroke="var(--t8-accent)"
          strokeWidth="5"
          opacity="0.16"
          onPointerDown={(e) => startDrag('azimuth', e)}
        />
        <circle
          cx={cx}
          cy={cy}
          r={ringR}
          fill="none"
          stroke="var(--t8-accent)"
          strokeWidth="2"
          strokeDasharray="5 7"
          opacity="0.62"
          onPointerDown={(e) => startDrag('azimuth', e)}
        />
        <line x1={camX} y1={camY} x2={cx} y2={cy} stroke="var(--t8-accent)" strokeWidth="2" opacity="0.76" />
        <circle cx={camX} cy={camY} r="12" fill="var(--t8-accent)" opacity="0.25" />
        <circle
          cx={camX}
          cy={camY}
          r="7"
          fill="var(--t8-accent)"
          stroke="var(--t8-bg-panel)"
          strokeWidth="2"
          onPointerDown={(e) => startDrag('azimuth', e)}
        />
        <path d={`M74 ${elevBottom} C48 154 52 96 74 ${elevTop}`} fill="none" stroke="var(--t8-secondary)" strokeWidth="5" opacity="0.18" />
        <path
          d={`M74 ${elevBottom} C48 154 52 96 74 ${elevTop}`}
          fill="none"
          stroke="var(--t8-secondary)"
          strokeWidth="2"
          opacity="0.7"
          onPointerDown={(e) => startDrag('elevation', e)}
        />
        <circle
          cx="74"
          cy={elevY}
          r="7"
          fill="var(--t8-secondary)"
          stroke="var(--t8-bg-panel)"
          strokeWidth="2"
          onPointerDown={(e) => startDrag('elevation', e)}
        />
        <text x="32" y="54" fontSize="9" fontWeight="800" fill="var(--t8-text-dim)">高</text>
        <text x="32" y="222" fontSize="9" fontWeight="800" fill="var(--t8-text-dim)">低</text>

        <line x1={distX1} y1={distY} x2={distX2} y2={distY} stroke="var(--t8-warning, #f59e0b)" strokeWidth="7" opacity="0.22" />
        <line
          x1={distX1}
          y1={distY}
          x2={distX2}
          y2={distY}
          stroke="var(--t8-warning, #f59e0b)"
          strokeWidth="2.5"
          strokeLinecap="round"
          onPointerDown={(e) => startDrag('distance', e)}
        />
        <circle
          cx={distX}
          cy={distY}
          r="7"
          fill="var(--t8-warning, #f59e0b)"
          stroke="var(--t8-bg-panel)"
          strokeWidth="2"
          onPointerDown={(e) => startDrag('distance', e)}
        />
        <text x="246" y="186" fontSize="9" fontWeight="800" fill="var(--t8-text-dim)">远</text>
        <text x="324" y="186" fontSize="9" fontWeight="800" fill="var(--t8-text-dim)">近</text>

        <rect x="142" y="89" width="72" height="98" rx="9" fill={`url(#${clipId}-card)`} stroke="var(--t8-border-strong)" strokeWidth="2" />
        {imageUrl ? (
          <image href={imageUrl} x="142" y="89" width="72" height="98" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
        ) : (
          <g opacity="0.85">
            <circle cx="178" cy="127" r="10" fill="var(--t8-accent)" opacity="0.22" />
            <path d="M164 169 C168 154 188 154 192 169" fill="var(--t8-accent)" opacity="0.18" />
            <path d="M164 169 C168 154 188 154 192 169" fill="none" stroke="var(--t8-accent)" strokeWidth="2" />
            <circle cx="178" cy="127" r="9" fill="none" stroke="var(--t8-accent)" strokeWidth="2" />
          </g>
        )}
        <rect x="142" y="89" width="72" height="98" rx="9" fill="none" stroke="var(--t8-border-strong)" strokeWidth="2" />
        <path d="M142 187 L214 187 L224 201 L132 201 Z" fill="var(--t8-accent)" opacity="0.12" />
        <g fontSize="10" fontWeight="800">
          <text x="178" y="32" textAnchor="middle" fill="var(--t8-text-main)">背面 180°</text>
          <text x="178" y="240" textAnchor="middle" fill="var(--t8-text-main)">正面 0°</text>
          <text x="315" y="142" textAnchor="middle" fill="var(--t8-text-main)">右侧</text>
          <text x="43" y="142" textAnchor="middle" fill="var(--t8-text-main)">左侧</text>
        </g>
      </svg>
      <div className="grid grid-cols-3 gap-1 text-[10px]">
        <div className="t8-card px-2 py-1">
          <div style={{ color: 'var(--t8-text-dim)' }}>水平</div>
          <div className="font-bold truncate">{labels.hZh}</div>
        </div>
        <div className="t8-card px-2 py-1">
          <div style={{ color: 'var(--t8-text-dim)' }}>垂直</div>
          <div className="font-bold truncate">{labels.vZh}</div>
        </div>
        <div className="t8-card px-2 py-1">
          <div style={{ color: 'var(--t8-text-dim)' }}>远近</div>
          <div className="font-bold truncate">{labels.zZh}</div>
        </div>
      </div>
    </div>
  );
}

const ToolboxParamNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const rf = useReactFlow();
  const d = p.data as any;
  const kind: 'cinematic' | 'video-motion' | 'multi-angle-visual' | string = d?.kind || 'cinematic';
  const prompt: string = d?.prompt || '';
  const [error, setError] = useState('');
  const upstreamConnections = useNodeConnections({ id: p.id, handleType: 'target' });
  const upstreamIds = useMemo(
    () => Array.from(new Set(upstreamConnections.map((c: any) => c.source).filter(Boolean))) as string[],
    [upstreamConnections],
  );
  const upstreamNodesData = useNodesData(upstreamIds);
  const upstreamPreviewImage = useMemo(() => collectFirstImageUrl(upstreamNodesData), [upstreamNodesData]);

  const cinematicLang: PromptLanguage = d?.cinematicLanguage === 'zh' ? 'zh' : 'en';
  const motionLang: PromptLanguage = d?.motionLanguage === 'zh' ? 'zh' : 'en';
  const multiAnglePromptMode: MultiAnglePromptMode =
    d?.multiAnglePromptMode === 'general' || d?.multiAnglePromptMode === 'dual' ? d.multiAnglePromptMode : 'qwen';
  const multiAngleLanguage: PromptLanguage = d?.multiAngleLanguage === 'zh' ? 'zh' : 'en';
  const multiAngleAzimuth = normalizeAngle(d?.multiAngleAzimuth ?? 0);
  const multiAngleElevation = clampNumber(d?.multiAngleElevation, -30, 60, 0);
  const multiAngleDistance = clampNumber(d?.multiAngleDistance, 0, 10, 5);
  const multiAngleLabels = getMultiAngleLabels(multiAngleAzimuth, multiAngleElevation, multiAngleDistance);
  const multiAngleBatchMode = normalizeMultiAngleBatchMode(d?.multiAngleBatchMode);
  const multiAngleBatchAngles = getMultiAngleBatchAngles(d);
  const multiAngleFavorites: MultiAngleFavorite[] = Array.isArray(d?.multiAngleFavorites)
    ? d.multiAngleFavorites
        .filter((item: any) => item && typeof item.label === 'string')
        .map((item: any) => ({
          id: String(item.id || `${item.label}-${item.azimuth}-${item.elevation}-${item.distance}`),
          label: String(item.label),
          azimuth: normalizeAngle(item.azimuth ?? 0),
          elevation: clampNumber(item.elevation, -30, 60, 0),
          distance: clampNumber(item.distance, 0, 10, 5),
          createdAt: Number(item.createdAt) || undefined,
        }))
    : [];
  const selectedAzimuthPresetId = MULTI_ANGLE_AZIMUTH_PRESETS.find((ps) => angleDistance(multiAngleAzimuth, ps.azimuth) < 1)?.id || '';
  const selectedElevationPresetId = MULTI_ANGLE_ELEVATION_PRESETS.find((ps) => Math.abs(multiAngleElevation - ps.elevation) < 1)?.id || '';
  const selectedDistancePresetId = MULTI_ANGLE_DISTANCE_PRESETS.find((ps) => Math.abs(multiAngleDistance - ps.distance) < 0.15)?.id || '';
  const selectedCreativePresetId =
    MULTI_ANGLE_CREATIVE_PRESETS.find(
      (ps) =>
        angleDistance(multiAngleAzimuth, ps.azimuth) < 1 &&
        Math.abs(multiAngleElevation - ps.elevation) < 1 &&
        Math.abs(multiAngleDistance - ps.distance) < 0.15,
    )?.id || '';
  const selectedMotionActionId: string = d?.motionActionId || d?.presetId || '';
  const selectedMotionSceneId: string = d?.motionSceneId || '';
  const selectedMotionPathId: string = d?.motionPathId || '';
  const selectedMotionTempoId: string = d?.motionTempoId || '';
  const selectedMotionStabilityId: string = d?.motionStabilityId || '';
  const selectedMotionSubjectId: string = d?.motionSubjectId || '';
  const motionFavorites: MotionFavorite[] = Array.isArray(d?.motionFavorites)
    ? d.motionFavorites
        .filter((item: any) => item && typeof item.label === 'string')
        .map((item: any, index: number) => ({
          id: String(item.id || `motion-fav-${index}`),
          label: String(item.label),
          motionSceneId: typeof item.motionSceneId === 'string' ? item.motionSceneId : '',
          motionActionId: typeof item.motionActionId === 'string' ? item.motionActionId : '',
          motionPathId: typeof item.motionPathId === 'string' ? item.motionPathId : '',
          motionTempoId: typeof item.motionTempoId === 'string' ? item.motionTempoId : '',
          motionStabilityId: typeof item.motionStabilityId === 'string' ? item.motionStabilityId : '',
          motionSubjectId: typeof item.motionSubjectId === 'string' ? item.motionSubjectId : '',
          motionCustom: typeof item.motionCustom === 'string' ? item.motionCustom : '',
          motionLanguage: (item.motionLanguage === 'zh' ? 'zh' : 'en') as PromptLanguage,
          createdAt: Number(item.createdAt) || undefined,
        }))
    : [];
  const selectedBaseId: string = d?.cinematicPresetId || d?.presetId || '';
  const selectedCinematicShotId: string = d?.cinematicShotId || '';
  const selectedCinematicLightId: string = d?.cinematicLightId || '';
  const selectedCinematicColorId: string = d?.cinematicColorId || '';
  const selectedCinematicTextureId: string = d?.cinematicTextureId || '';
  const selectedStrength: string = d?.cinematicStrength || 'balanced';
  const cinematicFavorites: CinematicFavorite[] = Array.isArray(d?.cinematicFavorites)
    ? d.cinematicFavorites
        .filter((item: any) => item && typeof item.label === 'string')
        .map((item: any, index: number) => ({
          id: String(item.id || `cinematic-fav-${index}`),
          label: String(item.label),
          cinematicPresetId: typeof item.cinematicPresetId === 'string' ? item.cinematicPresetId : '',
          cinematicShotId: typeof item.cinematicShotId === 'string' ? item.cinematicShotId : '',
          cinematicLightId: typeof item.cinematicLightId === 'string' ? item.cinematicLightId : '',
          cinematicColorId: typeof item.cinematicColorId === 'string' ? item.cinematicColorId : '',
          cinematicTextureId: typeof item.cinematicTextureId === 'string' ? item.cinematicTextureId : '',
          cinematicStrength: typeof item.cinematicStrength === 'string' ? item.cinematicStrength : 'balanced',
          cinematicCustom: typeof item.cinematicCustom === 'string' ? item.cinematicCustom : '',
          cinematicLanguage: (item.cinematicLanguage === 'zh' ? 'zh' : 'en') as PromptLanguage,
          createdAt: Number(item.createdAt) || undefined,
        }))
    : [];

  const updateCinematic = (patch: CinematicPatch) => {
    const promptText = buildCinematicPrompt(d, patch);
    const next: Record<string, any> = { ...patch, prompt: promptText };
    if (patch.cinematicPresetId !== undefined) next.presetId = patch.cinematicPresetId;
    if (patch.cinematicLanguage !== undefined) next.cinematicLanguage = patch.cinematicLanguage;
    update(next);
    setError('');
  };

  const clearCinematic = () => {
    update({
      presetId: '',
      cinematicPresetId: '',
      cinematicShotId: '',
      cinematicLightId: '',
      cinematicColorId: '',
      cinematicTextureId: '',
      cinematicStrength: 'balanced',
      cinematicCustom: '',
      cinematicLanguage: 'en',
      prompt: '',
    });
    setError('');
  };

  const cinematicFavoriteLabel = () => {
    const labels = [
      motionPresetLabel(CINEMATIC_PRESETS, selectedBaseId),
      motionPresetLabel(cinematicGroupItems('cinematicShotId'), selectedCinematicShotId),
      motionPresetLabel(cinematicGroupItems('cinematicLightId'), selectedCinematicLightId),
      motionPresetLabel(cinematicGroupItems('cinematicColorId'), selectedCinematicColorId),
    ].filter(Boolean);
    return labels.length > 0 ? labels.slice(0, 4).join(' / ') : '电影感收藏';
  };

  const addCinematicFavorite = () => {
    const favorite: CinematicFavorite = {
      id: `cinematic-fav-${Date.now()}`,
      label: cinematicFavoriteLabel(),
      cinematicPresetId: selectedBaseId,
      cinematicShotId: selectedCinematicShotId,
      cinematicLightId: selectedCinematicLightId,
      cinematicColorId: selectedCinematicColorId,
      cinematicTextureId: selectedCinematicTextureId,
      cinematicStrength: selectedStrength,
      cinematicCustom: d?.cinematicCustom || '',
      cinematicLanguage: cinematicLang,
      createdAt: Date.now(),
    };
    updateCinematic({ cinematicFavorites: [favorite, ...cinematicFavorites].slice(0, 12) });
  };

  const applyCinematicFavorite = (favorite: CinematicFavorite) => {
    updateCinematic({
      cinematicPresetId: favorite.cinematicPresetId || '',
      cinematicShotId: favorite.cinematicShotId || '',
      cinematicLightId: favorite.cinematicLightId || '',
      cinematicColorId: favorite.cinematicColorId || '',
      cinematicTextureId: favorite.cinematicTextureId || '',
      cinematicStrength: favorite.cinematicStrength || 'balanced',
      cinematicCustom: favorite.cinematicCustom || '',
      cinematicLanguage: favorite.cinematicLanguage === 'zh' ? 'zh' : 'en',
    });
  };

  const removeCinematicFavorite = (id: string) => {
    updateCinematic({ cinematicFavorites: cinematicFavorites.filter((item) => item.id !== id) });
  };

  const normalizeImportedCinematicFavorites = (value: any): CinematicFavorite[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any, index: number) => ({
        id: String(item.id || `cinematic-import-${Date.now()}-${index}`),
        label: String(item.label || `电影感收藏 ${index + 1}`),
        cinematicPresetId: typeof item.cinematicPresetId === 'string' ? item.cinematicPresetId : '',
        cinematicShotId: typeof item.cinematicShotId === 'string' ? item.cinematicShotId : '',
        cinematicLightId: typeof item.cinematicLightId === 'string' ? item.cinematicLightId : '',
        cinematicColorId: typeof item.cinematicColorId === 'string' ? item.cinematicColorId : '',
        cinematicTextureId: typeof item.cinematicTextureId === 'string' ? item.cinematicTextureId : '',
        cinematicStrength: typeof item.cinematicStrength === 'string' ? item.cinematicStrength : 'balanced',
        cinematicCustom: typeof item.cinematicCustom === 'string' ? item.cinematicCustom : '',
        cinematicLanguage: (item.cinematicLanguage === 'zh' ? 'zh' : 'en') as PromptLanguage,
        createdAt: Number(item.createdAt) || Date.now(),
      }))
      .slice(0, 12);
  };

  const importCinematicPresetPayload = (payload: any) => {
    const current = payload?.current || {};
    const patch: CinematicPatch = {};
    if (typeof current.cinematicPresetId === 'string') patch.cinematicPresetId = current.cinematicPresetId;
    if (typeof current.cinematicShotId === 'string') patch.cinematicShotId = current.cinematicShotId;
    if (typeof current.cinematicLightId === 'string') patch.cinematicLightId = current.cinematicLightId;
    if (typeof current.cinematicColorId === 'string') patch.cinematicColorId = current.cinematicColorId;
    if (typeof current.cinematicTextureId === 'string') patch.cinematicTextureId = current.cinematicTextureId;
    if (typeof current.cinematicStrength === 'string') patch.cinematicStrength = current.cinematicStrength;
    if (typeof current.cinematicCustom === 'string') patch.cinematicCustom = current.cinematicCustom;
    if (current.cinematicLanguage === 'zh' || current.cinematicLanguage === 'en') patch.cinematicLanguage = current.cinematicLanguage;

    const importedFavorites = normalizeImportedCinematicFavorites(payload?.favorites);
    if (importedFavorites.length > 0) {
      patch.cinematicFavorites = [...importedFavorites, ...cinematicFavorites]
        .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
        .slice(0, 12);
    }

    if (Object.keys(patch).length === 0) {
      setError('未识别到可导入的电影感预设');
      return;
    }
    updateCinematic(patch);
  };

  const importCinematicPresets = (file: File | null | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || '{}'));
        if (payload?.schema !== 't8-cinematic-presets') {
          setError('JSON 格式不是 T8 电影感预设');
          return;
        }
        importCinematicPresetPayload(payload);
      } catch {
        setError('JSON 解析失败，请检查文件内容');
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const exportCinematicPresets = () => {
    const payload = {
      schema: 't8-cinematic-presets',
      version: 1,
      exportedAt: new Date().toISOString(),
      current: {
        cinematicPresetId: selectedBaseId,
        cinematicShotId: selectedCinematicShotId,
        cinematicLightId: selectedCinematicLightId,
        cinematicColorId: selectedCinematicColorId,
        cinematicTextureId: selectedCinematicTextureId,
        cinematicStrength: selectedStrength,
        cinematicCustom: d?.cinematicCustom || '',
        cinematicLanguage: cinematicLang,
      },
      catalogs: {
        presets: CINEMATIC_PRESETS.map(({ id, label }) => ({ id, label })),
        groups: CINEMATIC_GROUPS.map((group) => ({
          id: group.id,
          label: group.label,
          items: group.items.map(({ id, label }) => ({ id, label })),
        })),
        strength: STRENGTH_PRESETS.map(({ id, label }) => ({ id, label })),
      },
      favorites: cinematicFavorites,
    };
    const text = JSON.stringify(payload, null, 2);
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
      if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(text).catch(() => undefined);
      return;
    }
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `t8-cinematic-presets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateMotion = (patch: MotionPatch) => {
    const promptText = buildMotionPrompt(d, patch);
    const next: Record<string, any> = { ...patch, prompt: promptText };
    if (patch.motionActionId !== undefined) next.presetId = patch.motionActionId;
    if (patch.motionLanguage !== undefined) next.motionLanguage = patch.motionLanguage;
    update(next);
    setError('');
  };

  const clearMotion = () => {
    update({
      presetId: '',
      motionSceneId: '',
      motionActionId: '',
      motionPathId: '',
      motionTempoId: '',
      motionStabilityId: '',
      motionSubjectId: '',
      motionCustom: '',
      motionLanguage: 'en',
      prompt: '',
    });
    setError('');
  };

  const motionFavoriteLabel = () => {
    const labels = [
      motionPresetLabel(MOTION_SCENE_PRESETS, selectedMotionSceneId),
      motionPresetLabel(MOTION_ACTION_PRESETS, selectedMotionActionId),
      motionPresetLabel(motionGroupItems('motionPathId'), selectedMotionPathId),
      motionPresetLabel(motionGroupItems('motionTempoId'), selectedMotionTempoId),
    ].filter(Boolean);
    return labels.length > 0 ? labels.slice(0, 4).join(' / ') : '视频运镜收藏';
  };

  const addMotionFavorite = () => {
    const favorite: MotionFavorite = {
      id: `motion-fav-${Date.now()}`,
      label: motionFavoriteLabel(),
      motionSceneId: selectedMotionSceneId,
      motionActionId: selectedMotionActionId,
      motionPathId: selectedMotionPathId,
      motionTempoId: selectedMotionTempoId,
      motionStabilityId: selectedMotionStabilityId,
      motionSubjectId: selectedMotionSubjectId,
      motionCustom: d?.motionCustom || '',
      motionLanguage: motionLang,
      createdAt: Date.now(),
    };
    updateMotion({ motionFavorites: [favorite, ...motionFavorites].slice(0, 12) });
  };

  const applyMotionFavorite = (favorite: MotionFavorite) => {
    updateMotion({
      motionSceneId: favorite.motionSceneId || '',
      motionActionId: favorite.motionActionId || '',
      motionPathId: favorite.motionPathId || '',
      motionTempoId: favorite.motionTempoId || '',
      motionStabilityId: favorite.motionStabilityId || '',
      motionSubjectId: favorite.motionSubjectId || '',
      motionCustom: favorite.motionCustom || '',
      motionLanguage: favorite.motionLanguage === 'zh' ? 'zh' : 'en',
    });
  };

  const removeMotionFavorite = (id: string) => {
    updateMotion({ motionFavorites: motionFavorites.filter((item) => item.id !== id) });
  };

  const normalizeImportedMotionFavorites = (value: any): MotionFavorite[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any, index: number) => ({
        id: String(item.id || `motion-import-${Date.now()}-${index}`),
        label: String(item.label || `运镜收藏 ${index + 1}`),
        motionSceneId: typeof item.motionSceneId === 'string' ? item.motionSceneId : '',
        motionActionId: typeof item.motionActionId === 'string' ? item.motionActionId : '',
        motionPathId: typeof item.motionPathId === 'string' ? item.motionPathId : '',
        motionTempoId: typeof item.motionTempoId === 'string' ? item.motionTempoId : '',
        motionStabilityId: typeof item.motionStabilityId === 'string' ? item.motionStabilityId : '',
        motionSubjectId: typeof item.motionSubjectId === 'string' ? item.motionSubjectId : '',
        motionCustom: typeof item.motionCustom === 'string' ? item.motionCustom : '',
        motionLanguage: (item.motionLanguage === 'zh' ? 'zh' : 'en') as PromptLanguage,
        createdAt: Number(item.createdAt) || Date.now(),
      }))
      .slice(0, 12);
  };

  const importMotionPresetPayload = (payload: any) => {
    const current = payload?.current || {};
    const patch: MotionPatch = {};
    if (typeof current.motionSceneId === 'string') patch.motionSceneId = current.motionSceneId;
    if (typeof current.motionActionId === 'string') patch.motionActionId = current.motionActionId;
    if (typeof current.motionPathId === 'string') patch.motionPathId = current.motionPathId;
    if (typeof current.motionTempoId === 'string') patch.motionTempoId = current.motionTempoId;
    if (typeof current.motionStabilityId === 'string') patch.motionStabilityId = current.motionStabilityId;
    if (typeof current.motionSubjectId === 'string') patch.motionSubjectId = current.motionSubjectId;
    if (typeof current.motionCustom === 'string') patch.motionCustom = current.motionCustom;
    if (current.motionLanguage === 'zh' || current.motionLanguage === 'en') patch.motionLanguage = current.motionLanguage;

    const importedFavorites = normalizeImportedMotionFavorites(payload?.favorites);
    if (importedFavorites.length > 0) {
      patch.motionFavorites = [...importedFavorites, ...motionFavorites]
        .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
        .slice(0, 12);
    }

    if (Object.keys(patch).length === 0) {
      setError('未识别到可导入的视频运镜预设');
      return;
    }
    updateMotion(patch);
  };

  const importMotionPresets = (file: File | null | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || '{}'));
        if (payload?.schema !== 't8-video-motion-presets') {
          setError('JSON 格式不是 T8 视频运镜预设');
          return;
        }
        importMotionPresetPayload(payload);
      } catch {
        setError('JSON 解析失败，请检查文件内容');
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const exportMotionPresets = () => {
    const payload = {
      schema: 't8-video-motion-presets',
      version: 1,
      exportedAt: new Date().toISOString(),
      current: {
        motionSceneId: selectedMotionSceneId,
        motionActionId: selectedMotionActionId,
        motionPathId: selectedMotionPathId,
        motionTempoId: selectedMotionTempoId,
        motionStabilityId: selectedMotionStabilityId,
        motionSubjectId: selectedMotionSubjectId,
        motionCustom: d?.motionCustom || '',
        motionLanguage: motionLang,
      },
      catalogs: {
        scenes: MOTION_SCENE_PRESETS.map(({ id, label }) => ({ id, label })),
        actions: MOTION_ACTION_PRESETS.map(({ id, label }) => ({ id, label })),
        groups: MOTION_GROUPS.map((group) => ({
          id: group.id,
          label: group.label,
          items: group.items.map(({ id, label }) => ({ id, label })),
        })),
      },
      favorites: motionFavorites,
    };
    const text = JSON.stringify(payload, null, 2);
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
      if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(text).catch(() => undefined);
      return;
    }
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `t8-video-motion-presets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateMultiAngle = (patch: MultiAnglePatch) => {
    const normalizedPatch: typeof patch = { ...patch };
    if (patch.multiAngleAzimuth !== undefined) normalizedPatch.multiAngleAzimuth = normalizeAngle(patch.multiAngleAzimuth);
    if (patch.multiAngleElevation !== undefined) normalizedPatch.multiAngleElevation = clampNumber(patch.multiAngleElevation, -30, 60, 0);
    if (patch.multiAngleDistance !== undefined) normalizedPatch.multiAngleDistance = clampNumber(patch.multiAngleDistance, 0, 10, 5);
    const promptText = buildMultiAnglePrompt(d, normalizedPatch);
    update({ ...normalizedPatch, prompt: promptText });
    setError('');
  };

  const clearMultiAngle = () => {
    const reset = {
      multiAngleAzimuth: 0,
      multiAngleElevation: 0,
      multiAngleDistance: 5,
      multiAnglePromptMode: 'qwen',
      multiAngleLanguage: 'en',
      multiAngleBatchMode: 'single',
      multiAngleBatchCustomAngles: '',
      multiAnglePrefix: '',
      multiAngleSuffix: '',
      multiAngleCustom: '',
    };
    update({ ...reset, prompt: buildMultiAnglePrompt(reset) });
    setError('');
  };

  const addMultiAngleFavorite = () => {
    const label = `${multiAngleLabels.hZh}/${multiAngleLabels.vZh}/${multiAngleLabels.zZh}`;
    const favorite: MultiAngleFavorite = {
      id: `fav-${Date.now()}`,
      label,
      azimuth: roundAngle(multiAngleAzimuth),
      elevation: roundAngle(multiAngleElevation),
      distance: Number(multiAngleDistance.toFixed(1)),
      createdAt: Date.now(),
    };
    const nextFavorites = [favorite, ...multiAngleFavorites].slice(0, 12);
    updateMultiAngle({ multiAngleFavorites: nextFavorites });
  };

  const applyMultiAngleFavorite = (favorite: MultiAngleFavorite) => {
    updateMultiAngle({
      multiAngleAzimuth: favorite.azimuth,
      multiAngleElevation: favorite.elevation,
      multiAngleDistance: favorite.distance,
    });
  };

  const removeMultiAngleFavorite = (id: string) => {
    updateMultiAngle({ multiAngleFavorites: multiAngleFavorites.filter((item) => item.id !== id) });
  };

  const normalizeImportedFavorites = (value: any): MultiAngleFavorite[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any, index: number) => ({
        id: String(item.id || `import-${Date.now()}-${index}`),
        label: String(item.label || `镜头 ${index + 1}`),
        azimuth: roundAngle(normalizeAngle(item.azimuth ?? 0)),
        elevation: roundAngle(clampNumber(item.elevation, -30, 60, 0)),
        distance: Number(clampNumber(item.distance, 0, 10, 5).toFixed(1)),
        createdAt: Number(item.createdAt) || Date.now(),
      }))
      .slice(0, 12);
  };

  const importMultiAnglePresetPayload = (payload: any) => {
    const current = payload?.current || {};
    const importedFavorites = normalizeImportedFavorites(payload?.favorites);
    const batchAngles = Array.isArray(current.batchAngles)
      ? current.batchAngles.map((n: any) => roundAngle(normalizeAngle(n))).join(',')
      : '';
    const patch: MultiAnglePatch = {};
    if (current.azimuth !== undefined) patch.multiAngleAzimuth = current.azimuth;
    if (current.elevation !== undefined) patch.multiAngleElevation = current.elevation;
    if (current.distance !== undefined) patch.multiAngleDistance = current.distance;
    if (current.promptMode === 'qwen' || current.promptMode === 'general' || current.promptMode === 'dual') patch.multiAnglePromptMode = current.promptMode;
    if (current.language === 'zh' || current.language === 'en') patch.multiAngleLanguage = current.language;
    if (current.batchMode === 'single' || current.batchMode === 'three' || current.batchMode === 'four' || current.batchMode === 'eight' || current.batchMode === 'custom') {
      patch.multiAngleBatchMode = current.batchMode;
    }
    if (batchAngles) patch.multiAngleBatchCustomAngles = batchAngles;
    if (typeof current.prefix === 'string') patch.multiAnglePrefix = current.prefix;
    if (typeof current.suffix === 'string') patch.multiAngleSuffix = current.suffix;
    if (typeof current.custom === 'string') patch.multiAngleCustom = current.custom;
    if (importedFavorites.length > 0) {
      patch.multiAngleFavorites = [...importedFavorites, ...multiAngleFavorites]
        .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
        .slice(0, 12);
    }
    if (Object.keys(patch).length === 0) {
      setError('未识别到可导入的角度预设');
      return;
    }
    updateMultiAngle(patch);
  };

  const importMultiAnglePresets = (file: File | null | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || '{}'));
        if (payload?.schema !== 't8-multi-angle-presets') {
          setError('JSON 格式不是 T8 多角度预设');
          return;
        }
        importMultiAnglePresetPayload(payload);
      } catch {
        setError('JSON 解析失败，请检查文件内容');
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const exportMultiAnglePresets = () => {
    const payload = {
      schema: 't8-multi-angle-presets',
      version: 1,
      exportedAt: new Date().toISOString(),
      current: {
        azimuth: roundAngle(multiAngleAzimuth),
        elevation: roundAngle(multiAngleElevation),
        distance: Number(multiAngleDistance.toFixed(1)),
        promptMode: multiAnglePromptMode,
        language: multiAngleLanguage,
        batchMode: multiAngleBatchMode,
        batchAngles: multiAngleBatchAngles,
        prefix: d?.multiAnglePrefix || '',
        suffix: d?.multiAngleSuffix || '',
        custom: d?.multiAngleCustom || '',
      },
      builtInBatches: MULTI_ANGLE_BATCH_PRESETS.map((item) => ({ id: item.id, label: item.label, angles: item.angles })),
      favorites: multiAngleFavorites,
    };
    const text = JSON.stringify(payload, null, 2);
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
      if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(text).catch(() => undefined);
      return;
    }
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `t8-multi-angle-presets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyPrompt = () => {
    const text = prompt || (kind === 'multi-angle-visual' ? buildMultiAnglePrompt(d) : '');
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).catch(() => undefined);
  };

  const handleRun = async () => {
    const fallbackPrompt = kind === 'multi-angle-visual' ? buildMultiAnglePrompt(p.data as any) : '';
    const finalPrompt = String((p.data as any)?.prompt || prompt || fallbackPrompt || '').trim();
    if (!finalPrompt) {
      const msg =
        kind === 'cinematic'
          ? '请先选择电影感风格或填写自定义补充'
          : kind === 'multi-angle-visual'
            ? '请先调整机位或选择多角度预设'
            : '请先选择运镜动作或填写自定义补充';
      setError(msg);
      throw new Error(msg);
    }
    setError('');
    const nodes = rf.getNodes();
    const edges = rf.getEdges();
    const downstreamOutputIds = new Set(
      edges
        .filter((e) => e.source === p.id)
        .map((e) => nodes.find((n) => n.id === e.target))
        .filter((n): n is Node => !!n && n.type === 'output')
        .map((n) => n.id),
    );

    if (downstreamOutputIds.size > 0) {
      rf.setNodes((nds) =>
        nds.map((n) => {
          if (!downstreamOutputIds.has(n.id)) return n;
          const nd = (n.data as any) || {};
          if (nd.directOutputText === finalPrompt) return n;
          return { ...n, data: { ...nd, directOutputText: finalPrompt } };
        }),
      );
      return;
    }

    const me = rf.getNode(p.id);
    const myW =
      (me as any)?.measured?.width ||
      (me as any)?.width ||
      (kind === 'cinematic' ? 720 : kind === 'multi-angle-visual' ? 760 : kind === 'video-motion' ? 720 : 540);
    const baseX = (me?.position?.x ?? 0) + myW + 80;
    const baseY = me?.position?.y ?? 0;
    const pos = placeSingleNode(baseX, baseY, 'output', nodes, { source: `placement:toolbox-output:${p.id}` });
    const ts = Date.now();
    const newId = `output-auto-toolbox-${p.id}-${ts}-${Math.random().toString(36).slice(2, 6)}`;
    const newNode: Node = {
      id: newId,
      type: 'output',
      position: pos,
      data: { directOutputText: finalPrompt },
      selected: false,
    } as Node;
    const newEdge: Edge = {
      id: `e-auto-toolbox-${newId}`,
      source: p.id,
      target: newId,
      type: 'deletable',
    } as Edge;
    rf.addNodes(newNode);
    rf.setEdges((eds) => [...eds, newEdge]);
  };

  useRunTrigger(p.id, handleRun);

  if (kind === 'multi-angle-visual') {
    return (
      <div
        className={`t8-node relative transition-all ${p.selected ? 'ring-2 ring-cyan-300' : ''}`}
        style={{ width: 760, maxWidth: 760 }}
      >
        <Handle type="target" position={Position.Left} style={{ background: 'var(--t8-secondary)', border: 0 }} />
        <Handle type="source" position={Position.Right} style={{ background: 'var(--t8-accent)', border: 0 }} />

        <div className="t8-node-header flex items-center gap-2 px-3 py-2 rounded-t-[inherit]">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{
              background: 'color-mix(in srgb, var(--t8-accent) 18%, var(--t8-bg-panel-elevated))',
              color: 'var(--t8-accent)',
              boxShadow: 'inset 0 0 0 1px var(--t8-accent)',
            }}
          >
            <Box size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">可视化多角度</div>
            <div className="text-[10px] truncate" style={{ color: 'var(--t8-text-dim)' }}>
              方位 / 俯仰 / 远近 → Qwen 多角度提示词
            </div>
          </div>
          <button
            type="button"
            style={miniIconControlStyle}
            title="重置机位"
            aria-label="重置多角度机位"
            onClick={clearMultiAngle}
          >
            <RotateCcw size={13} />
          </button>
        </div>

        <div className="p-3 nodrag" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-[340px_1fr] gap-3 items-start">
            <div className="space-y-2 min-w-0">
              <MultiAngleStage
                azimuth={multiAngleAzimuth}
                elevation={multiAngleElevation}
                distance={multiAngleDistance}
                imageUrl={upstreamPreviewImage}
                clipId={`multi-angle-preview-${p.id}`}
                onChange={updateMultiAngle}
              />

              <div className="t8-card px-2.5 py-2 text-[10px] leading-relaxed">
                <div className="flex items-center gap-2 mb-1" style={{ color: 'var(--t8-text-dim)' }}>
                  <Sparkles size={10} />
                  <span className="font-bold">输出 prompt</span>
                  <span className="truncate">
                    {multiAngleLabels.hZh} / {multiAngleLabels.vZh} / {multiAngleLabels.zZh}
                  </span>
                  <button
                    type="button"
                    className="ml-auto"
                    title="复制输出文本"
                    aria-label="复制输出文本"
                    onClick={copyPrompt}
                    disabled={!(prompt || kind === 'multi-angle-visual')}
                    style={{
                      ...miniIconControlStyle,
                      width: 24,
                      minWidth: 24,
                      height: 24,
                      minHeight: 24,
                      opacity: prompt || kind === 'multi-angle-visual' ? 1 : 0.45,
                      cursor: prompt || kind === 'multi-angle-visual' ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Copy size={11} />
                  </button>
                </div>
                <div className="min-h-[72px] max-h-28 overflow-y-auto pr-1 whitespace-pre-wrap break-words" style={{ color: prompt ? 'var(--t8-text-main)' : 'var(--t8-text-dim)' }}>
                  {prompt || buildMultiAnglePrompt(d)}
                </div>
              </div>
            </div>

            <div className="space-y-2 min-w-0">
              <section className="t8-card p-2 space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                  <SlidersHorizontal size={12} />
                  精准调节
                </div>
                <div className="grid grid-cols-[52px_1fr_40px] gap-2 items-center text-[11px]">
                  <span style={{ color: 'var(--t8-text-dim)' }}>水平</span>
                  <input type="range" min={0} max={360} step={1} value={roundAngle(multiAngleAzimuth)} onChange={(e) => updateMultiAngle({ multiAngleAzimuth: Number(e.target.value) })} style={{ accentColor: 'var(--t8-accent)' }} />
                  <span className="text-right font-bold">{roundAngle(multiAngleAzimuth)}°</span>
                  <span style={{ color: 'var(--t8-text-dim)' }}>垂直</span>
                  <input type="range" min={-30} max={60} step={1} value={roundAngle(multiAngleElevation)} onChange={(e) => updateMultiAngle({ multiAngleElevation: Number(e.target.value) })} style={{ accentColor: 'var(--t8-secondary)' }} />
                  <span className="text-right font-bold">{roundAngle(multiAngleElevation)}°</span>
                  <span style={{ color: 'var(--t8-text-dim)' }}>远近</span>
                  <input type="range" min={0} max={10} step={0.1} value={multiAngleDistance} onChange={(e) => updateMultiAngle({ multiAngleDistance: Number(e.target.value) })} style={{ accentColor: 'var(--t8-warning, #f59e0b)' }} />
                  <span className="text-right font-bold">{multiAngleDistance.toFixed(1)}</span>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-2">
                <div className="t8-card p-2 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                    <Compass size={12} />
                    角度列表
                  </div>
                  <select
                    className={compactSelectClass}
                    value={selectedAzimuthPresetId}
                    onChange={(e) => {
                      const ps = MULTI_ANGLE_AZIMUTH_PRESETS.find((item) => item.id === e.target.value);
                      if (ps) updateMultiAngle({ multiAngleAzimuth: ps.azimuth });
                    }}
                  >
                    <option value="">方向：当前 {roundAngle(multiAngleAzimuth)}°</option>
                    {MULTI_ANGLE_AZIMUTH_PRESETS.map((ps) => <option key={ps.id} value={ps.id}>{ps.label}</option>)}
                  </select>
                  <select
                    className={compactSelectClass}
                    value={selectedElevationPresetId}
                    onChange={(e) => {
                      const ps = MULTI_ANGLE_ELEVATION_PRESETS.find((item) => item.id === e.target.value);
                      if (ps) updateMultiAngle({ multiAngleElevation: ps.elevation });
                    }}
                  >
                    <option value="">高度：当前 {roundAngle(multiAngleElevation)}°</option>
                    {MULTI_ANGLE_ELEVATION_PRESETS.map((ps) => <option key={ps.id} value={ps.id}>{ps.label}</option>)}
                  </select>
                  <select
                    className={compactSelectClass}
                    value={selectedDistancePresetId}
                    onChange={(e) => {
                      const ps = MULTI_ANGLE_DISTANCE_PRESETS.find((item) => item.id === e.target.value);
                      if (ps) updateMultiAngle({ multiAngleDistance: ps.distance });
                    }}
                  >
                    <option value="">远近：当前 {multiAngleDistance.toFixed(1)}</option>
                    {MULTI_ANGLE_DISTANCE_PRESETS.map((ps) => <option key={ps.id} value={ps.id}>{ps.label}</option>)}
                  </select>
                  <select
                    className={compactSelectClass}
                    value={selectedCreativePresetId}
                    onChange={(e) => {
                      const ps = MULTI_ANGLE_CREATIVE_PRESETS.find((item) => item.id === e.target.value);
                      if (ps) updateMultiAngle({ multiAngleAzimuth: ps.azimuth, multiAngleElevation: ps.elevation, multiAngleDistance: ps.distance });
                    }}
                  >
                    <option value="">快捷机位</option>
                    {MULTI_ANGLE_CREATIVE_PRESETS.map((ps) => <option key={ps.id} value={ps.id}>{ps.label}</option>)}
                  </select>
                </div>

                <div className="t8-card p-2 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                    <Wand2 size={12} />
                    输出设置
                  </div>
                  <select className={compactSelectClass} value={multiAngleBatchMode} onChange={(e) => updateMultiAngle({ multiAngleBatchMode: e.target.value as MultiAngleBatchMode })}>
                    {MULTI_ANGLE_BATCH_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}{preset.id === 'single' ? '' : ` · ${preset.id === 'custom' ? multiAngleBatchAngles.length || 0 : preset.angles.length}条`}
                      </option>
                    ))}
                  </select>
                  {multiAngleBatchMode === 'custom' && (
                    <input className="t8-input w-full h-8 px-2 text-[11px]" value={d?.multiAngleBatchCustomAngles || ''} placeholder="0,45,90,180" onChange={(e) => updateMultiAngle({ multiAngleBatchCustomAngles: e.target.value })} />
                  )}
                  <select className={compactSelectClass} value={multiAnglePromptMode} onChange={(e) => updateMultiAngle({ multiAnglePromptMode: e.target.value as MultiAnglePromptMode })}>
                    <option value="qwen">Prompt：Qwen</option>
                    <option value="general">Prompt：通用</option>
                    <option value="dual">Prompt：双格式</option>
                  </select>
                  <select className={compactSelectClass} value={multiAngleLanguage} onChange={(e) => updateMultiAngle({ multiAngleLanguage: e.target.value as PromptLanguage })}>
                    <option value="en">语言：EN</option>
                    <option value="zh">语言：中</option>
                  </select>
                </div>
              </section>

              <section className="t8-card p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                  <Film size={12} />
                  文本补充
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <input className="t8-input h-8 px-2 text-[11px]" value={d?.multiAnglePrefix || ''} placeholder="前缀" onChange={(e) => updateMultiAngle({ multiAnglePrefix: e.target.value })} />
                  <input className="t8-input h-8 px-2 text-[11px]" value={d?.multiAngleCustom || ''} placeholder="补充" onChange={(e) => updateMultiAngle({ multiAngleCustom: e.target.value })} />
                  <input className="t8-input h-8 px-2 text-[11px]" value={d?.multiAngleSuffix || ''} placeholder="后缀" onChange={(e) => updateMultiAngle({ multiAngleSuffix: e.target.value })} />
                </div>
              </section>

              <section className="t8-card p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                  <Star size={12} />
                  镜头收藏
                  <button type="button" className={`${miniChipClass} ml-auto`} onClick={addMultiAngleFavorite} title="收藏当前机位">
                    <Star size={10} />
                    收藏
                  </button>
                  <label className={`${miniChipClass} cursor-pointer`} title="导入角度预设 JSON">
                    <FolderOpen size={10} />
                    导入
                    <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { importMultiAnglePresets(e.target.files?.[0]); e.currentTarget.value = ''; }} />
                  </label>
                  <button type="button" className={miniChipClass} onClick={exportMultiAnglePresets} title="导出角度预设 JSON">
                    <Download size={10} />
                    导出
                  </button>
                </div>
                {multiAngleFavorites.length > 0 ? (
                  <div
                    className="nowheel grid max-h-28 grid-cols-1 gap-1 overflow-y-auto overscroll-contain pr-2"
                    onWheelCapture={(e) => e.stopPropagation()}
                    onWheel={(e) => e.stopPropagation()}
                  >
                    {multiAngleFavorites.map((favorite) => {
                      const title = `${favorite.label}: ${favorite.azimuth}° / ${favorite.elevation}° / ${favorite.distance}`;
                      return (
                        <div key={favorite.id} className="grid min-w-0 grid-cols-[1fr_26px] items-center gap-1.5">
                          <button type="button" className={favoriteChipClass} title={title} onClick={() => applyMultiAngleFavorite(favorite)}>
                            <span className="block min-w-0 flex-1 truncate px-0.5">{favorite.label}</span>
                          </button>
                          <button type="button" style={{ ...miniIconControlStyle, width: 24, minWidth: 24, height: 24, minHeight: 24 }} title="删除收藏" aria-label="删除收藏" onClick={() => removeMultiAngleFavorite(favorite.id)}>
                            <Trash2 size={10} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>
                    收藏常用机位后，可一键应用并随画布保存。
                  </div>
                )}
              </section>
            </div>
          </div>

          <button type="button" className="t8-btn t8-btn-primary w-full min-h-9 text-xs mt-3" onClick={() => requestCanvasNodeRun(p.id)}>
            <Play size={13} fill="currentColor" />
            运行输出文本
          </button>
          {error && <div className="text-[10px] mt-1" style={{ color: 'var(--t8-danger, #ef4444)' }}>{error}</div>}
        </div>
      </div>
    );
  }

  if (kind === 'video-motion') {
    const motionSelects: Array<{ field: MotionField; label: string; items: Preset[]; value: string }> = [
      { field: 'motionSceneId', label: '成片场景', items: MOTION_SCENE_PRESETS, value: selectedMotionSceneId },
      { field: 'motionActionId', label: '运镜动作', items: MOTION_ACTION_PRESETS, value: selectedMotionActionId },
      { field: 'motionPathId', label: '运动路径', items: motionGroupItems('motionPathId'), value: selectedMotionPathId },
      { field: 'motionTempoId', label: '节奏速度', items: motionGroupItems('motionTempoId'), value: selectedMotionTempoId },
      { field: 'motionStabilityId', label: '稳定质感', items: motionGroupItems('motionStabilityId'), value: selectedMotionStabilityId },
      { field: 'motionSubjectId', label: '主体约束', items: motionGroupItems('motionSubjectId'), value: selectedMotionSubjectId },
    ];

    return (
      <div
        className={`t8-node relative transition-all ${p.selected ? 'ring-2 ring-violet-300' : ''}`}
        style={{ width: 720, maxWidth: 720 }}
      >
        <Handle type="source" position={Position.Right} style={{ background: 'var(--t8-accent)', border: 0 }} />

        <div className="t8-node-header flex items-center gap-2 px-3 py-2 rounded-t-[inherit]">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{
              background: 'color-mix(in srgb, var(--t8-accent) 18%, var(--t8-bg-panel-elevated))',
              color: 'var(--t8-accent)',
              boxShadow: 'inset 0 0 0 1px var(--t8-accent)',
            }}
          >
            <Film size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">视频运镜组合器</div>
            <div className="text-[10px] truncate" style={{ color: 'var(--t8-text-dim)' }}>
              列表选择 / 路径预览 / 收藏复用
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              style={miniIconControlStyle}
              title="清空"
              aria-label="清空视频运镜设置"
              onClick={clearMotion}
            >
              <RotateCcw size={13} />
            </button>
          </div>
        </div>

        <div className="p-3 space-y-2.5 nodrag" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-[260px_1fr] gap-3 items-start">
            <div className="space-y-2">
              <MotionRoutePreview actionId={selectedMotionActionId} pathId={selectedMotionPathId} />

              <div className="t8-card px-2.5 py-2 text-[10px] leading-relaxed">
                <div className="flex items-center gap-2 mb-1" style={{ color: 'var(--t8-text-dim)' }}>
                  <Sparkles size={10} />
                  <span className="font-bold">输出到下游 prompt</span>
                  <button
                    type="button"
                    className="ml-auto"
                    title="复制输出文本"
                    aria-label="复制输出文本"
                    onClick={copyPrompt}
                    disabled={!prompt}
                    style={{
                      ...miniIconControlStyle,
                      width: 24,
                      minWidth: 24,
                      height: 24,
                      minHeight: 24,
                      opacity: prompt ? 1 : 0.45,
                      cursor: prompt ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Copy size={11} />
                  </button>
                </div>
                <div
                  className="min-h-[74px] max-h-28 overflow-y-auto pr-1 break-words"
                  style={{ color: prompt ? 'var(--t8-text-main)' : 'var(--t8-text-dim)' }}
                >
                  {prompt || '用右侧列表选择场景、动作和约束，或导入已有 JSON 预设。'}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <section className="t8-card p-2 space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                  <SlidersHorizontal size={12} />
                  运镜配置
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {motionSelects.map((select) => (
                    <label key={select.field} className="min-w-0 space-y-1">
                      <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>{select.label}</span>
                      <select
                        className={compactSelectClass}
                        value={select.value}
                        onChange={(e) => updateMotion({ [select.field]: e.target.value } as MotionPatch)}
                      >
                        <option value="">{select.label}：未选择</option>
                        {select.items.map((ps) => (
                          <option key={ps.id} value={ps.id}>{ps.label}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label className="min-w-0 space-y-1">
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>语言</span>
                    <select className={compactSelectClass} value={motionLang} onChange={(e) => updateMotion({ motionLanguage: e.target.value as PromptLanguage })}>
                      <option value="en">英文 prompt</option>
                      <option value="zh">中文 prompt</option>
                    </select>
                  </label>
                  <label className="min-w-0 space-y-1">
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>补充</span>
                    <input
                      className="t8-input w-full h-8 px-2 text-[11px]"
                      value={d?.motionCustom || ''}
                      placeholder="慢动作 / 穿过雨幕 / 不切镜"
                      onChange={(e) => updateMotion({ motionCustom: e.target.value })}
                    />
                  </label>
                </div>
              </section>

              <section className="t8-card p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                  <Star size={12} />
                  运镜收藏
                  <button type="button" className={`${miniChipClass} ml-auto`} onClick={addMotionFavorite} title="收藏当前视频运镜组合">
                    <Star size={10} />
                    收藏
                  </button>
                  <label className={`${miniChipClass} cursor-pointer`} title="导入视频运镜 JSON">
                    <FolderOpen size={10} />
                    导入
                    <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { importMotionPresets(e.target.files?.[0]); e.currentTarget.value = ''; }} />
                  </label>
                  <button type="button" className={miniChipClass} onClick={exportMotionPresets} title="导出视频运镜 JSON">
                    <Download size={10} />
                    导出
                  </button>
                </div>
                {motionFavorites.length > 0 ? (
                  <div
                    className="nowheel grid max-h-24 grid-cols-1 gap-1 overflow-y-auto overscroll-contain pr-2"
                    onWheelCapture={(e) => e.stopPropagation()}
                    onWheel={(e) => e.stopPropagation()}
                  >
                    {motionFavorites.map((favorite) => (
                      <div key={favorite.id} className="grid min-w-0 grid-cols-[1fr_26px] items-center gap-1.5">
                        <button type="button" className={favoriteChipClass} title={favorite.label} onClick={() => applyMotionFavorite(favorite)}>
                          <span className="block min-w-0 flex-1 truncate px-0.5">{favorite.label}</span>
                        </button>
                        <button type="button" style={{ ...miniIconControlStyle, width: 24, minWidth: 24, height: 24, minHeight: 24 }} title="删除收藏" aria-label="删除收藏" onClick={() => removeMotionFavorite(favorite.id)}>
                          <Trash2 size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>
                    收藏常用运镜组合后，可一键套用并随画布保存。
                  </div>
                )}
              </section>
            </div>
          </div>

          <button type="button" className="t8-btn t8-btn-primary w-full min-h-9 text-xs" onClick={() => requestCanvasNodeRun(p.id)}>
            <Play size={13} fill="currentColor" />
            运行输出文本
          </button>
          {error && <div className="text-[10px]" style={{ color: 'var(--t8-danger, #ef4444)' }}>{error}</div>}
        </div>
      </div>
    );
  }

  const cinematicSelects: Array<{ field: CinematicField; label: string; items: Preset[]; value: string }> = [
    { field: 'cinematicPresetId', label: '成片风格', items: CINEMATIC_PRESETS, value: selectedBaseId },
    { field: 'cinematicShotId', label: '镜头', items: cinematicGroupItems('cinematicShotId'), value: selectedCinematicShotId },
    { field: 'cinematicLightId', label: '光影', items: cinematicGroupItems('cinematicLightId'), value: selectedCinematicLightId },
    { field: 'cinematicColorId', label: '调色', items: cinematicGroupItems('cinematicColorId'), value: selectedCinematicColorId },
    { field: 'cinematicTextureId', label: '质感', items: cinematicGroupItems('cinematicTextureId'), value: selectedCinematicTextureId },
  ];

  return (
    <div
      className={`t8-node relative transition-all ${p.selected ? 'ring-2 ring-pink-300' : ''}`}
      style={{ width: 720, maxWidth: 720 }}
    >
      <Handle type="source" position={Position.Right} style={{ background: 'var(--t8-accent)', border: 0 }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2 rounded-t-[inherit]">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{
            background: 'color-mix(in srgb, var(--t8-secondary) 18%, var(--t8-bg-panel-elevated))',
            color: 'var(--t8-secondary)',
            boxShadow: 'inset 0 0 0 1px var(--t8-secondary)',
          }}
        >
          <Clapperboard size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">电影感组合器</div>
          <div className="text-[10px] truncate" style={{ color: 'var(--t8-text-dim)' }}>
            列表选择 / 收藏复用 / JSON
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            style={miniIconControlStyle}
            title="清空"
            aria-label="清空电影感设置"
            onClick={clearCinematic}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      <div className="p-3 space-y-2.5 nodrag" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="grid grid-cols-[260px_1fr] gap-3 items-start">
          <div className="space-y-2">
            <div className="t8-card px-2.5 py-2 text-[10px] leading-relaxed">
              <div className="flex items-center gap-2 mb-1" style={{ color: 'var(--t8-text-dim)' }}>
                <Sparkles size={10} />
                <span className="font-bold">输出到下游 prompt</span>
                <button
                  type="button"
                  className="ml-auto"
                  title="复制输出文本"
                  aria-label="复制输出文本"
                  onClick={copyPrompt}
                  disabled={!prompt}
                  style={{
                    ...miniIconControlStyle,
                    width: 24,
                    minWidth: 24,
                    height: 24,
                    minHeight: 24,
                    opacity: prompt ? 1 : 0.45,
                    cursor: prompt ? 'pointer' : 'not-allowed',
                  }}
                >
                  <Copy size={11} />
                </button>
              </div>
              <div
                className="min-h-[128px] max-h-40 overflow-y-auto pr-1 break-words"
                style={{ color: prompt ? 'var(--t8-text-main)' : 'var(--t8-text-dim)' }}
              >
                {prompt || '用右侧列表选择成片风格，再叠加镜头、光影、调色和质感。'}
              </div>
            </div>

            <section className="t8-card p-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
                <Star size={12} />
                电影收藏
                <button type="button" className={`${miniChipClass} ml-auto`} onClick={addCinematicFavorite} title="收藏当前电影感组合">
                  <Star size={10} />
                  收藏
                </button>
                <label className={`${miniChipClass} cursor-pointer`} title="导入电影感 JSON">
                  <FolderOpen size={10} />
                  导入
                  <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { importCinematicPresets(e.target.files?.[0]); e.currentTarget.value = ''; }} />
                </label>
                <button type="button" className={miniChipClass} onClick={exportCinematicPresets} title="导出电影感 JSON">
                  <Download size={10} />
                  导出
                </button>
              </div>
              {cinematicFavorites.length > 0 ? (
                <div
                  className="nowheel grid max-h-24 grid-cols-1 gap-1 overflow-y-auto overscroll-contain pr-2"
                  onWheelCapture={(e) => e.stopPropagation()}
                  onWheel={(e) => e.stopPropagation()}
                >
                  {cinematicFavorites.map((favorite) => (
                    <div key={favorite.id} className="grid min-w-0 grid-cols-[1fr_26px] items-center gap-1.5">
                      <button type="button" className={favoriteChipClass} title={favorite.label} onClick={() => applyCinematicFavorite(favorite)}>
                        <span className="block min-w-0 flex-1 truncate px-0.5">{favorite.label}</span>
                      </button>
                      <button type="button" style={{ ...miniIconControlStyle, width: 24, minWidth: 24, height: 24, minHeight: 24 }} title="删除收藏" aria-label="删除收藏" onClick={() => removeCinematicFavorite(favorite.id)}>
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>
                  收藏常用电影风格组合后，可一键套用并随画布保存。
                </div>
              )}
            </section>
          </div>

          <section className="t8-card p-2 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--t8-text-muted)' }}>
              <SlidersHorizontal size={12} />
              电影配置
            </div>
            <div className="grid grid-cols-2 gap-2">
              {cinematicSelects.map((select) => (
                <label key={select.field} className="min-w-0 space-y-1">
                  <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>{select.label}</span>
                  <select
                    className={compactSelectClass}
                    value={select.value}
                    onChange={(e) => updateCinematic({ [select.field]: e.target.value } as CinematicPatch)}
                  >
                    <option value="">{select.label}：未选择</option>
                    {select.items.map((ps) => (
                      <option key={ps.id} value={ps.id}>{ps.label}</option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="min-w-0 space-y-1">
                <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>强度</span>
                <select className={compactSelectClass} value={selectedStrength} onChange={(e) => updateCinematic({ cinematicStrength: e.target.value })}>
                  {STRENGTH_PRESETS.map((ps) => (
                    <option key={ps.id} value={ps.id}>{ps.label}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 space-y-1">
                <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>语言</span>
                <select className={compactSelectClass} value={cinematicLang} onChange={(e) => updateCinematic({ cinematicLanguage: e.target.value as PromptLanguage })}>
                  <option value="en">英文 prompt</option>
                  <option value="zh">中文 prompt</option>
                </select>
              </label>
              <label className="min-w-0 space-y-1 col-span-2">
                <span className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-dim)' }}>补充</span>
                <input
                  className="t8-input w-full h-8 px-2 text-[11px]"
                  value={d?.cinematicCustom || ''}
                  placeholder="如雨夜 / 宫崎骏 / 冷白皮"
                  onChange={(e) => updateCinematic({ cinematicCustom: e.target.value })}
                />
              </label>
            </div>
          </section>
        </div>

        <button type="button" className="t8-btn t8-btn-primary w-full min-h-9 text-xs" onClick={() => requestCanvasNodeRun(p.id)}>
          <Play size={13} fill="currentColor" />
          运行输出文本
        </button>
        {error && <div className="text-[10px]" style={{ color: 'var(--t8-danger, #ef4444)' }}>{error}</div>}
      </div>
    </div>
  );
};

export default memo(ToolboxParamNode);
