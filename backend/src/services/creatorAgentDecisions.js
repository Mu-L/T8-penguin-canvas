const crypto = require('node:crypto');

const CREATOR_DECISION_DOCUMENT_SCHEMA = 't8-creator-decision-document-v1';
const CREATOR_DECISION_DOCUMENT_MAX_VERSIONS = 120;
const CREATOR_DECISION_PHASES = Object.freeze([
  'idea',
  'script',
  'assets',
  'shots',
  'candidates',
  'delivery',
]);

function text(value, maximum = 4_000) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maximum);
}

function stableString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(stableString(value)).digest('hex');
}

function normalizedPhase(value) {
  const phase = text(value, 40).toLowerCase();
  return CREATOR_DECISION_PHASES.includes(phase) ? phase : 'idea';
}

function inferredFamily(input = {}) {
  const explicit = text(input.family, 40).toLowerCase();
  if (['story', 'commerce', 'image', 'video', 'audio', 'mixed'].includes(explicit)) {
    return explicit;
  }
  const kind = text(input.kind, 40).toLowerCase();
  const prompt = text(input.prompt, 20_000);
  if (/电商|商品|详情页|主图|卖点|品牌|海报|广告|tvc|投放/u.test(prompt)) return 'commerce';
  if (['story', 'script'].includes(kind)) return 'story';
  if (['image', 'edit-image'].includes(kind)) return 'image';
  if (['video', 'edit-video'].includes(kind)) return 'video';
  if (kind === 'audio') return 'audio';
  return 'mixed';
}

function option(id, label, description, value, creatorPrompt, action = 'answer') {
  return Object.freeze({
    id,
    label,
    description,
    value,
    creatorPrompt,
    action,
  });
}

function decision(id, topic, question, whyItMatters, options) {
  return Object.freeze({
    id,
    kind: 'choice',
    topic,
    question,
    whyItMatters,
    options: Object.freeze(options),
  });
}

