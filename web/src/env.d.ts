/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production: public API origin (never use a Vite dev port like 5173 here). */
  readonly VITE_BACKEND_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
