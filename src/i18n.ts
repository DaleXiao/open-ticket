/**
 * i18n (zh/en) + theme (light/dark), localStorage persistence.
 *
 * Pattern:
 *   useT()   — returns t(key, params?) bound to current lang
 *   useLang() — subscribe to current lang (re-renders on change)
 *   toggleLang() / getLang() / setLang()
 *   useTheme() — subscribe to current theme
 *   toggleTheme() / applyTheme()
 *
 * Storage keys: `tickets-lang` ('zh' | 'en'), `tickets-theme` ('light' | 'dark').
 * Keeps <html lang> in sync and applies `.dark` class with no render-flash
 * (a tiny inline script in index.html also pre-applies before hydration).
 */

import { useSyncExternalStore } from "react";

export type Lang = "zh" | "en";
export type Theme = "light" | "dark";

type Dict = Record<string, string>;
type Dicts = Record<Lang, Dict>;

const LANG_KEY = "tickets-lang";
const THEME_KEY = "tickets-theme";

const DICT: Dicts = {
  zh: {
    "wordmark": "票根",
    "hero.headline": "凭票入场，纪念一场好电影",
    "theme.toLight": "切到浅色",
    "theme.toDark": "切到深色",
    "lang.toggle": "切换语言",
    "tagline": "输入片名与场次，生成一张纪念票根",
    "sec.film": "片名",
    "sec.time": "场次",
    "field.title": "片名",
    "field.title.req": "必填",
    "field.date": "日期",
    "field.time": "时间",
    "field.title.placeholder": "例如：银翼杀手 2049 / Parasite / 千与千寻",
    "btn.generate": "生成票根",
    "btn.generating": "生成中",
    "btn.regenerate": "重新生成",
    "btn.download": "下载 PNG",
    "status.queued": "前面还有 {n} 位，请稍候",
    "status.preparing": "正在准备…",
    "status.generating": "正在印制票根",
    "status.dontClose": "请勿关闭页面",
    "err.titleRequired": "请输入电影名",
    "err.timeRequired": "请选择放映时间",
    "err.generateFailed": "生成失败，请稍后重试",
    "err.connection": "连接中断，请重试",
    "err.busy": "当前使用人数较多，请稍后再试",
    "err.rateLimited": "今日免费额度已用完，明天再来",
    "err.network": "网络错误，请重试",
    "err.verifyFailed": "安全验证未通过，请重试",
    "err.retryAfter": "s 后可重试",
    "quota.left": "今日剩余",
    "quota.unit": "张",
    "footer.brand": "Tinkerer's Lab",
  },
  en: {
    "wordmark": "Tickets",
    "hero.headline": "A ticket for a film worth remembering",
    "theme.toLight": "Switch to light",
    "theme.toDark": "Switch to dark",
    "lang.toggle": "Toggle language",
    "tagline": "Enter a film and showtime to mint a commemorative ticket",
    "sec.film": "Film",
    "sec.time": "Showtime",
    "field.title": "Title",
    "field.title.req": "required",
    "field.date": "Date",
    "field.time": "Time",
    "field.title.placeholder": "e.g. Blade Runner 2049 / Parasite / Spirited Away",
    "btn.generate": "Generate ticket",
    "btn.generating": "Generating",
    "btn.regenerate": "Regenerate",
    "btn.download": "Download PNG",
    "status.queued": "{n} ahead of you, please wait",
    "status.preparing": "Preparing…",
    "status.generating": "Printing your ticket",
    "status.dontClose": "Please keep this page open",
    "err.titleRequired": "Please enter a film title",
    "err.timeRequired": "Please choose a showtime",
    "err.generateFailed": "Generation failed, please retry",
    "err.connection": "Connection lost, please retry",
    "err.busy": "High traffic right now, try again shortly",
    "err.rateLimited": "Daily free quota used up — come back tomorrow",
    "err.network": "Network error, please retry",
    "err.verifyFailed": "Verification failed, please retry",
    "err.retryAfter": "s until retry",
    "quota.left": "Today remaining",
    "quota.unit": "",
    "footer.brand": "Tinkerer's Lab",
  },
};

// --- Document metadata (title / description switch with the active language) ---

const META: Record<Lang, { title: string; description: string }> = {
  zh: {
    title: "票根 — 电影票根生成器",
    description: "输入片名和场次时间，AI 生成一张含电影标志性元素的纪念票根图。",
  },
  en: {
    title: "Tickets — Cinema Ticket Studio",
    description: "Enter a film title and showtime to generate a commemorative ticket with an iconic film motif.",
  },
};

function syncDocumentMeta(l: Lang): void {
  if (typeof document === "undefined") return;
  const meta = META[l] ?? META.zh;
  document.title = meta.title;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute("content", meta.description);
}

// --- lang ---

function readInitialLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* unavailable */
  }
  return "zh";
}

const langListeners = new Set<() => void>();
let currentLang: Lang = readInitialLang();

function syncHtmlLang(l: Lang): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  }
}

function emitLang(): void {
  langListeners.forEach((cb) => cb());
}

export function getLang(): Lang {
  return currentLang;
}

export function setLang(l: Lang): void {
  currentLang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* ignore */
  }
  syncHtmlLang(l);
  syncDocumentMeta(l);
  emitLang();
}

export function toggleLang(): Lang {
  setLang(currentLang === "zh" ? "en" : "zh");
  return currentLang;
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      langListeners.add(cb);
      return () => langListeners.delete(cb);
    },
    () => currentLang,
    () => "zh" as Lang
  );
}

export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const lang = useLang();
  return (key, params) => {
    let s = DICT[lang][key] ?? DICT.zh[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.split(`{${k}}`).join(String(v));
      }
    }
    return s;
  };
}

// --- theme ---

function readInitialTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* unavailable */
  }
  // No persisted choice → default to dark: the editorial deep-warm base color;
  // fall back to the light warm-paper palette when the system prefers light.
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

const themeListeners = new Set<() => void>();
let currentTheme: Theme = readInitialTheme();

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

export function getTheme(): Theme {
  return currentTheme;
}

export function toggleTheme(): Theme {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(currentTheme);
  themeListeners.forEach((cb) => cb());
  return currentTheme;
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    () => currentTheme,
    () => "dark" as Theme
  );
}

// First-import alignment (defensive; index.html inline script does the no-flash pre-apply).
syncHtmlLang(currentLang);
syncDocumentMeta(currentLang);
applyTheme(currentTheme);