const COMMON_PHASE_DECISIONS = Object.freeze({
  script: Object.freeze([
    decision(
      'script-structure',
      '叙事结构',
      '这版剧本最适合用哪种推进结构？',
      '它会直接决定开场、转折和结尾如何分配篇幅。',
      [
        option('progressive', '层层升级', '冲突逐步加码，适合剧情与情绪片。', '层层升级', '按“建立目标—阻力升级—关键选择—结果收束”重写本阶段完整剧本。'),
        option('contrast', '前后反差', '用强烈变化制造记忆点，适合短片和广告。', '前后反差', '按“问题状态—触发变化—结果对照”重写本阶段完整剧本。'),
        option('slice', '生活切片', '以细节和关系积累情绪，适合温馨与人物片。', '生活切片', '用一段具体生活事件推进关系变化，交付完整可拍剧本。'),
      ],
    ),
    decision(
      'script-viewpoint',
      '叙事视角',
      '观众主要跟随谁来经历这段内容？',
      '统一视角能避免场景跳跃和角色动机分散。',
      [
        option('protagonist', '紧跟主角', '信息随主角行动逐步揭示。', '主角视角', '保持主线不变，所有场景优先服务主角目标与感受。'),
        option('dual', '双主角交替', '两方都保留动机与变化。', '双主角交替', '把关键场景按双主角交替推进，并在高潮汇合。'),
        option('observer', '旁观式呈现', '少解释，用动作、空间和细节表达。', '旁观视角', '减少解释性对白，用可见动作、环境和声音推进剧情。'),
      ],
    ),
    decision(
      'script-dialogue',
      '对白密度',
      '对白和画面动作的比例采用哪一种？',
      '它会影响可拍性、节奏和后续声音资产。',
      [
        option('visual-first', '画面优先', '用动作和表情表达，只保留必要对白。', '画面优先', '删去解释性对白，让关键情绪和信息通过动作与画面完成。'),
        option('balanced', '对白与动作平衡', '信息清楚，同时保留可见动作。', '平衡对白', '让每句对白都推动行动，并为每段对白配置对应的可拍动作。'),
        option('dialogue-led', '对白驱动', '适合访谈、冲突对话和角色关系戏。', '对白驱动', '以有潜台词的对白推动关系变化，避免纯说明。'),
      ],
    ),
  ]),
  assets: Object.freeze([
    decision(
      'asset-source-policy',
      '素材来源',
      '缺失资产优先用哪种补齐方式？',
      '这会决定成本、速度和后续一致性；已有素材始终受到保护。',
      [
        option('upload-first', '已有与本地上传优先', '先用用户已有素材，只列仍缺的部分。', '上传优先', '保护所有上传、采用和锁定素材，只整理真正缺失项，不自动生成。'),
        option('library-first', '资产库优先', '先复用项目资产库，再补缺失项。', '资产库优先', '先匹配项目资产库中的可验证素材，再列无法匹配的缺失项。'),
        option('ai-missing-only', '仅缺失项用 AI', '已有素材不动，只为明确缺失项准备生成。', 'AI 仅补缺失', '保留已有素材，只为缺失资产写可编辑提示词和生成计划，不自动提交。'),
      ],
    ),
    decision(
      'asset-continuity',
      '一致性锁定',
      '本项目首先锁定哪类一致性？',
      '锁定优先级会影响角色、商品或场景在后续镜头中的稳定程度。',
      [
        option('identity', '主体身份与外观', '先锁脸、体态、商品形状和关键标识。', '身份外观', '把主体身份、比例、关键轮廓和不可变特征写成最高优先级锁定规则。'),
        option('world', '场景与视觉世界', '先锁时代、空间、色彩和光向。', '场景世界', '把场景时代、地理、材质、色彩和主光方向写成最高优先级锁定规则。'),
        option('wardrobe-props', '服装与道具', '先锁服装、配饰和关键道具状态。', '服装道具', '把服装、配饰、道具及其前后状态写成最高优先级锁定规则。'),
      ],
    ),
    decision(
      'asset-priority',
      '制作优先级',
      '资产应该按什么顺序准备？',
      '优先级决定哪些素材先进入分镜验证，避免一次性生成无用资产。',
      [
        option('story-impact', '按叙事重要性', '先做主角、核心场景和关键道具。', '叙事重要性', '按对剧情和镜头影响从高到低排列资产，并标出可延后项。'),
        option('reuse', '按复用次数', '先做会跨多个镜头重复使用的资产。', '复用次数', '按镜头复用频率排序，优先建立可反复引用的资产。'),
        option('risk', '按制作风险', '先验证最难保持一致或最可能失败的资产。', '制作风险', '按一致性和生成难度排序，先验证风险最高的资产。'),
      ],
    ),
  ]),
  shots: Object.freeze([
    decision(
      'shots-language',
      '镜头语言',
      '这组分镜采用哪种主导镜头语言？',
      '统一镜头语言能让镜头表更清晰，也便于后续生成保持风格。',
      [
        option('restrained', '克制稳定', '固定机位、缓慢运动，强调表演和构图。', '克制稳定', '以稳定机位和少量必要运动重排完整镜头表。'),
        option('immersive', '沉浸跟随', '跟拍、主观与近距离动作增强在场感。', '沉浸跟随', '以跟随主体行动的沉浸视角重排完整镜头表。'),
        option('graphic', '强构图与剪辑', '用明确景别对比和切点制造视觉冲击。', '强构图剪辑', '以景别反差、构图变化和清晰切点重排完整镜头表。'),
      ],
    ),
    decision(
      'shots-rhythm',
      '节奏密度',
      '镜头节奏以哪一种为主？',
      '它会直接影响镜头数量、平均时长和动作完整性。',
      [
        option('slow', '舒缓留白', '镜头较长，适合情绪与氛围。', '舒缓', '减少无效切换，保留动作起止和情绪停顿。'),
        option('balanced', '清晰均衡', '信息推进和观看舒适度平衡。', '均衡', '保持镜头职责单一，按信息变化设置切点。'),
        option('fast', '紧凑有力', '短镜头和动作切点更密集。', '紧凑', '压缩停顿并强化动作切点，但不得牺牲连续性。'),
      ],
    ),
    decision(
      'shots-sound',
      '声音策略',
      '声音在这组分镜中承担什么主要作用？',
      '声音策略会决定镜头表中的对白、环境、音效和音乐标注。',
      [
        option('dialogue', '对白信息优先', '保证台词清楚，其他声音让位。', '对白优先', '逐镜补齐对白进入点、停顿和环境声避让。'),
        option('environment', '环境与动作优先', '用空间声和动作声增强真实感。', '环境动作', '逐镜标注环境声层次和关键动作音效。'),
        option('music', '音乐情绪优先', '用音乐结构推动段落和转折。', '音乐情绪', '逐镜标注音乐进入、变化、停顿和收束位置。'),
      ],
    ),
  ]),
  candidates: Object.freeze([
    decision(
      'candidate-count',
      '候选策略',
      '每个镜头采用哪种候选策略？',
      '候选数会影响成本、比较质量和重试范围。',
      [
        option('single', '单候选快速验证', '先验证链路与构图，再决定是否扩展。', '单候选', '每镜先准备一个低成本候选并明确验收标准。'),
        option('two', '双候选对比', '在成本与可比较性之间平衡。', '双候选', '每镜准备两个差异明确的候选方向。'),
        option('three', '三候选择优', '关键镜头用三种方向充分比较。', '三候选', '关键镜头准备三个有明确差异的候选，其余保持精简。'),
      ],
    ),
    decision(
      'candidate-criterion',
      '采用标准',
      '候选首先按什么标准取舍？',
      '明确首要标准能避免只凭瞬时观感反复重做。',
      [
        option('continuity', '一致性优先', '身份、服装、商品、场景和光向先过关。', '一致性', '先按连续性筛除不合格候选，再比较美感。'),
        option('performance', '动作与表达优先', '动作完整、情绪准确、信息清楚。', '动作表达', '先按动作起止、表演和信息传达筛选。'),
        option('visual', '视觉完成度优先', '构图、光影、材质和清晰度优先。', '视觉完成度', '先按构图、光影、材质和画质筛选。'),
      ],
    ),
    decision(
      'candidate-retry',
      '重试边界',
      '不满意时采用哪种重试规则？',
      '它决定成功素材是否被保护，以及允许变化的范围。',
      [
        option('failed-only', '只重试失败项', '成功和已采用结果全部保留。', '失败项重试', '只列明确失败项的重试计划，成功结果保持不动。'),
        option('named-only', '只重试点名镜头', '由用户明确指定需要重做的镜头。', '点名重试', '只处理用户点名镜头，并写清允许变化与必须保留项。'),
        option('branch', '保留原版建探索分支', '不覆盖原候选，在新分支尝试。', '探索分支', '保留现有候选，建立独立探索分支进行变化。'),
      ],
    ),
  ]),
  delivery: Object.freeze([
    decision(
      'delivery-format',
      '成片规格',
      '最终交付首先面向哪种观看场景？',
      '它会决定画幅、分辨率、时长和安全区。',
      [
        option('vertical', '竖屏移动端', '9:16，适合短视频平台。', '竖屏移动端', '按竖屏移动端整理成片、字幕和封面规格。'),
        option('horizontal', '横屏播放', '16:9，适合桌面、电视和长视频。', '横屏播放', '按横屏播放整理成片、字幕和封面规格。'),
        option('multi', '主版加多尺寸变体', '先锁主版，再派生横竖版本。', '多尺寸变体', '先完成一个主版，再规划不破坏构图的横竖尺寸变体。'),
      ],
    ),
    decision(
      'delivery-caption',
      '声音与字幕',
      '交付时优先采用哪种声音与字幕组合？',
      '它会影响可访问性、观看环境和文件清单。',
      [
        option('burned', '成片内嵌字幕', '直接可播放，适合社交平台。', '内嵌字幕', '准备带内嵌字幕的成片，并保留字幕安全区。'),
        option('separate', '独立字幕文件', '便于多语言和后期修改。', '独立字幕', '准备无字幕主片和独立字幕文件。'),
        option('both', '内嵌与独立都交付', '兼顾直接发布和后续修改。', '双字幕交付', '同时准备内嵌字幕成片、无字幕主片和独立字幕。'),
      ],
    ),
    decision(
      'delivery-package',
      '交付包范围',
      '最终交付包包含到什么程度？',
      '明确范围能避免漏掉封面、源素材、许可和校验信息。',
      [
        option('final-only', '仅发布成片', '成片、封面和必要字幕。', '发布成片', '交付成片、封面、字幕和播放核验信息。'),
        option('editable', '成片加可编辑素材', '增加已采用素材和制作清单。', '可编辑交付', '交付成片、封面、字幕、已采用素材和可编辑制作清单。'),
        option('archive', '完整归档包', '增加源素材、许可、摘要和版本记录。', '完整归档', '准备完整归档包，包含源素材、许可、摘要与版本记录。'),
      ],
    ),
  ]),
});

