import { useEffect, useState } from 'react';
import type { Operation } from '@e-launcher/center-contract';
import { api } from '../api';

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function ConfigOperation({ id, onFinished }: { id: string; onFinished?(): void }) {
  const [operation, setOperation] = useState<Operation>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.getOperation(id);
        if (!active) return;
        setOperation(next); setError('');
        if (['applied', 'failed', 'removed'].includes(next.phase)) onFinished?.();
        else timer = setTimeout(poll, 1500);
      } catch (e) { if (active) { setError(errorMessage(e)); timer = setTimeout(poll, 5000); } }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [id]);
  return <div className="config-operation" role="status"><strong>操作 {id}</strong><p>阶段：{operation?.phase ?? '读取中'}</p>{operation?.error && <p role="alert">{operation.error.message}</p>}{error && <p role="alert">{error}；正在重试读取状态</p>}<small>受理不代表部署完成，请查看设备回执。</small></div>;
}
