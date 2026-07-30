import type { MidjourneyNzOperation } from '../../services/generation';
import {
  MIDJOURNEY_NZ_ACTIONS,
  MIDJOURNEY_NZ_CUSTOM_ID_ACTIONS,
  MIDJOURNEY_NZ_ONE_BASED_INDEX_ACTIONS,
  MIDJOURNEY_NZ_OPTIONAL_INDEX_ACTIONS,
  MIDJOURNEY_NZ_TASK_ACTIONS,
} from '../../utils/midjourneyNz';

interface MidjourneyNzPanelProps {
  data: any;
  update: (patch: Record<string, unknown>) => void;
  imageCount: number;
  hasApiKey: boolean;
}
const fieldClass = 'w-full rounded border border-white/10 bg-[#18181b] px-2 py-1 text-xs text-white outline-none focus:border-cyan-400/60';
const labelClass = 'mb-1 block text-[10px] text-white/50';

export default function MidjourneyNzPanel({
  data,
  update,
  imageCount,
  hasApiKey,
}: MidjourneyNzPanelProps) {
  const operation = (MIDJOURNEY_NZ_ACTIONS.some((item) => item.value === data?.mjNzOperation)
    ? data.mjNzOperation
    : 'midjourney-imagine') as MidjourneyNzOperation;
  const action = MIDJOURNEY_NZ_ACTIONS.find((item) => item.value === operation)!;
  const videoSource: 'image' | 'task' = data?.mjNzVideoSource === 'task' ? 'task' : 'image';
  const needsTask = MIDJOURNEY_NZ_TASK_ACTIONS.has(operation)
    || (operation === 'midjourney-video' && videoSource === 'task');
  const supportsCustomId = MIDJOURNEY_NZ_CUSTOM_ID_ACTIONS.has(operation);
  const customId = String(data?.mjNzCustomId || '');
  const showsOneBasedIndex = !customId && (
    MIDJOURNEY_NZ_ONE_BASED_INDEX_ACTIONS.has(operation)
    || MIDJOURNEY_NZ_OPTIONAL_INDEX_ACTIONS.has(operation)
  );
  const buttons = Array.isArray(data?.mjNzButtons) ? data.mjNzButtons : [];
  const showStructured = operation === 'midjourney-imagine' || operation === 'midjourney-edits';

  return (
    <div className="space-y-2 rounded border border-cyan-400/30 bg-cyan-500/5 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold tracking-wide text-cyan-200">
          贞贞的平价AI小屋 · Midjourney
        </div>
        <span className="rounded bg-cyan-400/10 px-1.5 py-0.5 text-[9px] text-cyan-100/70">
          {action.result === 'image' ? '图片' : action.result === 'video' ? '视频' : action.result === 'text' ? '文本' : '交互阶段'}
        </span>
      </div>

      <div>
        <label className={labelClass}>功能（16 个官方动作）</label>
        <select
          value={operation}
          onChange={(event) => update({
            mjNzOperation: event.currentTarget.value,
            error: null,
          })}
          className={fieldClass}
        >
          {MIDJOURNEY_NZ_ACTIONS.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </div>
      <div className="rounded border border-cyan-300/15 bg-black/10 px-2 py-1 text-[10px] leading-4 text-cyan-50/70">
        {action.summary}
        <span className="ml-1 text-white/40">当前参考图 {imageCount} 张。</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>速度</label>
          <select
            value={data?.mjNzSpeed || 'fast'}
            onChange={(event) => update({ mjNzSpeed: event.currentTarget.value })}
            className={fieldClass}
          >
            <option value="fast">Fast</option>
            <option value="relax">Relax</option>
            <option value="turbo">Turbo</option>
          </select>
        </div>
        {operation === 'midjourney-blend' && (
          <div>
            <label className={labelClass}>画布方向</label>
            <select
              value={data?.mjNzDimensions || 'SQUARE'}
              onChange={(event) => update({ mjNzDimensions: event.currentTarget.value })}
              className={fieldClass}
            >
              <option value="SQUARE">正方形</option>
              <option value="PORTRAIT">竖向</option>
              <option value="LANDSCAPE">横向</option>
            </select>
          </div>
        )}
      </div>

      {needsTask && (
        <div className="space-y-2 rounded border border-white/10 bg-black/10 p-2">
          <div>
            <label className={labelClass}>来源任务 ID</label>
            <input
              value={data?.mjNzSourceTaskId || data?.mjNzLastTaskId || data?.taskId || ''}
              onChange={(event) => update({ mjNzSourceTaskId: event.currentTarget.value })}
              placeholder="粘贴之前 Midjourney 任务 ID"
              className={fieldClass}
            />
          </div>
          {supportsCustomId && (
            <div>
              <label className={labelClass}>custom_id（可选，填写后优先于索引/方向）</label>
              <input
                value={customId}
                onChange={(event) => update({ mjNzCustomId: event.currentTarget.value })}
                placeholder="可从上次任务返回的按钮中选择"
                className={fieldClass}
              />
            </div>
          )}
          {buttons.length > 0 && supportsCustomId && (
            <div className="flex flex-wrap gap-1">
              {buttons.slice(0, 24).map((button: any, index: number) => (
                <button
                  key={`${button?.customId || button?.label || index}`}
                  type="button"
                  onClick={() => update({ mjNzCustomId: button?.customId || '' })}
                  className="rounded border border-cyan-300/20 bg-cyan-400/10 px-1.5 py-0.5 text-[9px] text-cyan-100 hover:bg-cyan-400/20"
                  title={button?.customId || ''}
                >
                  {button?.label || `动作 ${index + 1}`}
                </button>
              ))}
            </div>
          )}
          {showsOneBasedIndex && (
            <div>
              <label className={labelClass}>子图索引（1–4）</label>
              <select
                value={Math.max(1, Math.min(4, Number(data?.mjNzIndex) || 1))}
                onChange={(event) => update({ mjNzIndex: Number(event.currentTarget.value) })}
                className={fieldClass}
              >
                {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {operation === 'midjourney-pan' && !customId && (
        <div>
          <label className={labelClass}>扩图方向</label>
          <select
            value={data?.mjNzDirection || 'left'}
            onChange={(event) => update({ mjNzDirection: event.currentTarget.value })}
            className={fieldClass}
          >
            <option value="left">左</option>
            <option value="right">右</option>
            <option value="up">上</option>
            <option value="down">下</option>
          </select>
        </div>
      )}

      {operation === 'midjourney-zoom' && !customId && (
        <div>
          <label className={labelClass}>Zoom 倍率（1.0–2.0）</label>
          <input
            type="number"
            min={1}
            max={2}
            step={0.1}
            value={data?.mjNzZoomRatio ?? 2}
            onChange={(event) => update({ mjNzZoomRatio: Number(event.currentTarget.value) })}
            className={fieldClass}
          />
        </div>
      )}

      {operation === 'midjourney-modal' && (
        <div className="space-y-2">
          <div>
            <label className={labelClass}>Modal 模式</label>
            <select
              value={data?.mjNzModalMode === 'outpaint' ? 'outpaint' : 'region'}
              onChange={(event) => update({ mjNzModalMode: event.currentTarget.value })}
              className={fieldClass}
            >
              <option value="region">局部重绘（第 1 张参考图必须是 PNG 遮罩）</option>
              <option value="outpaint">扩图（不使用遮罩）</option>
            </select>
          </div>
          {data?.mjNzModalMode !== 'outpaint' && (
            <div className="text-[10px] leading-4 text-amber-200/80">
              请把 PNG 遮罩上传或连接为本节点第 1 张参考图。遮罩和来源任务必须在进入 MODAL 后 30 分钟内提交。
            </div>
          )}
        </div>
      )}

      {operation === 'midjourney-video' && (
        <div className="space-y-2 rounded border border-white/10 bg-black/10 p-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>视频来源</label>
              <select
                value={videoSource}
                onChange={(event) => update({ mjNzVideoSource: event.currentTarget.value })}
                className={fieldClass}
              >
                <option value="image">参考图（第 1 张）</option>
                <option value="task">历史任务</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>视频规格</label>
              <select
                value={data?.mjNzVideoType || 'vid_1.1_i2v_480'}
                onChange={(event) => update({ mjNzVideoType: event.currentTarget.value })}
                className={fieldClass}
              >
                <option value="vid_1.1_i2v_480">480p</option>
                <option value="vid_1.1_i2v_720">720p</option>
                <option value="vid_1.1_i2v_start_end_480">首尾帧 480p（第 2 张为尾帧）</option>
                <option value="vid_1.1_i2v_start_end_720">首尾帧 720p（第 2 张为尾帧）</option>
              </select>
            </div>
          </div>
          {videoSource === 'task' && (
            <div>
              <label className={labelClass}>任务子图索引（0–3）</label>
              <select
                value={Math.max(0, Math.min(3, Number(data?.mjNzVideoIndex) || 0))}
                onChange={(event) => update({ mjNzVideoIndex: Number(event.currentTarget.value) })}
                className={fieldClass}
              >
                {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={labelClass}>动画</label>
              <select
                value={data?.mjNzAnimateMode || 'manual'}
                onChange={(event) => update({ mjNzAnimateMode: event.currentTarget.value })}
                className={fieldClass}
              >
                <option value="manual">Manual</option>
                <option value="auto">Auto</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>运动</label>
              <select
                value={data?.mjNzMotion || 'low'}
                onChange={(event) => update({ mjNzMotion: event.currentTarget.value })}
                className={fieldClass}
              >
                <option value="low">Low</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>批量</label>
              <select
                value={[1, 2, 4].includes(Number(data?.mjNzBatchSize)) ? Number(data.mjNzBatchSize) : 1}
                onChange={(event) => update({ mjNzBatchSize: Number(event.currentTarget.value) })}
                className={fieldClass}
              >
                {[1, 2, 4].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {showStructured && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => update({ mjNzAdvancedOpen: !data?.mjNzAdvancedOpen })}
            className="w-full rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-white/60 hover:text-white"
          >
            {data?.mjNzAdvancedOpen ? '收起 Imagine / Edits 高级参数' : '展开 Imagine / Edits 高级参数'}
          </button>
          {data?.mjNzAdvancedOpen && (
            <div className="space-y-2 rounded border border-white/10 bg-black/10 p-2">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className={labelClass}>Version</label>
                  <select
                    value={data?.mjNzVersion || '8.1'}
                    onChange={(event) => update({ mjNzVersion: event.currentTarget.value })}
                    className={fieldClass}
                  >
                    {['5', '5.1', '5.2', '6', '6.1', '7', '8.1', '8.2'].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Quality</label>
                  <select
                    value={data?.mjNzQuality || '1'}
                    onChange={(event) => update({ mjNzQuality: event.currentTarget.value })}
                    className={fieldClass}
                  >
                    {['0.25', '0.5', '1', '2'].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Seed（-1 不传）</label>
                  <input
                    type="number"
                    min={-1}
                    value={data?.mjNzSeed ?? -1}
                    onChange={(event) => update({ mjNzSeed: Number(event.currentTarget.value) })}
                    className={fieldClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['Stylize', 'mjNzStylize', -1],
                  ['Chaos', 'mjNzChaos', -1],
                  ['Weird', 'mjNzWeird', -1],
                  ['IW', 'mjNzIw', -1],
                  ['CW', 'mjNzCw', -1],
                  ['SW', 'mjNzSw', -1],
                  ['DW', 'mjNzDw', -1],
                  ['Repeat', 'mjNzRepeat', 0],
                  ['Stop', 'mjNzStop', 0],
                ].map(([label, key, fallback]) => (
                  <div key={String(key)}>
                    <label className={labelClass}>{label}</label>
                    <input
                      type="number"
                      value={data?.[String(key)] ?? fallback}
                      onChange={(event) => update({ [String(key)]: Number(event.currentTarget.value) })}
                      className={fieldClass}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-5 gap-1 text-[9px] text-white/60">
                {[
                  ['Tile', 'mjNzTile'],
                  ['Niji', 'mjNzNiji'],
                  ['Raw', 'mjNzRaw'],
                  ['Draft', 'mjNzDraft'],
                  ['HD', 'mjNzHd'],
                ].map(([label, key]) => (
                  <label key={key} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={data?.[key] === true}
                      onChange={(event) => update({ [key]: event.currentTarget.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {[
                ['Style', 'mjNzStyle', '风格字符串（可选）'],
                ['Negative', 'mjNzNegativePrompt', '负面提示词（可选）'],
                ['Cref', 'mjNzCref', '角色参考图片地址（可选）'],
                ['Sref', 'mjNzSref', '风格参考图片地址（可选）'],
                ['Dref', 'mjNzDref', '材质参考图片地址（可选）'],
                ['Extra', 'mjNzExtra', '额外官方参数字符串（可选）'],
              ].map(([label, key, placeholder]) => (
                <div key={key}>
                  <label className={labelClass}>{label}</label>
                  <input
                    value={data?.[key] || ''}
                    onChange={(event) => update({ [key]: event.currentTarget.value })}
                    placeholder={placeholder}
                    className={fieldClass}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!hasApiKey && (
        <div className="rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          尚未配置“贞贞的平价AI小屋 API Key”。
        </div>
      )}
    </div>
  );
}