const IDEA_DECISIONS = Object.freeze({
  story: Object.freeze([
    decision(
      'idea-emotional-promise',
      '核心体验',
      '这次作品最想让观众记住哪种核心体验？',
      '它会决定故事事件、情绪变化和最终收束。',
      [
        option('relationship', '一段关系的变化', '让陪伴、理解、和解或告别成为核心。', '关系变化', '围绕一段具体关系变化完善创意简报，事件必须可见、可拍。'),
        option('goal', '一次目标与阻力', '让主体为一个明确目标采取行动。', '目标与阻力', '围绕明确目标、阻力和关键选择完善创意简报。'),
        option('wonder', '一个有记忆点的画面奇想', '用视觉事件和世界规则驱动内容。', '视觉奇想', '围绕一个可执行的视觉奇想完善创意简报，并写清世界规则。'),
      ],
    ),
    decision(
      'idea-audience-format',
      '观看场景',
      '首版最适合按哪种观看场景设计？',
      '观看场景会直接约束时长、画幅、信息密度和开场速度。',
      [
        option('short-vertical', '竖屏短视频', '15–60 秒，移动端快速进入事件。', '竖屏短视频', '按竖屏短视频给出推荐时长、开场钩子和画面安全区。'),
        option('short-horizontal', '横屏短片', '30–120 秒，保留空间与表演。', '横屏短片', '按横屏短片给出推荐时长、空间调度和节奏。'),
        option('flexible', '先做可改编母版', '先锁内容，再派生横竖版本。', '可改编母版', '先做内容母版，并标注横竖改编时必须保持的核心。'),
      ],
    ),
    decision(
      'idea-tone',
      '整体基调',
      '这版作品采用哪种主导基调？',
      '基调会统一表演、镜头、光色和声音。',
      [
        option('warm', '温暖克制', '真实细节、柔和情绪，不过度煽情。', '温暖克制', '把创意统一为温暖克制的动作、光色和声音方向。'),
        option('playful', '轻松有趣', '清晰节奏、反差与小惊喜。', '轻松有趣', '把创意统一为轻松有趣的事件、节奏和视觉反差。'),
        option('cinematic', '电影感张力', '强调气氛、冲突和画面化选择。', '电影感张力', '把创意统一为电影感张力，强化具体冲突、氛围和画面化结尾。'),
      ],
    ),
  ]),
  commerce: Object.freeze([
    decision(
      'commerce-objective',
      '商业目标',
      '这套内容首先要解决哪个商业目标？',
      '它决定卖点顺序、画面证据和行动引导。',
      [
        option('conversion', '直接促进下单', '首屏突出利益点、证据和行动。', '转化优先', '以转化为首要目标重排卖点、证据和行动页。'),
        option('understanding', '讲清产品价值', '让用户快速理解功能、差异和使用场景。', '理解优先', '以产品理解为首要目标组织逐屏内容。'),
        option('brand', '建立品牌信任', '突出质感、价值观和一致视觉。', '品牌信任', '以品牌信任为首要目标组织视觉与文案。'),
      ],
    ),
    decision(
      'commerce-audience',
      '目标人群',
      '首版主要对哪类购买者说话？',
      '明确人群能避免文案、场景和卖点泛化。',
      [
        option('practical', '重视实用与性价比', '关注功能、价格、耐用和省心。', '实用人群', '优先使用可验证功能、使用成本和场景证据。'),
        option('quality', '重视品质与审美', '关注材质、设计、细节和体验。', '品质人群', '优先使用可验证材质、设计与细节体验。'),
        option('gift', '礼赠或情绪消费', '关注体面、意义和分享场景。', '礼赠人群', '优先组织礼赠场景、情绪价值与包装体验。'),
      ],
    ),
    decision(
      'commerce-visual',
      '视觉路线',
      '商品首版采用哪种视觉路线？',
      '它会统一主图、详情页、场景图和后续视频。',
      [
        option('clean', '清晰可信', '干净背景、信息层级明确。', '清晰可信', '采用清晰可信的构图、光影和版式。'),
        option('lifestyle', '真实生活场景', '通过使用情境解释价值。', '生活场景', '采用真实生活场景展示使用方式和利益点。'),
        option('premium', '高质感棚拍', '强调材质、细节和品牌气质。', '高质感棚拍', '采用高质感棚拍路线，强化材质和细节。'),
      ],
    ),
  ]),
  image: Object.freeze([
    decision(
      'image-purpose',
      '图像用途',
      '这张图首先服务哪种用途？',
      '用途会决定构图、安全区、文字空间和细节优先级。',
      [
        option('hero', '封面或主视觉', '单一视觉中心，第一眼明确。', '主视觉', '按封面主视觉重构方案，保留明确视觉中心与标题安全区。'),
        option('detail', '产品或内容说明', '信息清楚，细节可读。', '说明图', '按说明图重构方案，优先可读性和事实表达。'),
        option('atmosphere', '氛围与情绪图', '强调光色、空间和感受。', '氛围图', '按氛围图重构方案，统一光色、空间和情绪。'),
      ],
    ),
    decision(
      'image-composition',
      '构图重点',
      '这张图用哪种构图关系突出主体？',
      '构图会影响主体识别、背景污染和后续裁切。',
      [
        option('centered', '稳定中心构图', '主体明确，适合封面和商品。', '中心构图', '采用稳定中心构图，背景只服务主体。'),
        option('environmental', '主体与环境叙事', '用空间关系解释情境。', '环境叙事', '采用环境叙事构图，保持主体清晰且空间有信息。'),
        option('dynamic', '动态斜线与前后层次', '强调动作和视觉冲击。', '动态构图', '采用动态构图，但保护主体比例和关键轮廓。'),
      ],
    ),
    decision(
      'image-finish',
      '成像质感',
      '首版采用哪种质感完成方向？',
      '质感会统一皮肤、材质、纹理、锐度和光影。',
      [
        option('natural', '自然真实', '纹理克制、肤质与材质可信。', '自然真实', '统一为自然真实质感，避免过度磨皮和锐化。'),
        option('polished', '商业精修', '干净、清晰、受控，适合广告。', '商业精修', '统一为商业精修质感，保留真实材质细节。'),
        option('stylized', '风格化表达', '允许明确色彩和纹理语言。', '风格化', '统一为风格化质感，并列出不可污染的主体特征。'),
      ],
    ),
  ]),
  video: Object.freeze([
    decision(
      'video-objective',
      '视频职责',
      '这段视频最主要完成什么任务？',
      '职责会决定镜头结构和开头三秒。',
      [
        option('story', '讲清一个事件', '有起因、变化和结果。', '事件叙事', '按一个完整事件组织视频结构。'),
        option('showcase', '展示主体或产品', '突出外观、动作和细节证据。', '主体展示', '按主体展示组织镜头与节奏。'),
        option('mood', '建立氛围和情绪', '用空间、光色和声音形成感受。', '氛围情绪', '按氛围建立组织镜头、光色和声音。'),
      ],
    ),
    decision(
      'video-rhythm',
      '节奏',
      '首版视频采用哪种节奏？',
      '它会影响镜头数、动作完整性和观看平台。',
      [
        option('slow', '舒缓', '镜头较长，强调情绪和空间。', '舒缓', '用舒缓节奏组织开头、中段和结尾。'),
        option('balanced', '均衡', '信息清楚，观看自然。', '均衡', '用均衡节奏组织镜头职责和切点。'),
        option('fast', '紧凑', '快速切换，适合广告和动作内容。', '紧凑', '用紧凑节奏组织镜头，但保留动作起止。'),
      ],
    ),
    decision(
      'video-sound',
      '声音重点',
      '声音首先服务哪一种体验？',
      '它会决定对白、环境、音效和音乐的优先级。',
      [
        option('dialogue', '对白或旁白', '信息清楚，音乐让位。', '对白旁白', '以对白或旁白可懂度为先设计声音。'),
        option('effects', '环境与动作声', '增强空间、动作和真实感。', '环境动作声', '以环境和动作声建立空间与节奏。'),
        option('music', '音乐驱动', '用音乐结构推动情绪和剪辑。', '音乐驱动', '以音乐段落组织情绪与切点。'),
      ],
    ),
  ]),
  audio: Object.freeze([
    decision(
      'audio-purpose',
      '声音用途',
      '这份声音作品首先用于哪种场景？',
      '用途会决定时长、动态、语言和文件规格。',
      [
        option('voice', '对白或旁白', '优先清晰度、情绪和语言表达。', '对白旁白', '按对白或旁白用途完善声音方案。'),
        option('music', '音乐作品', '优先结构、旋律、节拍和情绪。', '音乐作品', '按音乐作品用途完善结构与制作方案。'),
        option('soundscape', '环境与音效', '优先空间、层次和动作同步。', '环境音效', '按环境与音效用途完善声音层次。'),
      ],
    ),
    decision(
      'audio-tone',
      '情绪质感',
      '首版采用哪种声音质感？',
      '它会统一声线、乐器、空间和混音。',
      [
        option('warm', '温暖亲近', '柔和、自然、有呼吸感。', '温暖亲近', '统一为温暖亲近的声线、配器和混音。'),
        option('clean', '清晰专业', '干净、稳定、信息优先。', '清晰专业', '统一为清晰专业的录音和混音。'),
        option('dramatic', '戏剧张力', '动态变化明显，转折突出。', '戏剧张力', '统一为戏剧张力的结构和动态。'),
      ],
    ),
    decision(
      'audio-delivery',
      '交付形态',
      '首版先交付哪种声音形态？',
      '交付形态会决定是否需要分轨、纯音乐或伴奏版本。',
      [
        option('master', '单一成品母带', '先完成可直接使用的版本。', '成品母带', '先完成单一成品母带并标注规格。'),
        option('stems', '成品加分轨', '便于后期调整和剪辑。', '成品分轨', '同时规划成品与对白/音乐/音效分轨。'),
        option('variants', '多个时长变体', '适配片头、短版和完整版。', '时长变体', '规划主版及短版、片头片尾变体。'),
      ],
    ),
  ]),
  mixed: Object.freeze([
    decision(
      'mixed-deliverable',
      '首要交付物',
      '这次先把哪一种作品做完整？',
      '先锁一个首要交付物，Agent 才能选择最短且可验收的路径。',
      [
        option('image', '一张或一套图片', '先完成视觉方向与可用图像。', '图像交付', '先把需求整理成完整图像作品方案。'),
        option('video', '一段视频', '先完成视频结构、素材和镜头路线。', '视频交付', '先把需求整理成完整视频作品方案。'),
        option('story', '剧本或故事板', '先完成内容结构，再决定媒体生成。', '剧本故事板', '先把需求整理成完整可编辑剧本或故事板。'),
      ],
    ),
    decision(
      'mixed-audience',
      '目标观众',
      '首版主要给谁看？',
      '观众会影响信息密度、语言、风格和平台。',
      [
        option('consumer', '普通消费者', '直接、清楚、低学习成本。', '普通消费者', '按普通消费者理解路径完善方案。'),
        option('fan', '兴趣或内容受众', '更重视情绪、角色和记忆点。', '兴趣受众', '按兴趣受众完善情绪与内容记忆点。'),
        option('professional', '客户或专业评审', '更重视逻辑、规格和可验证证据。', '专业评审', '按专业评审完善逻辑、规格和证据。'),
      ],
    ),
    decision(
      'mixed-style',
      '表达方式',
      '首版采用哪种表达方式？',
      '表达方式会统一文案、画面、节奏和声音。',
      [
        option('clear', '清晰可信', '内容优先，风格克制。', '清晰可信', '统一为清晰可信的表达。'),
        option('emotional', '情绪驱动', '用关系、氛围或共鸣推进。', '情绪驱动', '统一为情绪驱动的表达。'),
        option('bold', '强视觉创意', '用鲜明概念和视觉反差吸引注意。', '强视觉创意', '统一为强视觉创意表达，并保护核心信息。'),
      ],
    ),
  ]),
});

