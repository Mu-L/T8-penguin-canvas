export const IMAGE_PROMPT_ADJUSTMENT_CATALOG_VERSION = '2026-07-25-v1';

export type ImagePromptAdjustmentLanguage = 'zh' | 'en';
export type ImagePromptAdjustmentApplicability = 'all' | 'reference' | 'people';

export interface ImagePromptAdjustmentCategory {
  id: string;
  code: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  priority: 'P0' | 'P1';
  compileOrder: number;
}

export interface ImagePromptAdjustmentItem {
  id: string;
  categoryId: string;
  labelZh: string;
  labelEn: string;
  promptZh: string;
  promptEn: string;
  applicability: ImagePromptAdjustmentApplicability;
  conflictKey?: string;
  conflictsWith?: string[];
}

export interface ImagePromptAdjustmentSelection {
  itemId: string;
  categoryId: string;
  catalogVersion: string;
  labelZh: string;
  labelEn: string;
  promptZh: string;
  promptEn: string;
  applicability: ImagePromptAdjustmentApplicability;
  conflictKey?: string;
  conflictsWith?: string[];
}

export interface CompileImagePromptAdjustmentOptions {
  hasReferenceImages?: boolean;
  language?: ImagePromptAdjustmentLanguage | 'auto';
}

export interface CompiledImagePromptAdjustments {
  text: string;
  active: ImagePromptAdjustmentSelection[];
  inactive: Array<ImagePromptAdjustmentSelection & { reason: string }>;
  language: ImagePromptAdjustmentLanguage;
}

type RawItem = readonly [
  labelZh: string,
  labelEn: string,
  promptZh: string,
  promptEn: string,
  applicability?: ImagePromptAdjustmentApplicability,
];

interface RawCategory {
  category: ImagePromptAdjustmentCategory;
  items: readonly RawItem[];
}

