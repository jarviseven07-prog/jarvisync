import { Maximize2, Minimize, Minimize2, ScanLine, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import './desktop-window-controls.css';

type DesktopWindowState = {
  isMaximized: boolean;
  isFullScreen: boolean;
};

type DesktopWindowApi = {
  getState: () => Promise<DesktopWindowState>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  toggleFullScreen: () => Promise<void>;
  close: () => Promise<void>;
  onStateChange: (listener: (state: DesktopWindowState) => void) => () => void;
};

declare global {
  interface Window {
    desktopWindow?: DesktopWindowApi;
  }
}

const initialState: DesktopWindowState = { isMaximized: false, isFullScreen: false };

export function DesktopWindowControls() {
  const desktopWindow = window.desktopWindow;
  const [state, setState] = useState(initialState);

  useEffect(() => {
    if (!desktopWindow) return;
    let active = true;
    void desktopWindow.getState().then((next) => {
      if (active) setState(next);
    }).catch(() => {});
    const unsubscribe = desktopWindow.onStateChange((next) => {
      if (active) setState(next);
    });
    return () => { active = false; unsubscribe(); };
  }, [desktopWindow]);

  if (!desktopWindow) return null;

  return (
    <header className={`desktop-window-controls${state.isFullScreen ? ' is-full-screen' : ''}`} aria-label="桌面窗口控制栏">
      <div className="desktop-window-title" aria-label="拖动窗口">
        <span>JarviSync · 项目画布</span>
        {state.isFullScreen && <small>全屏</small>}
      </div>
      <div className="desktop-window-actions" aria-label="窗口操作">
        <button type="button" onClick={() => void desktopWindow.minimize()} aria-label="最小化窗口" title="最小化">
          <Minimize size={15} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={() => void desktopWindow.toggleMaximize()} aria-label={state.isMaximized ? '还原窗口' : '最大化窗口'} title={state.isMaximized ? '还原窗口' : '最大化窗口'}>
          {state.isMaximized ? <Minimize2 size={15} strokeWidth={1.8} /> : <Maximize2 size={15} strokeWidth={1.8} />}
        </button>
        <button type="button" onClick={() => void desktopWindow.toggleFullScreen()} aria-label={state.isFullScreen ? '退出全屏' : '全屏显示'} title={state.isFullScreen ? '退出全屏（Esc）' : '全屏显示（F11）'}>
          <ScanLine size={16} strokeWidth={1.8} />
        </button>
        <button className="desktop-window-close" type="button" onClick={() => void desktopWindow.close()} aria-label="关闭窗口" title="关闭">
          <X size={17} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