function stageConfirmationDecision(phase) {
  const labels = {
    idea: '创意简报',
    script: '完整剧本',
    assets: '资产方案',
    shots: '镜头与分镜',
    candidates: '候选与采用方案',
    delivery: '成片交付方案',
  };
  const label = labels[phase] || '当前阶段';
  const finalStage = phase === 'delivery';
  return decision(
    `confirm-${phase}`,
    '阶段确认',
    `${label}已经按本轮选择更新，接下来怎么处理？`,
    '只有明确确认才会推进阶段；修改或补充不会误触生成，也不会覆盖已确认内容。',
    [
      option(
        'confirm',
        finalStage ? `确认${label}，完成本次创作` : `确认${label}，进入下一阶段`,
        finalStage
          ? '保存最终版本并准备非空画布留存预览。'
          : '保存当前版本并准备非空画布留存预览。',
        `确认${label}`,
        finalStage
          ? `当前${label}已经确认。保存最终版本并完成本次创作；不得覆盖已上传、采用或锁定内容。`
          : `当前${label}已经确认。保存这个版本并进入下一阶段；不得覆盖已上传、采用或锁定内容。`,
        'confirm-stage',
      ),
      option(
        'revise',
        `先修改${label}中的一个部分`,
        '保持当前阶段，下一条直接写出具体修改要求。',
        `修改${label}`,
        `保持当前阶段，不确认推进；请根据我接下来的具体要求修订${label}完整版本。`,
        'revise-stage',
      ),
      option(
        'constraint',
        `先补充${label}的一条约束`,
        '保持当前阶段，补入一个不能丢失的条件。',
        `补充${label}约束`,
        `保持当前阶段，不确认推进；请把我接下来补充的约束写回${label}完整版本。`,
        'revise-stage',
      ),
    ],
  );
}