const rawCategories: readonly RawCategory[] = [
  {
    category: {
      id: 'subject-fusion',
      code: 'A',
      labelZh: '人景 / 主体融合',
      labelEn: 'Subject Integration',
      descriptionZh: '让人物、产品或新主体自然进入环境，统一透视、接触、光色与景深。',
      descriptionEn: 'Integrate a person, product, or inserted subject through consistent perspective, contact, light, color, and depth.',
      priority: 'P0',
      compileOrder: 30,
    },
    items: [
      ['轻度对齐', 'Light Alignment', '轻微校正主体与环境的透视、比例和地面关系，保留原构图与主体特征。', 'Gently align the subject with the scene perspective, scale, and ground plane while preserving the original composition and identity.'],
      ['自然融合', 'Natural Integration', '统一主体与环境的光线、色温、对比度和边缘过渡，使其像在同一镜头中拍摄。', 'Match lighting, color temperature, contrast, and edge transitions so the subject appears captured in the same shot.'],
      ['深度融合', 'Deep Integration', '同时匹配透视、遮挡、接触阴影、反射、景深和空气透视，消除拼贴感。', 'Match perspective, occlusion, contact shadows, reflections, depth of field, and atmospheric perspective to remove any pasted-on look.'],
      ['地面接触', 'Ground Contact', '建立可信的脚底或物体底部接触、受力和接触阴影，不悬浮也不陷入地面。', 'Create believable support, weight, and contact shadows at the feet or base, without floating or sinking.'],
      ['边缘去抠图感', 'Natural Edges', '修复白边、黑边、硬切边和半透明污染，让毛发、衣物与环境自然交叠。', 'Remove halos, hard cutouts, and transparency contamination while preserving natural hair and fabric overlap.'],
      ['比例统一', 'Scale Matching', '根据场景参照物和相机距离校正主体尺寸，保持人体、产品和建筑比例可信。', 'Correct subject scale using scene references and camera distance while preserving believable human, product, and architectural proportions.'],
      ['透视统一', 'Perspective Matching', '让主体消失点、相机高度、俯仰角和环境透视保持一致。', 'Align the subject vanishing points, camera height, pitch, and perspective with the environment.'],
      ['遮挡关系', 'Occlusion Matching', '补齐前后景遮挡，让主体正确位于桌面、门框、植物或人群之间。', 'Restore correct foreground and background occlusion around furniture, frames, plants, crowds, and scene objects.'],
      ['色温统一', 'Color Temperature Match', '校正主体与环境的冷暖关系，保留肤色或产品固有色，避免整体染色。', 'Match subject and scene color temperature while protecting skin tone and intrinsic product colors.'],
      ['明暗统一', 'Exposure Match', '匹配主体与环境曝光、黑白点和局部对比，避免主体过亮或灰暗漂浮。', 'Match exposure, black and white points, and local contrast so the subject does not appear too bright, dull, or detached.'],
      ['饱和度统一', 'Saturation Match', '统一主体与环境的色彩密度，保留重点色，不让主体艳得突兀或灰得脱离。', 'Balance color density between subject and scene while preserving important accent colors.'],
      ['噪点颗粒统一', 'Grain Match', '匹配主体与背景的噪点尺度、胶片颗粒和压缩质感，避免局部过净或过糙。', 'Match noise scale, film grain, and compression texture so no region looks unnaturally clean or coarse.'],
      ['清晰度统一', 'Sharpness Match', '统一主体与背景在同一焦平面上的锐度与细节密度，保持真实景深层级。', 'Match sharpness and detail density within the same focal plane while preserving realistic depth hierarchy.'],
      ['景深统一', 'Depth-of-Field Match', '根据焦点距离让主体与环境共享连续景深，不出现主体全清晰、背景假模糊。', 'Place subject and environment in one continuous depth of field without cutout-like sharpness or artificial blur.'],
      ['接触阴影', 'Contact Shadows', '在接触面补充方向、软硬和强度正确的阴影，明确重量与空间位置。', 'Add directionally correct contact shadows with believable softness and intensity to establish weight and position.'],
      ['环境反射', 'Environmental Reflections', '让金属、玻璃、湿面和高光表面反映周围颜色与光源，反射不过度。', 'Add restrained environmental color and light reflections to metal, glass, wet, and glossy surfaces.'],
      ['环境色溢出', 'Environmental Color Spill', '把邻近墙面、地面或霓虹的微弱反射色自然带到主体边缘与阴影。', 'Introduce subtle color spill from nearby walls, floors, or neon onto subject edges and shadows.'],
      ['轮廓光匹配', 'Rim-Light Match', '依据环境光源补充或削弱轮廓光，方向和颜色必须有真实来源。', 'Match rim light direction, color, and intensity to visible or implied scene light sources.'],
      ['空气透视融合', 'Atmospheric Integration', '按主体距离加入适量雾化、对比衰减和色彩偏移，使空间层次连续。', 'Apply distance-appropriate haze, contrast falloff, and color shift for continuous atmospheric depth.'],
      ['复杂场景融合', 'Complex Scene Integration', '综合处理多人、道具、反射、遮挡和多光源关系，保持每个主体边界与身份清楚。', 'Resolve multi-subject, prop, reflection, occlusion, and multi-light relationships while keeping every identity and boundary clear.'],
    ],
  },
  {
    category: {
      id: 'lighting',
      code: 'B',
      labelZh: '光影融合',
      labelEn: 'Lighting',
      descriptionZh: '控制主光、补光、阴影、反射与环境光，让光线有来源、有层次。',
      descriptionEn: 'Control key, fill, shadows, reflections, and ambience so lighting remains motivated and dimensional.',
      priority: 'P0',
      compileOrder: 40,
    },
    items: [
      ['柔和补光', 'Soft Fill Light', '使用大面积柔和补光抬起暗部，保留主光方向和自然立体感。', 'Use broad soft fill to lift shadows while preserving key-light direction and natural volume.'],
      ['自然匹配', 'Natural Light Match', '匹配现有光源方向、色温、光比和阴影软硬，不凭空增加无来源灯光。', 'Match existing direction, temperature, contrast ratio, and shadow softness without inventing unmotivated light.'],
      ['氛围强化', 'Atmosphere Lighting', '在保留真实光源逻辑的前提下加强明暗层次、空气感和视觉焦点。', 'Strengthen tonal depth, atmosphere, and visual focus while preserving believable source logic.'],
      ['窗光塑形', 'Window-Light Shaping', '使用有方向的柔窗光塑造体积，阴影过渡自然且环境仍可读。', 'Shape form with directional soft window light, natural shadow transitions, and a readable environment.'],
      ['伦勃朗光', 'Rembrandt Lighting', '形成克制的面部三角光和清晰主次关系，暗部保留肤质与轮廓。', 'Create restrained Rembrandt facial lighting with clear hierarchy and preserved shadow detail.'],
      ['蝴蝶光', 'Butterfly Lighting', '使用正面略高主光塑造对称面部阴影，保持鼻影、眼窝和下颌自然。', 'Use a slightly elevated frontal key for balanced facial shadows and natural nose, eye, and jaw definition.'],
      ['侧逆光', 'Side Backlight', '用侧后方光源勾勒轮廓和材质，同时用环境补光保留正面信息。', 'Use side backlight to define silhouette and material, with ambient fill retaining frontal detail.'],
      ['轮廓光', 'Rim Lighting', '加入窄而有来源的轮廓光分离主体与背景，避免整圈发光。', 'Add a narrow motivated rim light to separate subject and background without a full glowing outline.'],
      ['顶光戏剧感', 'Dramatic Top Light', '用顶部主光建立戏剧阴影，保护眼睛、面部和关键结构不过度陷黑。', 'Use top lighting for dramatic shadow while keeping eyes, faces, and key structure readable.'],
      ['底部反射补光', 'Bounce Fill', '利用地面或桌面反射形成柔和下方补光，颜色与材质环境一致。', 'Create subtle lower fill from floor or table bounce with scene-consistent color and material response.'],
      ['黄金时刻', 'Golden Hour', '使用低角度暖光、长阴影和轻微冷环境光，避免通体橙黄。', 'Use low warm sunlight, long shadows, and subtle cool ambience without turning the whole image orange.'],
      ['蓝调时刻', 'Blue Hour', '使用清冷环境光与逐渐点亮的人造灯，保留天空和暗部色彩。', 'Balance cool ambient blue-hour light with emerging practical lights while retaining sky and shadow color.'],
      ['阴天漫射光', 'Overcast Diffusion', '使用均匀柔光和细腻体积塑造，避免平光与灰雾感。', 'Use even diffused light with subtle form modeling, avoiding flatness and muddy haze.'],
      ['棚拍柔箱', 'Studio Softbox', '用可控柔箱主光、补光和背景分离光呈现干净商业质感。', 'Use controlled softbox key, fill, and separation light for a clean commercial result.'],
      ['产品边缘光', 'Product Edge Light', '在产品轮廓与关键结构上建立连续高光，清楚展示材质和形体。', 'Create continuous controlled highlights along product contours and key structure to reveal form and material.'],
      ['霓虹反射光', 'Neon Reflections', '让霓虹色只在受光面、湿面和反射材质上出现，保持肤色与黑位干净。', 'Restrict neon color to lit, wet, and reflective surfaces while keeping skin and blacks clean.'],
      ['烛光暖照', 'Candlelight', '使用近距离暖光、快速衰减和自然跳动感，暗部保持层次。', 'Use intimate warm light with fast falloff and subtle flicker while preserving dimensional shadows.'],
      ['月光冷照', 'Moonlight', '使用克制冷色方向光和柔弱环境补光，避免把夜景照成白天。', 'Use restrained cool directional light with faint ambience, keeping the scene convincingly nocturnal.'],
      ['阴影细节恢复', 'Shadow Detail Recovery', '恢复暗部轮廓、材质和色彩，但保持整体光比与夜景氛围。', 'Recover shadow contours, material, and color without flattening contrast or night ambience.'],
      ['高光滚降', 'Highlight Roll-Off', '让强光和反射从亮部平滑过渡，保留颜色与纹理，避免纯白剪切。', 'Create smooth highlight roll-off that retains color and texture instead of clipping to white.'],
    ],
  },
  {
    category: {
      id: 'skin',
      code: 'C',
      labelZh: '皮肤质感',
      labelEn: 'Skin',
      descriptionZh: '改善人物皮肤与五官，但保留身份、年龄、毛孔和真实光泽。',
      descriptionEn: 'Refine skin and facial rendering while preserving identity, age, pores, and believable sheen.',
      priority: 'P0',
      compileOrder: 60,
    },
    items: [
      ['清透修饰', 'Clean Retouch', '轻度均匀肤色并清理临时瑕疵，保留毛孔、细纹、痣和真实年龄感。', 'Gently even skin tone and remove temporary blemishes while preserving pores, fine lines, moles, and age.'],
      ['自然肤质', 'Natural Skin', '保持真实皮肤微纹理、细微色差和柔和光泽，避免磨皮与蜡像感。', 'Preserve authentic microtexture, subtle color variation, and soft sheen without waxy smoothing.'],
      ['真实肌理', 'Real Skin Texture', '增强可信毛孔、细纹和皮下色彩变化，尺度自然且不夸张。', 'Enhance believable pores, fine lines, and subsurface color variation at a natural scale.'],
      ['轻度祛痘', 'Light Blemish Cleanup', '只清理明显临时痘印和炎症，不改变面部结构、痣、雀斑和身份特征。', 'Remove only obvious temporary blemishes and inflammation without changing structure, moles, freckles, or identity.'],
      ['肤色均匀', 'Even Skin Tone', '减少局部不自然红斑和灰黄偏色，保留面部自然血色与明暗。', 'Reduce unnatural redness and dull casts while retaining natural facial color and tonal variation.'],
      ['毛孔保留', 'Preserve Pores', '修饰皮肤时完整保留自然毛孔尺度与分布，不生成重复噪点。', 'Retain natural pore scale and distribution during retouching without repetitive synthetic noise.'],
      ['雀斑保留', 'Preserve Freckles', '保留雀斑、痣与身份性皮肤特征，避免被磨平或复制。', 'Preserve freckles, moles, and identity-defining skin marks without smoothing or duplication.'],
      ['年龄感保留', 'Preserve Age', '保留符合人物年龄的细纹、轮廓和皮肤弹性，不做不自然年轻化。', 'Preserve age-appropriate lines, contours, and elasticity without artificial de-aging.'],
      ['油光控制', 'Controlled Shine', '压低额头、鼻梁和面颊的过曝油光，同时保留健康皮肤光泽。', 'Reduce clipped shine on forehead, nose, and cheeks while preserving healthy skin luster.'],
      ['健康光泽', 'Healthy Glow', '增加克制、分布自然的皮肤光泽和血色，不产生塑料高光。', 'Add restrained, naturally distributed skin glow and vitality without plastic highlights.'],
      ['柔和妆面', 'Soft Makeup', '整理底妆、眼妆和唇妆边缘，保留皮肤纹理和真实颜色层次。', 'Refine complexion, eye, and lip makeup edges while retaining skin texture and color depth.'],
      ['高定妆面', 'Editorial Makeup', '强化精致妆面结构与色彩控制，五官和皮肤仍保持真实可辨。', 'Enhance precise editorial makeup structure and color control while keeping the face authentic.'],
      ['男士自然皮肤', 'Natural Male Skin', '保留较明显毛孔、胡茬和面部结构，只做克制清理与色调平衡。', 'Preserve pores, stubble, and facial structure with restrained cleanup and tonal balancing.'],
      ['儿童皮肤保护', 'Child Skin Protection', '保持儿童自然细腻皮肤、红润和年龄特征，不添加成人妆感或强纹理。', 'Maintain naturally delicate child skin and age cues without adult makeup or exaggerated texture.'],
      ['成熟皮肤质感', 'Mature Skin Texture', '尊重皱纹、松弛和年龄特征，提升光线与肤色，不抹除人生痕迹。', 'Respect wrinkles, softness, and age characteristics while improving light and tone without erasing lived detail.'],
      ['面部红润平衡', 'Balanced Complexion', '平衡面颊、鼻翼和耳部血色，避免通红、灰白或局部色块。', 'Balance natural color across cheeks, nose, and ears without excessive redness, pallor, or patches.'],
      ['眼周自然修饰', 'Natural Eye-Area Retouch', '减轻异常黑眼圈和浮肿，同时保留眼窝结构、睫毛和细纹。', 'Reduce excessive dark circles and puffiness while preserving eye structure, lashes, and fine lines.'],
      ['唇部质感', 'Natural Lip Texture', '保持唇纹、湿润度和唇色层次，修复干裂但不生成塑料嘴唇。', 'Preserve lip lines, moisture, and color depth while repairing dryness without plastic texture.'],
      ['手部皮肤一致', 'Consistent Hand Skin', '让手部肤色、纹理和年龄感与面部一致，并保持关节结构真实。', 'Match hand tone, texture, and age to the face while preserving correct joint structure.'],
      ['全身肤色一致', 'Full-Body Skin Match', '统一脸、颈、手臂和腿部的肤色与光照响应，保留自然局部差异。', 'Unify tone and lighting response across face, neck, arms, and legs while retaining natural variation.'],
    ],
  },
  {
    category: {
      id: 'material',
      code: 'D',
      labelZh: '纹理 / 材质',
      labelEn: 'Texture & Material',
      descriptionZh: '准确表达柔软、粗糙、反光、透明等材质特征，不用噪点冒充细节。',
      descriptionEn: 'Render softness, roughness, reflection, and transparency accurately without substituting noise for detail.',
      priority: 'P0',
      compileOrder: 70,
    },
    items: [
      ['柔和纹理', 'Soft Texture', '降低粗糙纹理攻击性，保留真实表面起伏和材质识别。', 'Soften aggressive texture while retaining authentic surface relief and material identity.'],
      ['自然纹理', 'Natural Texture', '恢复尺度正确、分布不重复的真实纹理，不生成统一噪点。', 'Restore scale-accurate, non-repeating texture without generic noise.'],
      ['颗粒质感', 'Fine Grain', '加入细腻均匀但不机械重复的成像颗粒，细节与暗部不过度放大。', 'Add fine, organic imaging grain without repetition or exaggerated shadow detail.'],
      ['织物纤维', 'Fabric Fibers', '表现布料经纬、纤维、褶皱和厚度，纹理随形体与景深变化。', 'Render weave, fibers, folds, and thickness with texture following form and depth of field.'],
      ['丝绸光泽', 'Silk Sheen', '表现丝绸方向性高光、柔软褶皱与顺滑质感，避免塑料反光。', 'Render directional silk highlights, soft folds, and smooth hand without plastic shine.'],
      ['皮革纹理', 'Leather Texture', '表现皮革毛孔、压纹、折痕和受控半光泽，保留使用痕迹。', 'Render leather pores, embossing, creases, and controlled semi-gloss with believable wear.'],
      ['金属拉丝', 'Brushed Metal', '保持一致拉丝方向、细密纹路和各向异性反射，边缘结构清楚。', 'Maintain consistent brushing direction, fine striations, anisotropic reflections, and clear edges.'],
      ['抛光金属', 'Polished Metal', '呈现清晰但不过度的环境反射、曲面高光和金属黑位。', 'Render clean restrained environmental reflections, curved highlights, and metallic dark tones.'],
      ['磨砂金属', 'Matte Metal', '使用宽柔高光和细微粗糙度表现磨砂表面，仍保留金属重量感。', 'Use broad soft highlights and subtle roughness for matte metal while retaining metallic weight.'],
      ['玻璃通透', 'Clear Glass', '表现正确折射、边缘厚度、反射和透明层次，不让玻璃消失或变塑料。', 'Render correct refraction, edge thickness, reflections, and transparency so glass remains tangible.'],
      ['陶瓷釉面', 'Glazed Ceramic', '表现平滑釉面、细微曲率高光和真实厚度，避免纯白无细节。', 'Render smooth glaze, subtle curved highlights, and real thickness without featureless white clipping.'],
      ['木材纹理', 'Wood Grain', '保持木纹沿结构连续、年轮尺度自然，并区分哑光与上漆区域。', 'Keep wood grain continuous along structure with natural scale and distinct matte or finished surfaces.'],
      ['石材纹理', 'Stone Texture', '表现石材颗粒、层理、孔隙和磨损，纹路不重复且符合切面。', 'Render stone grain, strata, pores, and wear with non-repeating patterns aligned to cut surfaces.'],
      ['混凝土质感', 'Concrete Texture', '表现细孔、色差、施工痕迹和克制粗糙度，不把墙面做成噪点。', 'Render pores, tonal variation, construction marks, and restrained roughness without noisy walls.'],
      ['纸张纤维', 'Paper Fibers', '表现纸张厚度、细纤维、压痕和漫反射，边缘保持自然。', 'Render paper thickness, fine fibers, embossing, diffuse reflection, and natural edges.'],
      ['液体质感', 'Liquid Material', '保持液体表面张力、透明度、折射和流动方向，反射符合光源。', 'Preserve surface tension, transparency, refraction, flow direction, and source-consistent reflections.'],
      ['湿润表面', 'Wet Surface', '增加连续水膜、局部高光和暗色加深，保持材质本身可辨。', 'Add continuous moisture film, local highlights, and darker saturation while preserving base material identity.'],
      ['磨损旧化', 'Believable Wear', '在接触、边缘和受力位置加入合理磨损、划痕与褪色，不做随机脏化。', 'Place wear, scratches, and fading at believable contact, edge, and stress areas rather than random grime.'],
      ['微距材质', 'Macro Material Detail', '放大关键微结构并保持尺度、焦平面和光线真实，不生成假细节。', 'Reveal key microstructure with accurate scale, focal plane, and light without invented detail.'],
      ['材质分离', 'Material Separation', '通过高光形态、粗糙度和边缘响应清楚区分相邻材质。', 'Separate adjacent materials through distinct highlight shape, roughness, and edge response.'],
    ],
  },
  {
    category: {
      id: 'clarity',
      code: 'E',
      labelZh: '锐度 / 清晰度',
      labelEn: 'Sharpness & Clarity',
      descriptionZh: '提升有效细节与焦点层级，避免过锐、光晕、锯齿和假纹理。',
      descriptionEn: 'Improve meaningful detail and focal hierarchy while avoiding oversharpening, halos, aliasing, and fake texture.',
      priority: 'P0',
      compileOrder: 80,
    },
    items: [
      ['柔焦', 'Soft Focus', '使用轻微光学柔化降低数字锐利感，主体关键结构仍然清楚。', 'Apply subtle optical softness to reduce digital harshness while keeping key subject structure clear.'],
      ['标准清晰', 'Balanced Clarity', '提升主体轮廓与关键细节，保持自然局部对比和景深。', 'Improve subject contours and key detail with natural local contrast and depth of field.'],
      ['高清锐化', 'High-Definition Sharpening', '针对焦内细节进行高质量锐化，避免边缘光晕、噪点放大和假纹理。', 'Sharpen in-focus detail precisely without edge halos, amplified noise, or synthetic texture.'],
      ['主体优先清晰', 'Subject-First Clarity', '让主视觉最清楚，次要区域按距离和叙事层级逐渐衰减。', 'Keep the primary subject clearest, with secondary regions falling off by distance and narrative priority.'],
      ['眼睛与五官清晰', 'Facial Detail Clarity', '精确提升眼睛、睫毛、眉毛和嘴唇细节，皮肤不过度锐化。', 'Clarify eyes, lashes, brows, and lips precisely without oversharpening skin.'],
      ['产品标签清晰', 'Product Label Clarity', '提高产品标识区、边缘和关键结构可读性，不重写或发明文字。', 'Improve readability of product labels, edges, and key structure without rewriting or inventing text.'],
      ['微纹理增强', 'Microtexture Enhancement', '增强真实存在的细小纹理和材质变化，不用均匀噪点填充。', 'Enhance existing microtexture and material variation without filling surfaces with uniform noise.'],
      ['局部对比增强', 'Local Contrast', '提升主体内部层次、远近关系和局部对比，保留真实空气透视。', 'Improve internal subject depth, distance cues, and local contrast while preserving atmospheric perspective.'],
      ['动作细节保留', 'Motion Detail Preservation', '保持运动方向感，同时让动作主体的关键部位清楚可辨。', 'Preserve motion direction while keeping critical body and object details readable.'],
      ['抗过锐化', 'De-Sharpen Artifacts', '移除双边、硬轮廓和颗粒放大，恢复自然成像。', 'Remove double edges, hard outlines, and amplified grain to restore natural imaging.'],
      ['抑制锐化光晕', 'Suppress Sharpening Halos', '清理高反差边缘周围的白圈、黑圈和彩边。', 'Remove white, dark, and colored halos around high-contrast edges.'],
      ['抑制锯齿', 'Anti-Aliasing', '平滑斜线、发丝和细小结构边缘，不牺牲真实细节。', 'Smooth diagonals, hair, and fine structural edges without sacrificing authentic detail.'],
      ['线稿清晰', 'Clean Line Art', '保持线条连续、粗细稳定和交界干净，适合插画与设计稿。', 'Keep linework continuous, weight-consistent, and clean at intersections for illustration and design.'],
      ['发丝清晰', 'Hair Detail', '保留发束层次、细碎发丝和半透明边缘，避免钢丝感。', 'Preserve layered locks, flyaway hairs, and translucent edges without wire-like strands.'],
      ['织物细节清晰', 'Fabric Detail', '突出布料纹理和缝线，避免把噪点误当纤维。', 'Clarify fabric weave and stitching without mistaking noise for fibers.'],
      ['风景层次清晰', 'Landscape Clarity', '近景清楚、中景稳定、远景适度衰减，不把全画面压成同一锐度。', 'Keep foreground crisp, midground stable, and distance naturally softer instead of uniformly sharp.'],
      ['前后景清晰层级', 'Depth Clarity Hierarchy', '建立主焦点到背景的渐进清晰关系，避免抠图式主体。', 'Create gradual clarity from focal subject to background without a cutout look.'],
      ['轻度失焦恢复', 'Mild Defocus Recovery', '恢复可恢复的轮廓和细节，不凭空生成错误五官或文字。', 'Recover plausible contours and detail without inventing facial features or text.'],
      ['印刷级边缘', 'Print-Ready Edges', '优化大尺寸输出所需的结构边缘和局部对比，避免过度数字锐化。', 'Optimize structural edges and local contrast for large-format output without digital oversharpening.'],
      ['电影柔锐平衡', 'Cinematic Soft-Sharp Balance', '关键细节清楚、肤质柔和、边缘不过硬，保留电影镜头感。', 'Keep key detail clear, skin gentle, and edges natural for a cinematic lens response.'],
    ],
  },
  {
    category: {
      id: 'composition',
      code: 'F',
      labelZh: '构图 / 空间',
      labelEn: 'Composition & Space',
      descriptionZh: '快速组织主体位置、留白、层级和空间纵深，同时保护安全裁切。',
      descriptionEn: 'Organize subject placement, negative space, hierarchy, and depth while preserving safe framing.',
      priority: 'P0',
      compileOrder: 20,
    },
    items: [
      ['中心稳定构图', 'Centered Composition', '主体居中且视觉重量均衡，适合正式肖像、产品和图标式画面。', 'Center the subject with balanced visual weight for formal portraits, products, and icon-like imagery.'],
      ['三分法构图', 'Rule of Thirds', '将主体和视觉焦点放在三分交点，保留合理视线空间。', 'Place subject and focal point near thirds intersections with appropriate look room.'],
      ['黄金比例构图', 'Golden-Ratio Composition', '用自然视觉流线引导视线从环境进入核心主体。', 'Use a natural golden-ratio visual flow that guides the eye from environment to subject.'],
      ['引导线构图', 'Leading Lines', '利用道路、建筑、光线或物体边缘把视线引向主体。', 'Use roads, architecture, light, or object edges to guide attention toward the subject.'],
      ['框中框构图', 'Frame Within a Frame', '使用门窗、拱洞或前景形成自然取景框，不遮挡关键内容。', 'Use doors, windows, arches, or foreground elements as a natural frame without blocking key content.'],
      ['对称构图', 'Symmetrical Composition', '建立清晰中轴、左右视觉重量平衡和稳定秩序，同时保留主体呼吸空间。', 'Create a clear central axis, left-right balance, and stable visual order.'],
      ['非对称平衡', 'Asymmetrical Balance', '用大小、明暗和留白平衡不同视觉重量，避免一侧空塌。', 'Balance unequal visual weights through scale, tone, and negative space without leaving a dead side.'],
      ['负空间留白', 'Negative Space', '保留干净呼吸区，适合标题、文案或情绪表达。', 'Preserve clean breathing room for titles, copy, or emotional emphasis.'],
      ['前中后景分层', 'Foreground-Midground-Background', '设置清晰前景锚点、中景主体和远景环境，增强空间深度。', 'Establish a foreground anchor, midground subject, and distant environment for clear spatial depth.'],
      ['纵深走廊', 'Deep Corridor', '用重复结构和消失点建立强烈纵深，主体位置保持可读。', 'Use repeated structures and vanishing points for strong depth while keeping the subject readable.'],
      ['对角线动势', 'Diagonal Energy', '使用斜向结构形成速度和张力，同时保持画面稳定。', 'Use diagonal structures to create speed and tension while maintaining overall stability.'],
      ['三角构图', 'Triangular Composition', '组织单人姿态、多人关系或产品组合，形成稳定视觉层级。', 'Arrange poses, groups, or product sets into a stable triangular hierarchy.'],
      ['S 形视觉路径', 'S-Curve Flow', '让道路、河流、姿态或光带形成自然流动视线。', 'Use roads, rivers, poses, or light bands to form a natural S-shaped visual path.'],
      ['低机位英雄构图', 'Low-Angle Hero Framing', '适度降低视角强化力量，不产生夸张肢体和广角畸变。', 'Lower the viewpoint moderately for power without exaggerated limbs or wide-angle distortion.'],
      ['高机位概览', 'High-Angle Overview', '清楚展示空间关系和主体分布，避免顶部空间浪费。', 'Show spatial relationships and subject distribution clearly without wasted overhead space.'],
      ['平视纪实构图', 'Eye-Level Documentary', '使用自然人眼高度和克制取景，保持真实观察感。', 'Use natural eye height and restrained framing for an observational documentary feel.'],
      ['特写安全裁切', 'Safe Close-Up Crop', '聚焦表情或细节，避开关节和五官的不自然切边。', 'Focus on expression or detail while avoiding awkward cuts through joints or facial features.'],
      ['全身安全留白', 'Full-Body Safe Area', '完整保留头顶、脚底、手臂和动作范围，方便后续裁切。', 'Keep head, feet, arms, and motion range fully visible for flexible later cropping.'],
      ['商业主体呼吸区', 'Commercial Breathing Room', '给产品或主视觉留出清晰边界、卖点空间和版式余量。', 'Leave clean boundaries, selling-point space, and layout margin around the commercial subject.'],
      ['多主体层级', 'Multi-Subject Hierarchy', '明确第一、第二、第三视觉主体，避免人物或物体相互粘连抢焦点。', 'Define primary, secondary, and tertiary subjects while preventing overlaps and competing focal points.'],
    ],
  },
  {
    category: {
      id: 'color',
      code: 'G',
      labelZh: '色彩 / 色调',
      labelEn: 'Color & Tone',
      descriptionZh: '统一不同素材的色相、饱和度与黑白点，并保护肤色、品牌色和固有色。',
      descriptionEn: 'Unify hue, saturation, and tonal range while protecting skin, brand, and intrinsic colors.',
      priority: 'P0',
      compileOrder: 50,
    },
    items: [
      ['中性真实色', 'Neutral Realism', '校正偏色并保护物体固有色，保持自然曝光和肤色。', 'Correct color casts while preserving intrinsic object colors, natural exposure, and skin tone.'],
      ['暖调电影色', 'Warm Cinematic Grade', '使用克制暖高光和中性阴影，避免全画面橙黄。', 'Use restrained warm highlights and neutral shadows without turning the whole image orange.'],
      ['冷调电影色', 'Cool Cinematic Grade', '使用清冷环境色和保留肤色分离的中性高光。', 'Use cool environmental tones with neutral highlights that keep skin clearly separated.'],
      ['青橙平衡', 'Balanced Teal and Orange', '建立受控青色环境与暖色主体对比，不产生夸张网红滤镜。', 'Create controlled teal ambience and warm subject contrast without an exaggerated social-media grade.'],
      ['胶片印片色', 'Film Print Color', '使用柔和高光滚降、稳定黑位和细腻色彩密度。', 'Use gentle highlight roll-off, stable blacks, and nuanced film-print color density.'],
      ['低饱和粉彩', 'Muted Pastels', '降低强色冲突，保持明亮、柔和且不灰脏。', 'Reduce harsh color conflicts while staying bright, soft, and clean rather than muddy.'],
      ['浓郁但自然', 'Rich Natural Color', '增强关键色彩密度，同时保护肤色、白色和中性色。', 'Increase important color density while protecting skin, whites, and neutrals.'],
      ['克制单色', 'Restrained Monochrome', '以一个主色家族组织画面，并保留足够明暗层次。', 'Organize the image around one color family while retaining sufficient tonal separation.'],
      ['黑金质感', 'Black and Gold', '使用深中性色、克制金色高光和干净材质分离。', 'Use deep neutrals, restrained gold highlights, and clean material separation.'],
      ['青紫霓虹', 'Cyan Violet Neon', '建立有光源依据的青紫层次，避免综合色污染主体。', 'Build source-motivated cyan and violet layers without contaminating the subject with mixed color.'],
      ['大地色系', 'Earth Tones', '使用土壤、木材、岩石和植物的自然低饱和色彩。', 'Use naturally muted colors inspired by soil, wood, stone, and vegetation.'],
      ['清新绿调', 'Fresh Greens', '提升植物与环境清新感，同时抑制肤色和白色被染绿。', 'Freshen vegetation and environment while preventing green contamination of skin and whites.'],
      ['蓝调夜色', 'Blue Night', '保留夜景暗部色彩和灯光层级，不把黑位压死。', 'Retain shadow color and practical-light hierarchy at night without crushing blacks.'],
      ['夕阳琥珀色', 'Amber Sunset', '使用暖高光、柔和红橙过渡和受控冷阴影。', 'Use warm highlights, smooth red-orange transitions, and controlled cool shadows.'],
      ['高级灰调', 'Refined Neutrals', '降低无关颜色，保留关键点色和材质层次。', 'Reduce distracting colors while retaining key accents and material depth.'],
      ['电商洁净色', 'Clean E-Commerce Color', '使用准确白底、中性产品色和清晰色差，避免环境染色。', 'Use an accurate white background, neutral product color, and clear color separation without ambient contamination.'],
      ['复古褪色色调', 'Vintage Faded Tone', '使用轻微褪色、偏暖纸感和受控黑位，不损失主体识别。', 'Apply mild fading, warm paper character, and controlled blacks without losing subject recognition.'],
      ['互补色和谐', 'Complementary Harmony', '选择一组主辅互补色，通过面积和明度控制避免冲突。', 'Balance a primary and secondary complementary pair through area and luminance control.'],
      ['局部固有色保护', 'Protect Key Colors', '调色时锁定肤色、品牌色、服装或产品关键颜色。', 'Lock skin tone, brand colors, clothing, or critical product colors during grading.'],
      ['全局色彩统一', 'Global Color Unification', '统一不同来源素材的色相、饱和度、亮度和黑白点，同时保留层次。', 'Unify hue, saturation, luminance, and black-white points across mixed sources while preserving depth.'],
    ],
  },
  {
    category: {
      id: 'lens',
      code: 'H',
      labelZh: '镜头 / 景深',
      labelEn: 'Lens & Depth',
      descriptionZh: '调整焦段、透视和焦平面，得到连贯的光学成像而不是后期抠图式模糊。',
      descriptionEn: 'Control focal length, perspective, and focus planes for coherent optics rather than cutout-style blur.',
      priority: 'P0',
      compileOrder: 21,
    },
    items: [
      ['24mm 环境广角', '24mm Environmental Wide', '展示主体与大环境关系，校正边缘拉伸和垂直线。', 'Show the subject within the wider environment while correcting edge stretch and vertical lines.'],
      ['35mm 纪实视角', '35mm Documentary', '保持自然临场感和适度环境信息，避免夸张透视。', 'Maintain natural immediacy and useful context without exaggerated perspective.'],
      ['50mm 自然视角', '50mm Natural View', '使用接近人眼观察的空间比例和中性透视，避免广角拉伸或长焦压缩。', 'Use near-human spatial proportions and neutral perspective.'],
      ['85mm 人像视角', '85mm Portrait', '轻度压缩背景、自然塑造五官并突出人物。', 'Gently compress the background, render facial proportions naturally, and emphasize the person.'],
      ['105mm 微距', '105mm Macro', '展示微小纹理和结构，控制焦平面与反光。', 'Reveal minute texture and structure with controlled focus plane and reflections.'],
      ['长焦压缩', 'Telephoto Compression', '压缩前后景距离、简化背景并保持主体比例自然。', 'Compress foreground-background distance, simplify the background, and preserve natural subject proportions.'],
      ['超广角校正', 'Corrected Ultra-Wide', '保留开阔空间感，同时修正边缘人物、产品和建筑变形。', 'Retain expansive space while correcting edge distortion on people, products, and architecture.'],
      ['全景深', 'Deep Focus', '让前中后景都清晰可读，避免不自然的锐度断层。', 'Keep foreground, midground, and background readable without abrupt unnatural sharpness boundaries.'],
      ['自然浅景深', 'Natural Shallow Focus', '主体清楚、背景渐进虚化，轮廓不出现抠图边。', 'Keep the subject clear with gradual optical background blur and no cutout edges.'],
      ['柔滑背景虚化', 'Smooth Bokeh', '生成光学上连续的圆润散景，避免重复纹理和假模糊。', 'Create optically continuous rounded bokeh without repeated texture or synthetic blur.'],
      ['前景虚化遮挡', 'Foreground Bokeh', '用轻量前景散景增强临场感，不遮挡主体关键区域。', 'Use subtle foreground bokeh for immersion without obscuring important subject areas.'],
      ['多人焦平面', 'Group Focus Plane', '让同一重要层级的人物面部都处于可接受清晰范围。', 'Keep all equally important faces within an acceptable focus plane.'],
      ['焦点堆栈', 'Focus Stacking', '合并多个焦平面，让产品、微距或静物从前到后清楚。', 'Combine focus planes so products, macro subjects, or still life remain clear front to back.'],
      ['眼睛精准对焦', 'Precise Eye Focus', '最近眼睛最清晰，鼻尖、耳朵和头发按真实景深衰减。', 'Keep the nearest eye sharpest with realistic falloff across nose, ears, and hair.'],
      ['产品全结构对焦', 'Full Product Focus', '保持产品关键面、标识区和结构边缘清晰。', 'Keep critical product surfaces, label areas, and structural edges in focus.'],
      ['建筑移轴校正', 'Architectural Shift Correction', '保持垂直线平行、透视自然并控制画面边缘。', 'Keep verticals parallel, perspective natural, and frame edges controlled.'],
      ['长曝光轨迹', 'Long-Exposure Trails', '让水流、车灯或云层形成连续轨迹，静止主体保持稳定。', 'Create continuous water, light, or cloud trails while keeping static subjects stable.'],
      ['高速冻结', 'High-Speed Freeze', '冻结动作关键瞬间，同时保留力量方向和必要动态感。', 'Freeze the decisive moment while retaining force direction and essential motion energy.'],
      ['柔光滤镜', 'Diffusion Filter', '添加轻微高光晕染和柔和反差，细节不被雾化吞没。', 'Add subtle highlight bloom and gentle contrast without fogging away detail.'],
      ['纯净光学成像', 'Clean Optical Rendering', '抑制色散、鬼影、脏镜和不合理畸变，保留自然镜头特性。', 'Suppress chromatic aberration, ghosting, dirty-lens artifacts, and implausible distortion while retaining natural lens character.'],
    ],
  },
  {
    category: {
      id: 'reference',
      code: 'I',
      labelZh: '参考图 / 一致性',
      labelEn: 'Reference Consistency',
      descriptionZh: '锁定参考图中的身份、服装、产品、构图或指定区域；需要至少一张参考图。',
      descriptionEn: 'Lock identity, clothing, product, composition, or specified regions from references; requires at least one reference image.',
      priority: 'P0',
      compileOrder: 10,
    },
    items: [
      ['身份锁定', 'Identity Lock', '保持参考人物身份、年龄感和核心面部特征不变。', 'Preserve the reference person’s identity, apparent age, and defining facial features.', 'reference'],
      ['五官锁定', 'Facial Feature Lock', '锁定眼、鼻、嘴、脸型和关键不对称特征，允许光线与表情变化。', 'Lock eyes, nose, mouth, face shape, and defining asymmetry while allowing light and expression changes.', 'reference'],
      ['发型锁定', 'Hairstyle Lock', '保持发长、发色、刘海、发缝和轮廓一致。', 'Preserve hair length, color, fringe, parting, and silhouette.', 'reference'],
      ['服装锁定', 'Wardrobe Lock', '保持服装款式、层次、图案、颜色和配饰位置一致。', 'Preserve clothing design, layers, pattern, color, and accessory placement.', 'reference'],
      ['身形比例锁定', 'Body Proportion Lock', '保持身高感、肩胯比例、四肢长度和体态特征。', 'Preserve perceived height, shoulder-hip ratio, limb length, and posture characteristics.', 'reference'],
      ['姿势跟随', 'Pose Reference', '跟随参考姿势和动作关系，不复制背景与无关风格。', 'Follow pose and action relationships without copying background or unrelated style.', 'reference'],
      ['构图跟随', 'Composition Lock', '保持参考的主体位置、画面裁切和留白结构。', 'Preserve reference subject placement, crop, and negative-space structure.', 'reference'],
      ['视角跟随', 'Viewpoint Lock', '保持参考相机高度、俯仰、方位和透视关系。', 'Preserve reference camera height, pitch, orientation, and perspective.', 'reference'],
      ['光线跟随', 'Lighting Lock', '复用参考主光方向、光比、色温和阴影软硬。', 'Reuse reference key-light direction, contrast ratio, color temperature, and shadow softness.', 'reference'],
      ['色调跟随', 'Color Grade Lock', '复用参考色彩关系和对比曲线，同时保护新主体固有色。', 'Reuse reference color relationships and contrast curve while protecting new subject colors.', 'reference'],
      ['风格跟随', 'Style Reference', '复用参考笔触、成像或设计语言，不复制其中具体人物和物体。', 'Reuse reference brushwork, imaging, or design language without copying specific people or objects.', 'reference'],
      ['产品外形锁定', 'Product Shape Lock', '保持轮廓、尺寸比例、结构接口和关键工业设计不变。', 'Preserve silhouette, dimensional proportions, interfaces, and key industrial design.', 'reference'],
      ['标识位置锁定', 'Logo Placement Lock', '保持已有 logo、标签和装饰的位置与比例，不生成新乱码。', 'Preserve existing logo, label, and decoration position and scale without inventing text.', 'reference'],
      ['材质锁定', 'Material Lock', '保持主体原有材质类别、表面粗糙度和反射特征。', 'Preserve the subject’s material class, surface roughness, and reflection behavior.', 'reference'],
      ['背景布局锁定', 'Background Layout Lock', '保持建筑、家具、道路和大空间位置关系，只改指定内容。', 'Preserve architecture, furniture, roads, and large-scale layout while changing only requested content.', 'reference'],
      ['人景关系锁定', 'Subject-Scene Relationship Lock', '保持人物与道具、座位、车辆或建筑的接触和位置关系。', 'Preserve contact and spatial relationships between people, props, seating, vehicles, and architecture.', 'reference'],
      ['多参考角色分离', 'Multi-Reference Separation', '明确每张参考图对应的角色或物体，禁止身份和服装串用。', 'Assign each reference to its intended person or object and prevent identity or wardrobe leakage.', 'reference'],
      ['仅修改指定区域', 'Edit Specified Region Only', '只改变用户点名区域，其余人物、背景、构图和光线保持不变。', 'Change only the explicitly specified region; preserve all other people, background, composition, and lighting.', 'reference'],
      ['保护未提及区域', 'Protect Unmentioned Regions', '未被要求修改的区域保持像素语义、结构和细节稳定。', 'Keep semantic content, structure, and detail stable in every unmentioned region.', 'reference'],
      ['语义参考去伪影', 'Reference Artifact Rejection', '只学习参考的目标特征，不复制水印、边框、拼图缝和压缩瑕疵。', 'Learn only intended reference traits; do not copy watermarks, borders, collage seams, or compression artifacts.', 'reference'],
    ],
  },
  {
    category: {
      id: 'structure',
      code: 'J',
      labelZh: '瑕疵 / 结构控制',
      labelEn: 'Structure & Cleanup',
      descriptionZh: '修复手部、人体、边缘、反射、文字等常见结构问题，并抑制过度处理。',
      descriptionEn: 'Correct common structural failures in hands, anatomy, edges, reflections, and text while preventing overprocessing.',
      priority: 'P0',
      compileOrder: 90,
    },
    items: [
      ['干净边缘', 'Clean Edges', '保持主体轮廓连续、自然抗锯齿，无白边、黑边和破碎遮罩。', 'Keep contours continuous and naturally anti-aliased without halos or broken masks.'],
      ['正确手部', 'Correct Hands', '手指数目、关节方向、抓握关系和遮挡符合真实结构。', 'Ensure correct finger count, joint direction, grip, and occlusion.'],
      ['正确人体结构', 'Correct Anatomy', '四肢数量、关节连接、重心和身体比例自然可信。', 'Maintain correct limbs, joint connections, center of gravity, and body proportions.'],
      ['自然面部结构', 'Natural Facial Structure', '五官位置、面部转折和左右差异自然，不做机械对称。', 'Keep facial placement, planes, and natural asymmetry without mechanical symmetry.'],
      ['视线一致', 'Consistent Gaze', '双眼方向、瞳孔位置和人物注视目标一致。', 'Align both eyes, pupil position, and the intended gaze target.'],
      ['自然牙齿', 'Natural Teeth', '牙齿数量、排列、光泽和嘴唇遮挡自然，不生成整齐白条。', 'Render believable tooth count, arrangement, sheen, and lip occlusion without a white strip.'],
      ['发丝边缘完整', 'Complete Hair Edges', '发束、碎发和耳部遮挡连续，无融化和断裂。', 'Keep hair locks, flyaways, and ear occlusion continuous without melting or breaks.'],
      ['配饰结构完整', 'Correct Accessories', '眼镜、耳环、项链、戒指和帽子连接方式正确。', 'Ensure glasses, earrings, necklaces, rings, and hats connect and sit correctly.'],
      ['无重复主体', 'No Duplicate Subjects', '不复制人物、肢体、产品、道具或背景元素。', 'Do not duplicate people, limbs, products, props, or background elements.'],
      ['无漂浮物体', 'No Floating Objects', '所有主体有可信支撑、悬挂或接触关系。', 'Give every object believable support, suspension, or contact.'],
      ['无粘连穿插', 'No Merging or Intersections', '人物、衣物、道具和背景边界不互相融化或错误穿透。', 'Prevent people, clothing, props, and backgrounds from melting together or intersecting incorrectly.'],
      ['建筑直线稳定', 'Stable Architectural Lines', '墙线、门窗、地平线和重复结构保持几何一致。', 'Keep walls, openings, horizons, and repeated structures geometrically consistent.'],
      ['反射逻辑正确', 'Correct Reflections', '镜面、水面和金属反射与主体位置、角度和光源一致。', 'Align mirror, water, and metal reflections with subject position, angle, and light sources.'],
      ['阴影逻辑正确', 'Correct Shadows', '阴影数量、方向、接触点和软硬符合真实光源。', 'Match shadow count, direction, contact point, and softness to real light sources.'],
      ['无随机文字', 'No Random Text', '不生成乱码、伪字幕、随机字母、水印或无关 logo。', 'Do not generate gibberish, fake subtitles, random letters, watermarks, or unrelated logos.'],
      ['无色带断层', 'No Color Banding', '渐变、天空和皮肤暗部平滑，无色带、块状和脏色。', 'Keep gradients, skies, and skin shadows smooth without banding, blocks, or dirty color.'],
      ['无压缩伪影', 'No Compression Artifacts', '清理马赛克、振铃、异常噪点和局部涂抹感。', 'Remove blocking, ringing, abnormal noise, and smeared local detail.'],
      ['高光不过曝', 'Protect Highlights', '保留亮部纹理和颜色，避免纯白剪切吞掉结构。', 'Retain highlight texture and color without white clipping that erases structure.'],
      ['暗部不死黑', 'Protect Shadows', '保留暗部材质、轮廓和色彩，不把阴影压成无信息黑块。', 'Retain shadow material, contours, and color without crushing them into empty black.'],
      ['不过度处理', 'Avoid Overprocessing', '避免塑料皮肤、HDR 光晕、过饱和、过锐和假细节。', 'Avoid plastic skin, HDR halos, oversaturation, oversharpening, and invented detail.'],
    ],
  },
  {
    category: {
      id: 'atmosphere',
      code: 'K',
      labelZh: '氛围 / 环境',
      labelEn: 'Atmosphere & Environment',
      descriptionZh: '用雾、天气、时段和空气粒子建立空间与情绪，但不遮挡核心主体。',
      descriptionEn: 'Use haze, weather, time, and particles to create space and mood without obscuring the primary subject.',
      priority: 'P1',
      compileOrder: 100,
    },
    items: [
      ['通透空气', 'Clear Air', '减少无依据灰雾，保留自然距离衰减和清晰空间层次。', 'Reduce unmotivated gray haze while preserving natural distance falloff and clear spatial layers.'],
      ['轻雾层次', 'Light Haze', '用薄雾分离前中后景，不遮挡主体面部和关键结构。', 'Use thin haze to separate depth layers without obscuring faces or key structure.'],
      ['晨雾氛围', 'Morning Mist', '使用低位柔雾、清冷环境光和初升暖光。', 'Use low soft mist, cool ambience, and the first warm sunlight.'],
      ['雨夜氛围', 'Rainy Night', '加入可信雨丝、湿地反射和有来源的城市灯光。', 'Add believable rain streaks, wet-ground reflections, and motivated city lights.'],
      ['雨后湿润', 'After the Rain', '保留停雨后的水膜、积水、潮湿色彩和稀疏滴水。', 'Retain moisture film, puddles, saturated color, and sparse dripping after rainfall.'],
      ['安静雪景', 'Quiet Snow', '使用柔和降雪、冷色环境光和合理积雪覆盖。', 'Use gentle snowfall, cool ambience, and physically plausible snow accumulation.'],
      ['尘埃阳光', 'Dust in Sunlight', '在侧逆光中加入少量可见尘埃，保持空气自然。', 'Add a small amount of visible dust in side or backlight while keeping the air natural.'],
      ['金色黄昏', 'Golden Dusk', '使用低角度暖光、长阴影和宁静暮色层次。', 'Use low warm light, long shadows, and calm dusk layers.'],
      ['蓝调夜幕', 'Blue Twilight', '使用日落后冷蓝环境和逐渐点亮的实景灯。', 'Use post-sunset cool ambience with practical lights gradually coming alive.'],
      ['城市霓虹夜', 'Neon City Night', '使用湿润反射、分层霓虹和深色环境，不让色光失控。', 'Use wet reflections, layered neon, and deep surroundings without uncontrolled color spill.'],
      ['烛光私密感', 'Intimate Candlelight', '使用近距离暖光、快速衰减和柔和暗部。', 'Use close warm light, rapid falloff, and gentle shadows for intimacy.'],
      ['工业冷峻', 'Industrial Cold', '使用金属、混凝土、冷白灯和克制雾气构成硬朗空间。', 'Build a hard industrial space with metal, concrete, cool white light, and restrained haze.'],
      ['热带湿润', 'Tropical Humidity', '使用高湿空气、浓绿植物、柔亮表面和温暖环境色。', 'Use humid air, dense greens, softly glossy surfaces, and warm environmental color.'],
      ['冬日干冷', 'Dry Winter Cold', '使用低湿清晰空气、冷阴影和偏低太阳角度。', 'Use dry clear air, cool shadows, and a low winter sun angle.'],
      ['盛夏通透', 'Clear Midsummer', '使用明亮天空、清晰阴影和高饱和但自然的环境色。', 'Use a bright sky, defined shadows, and saturated yet natural midsummer color.'],
      ['电影薄烟', 'Cinematic Thin Smoke', '使用受控薄烟呈现光路和层次，不形成舞台烟墙。', 'Use controlled thin smoke to reveal light paths and depth without a theatrical smoke wall.'],
      ['细微漂浮粒子', 'Subtle Floating Particles', '加入少量灰尘、花粉或微粒，尺度和受光保持一致。', 'Add sparse dust, pollen, or particles with consistent scale and lighting.'],
      ['水下焦散', 'Underwater Caustics', '使用水下蓝绿衰减、真实焦散和漂浮颗粒。', 'Use underwater blue-green attenuation, believable caustics, and suspended particles.'],
      ['梦境柔光', 'Dreamlike Soft Light', '使用克制辉光、柔和色彩过渡和轻微空间虚化，主体仍清楚。', 'Use restrained glow, soft color transitions, and slight spatial diffusion while keeping the subject clear.'],
      ['紧张压迫感', 'Tense Oppression', '使用收紧空间、低照度、深阴影和局部强光建立叙事压力。', 'Create narrative pressure through constrained space, low illumination, deep shadows, and local hard light.'],
    ],
  },
  {
    category: {
      id: 'motion',
      code: 'L',
      labelZh: '动态 / 叙事瞬间',
      labelEn: 'Motion & Narrative',
      descriptionZh: '让动作、受力、惯性和人物关系形成清楚的决定性瞬间。',
      descriptionEn: 'Shape action, force, inertia, and character relationships into a clear decisive moment.',
      priority: 'P1',
      compileOrder: 110,
    },
    items: [
      ['决定性瞬间', 'Decisive Moment', '捕捉动作最具表达力且身体结构最清楚的一刻。', 'Capture the most expressive instant while keeping body structure clearly readable.'],
      ['起势张力', 'Anticipation', '动作尚未爆发，重心、视线和预备姿态先建立明确方向。', 'Before the action breaks, establish direction through weight, gaze, and preparatory pose.'],
      ['冲击前一刻', 'Before Impact', '主体即将接触目标，保留可信距离、速度和紧张感。', 'Hold the instant before contact with believable distance, speed, and tension.'],
      ['冲击后反馈', 'After Impact', '接触后身体、衣物、碎屑和周围物体产生符合受力的反馈。', 'After contact, show force-consistent response in body, clothing, debris, and nearby objects.'],
      ['自然行走', 'Natural Walking', '步幅、摆臂、脚掌落地和重心转移符合真实步态。', 'Use realistic stride, arm swing, foot contact, and weight transfer.'],
      ['奔跑步态', 'Natural Running', '手脚交替、躯干前倾和地面反作用自然，避免同手同脚。', 'Keep alternating limbs, forward lean, and ground reaction natural without mirrored gait.'],
      ['跳跃滞空', 'Jump Suspension', '身体姿态、衣物、头发和随身物遵循同一惯性。', 'Keep body pose, clothing, hair, and carried objects under the same inertia.'],
      ['连续转身', 'Continuous Turn', '头、肩、髋和视线形成连续扭转，避免只扭脖子。', 'Coordinate head, shoulders, hips, and gaze through one continuous turn.'],
      ['舞蹈延展', 'Dance Extension', '肢体线条完整，动作流畅且关节、重心可信。', 'Keep full limb lines, fluid movement, believable joints, and stable weight.'],
      ['自然手势', 'Natural Gesture', '手部动作清楚、克制并服务于情绪，手指结构完整。', 'Use clear restrained hand gestures that support emotion with correct finger structure.'],
      ['双人视线互动', 'Two-Person Gaze', '两人的视线、距离、姿态和情绪形成明确叙事关系。', 'Align gaze, distance, pose, and emotion into a clear two-person narrative relationship.'],
      ['多人差异动作', 'Varied Group Action', '群体动作有节奏和个体差异，不呈复制粘贴姿势。', 'Give group action rhythm and individual variation rather than duplicated poses.'],
      ['道具互动', 'Prop Interaction', '手、道具、身体和视线形成完整因果链，不悬空或穿模。', 'Connect hands, props, body, and gaze into one causal chain without floating or intersections.'],
      ['自然手持产品', 'Natural Product Handling', '抓握、产品比例、遮挡和品牌展示位置合理。', 'Keep grip, product scale, occlusion, and brand-facing placement believable.'],
      ['头发惯性', 'Hair Inertia', '发束根据速度和转向产生自然延迟，不与身体反向乱飞。', 'Give hair a natural delayed response to speed and turning without contradictory motion.'],
      ['衣摆惯性', 'Fabric Inertia', '布料受动作与风力共同影响，褶皱和方向连续。', 'Let fabric respond coherently to both body motion and wind, with continuous folds and direction.'],
      ['水花与液体反馈', 'Liquid Reaction', '液体从真实接触点产生，规模与动作力度匹配。', 'Generate liquid response from real contact points at a scale matching the action.'],
      ['尘土与碎屑尾迹', 'Dust and Debris Trail', '运动后留下逐渐衰减的粒子轨迹，来源和方向明确。', 'Leave a decaying particle trail after movement with a clear source and direction.'],
      ['定向运动模糊', 'Directional Motion Blur', '模糊只沿运动方向出现，脸部或关键结构保持可辨。', 'Apply blur only along motion direction while preserving faces and critical structure.'],
      ['环境连锁反应', 'Environmental Chain Reaction', '动作带动纸张、树叶、布帘、液体或小物体产生合理反馈。', 'Let action trigger plausible secondary response in paper, leaves, curtains, liquid, or small objects.'],
    ],
  },
];

