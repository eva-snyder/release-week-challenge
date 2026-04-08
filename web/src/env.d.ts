/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production: public API origin (never use a Vite dev port like 5173 here). */
  readonly VITE_BACKEND_ORIGIN?: string
  /** Set to `1` to show leaderboard and stream UI. Omit or unset to pause (Spotify ToS review). */
  readonly VITE_CHALLENGE_ACTIVE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