function templatesFor(family, phase) {
  const normalized = normalizedPhase(phase);
  if (normalized === 'idea') return IDEA_DECISIONS[family] || IDEA_DECISIONS.mixed;
  return COMMON_PHASE_DECISIONS[normalized] || IDEA_DECISIONS[family] || IDEA_DECISIONS.mixed;
}

function normalizedOption(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = text(value.id, 80);
  const label = text(value.label, 160);
  const description = text(value.description, 600);
  const optionValue = text(value.value, 1_000);
  const creatorPrompt = text(value.creatorPrompt, 4_000);
  const action = ['answer', 'confirm-stage', 'revise-stage'].includes(value.action)
    ? value.action : 'answer';
  if (!id || !label || !description || !optionValue || !creatorPrompt) return null;
  return { id, label, description, value: optionValue, creatorPrompt, action };
}

function normalizedDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = text(value.id, 120);
  const kind = value.kind === 'stage-confirmation' ? 'stage-confirmation' : 'choice';
  const topic = text(value.topic, 160);
  const question = text(value.question, 600);
  const whyItMatters = text(value.whyItMatters, 1_000);
  const options = (Array.isArray(value.options) ? value.options : [])
    .map(normalizedOption)
    .filter(Boolean);
  if (!id || !topic || !question || !whyItMatters || options.length !== 3
    || new Set(options.map((item) => item.id)).size !== 3) return null;
  const status = value.status === 'resolved' ? 'resolved' : 'pending';
  const answer = status === 'resolved' && value.answer && typeof value.answer === 'object'
    ? {
        source: value.answer.source === 'option' ? 'option' : 'custom',
        optionId: text(value.answer.optionId, 80) || null,
        value: text(value.answer.value, 4_000),
      }
    : null;
  if (status === 'resolved' && !answer?.value) return null;
  return {
    id,
    kind,
    topic,
    question,
    whyItMatters,
    options,
    status,
    answer,
  };
}