const itemOverrides: Record<string, Pick<ImagePromptAdjustmentItem, 'conflictKey' | 'conflictsWith'>> = {
  E01: { conflictKey: 'soft-focus', conflictsWith: ['hard-sharpness'] },
  E03: { conflictKey: 'hard-sharpness', conflictsWith: ['soft-focus'] },
  E20: { conflictKey: 'soft-sharp-balance' },
  F01: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F02: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F03: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F04: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F05: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F06: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F07: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F08: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F09: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F10: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F11: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F12: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F13: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F14: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F15: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F16: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F17: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F18: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F19: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  F20: { conflictKey: 'new-composition', conflictsWith: ['composition-lock'] },
  H08: { conflictKey: 'deep-focus', conflictsWith: ['shallow-focus'] },
  H09: { conflictKey: 'shallow-focus', conflictsWith: ['deep-focus'] },
  H10: { conflictKey: 'shallow-focus', conflictsWith: ['deep-focus'] },
  I07: { conflictKey: 'composition-lock', conflictsWith: ['new-composition'] },
  I09: { conflictKey: 'lighting-lock', conflictsWith: ['relighting'] },
  K01: { conflictKey: 'clear-air', conflictsWith: ['heavy-atmosphere'] },
  K02: { conflictKey: 'heavy-atmosphere', conflictsWith: ['clear-air'] },
  K03: { conflictKey: 'heavy-atmosphere', conflictsWith: ['clear-air'] },
  K16: { conflictKey: 'heavy-atmosphere', conflictsWith: ['clear-air'] },
};

