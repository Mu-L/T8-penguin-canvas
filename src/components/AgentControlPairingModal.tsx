import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Loader2, ShieldCheck, X } from 'lucide-react';

const SCOPE_LABELS: Record<T8AgentControlScope, string> = {
  'canvas:read': '查看画布结构与创作上下文',
  'canvas:write': '预览后修改画布',
  'run:read': '查看任务状态与结果',
  'run:execute': '提交、取消或重试生成任务',
  'asset:read': '查看素材元数据',
  'asset:transfer': '上传或下载素材',
  'browser:handoff': '发起可见的浏览器接管请求',
};

function secondsRemaining(expiresAt: string) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

export default function AgentControlPairingModal() {
  const [pairings, setPairings] = useState<T8AgentControlPairing[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [approvedScopes, setApprovedScopes] = useState<T8AgentControlScope[]>([]);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pairing = pairings[0] || null;

  const refresh = useCallback(async () => {
    const bridge = window.t8pc?.agentControl;
    if (!bridge) return;
    try {
      const result = await bridge.listPendingPairings();
      if (!result.success) {
        setError(result.message || '无法读取 Agent 配对请求');
        return;
      }
      setPairings(Array.isArray(result.data) ? result.data : []);
    } catch {
      setError('无法读取 Agent 配对请求，请确认桌面端后端已启动');
    }
  }, []);

  useEffect(() => {
    if (!window.t8pc?.agentControl) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    setConfirmed(false);
    setError('');
    setApprovedScopes(pairing?.requestedScopes || []);
  }, [pairing?.pairingId]);

  const remaining = useMemo(
    () => pairing ? secondsRemaining(pairing.expiresAt) : 0,
    [pairing?.expiresAt, tick],
  );

  const restorePreviousFocus = useCallback(() => {
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    if (!previous?.isConnected) return;
    window.requestAnimationFrame(() => previous.focus());
  }, []);

  useEffect(() => {
    if (!pairing) {
      restorePreviousFocus();
      return undefined;
    }

    const activeElement = document.activeElement;
    if (
      !previousFocusRef.current
      && activeElement instanceof HTMLElement
      && activeElement !== document.body
      && !dialogRef.current?.contains(activeElement)
    ) {
      previousFocusRef.current = activeElement;
    }

    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pairing?.pairingId, restorePreviousFocus]);

  useEffect(() => () => {
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    if (previous?.isConnected) previous.focus();
  }, []);

  const deny = useCallback(async () => {
    if (!pairing || busy) return;
    setBusy('deny');
    setError('');
    try {
      const result = await window.t8pc!.agentControl!.denyPairing(pairing.pairingId);
      if (!result.success) {
        setError(result.message || '拒绝 Agent 失败');
        return;
      }
      setPairings((current) => current.filter((item) => item.pairingId !== pairing.pairingId));
    } catch {
      setError('拒绝 Agent 失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }, [busy, pairing]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void deny();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;

    const focusable = focusableElements(dialogRef.current);
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!pairing) return null;

  const toggleScope = (scope: T8AgentControlScope) => {
    setApprovedScopes((current) => (
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope]
    ));
  };

  const approve = async () => {
    if (!confirmed || !approvedScopes.length || busy) return;
    setBusy('approve');
    setError('');
    try {
      const result = await window.t8pc!.agentControl!.approvePairing({
        pairingId: pairing.pairingId,
        userCode: pairing.userCode,
        approvedScopes,
      });
      if (!result.success) {
        setError(result.message || '批准 Agent 失败');
        return;
      }
      setPairings((current) => current.filter((item) => item.pairingId !== pairing.pairingId));
    } catch {
      setError('批准 Agent 失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-control-pairing-title"
        aria-describedby="agent-control-pairing-description"
        data-agent-control-pairing-dialog
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-lime-400/30 bg-[#10150f] text-zinc-100 shadow-2xl shadow-lime-950/60"
      >
        <header className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-lime-400/15 text-lime-300">
            <Bot size={21} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="agent-control-pairing-title" className="text-base font-semibold">
              Agent 请求连接贞贞无限画布
            </h2>
            <p
              id="agent-control-pairing-description"
              className="mt-1 text-xs leading-relaxed text-zinc-400"
            >
              只有你在本机确认后，它才能按所选权限协助创作。API Key、Cookie 和密码不会提供给 Agent。
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-zinc-400 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-lime-300"
            onClick={() => void deny()}
            aria-label="拒绝并关闭"
          >
            <X size={17} />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
            <div>
              <div className="text-sm font-medium">{pairing.clientName}</div>
              <div className="mt-1 text-xs text-zinc-500">
                类型：{pairing.agentKind} · {pairings.length > 1 ? `还有 ${pairings.length - 1} 个请求` : '本机请求'}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-xl font-bold tracking-[0.18em] text-lime-300">
                {pairing.userCode}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">{remaining} 秒后过期</div>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
              <ShieldCheck size={14} className="text-lime-300" />
              本次允许的能力（可以取消不需要的权限）
            </div>
            <div className="space-y-2">
              {pairing.requestedScopes.map((scope) => (
                <label
                  key={scope}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={approvedScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    className="accent-lime-400"
                  />
                  <span>{SCOPE_LABELS[scope] || scope}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-100">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 accent-lime-400"
            />
            <span>我已核对验证码：Codex/Agent 终端显示的也是 <strong>{pairing.userCode}</strong>，并了解它将按上方权限操作当前应用。</span>
          </label>

          {error && (
            <div role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            disabled={Boolean(busy)}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-300 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-lime-300 disabled:opacity-50"
            onClick={() => void deny()}
          >
            {busy === 'deny' ? '正在拒绝…' : '拒绝'}
          </button>
          <button
            type="button"
            disabled={!confirmed || !approvedScopes.length || Boolean(busy)}
            className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-[#102000] outline-none hover:bg-lime-300 focus-visible:ring-2 focus-visible:ring-lime-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[#10150f] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void approve()}
          >
            {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            批准连接
          </button>
        </footer>
      </section>
    </div>
  );
}