function decisionVersionPayload(document) {
  return {
    schema: CREATOR_DECISION_DOCUMENT_SCHEMA,
    documentId: document.documentId,
    sessionId: document.sessionId,
    family: document.family,
    phase: document.phase,
    revision: document.revision,
    status: document.status,
    currentDecisionId: document.currentDecisionId,
    decisions: document.decisions,
    revisionNotes: document.revisionNotes,
  };
}

function sealDocument(value) {
  const base = {
    schema: CREATOR_DECISION_DOCUMENT_SCHEMA,
    documentId: text(value.documentId, 160),
    sessionId: text(value.sessionId, 160),
    family: inferredFamily(value),
    phase: normalizedPhase(value.phase),
    revision: Math.max(1, Math.trunc(Number(value.revision) || 1)),
    status: ['collecting', 'ready-for-confirmation', 'confirmed'].includes(value.status)
      ? value.status : 'collecting',
    currentDecisionId: text(value.currentDecisionId, 120) || null,
    decisions: value.decisions,
    revisionNotes: (Array.isArray(value.revisionNotes) ? value.revisionNotes : [])
      .map((item) => text(item, 4_000))
      .filter(Boolean)
      .slice(-40),
  };
  const contentDigest = digest(decisionVersionPayload(base));
  return {
    ...base,
    versionId: `decisionv_${contentDigest.slice(0, 32)}`,
    contentDigest,
  };
}

function normalizeCreatorDecisionDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== CREATOR_DECISION_DOCUMENT_SCHEMA) return null;
  const decisions = (Array.isArray(value.decisions) ? value.decisions : [])
    .map(normalizedDecision)
    .filter(Boolean);
  if (decisions.length < 2
    || new Set(decisions.map((item) => item.id)).size !== decisions.length) return null;
  const confirmationDecisions = decisions.filter((item) => item.kind === 'stage-confirmation');
  const confirmationDecision = confirmationDecisions[0] || null;
  if (confirmationDecisions.length !== 1
    || confirmationDecision !== decisions.at(-1)
    || confirmationDecision.options.map((item) => item.action).join(',')
      !== 'confirm-stage,revise-stage,revise-stage'
    || decisions.slice(0, -1).some((item) => (
      item.kind !== 'choice'
      || item.options.some((optionValue) => optionValue.action !== 'answer')
    ))) return null;
  for (const item of decisions) {
    if (item.status !== 'resolved') continue;
    if (item.answer?.source === 'option') {
      const answeredOption = item.options.find((optionValue) => (
        optionValue.id === item.answer.optionId
      ));
      if (!answeredOption || answeredOption.value !== item.answer.value) return null;
    } else if (item.answer?.optionId !== null || item.kind === 'stage-confirmation') {
      return null;
    }
  }
  const sealed = sealDocument({ ...value, decisions });
  if (!sealed.documentId || !sealed.sessionId) return null;
  if (text(value.versionId, 80) !== sealed.versionId
    || text(value.contentDigest, 64).toLowerCase() !== sealed.contentDigest) return null;
  const current = sealed.currentDecisionId
    ? sealed.decisions.find((item) => item.id === sealed.currentDecisionId) : null;
  if (sealed.status === 'confirmed') {
    const confirmedOption = confirmationDecision.options.find((item) => (
      item.id === confirmationDecision.answer?.optionId
    ));
    if (sealed.currentDecisionId !== null
      || sealed.decisions.some((item) => item.status !== 'resolved')
      || confirmedOption?.action !== 'confirm-stage') return null;
  } else if (!current || current.status !== 'pending') {
    return null;
  } else {
    const currentIndex = sealed.decisions.findIndex((item) => item.id === current.id);
    if (sealed.decisions.slice(0, currentIndex).some((item) => item.status !== 'resolved')
      || sealed.decisions.slice(currentIndex + 1).some((item) => item.status !== 'pending')
      || (sealed.status === 'collecting' && current.kind !== 'choice')
      || (sealed.status === 'ready-for-confirmation'
        && current.kind !== 'stage-confirmation')) return null;
  }
  return sealed;
}

