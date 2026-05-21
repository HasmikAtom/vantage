/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VANTAGE_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
