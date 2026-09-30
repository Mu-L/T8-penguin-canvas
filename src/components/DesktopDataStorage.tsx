import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function DesktopDataStorage() {
  const { i18n } = useTranslation();
  const english = i18n.language.startsWith('en');
  const [status, setStatus] = useState<{ enabled: boolean; path?: string; freeBytes?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true;
    void window.t8pc?.storage?.status().then((value) => { if (active) setStatus(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!status?.enabled) return null;
  return <section className="my-3 rounded-lg border p-3 text-left text-sm" data-desktop-data-storage>
    <p className="font-bold">{english ? 'Application data directory' : '应用数据目录（画布、素材、配置）'}</p>
    <p className="break-all text-xs mt-2">{status.path}</p>
    <p className="text-xs my-2">{english ? 'Keep 10 GiB free on the data drive. System temporary drive still needs 0.5 GiB.' : '建议数据所在盘预留至少 10 GiB；系统临时目录所在盘仍需至少 0.5 GiB。'}
      {status.freeBytes != null ? ` ${english ? 'Available' : '当前剩余'} ${(status.freeBytes / 1024 ** 3).toFixed(2)} GiB。` : ''}</p>
    <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { const result = await window.t8pc?.storage?.chooseAndRestart(); if (result?.error) setError(result.error); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>{busy ? (english ? 'Preparing…' : '准备中…') : (english ? 'Choose another drive and restart' : '选择其他盘并迁移重启')}</button>
    {error && <p role="alert" className="text-red-500 mt-2">{error}</p>}
  </section>;
}