for (let index = 1; index <= 20; index += 1) {
  const id = `B${String(index).padStart(2, '0')}`;
  itemOverrides[id] = {
    ...itemOverrides[id],
    conflictKey: 'relighting',
    conflictsWith: [...(itemOverrides[id]?.conflictsWith || []), 'lighting-lock'],
  };
}

export const IMAGE_PROMPT_ADJUSTMENT_CATEGORIES: readonly ImagePromptAdjustmentCategory[] =
  rawCategories.map(({ category }) => category);

export const IMAGE_PROMPT_ADJUSTMENTS: readonly ImagePromptAdjustmentItem[] =
  rawCategories.flatMap(({ category, items }) =>
    items.map((item, index) => {
      const id = `${category.code}${String(index + 1).padStart(2, '0')}`;
      const override = itemOverrides[id];
      return {
        id,
        categoryId: category.id,
        labelZh: item[0],
        labelEn: item[1],
        promptZh: item[2],
        promptEn: item[3],
        applicability: item[4] || (category.id === 'skin' ? 'people' : 'all'),
        ...(override || {}),
      };
    }),
  );

const categoryById = new Map(IMAGE_PROMPT_ADJUSTMENT_CATEGORIES.map((category) => [category.id, category]));
const itemById = new Map(IMAGE_PROMPT_ADJUSTMENTS.map((item) => [item.id, item]));