function createCreatorDecisionDocument(input = {}) {
  const sessionId = text(input.sessionId, 160);
  if (!sessionId) throw new Error('Creator decision document requires sessionId');
  const family = inferredFamily(input);
  const phase = normalizedPhase(input.phase);
  const templates = templatesFor(family, phase);
  const decisions = [
    ...templates.map((item) => ({
      id: item.id,
      kind: 'choice',
      topic: item.topic,
      question: item.question,
      whyItMatters: item.whyItMatters,
      options: item.options.map((entry) => ({ ...entry })),
      status: 'pending',
      answer: null,
    })),
    {
      ...stageConfirmationDecision(phase),
      kind: 'stage-confirmation',
      options: stageConfirmationDecision(phase).options.map((entry) => ({ ...entry })),
      status: 'pending',
      answer: null,
    },
  ];
  return sealDocument({
    documentId: `decision_${digest({ sessionId, family, phase }).slice(0, 32)}`,
    sessionId,
    family,
    phase,
    revision: 1,
    status: 'collecting',
    currentDecisionId: decisions[0].id,
    decisions,
    revisionNotes: [],
  });
}

function currentCreatorDecision(document) {
  const normalized = normalizeCreatorDecisionDocument(document);
  if (!normalized?.currentDecisionId) return null;
  return normalized.decisions.find((item) => item.id === normalized.currentDecisionId) || null;
}

function advanceCreatorDecisionDocument(document, input = {}) {
  const normalized = normalizeCreatorDecisionDocument(document);
  if (!normalized) throw new Error('Creator decision document is invalid');
  const current = currentCreatorDecision(normalized);
  if (!current) throw new Error('Creator decision document has no current decision');
  const selectedOptionId = text(input.optionId, 80);
  const selectedOption = selectedOptionId
    ? current.options.find((item) => item.id === selectedOptionId)
    : null;
  const customValue = text(input.customValue, 4_000);
  if (selectedOptionId && !selectedOption) throw new Error('Creator decision option is stale');

  if (current.kind === 'stage-confirmation') {
    if (selectedOption?.action === 'confirm-stage') {
      const decisions = normalized.decisions.map((item) => (
        item.id === current.id
          ? {
              ...item,
              status: 'resolved',
              answer: { source: 'option', optionId: selectedOption.id, value: selectedOption.value },
            }
          : item
      ));
      const next = sealDocument({
        ...normalized,
        revision: normalized.revision + 1,
        status: 'confirmed',
        currentDecisionId: null,
        decisions,
      });
      return { document: next, resolvedDecision: current, selectedOption, advanced: true };
    }
    const revisionNote = customValue || selectedOption?.value;
    if (!revisionNote) throw new Error('Creator stage revision requires a value');
    const next = sealDocument({
      ...normalized,
      revision: normalized.revision + 1,
      status: 'ready-for-confirmation',
      revisionNotes: [...normalized.revisionNotes, revisionNote],
    });
    return {
      document: next,
      resolvedDecision: current,
      selectedOption,
      advanced: false,
      revisionRequested: true,
      customValue: revisionNote,
    };
  }

  const answerValue = selectedOption?.value || customValue;
  if (!answerValue) throw new Error('Creator decision answer is empty');
  const decisions = normalized.decisions.map((item) => (
    item.id === current.id
      ? {
          ...item,
          status: 'resolved',
          answer: {
            source: selectedOption ? 'option' : 'custom',
            optionId: selectedOption?.id || null,
            value: answerValue,
          },
        }
      : item
  ));
  const nextDecision = decisions.find((item) => item.status === 'pending');
  const ready = nextDecision?.kind === 'stage-confirmation';
  const next = sealDocument({
    ...normalized,
    revision: normalized.revision + 1,
    status: ready ? 'ready-for-confirmation' : 'collecting',
    currentDecisionId: nextDecision?.id || null,
    decisions,
  });
  return {
    document: next,
    resolvedDecision: current,
    selectedOption,
    advanced: true,
    customValue: selectedOption ? '' : answerValue,
  };
}

