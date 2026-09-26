/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional API base URL override for production builds. */
  readonly VITE_API_BASE?: string;
  /** Optional Cloudflare Turnstile site key override. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