export function getImagePromptAdjustmentItem(itemId: string): ImagePromptAdjustmentItem | undefined {
  return itemById.get(itemId);
}

export function imagePromptAdjustmentsForCategory(categoryId: string): ImagePromptAdjustmentItem[] {
  return IMAGE_PROMPT_ADJUSTMENTS.filter((item) => item.categoryId === categoryId);
}

export function createImagePromptAdjustmentSelection(
  item: ImagePromptAdjustmentItem,
): ImagePromptAdjustmentSelection {
  return {
    ...item,
    itemId: item.id,
    catalogVersion: IMAGE_PROMPT_ADJUSTMENT_CATALOG_VERSION,
  };
}

function snapshotFromUnknown(value: unknown): ImagePromptAdjustmentSelection | null {
  if (typeof value === 'string') {
    const item = itemById.get(value);
    return item ? createImagePromptAdjustmentSelection(item) : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const itemId = String(record.itemId || record.id || '').trim();
  const catalogItem = itemById.get(itemId);
  if (catalogItem) {
    const sameVersion = record.catalogVersion === IMAGE_PROMPT_ADJUSTMENT_CATALOG_VERSION;
    if (!record.catalogVersion || sameVersion) return createImagePromptAdjustmentSelection(catalogItem);
  }

  const categoryId = String(record.categoryId || catalogItem?.categoryId || '').trim();
  const labelZh = String(record.labelZh || catalogItem?.labelZh || '').trim();
  const labelEn = String(record.labelEn || catalogItem?.labelEn || '').trim();
  const promptZh = String(record.promptZh || catalogItem?.promptZh || '').trim();
  const promptEn = String(record.promptEn || catalogItem?.promptEn || '').trim();
  if (!itemId || !categoryId || !labelZh || !labelEn || !promptZh || !promptEn) return null;
  return {
    itemId,
    categoryId,
    catalogVersion: String(record.catalogVersion || IMAGE_PROMPT_ADJUSTMENT_CATALOG_VERSION),
    labelZh,
    labelEn,
    promptZh,
    promptEn,
    applicability: record.applicability === 'reference' || record.applicability === 'people'
      ? record.applicability
      : (catalogItem?.applicability || 'all'),
    conflictKey: typeof record.conflictKey === 'string' ? record.conflictKey : catalogItem?.conflictKey,
    conflictsWith: Array.isArray(record.conflictsWith)
      ? record.conflictsWith.map(String).filter(Boolean)
      : catalogItem?.conflictsWith,
  };
}

export function normalizeImagePromptAdjustmentSelections(value: unknown): ImagePromptAdjustmentSelection[] {
  if (!Array.isArray(value)) return [];
  const byCategory = new Map<string, ImagePromptAdjustmentSelection>();
  for (const entry of value) {
    const selection = snapshotFromUnknown(entry);
    if (!selection || !categoryById.has(selection.categoryId)) continue;
    byCategory.set(selection.categoryId, selection);
  }
  return [...byCategory.values()].sort((left, right) => {
    const leftOrder = categoryById.get(left.categoryId)?.compileOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = categoryById.get(right.categoryId)?.compileOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.itemId.localeCompare(right.itemId);
  });
}

function selectionsConflict(
  left: ImagePromptAdjustmentSelection,
  right: ImagePromptAdjustmentSelection,
): boolean {
  if (left.categoryId === right.categoryId) return true;
  if (left.conflictKey && right.conflictsWith?.includes(left.conflictKey)) return true;
  return !!right.conflictKey && !!left.conflictsWith?.includes(right.conflictKey);
}

export function toggleImagePromptAdjustmentSelection(
  current: unknown,
  itemOrId: ImagePromptAdjustmentItem | string,
): ImagePromptAdjustmentSelection[] {
  const item = typeof itemOrId === 'string' ? itemById.get(itemOrId) : itemOrId;
  const normalized = normalizeImagePromptAdjustmentSelections(current);
  if (!item) return normalized;
  if (normalized.some((selection) => selection.itemId === item.id)) {
    return normalized.filter((selection) => selection.itemId !== item.id);
  }
  const nextSelection = createImagePromptAdjustmentSelection(item);
  return normalizeImagePromptAdjustmentSelections([
    ...normalized.filter((selection) => !selectionsConflict(selection, nextSelection)),
    nextSelection,
  ]);
}

function inferPromptLanguage(basePrompt: string): ImagePromptAdjustmentLanguage {
  const text = String(basePrompt || '').trim();
  if (!text) return 'zh';
  const hanCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  return latinCount > hanCount * 2 ? 'en' : 'zh';
}

export function compileImagePromptAdjustments(
  selections: unknown,
  options: CompileImagePromptAdjustmentOptions = {},
  basePrompt = '',
): CompiledImagePromptAdjustments {
  const normalized = normalizeImagePromptAdjustmentSelections(selections);
  const active: ImagePromptAdjustmentSelection[] = [];
  const inactive: CompiledImagePromptAdjustments['inactive'] = [];
  for (const selection of normalized) {
    if (selection.applicability === 'reference' && options.hasReferenceImages === false) {
      inactive.push({ ...selection, reason: '需要至少一张参考图' });
      continue;
    }
    active.push(selection);
  }
  const language = options.language && options.language !== 'auto'
    ? options.language
    : inferPromptLanguage(basePrompt);
  const prompts = active.map((selection) => (
    language === 'en' ? selection.promptEn : selection.promptZh
  ));
  return {
    text: prompts.length === 0
      ? ''
      : language === 'en'
        ? `Image adjustment requirements: ${prompts.join('; ')}`
        : `图像调节要求：${prompts.join('；')}`,
    active,
    inactive,
    language,
  };
}

export function combinePromptWithImageAdjustments(
  basePrompt: string,
  selections: unknown,
  options: CompileImagePromptAdjustmentOptions = {},
): CompiledImagePromptAdjustments & { finalPrompt: string } {
  const base = String(basePrompt || '').trim();
  const compiled = compileImagePromptAdjustments(selections, options, base);
  return {
    ...compiled,
    finalPrompt: [base, compiled.text].filter(Boolean).join('\n').trim(),
  };
}