function prepareCreatorDecisionTurn(input = {}) {
  const phase = normalizedPhase(input.phase);
  const family = inferredFamily(input);
  let document = normalizeCreatorDecisionDocument(input.document);
  if (!document || document.phase !== phase || document.family !== family
    || document.status === 'confirmed') {
    document = createCreatorDecisionDocument({
      sessionId: input.sessionId,
      family,
      phase,
      kind: input.kind,
      prompt: input.prompt,
    });
    return {
      schema: 't8-creator-decision-turn-v1',
      document,
      initialized: true,
      answered: false,
      resolvedDecision: null,
      selectedOption: null,
      currentDecision: currentCreatorDecision(document),
    };
  }
  if (input.skipAnswer === true) {
    return {
      schema: 't8-creator-decision-turn-v1',
      document,
      initialized: false,
      answered: false,
      resolvedDecision: null,
      selectedOption: null,
      currentDecision: currentCreatorDecision(document),
    };
  }
  const selection = input.selection && typeof input.selection === 'object'
    ? input.selection : null;
  const customValue = selection ? '' : text(input.customValue, 4_000);
  if (!selection?.decisionOptionId && !customValue) {
    return {
      schema: 't8-creator-decision-turn-v1',
      document,
      initialized: false,
      answered: false,
      resolvedDecision: null,
      selectedOption: null,
      currentDecision: currentCreatorDecision(document),
    };
  }
  if (selection) {
    if (text(selection.decisionDocumentId, 160) !== document.documentId
      || text(selection.decisionDocumentVersionId, 80) !== document.versionId
      || text(selection.decisionDocumentDigest, 64).toLowerCase() !== document.contentDigest
      || text(selection.decisionId, 120) !== document.currentDecisionId) {
      throw new Error('Creator decision selection is stale');
    }
  }
  const advanced = advanceCreatorDecisionDocument(document, {
    optionId: selection?.decisionOptionId,
    customValue,
  });
  return {
    schema: 't8-creator-decision-turn-v1',
    ...advanced,
    initialized: false,
    answered: true,
    currentDecision: currentCreatorDecision(advanced.document),
  };
}

function creatorDecisionSuggestionChoices(document) {
  const normalized = normalizeCreatorDecisionDocument(document);
  const current = currentCreatorDecision(normalized);
  if (!current) return [];
  return current.options.map((entry) => ({
    id: `decision-${current.id}-${entry.id}`,
    label: entry.label,
    description: entry.description,
    creatorPrompt: entry.creatorPrompt,
    creatorKind: ['story', 'commerce', 'mixed'].includes(normalized.family)
      ? 'story'
      : normalized.family,
    intent: `decision.${normalized.phase}.${current.id}.${entry.id}`,
    expectedEffect: `回答同一项“${current.topic}”决策；不会同时展开其他问题`,
    requiredCapabilityIds: normalized.family === 'image'
      ? ['create.image']
      : normalized.family === 'video'
        ? ['create.video']
        : normalized.family === 'audio'
          ? ['create.audio']
          : ['create.story'],
    decision: {
      decisionDocumentId: normalized.documentId,
      decisionDocumentVersionId: normalized.versionId,
      decisionDocumentDigest: normalized.contentDigest,
      decisionId: current.id,
      decisionOptionId: entry.id,
      decisionValue: entry.value,
      decisionAction: entry.action,
    },
  }));
}

function creatorDecisionPromptContract(turn) {
  if (!turn?.document) return '';
  const normalized = normalizeCreatorDecisionDocument(turn.document);
  const current = currentCreatorDecision(normalized);
  if (!normalized || !current) return '';
  const resolved = turn.resolvedDecision && turn.resolvedDecision.answer
    ? turn.resolvedDecision.answer.value
    : turn.selectedOption?.value || turn.customValue || '';
  return [
    '本轮使用版本化创作决策文档推进。',
    resolved
      ? `刚刚确认/补充的内容：${resolved}。必须把它写进本阶段完整可编辑正文。`
      : '这是本阶段第一轮：先交付有实质内容的可编辑版本，再邀请创作者回答当前唯一决策。',
    `当前唯一待回答决策主题：${current.topic}。`,
    `当前唯一问题：${current.question}`,
    `为什么重要：${current.whyItMatters}`,
    `三个界面选项：${current.options.map((item) => item.label).join(' / ')}。`,
    '正文中不得列出其他未来问题、不得出现“本阶段待确认”清单，也不得提前展示内部决策队列。',
    '回复末尾只允许用一句话提出上面的当前问题；三个选项由界面单独显示，不要在正文复制成列表。',
  ].join('\n');
}

function normalizeCreatorDecisionDocumentVersions(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeCreatorDecisionDocument)
    .filter(Boolean)
    .filter((item, index, all) => (
      all.findIndex((candidate) => candidate.versionId === item.versionId) === index
    ))
    .slice(-CREATOR_DECISION_DOCUMENT_MAX_VERSIONS);
}

module.exports = {
  CREATOR_DECISION_DOCUMENT_MAX_VERSIONS,
  CREATOR_DECISION_DOCUMENT_SCHEMA,
  advanceCreatorDecisionDocument,
  createCreatorDecisionDocument,
  creatorDecisionPromptContract,
  creatorDecisionSuggestionChoices,
  currentCreatorDecision,
  inferredFamily,
  normalizeCreatorDecisionDocument,
  normalizeCreatorDecisionDocumentVersions,
  prepareCreatorDecisionTurn,
};
