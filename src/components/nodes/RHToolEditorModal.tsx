/**
 * RH 工具节点 - 编辑器 Modal（T8 子项目复刻版）
 *
 * 两个 Tab：
 * 1) 应用：列出所有应用，支持新增、编辑（标题/简介/分类/webappId/封面）、删除
 * 2) 分类：列出分类，支持新增、重命名、删除（删除会把分类下应用归零为未分类）
 *
 * 仅作为浮层渲染，由 RHToolsNode 在用户点击「编辑」时打开。
 * 自动填名：通过 fetchRhAppInfo(webappId) 从 T8 后端 /api/proxy/runninghub/app-info 拉取。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { useRHTools } from '../../providers/RHToolsProvider';
import type { RHTool, RHToolCategory, RHToolsBackup } from '../../services/api';
import { fetchRhAppInfo } from '../../services/generation';
import PromptTextarea from '../PromptTextarea';

interface RHToolEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  isLight: boolean;
  defaultCategoryId?: string; // 添加应用时默认选中的分类
}

const RHToolEditorModal: React.FC<RHToolEditorModalProps> = ({ isOpen, onClose, isLight, defaultCategoryId }) => {
  const { categories, tools, addCategory, renameCategory, deleteCategory, addTool, updateTool, deleteTool, importBackup } = useRHTools();
  const [tab, setTab] = useState<'apps' | 'categories'>('apps');
  const importInputRef = useRef<HTMLInputElement>(null);

  // 主题色
  const bg = isLight ? '#ffffff' : '#1c1c1e';
  const surface = isLight ? '#f5f5f7' : '#2c2c2e';
  const text = isLight ? '#1c1c1e' : '#e5e5e7';
  const subText = isLight ? '#6b7280' : '#9ca3af';
  const border = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
  const accent = isLight ? 'rgb(8, 145, 178)' : 'rgb(34, 211, 238)'; // v1.2.10.2 cyan-600/400, 与 RHToolsNode 一致

  // 应用表单状态
  const [editingTool, setEditingTool] = useState<RHTool | null>(null);
  const emptyForm = useMemo(
    () => ({
      webappId: '',
      rhSite: 'cn' as 'cn' | 'intl',
      title: '',
      description: '',
      categoryId:
        defaultCategoryId && !['all', 'uncategorized'].includes(defaultCategoryId) ? defaultCategoryId : '',
      coverUrl: '',
    }),
    [defaultCategoryId],
  );
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [autoFetching, setAutoFetching] = useState(false);

  // 分类表单
  const [newCatName, setNewCatName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [transferMsg, setTransferMsg] = useState('');

  // 重置表单
  useEffect(() => {
    if (!isOpen) {
      setEditingTool(null);
      setForm(emptyForm);
      setFormError('');
      setRenamingId(null);
      setRenameValue('');
      setNewCatName('');
      setTransferMsg('');
    } else {
      setForm(emptyForm);
    }
  }, [isOpen, emptyForm]);

  if (!isOpen) return null;

  const startEditTool = (t: RHTool) => {
    setEditingTool(t);
    setForm({
      webappId: t.webappId,
      rhSite: t.rhSite === 'intl' ? 'intl' : 'cn',
      title: t.title,
      description: t.description || '',
      categoryId: t.categoryId || '',
      coverUrl: t.coverUrl || '',
    });
    setFormError('');
    setTab('apps');
  };

  const cancelEdit = () => {
    setEditingTool(null);
    setForm(emptyForm);
    setFormError('');
  };

  const handleAutoFetchTitle = async () => {
    if (!form.webappId.trim()) return;
    setAutoFetching(true);
    setFormError('');
    try {
      const data = await fetchRhAppInfo(form.webappId.trim(), form.rhSite);
      const cover = data?.covers?.[0]?.thumbnailUri || data?.covers?.[0]?.url || '';
      setForm((f) => ({
        ...f,
        rhSite: data?.rhSite === 'intl' ? 'intl' : f.rhSite,
        title: f.title || data?.webappName || '',
        coverUrl: f.coverUrl || cover,
      }));
    } catch (e) {
      setFormError((e as Error)?.message || '获取应用信息失败');
    } finally {
      setAutoFetching(false);
    }
  };

  const handleSubmitTool = async () => {
    if (!form.webappId.trim()) {
      setFormError('请填写 webappId');
      return;
    }
    if (!form.title.trim()) {
      setFormError('请填写应用标题');
      return;
    }
    setFormError('');
    if (editingTool) {
      const r = await updateTool(editingTool.id, {
        webappId: form.webappId.trim(),
        rhSite: form.rhSite,
        title: form.title.trim(),
        description: form.description,
        categoryId: form.categoryId || '',
        coverUrl: form.coverUrl,
      });
      if (!r) setFormError('更新失败');
      else cancelEdit();
    } else {
      const r = await addTool({
        webappId: form.webappId.trim(),
        rhSite: form.rhSite,
        title: form.title.trim(),
        description: form.description,
        categoryId: form.categoryId || '',
        coverUrl: form.coverUrl,
      });
      if (!r) setFormError('添加失败');
      else cancelEdit();
    }
  };

  const handleDeleteTool = async (t: RHTool) => {
    if (!window.confirm(`确认删除应用「${t.title}」?`)) return;
    await deleteTool(t.id);
  };

  const handleAddCategory = async () => {
    if (!newCatName.trim()) return;
    const r = await addCategory(newCatName.trim());
    if (r) setNewCatName('');
  };

  const handleConfirmRename = async (cat: RHToolCategory) => {
    if (!renameValue.trim() || renameValue.trim() === cat.name) {
      setRenamingId(null);
      return;
    }
    await renameCategory(cat.id, renameValue.trim());
    setRenamingId(null);
  };

  const handleDeleteCategory = async (cat: RHToolCategory) => {
    const cnt = tools.filter((t) => t.categoryId === cat.id).length;
    const msg = cnt > 0
      ? `确认删除分类「${cat.name}」?该分类下 ${cnt} 个应用将变为「未分类」。`
      : `确认删除分类「${cat.name}」?`;
    if (!window.confirm(msg)) return;
    await deleteCategory(cat.id);
  };

  const handleExportBackup = () => {
    const payload: RHToolsBackup = {
      schema: 't8-rh-tools',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories,
      tools,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `t8-rh-tools-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setTransferMsg(`已导出 ${categories.length} 个分类 / ${tools.length} 个应用`);
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const payload: RHToolsBackup = {
        schema: json?.schema || 't8-rh-tools',
        version: Number(json?.version || 1),
        exportedAt: json?.exportedAt,
        categories: Array.isArray(json?.categories) ? json.categories : [],
        tools: Array.isArray(json?.tools) ? json.tools : [],
      };
      if (payload.categories.length === 0 && payload.tools.length === 0) {
        setTransferMsg('导入失败：文件里没有 RH 超市数据');
        return;
      }
      const ok = window.confirm(
        `导入将覆盖当前 RH 超市数据。\n\n文件中包含 ${payload.categories.length} 个分类 / ${payload.tools.length} 个应用，是否继续?`
      );
      if (!ok) return;
      const success = await importBackup(payload, 'replace');
      setTransferMsg(success ? `导入完成：${payload.categories.length} 个分类 / ${payload.tools.length} 个应用` : '导入失败：后端写入失败');
    } catch (err) {
      console.error(err);
      setTransferMsg('导入失败：JSON 解析错误');
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: surface,
    color: text,
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 13,
    outline: 'none',
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9999, background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="rounded-xl shadow-2xl flex flex-col nodrag nowheel"
        style={{
          background: bg,
          color: text,
          width: 560,
          maxWidth: '92vw',
          maxHeight: '86vh',
          border: `1px solid ${border}`,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${border}` }}>
          <div className="flex items-center gap-3">
            <div className="text-base font-semibold">RH 超市管理</div>
            <div className="flex items-center gap-1 text-xs" style={{ background: surface, padding: 2, borderRadius: 6 }}>
              <button
                onClick={() => setTab('apps')}
                className="px-2 py-1 rounded"
                style={{
                  background: tab === 'apps' ? accent : 'transparent',
                  color: tab === 'apps' ? '#fff' : subText,
                }}
              >
                应用 ({tools.length})
              </button>
              <button
                onClick={() => setTab('categories')}
                className="px-2 py-1 rounded"
                style={{
                  background: tab === 'categories' ? accent : 'transparent',
                  color: tab === 'categories' ? '#fff' : subText,
                }}
              >
                分类 ({categories.length})
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleExportBackup}
              className="px-2 py-1 rounded text-xs flex items-center gap-1"
              style={{ background: surface, color: text, border: `1px solid ${border}` }}
              title="导出 RH 超市 JSON"
            >
              <Download size={12} /> 导出
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              className="px-2 py-1 rounded text-xs flex items-center gap-1"
              style={{ background: accent, color: '#fff', border: `1px solid ${accent}` }}
              title="导入 RH 超市 JSON"
            >
              <Upload size={12} /> 导入
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportBackup}
            />
          </div>
          <button onClick={onClose} className="text-xl leading-none hover:opacity-70" style={{ color: subText }}>
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {transferMsg && (
            <div
              className="text-xs px-3 py-2 rounded mb-3"
              style={{ background: surface, color: transferMsg.includes('失败') ? '#ef4444' : accent, border: `1px solid ${border}` }}
            >
              {transferMsg}
            </div>
          )}
          {tab === 'apps' && (
            <div className="flex flex-col gap-3">
              {/* 表单 */}
              <div className="rounded-lg p-3 flex flex-col gap-2" style={{ background: surface }}>
                <div className="text-xs font-semibold" style={{ color: subText }}>
                  {editingTool ? `编辑：${editingTool.title}` : '添加应用'}
                </div>
                <div className="flex gap-2">
                  <select
                    aria-label="RunningHub 站点"
                    value={form.rhSite}
                    onChange={(e) => setForm((f) => ({ ...f, rhSite: e.target.value === 'intl' ? 'intl' : 'cn' }))}
                    style={{ ...inputStyle, width: 150, flex: '0 0 150px' }}
                    title="选择该应用所属的 RunningHub 站点"
                  >
                    <option value="cn">国内站 .cn</option>
                    <option value="intl">海外站 .ai</option>
                  </select>
                  <input
                    placeholder="webappId（RunningHub AI 应用 ID）"
                    value={form.webappId}
                    onChange={(e) => setForm((f) => ({ ...f, webappId: e.target.value }))}
                    style={inputStyle}
                  />
                  <button
                    onClick={handleAutoFetchTitle}
                    disabled={autoFetching || !form.webappId.trim()}
                    className="px-2 py-1 rounded text-xs whitespace-nowrap"
                    style={{
                      background: accent,
                      color: '#fff',
                      opacity: autoFetching || !form.webappId.trim() ? 0.5 : 1,
                    }}
                  >
                    {autoFetching ? '获取中' : '自动填名'}
                  </button>
                </div>
                <input
                  placeholder="应用标题（节点上显示）"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  style={inputStyle}
                />
                <PromptTextarea
                  title="RH 超市应用简介"
                  placeholder="简介（点击应用时显示在节点底部）"
                  value={form.description}
                  rows={2}
                  onValueChange={(value) => setForm((f) => ({ ...f, description: value }))}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
                <div className="flex gap-2 items-center">
                  <span className="text-xs" style={{ color: subText, width: 48 }}>
                    分类
                  </span>
                  <select
                    value={form.categoryId}
                    onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
                    style={inputStyle}
                  >
                    <option value="">未分类</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  placeholder="封面 URL（可选）"
                  value={form.coverUrl}
                  onChange={(e) => setForm((f) => ({ ...f, coverUrl: e.target.value }))}
                  style={inputStyle}
                />
                {formError && (
                  <div
                    className="text-xs px-2 py-1 rounded"
                    style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
                  >
                    {formError}
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-1">
                  {editingTool && (
                    <button
                      onClick={cancelEdit}
                      className="px-3 py-1 rounded text-xs"
                      style={{ background: 'transparent', color: subText, border: `1px solid ${border}` }}
                    >
                      取消
                    </button>
                  )}
                  <button
                    onClick={handleSubmitTool}
                    className="px-3 py-1 rounded text-xs font-medium"
                    style={{ background: accent, color: '#fff' }}
                  >
                    {editingTool ? '保存修改' : '+ 添加'}
                  </button>
                </div>
              </div>

              {/* 列表 */}
              <div className="flex flex-col gap-1">
                <div className="text-xs px-1" style={{ color: subText }}>
                  已添加（{tools.length}）
                </div>
                {tools.length === 0 && (
                  <div
                    className="text-xs py-6 text-center rounded"
                    style={{ color: subText, background: surface }}
                  >
                    暂无应用，先添加一个吧
                  </div>
                )}
                {tools.map((t) => {
                  const cat = categories.find((c) => c.id === t.categoryId);
                  return (
                    <div
                      key={t.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:opacity-90"
                      style={{ background: surface }}
                    >
                      {t.coverUrl ? (
                        <img
                          src={t.coverUrl}
                          alt=""
                          style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 6,
                            background: bg,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: subText,
                            fontSize: 10,
                          }}
                        >
                          RH
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{t.title}</div>
                        <div className="text-[11px] truncate" style={{ color: subText }}>
                          {cat ? cat.name : '未分类'} · {t.webappId}
                        </div>
                      </div>
                      <button
                        onClick={() => startEditTool(t)}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{ color: accent }}
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleDeleteTool(t)}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{ color: '#ef4444' }}
                      >
                        删除
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'categories' && (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg p-3 flex gap-2" style={{ background: surface }}>
                <input
                  placeholder="新分类名"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddCategory();
                  }}
                  style={inputStyle}
                />
                <button
                  onClick={handleAddCategory}
                  className="px-3 py-1 rounded text-xs font-medium whitespace-nowrap"
                  style={{ background: accent, color: '#fff', opacity: newCatName.trim() ? 1 : 0.5 }}
                  disabled={!newCatName.trim()}
                >
                  + 添加
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {categories.length === 0 && (
                  <div
                    className="text-xs py-6 text-center rounded"
                    style={{ color: subText, background: surface }}
                  >
                    暂无分类
                  </div>
                )}
                {categories.map((c) => {
                  const cnt = tools.filter((t) => t.categoryId === c.id).length;
                  const isRenaming = renamingId === c.id;
                  return (
                    <div
                      key={c.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded"
                      style={{ background: surface }}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleConfirmRename(c)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleConfirmRename(c);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          style={{ ...inputStyle, padding: '2px 6px' }}
                        />
                      ) : (
                        <div className="flex-1 min-w-0 text-sm truncate">{c.name}</div>
                      )}
                      <span className="text-[11px]" style={{ color: subText }}>
                        {cnt} 个应用
                      </span>
                      {!isRenaming && (
                        <button
                          onClick={() => {
                            setRenamingId(c.id);
                            setRenameValue(c.name);
                          }}
                          className="text-[11px] px-2 py-1 rounded"
                          style={{ color: accent }}
                        >
                          重命名
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteCategory(c)}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{ color: '#ef4444' }}
                      >
                        删除
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RHToolEditorModal;
