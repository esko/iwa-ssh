/// <reference types="vite/client" />

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '@xterm/xterm/css/xterm.css';
