import { useEffect, useRef, useState } from 'react';
import './project-number.css';

interface ProjectNumberProps {
  value: string;
  active?: boolean;
  className?: string;
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('clipboard unavailable');
  } finally {
    field.remove();
  }
}

export function ProjectNumber({ value, active = false, className = '' }: ProjectNumberProps) {
  const [copyResult, setCopyResult] = useState<{ value: string; state: 'idle' | 'copied' | 'failed' }>({ value, state: 'idle' });
  const resetTimer = useRef<number | null>(null);
  const requestToken = useRef(0);
  const mounted = useRef(true);
  const copyState = copyResult.value === value ? copyResult.state : 'idle';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestToken.current += 1;
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    requestToken.current += 1;
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setCopyResult({ value, state: 'idle' });
  }, [value]);

  async function copyNumber() {
    const requestedValue = value;
    const token = ++requestToken.current;
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    let state: 'copied' | 'failed';
    try {
      await writeClipboard(requestedValue);
      state = 'copied';
    } catch {
      state = 'failed';
    }
    if (!mounted.current || token !== requestToken.current) return;
    setCopyResult({ value: requestedValue, state });
    resetTimer.current = window.setTimeout(() => {
      if (mounted.current && token === requestToken.current) setCopyResult({ value: requestedValue, state: 'idle' });
    }, 1800);
  }

  const stateLabel = copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '点击复制';
  return (
    <button
      className={`project-number ${active ? 'is-active' : ''} ${className}`.trim()}
      type="button"
      onClick={(event) => { event.stopPropagation(); void copyNumber(); }}
      aria-label={`复制项目编号 ${value}`}
      title={`${value} · ${stateLabel}`}
      data-copy-state={copyState}
    >
      <span className="project-number-digits">{value}</span>
      <span className="sr-only" aria-live="polite">{copyState === 'copied' ? `${value} 已复制` : copyState === 'failed' ? `${value} 复制失败` : ''}</span>
    </button>
  );
}
