/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Server origin, e.g. http://127.0.0.1:8710. Unset → in-memory mock backend. */
  readonly VITE_VOKKO_API?: string;
  /** Optional full gateway WebSocket URL; defaults to <api origin as ws>/api/v1/gateway. */
  readonly VITE_VOKKO_GATEWAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
