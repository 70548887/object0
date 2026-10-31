import { create } from "zustand";

export type Locale = "zh-CN" | "en";
export const LOCALE_STORAGE_KEY = "object0-locale";
export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : "zh-CN";
}
export function readSavedLocale(): Locale {
  try {
    return normalizeLocale(
      globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY),
    );
  } catch {
    return "zh-CN";
  }
}
export const useLocaleStore = create<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
}>()((set) => ({
  locale: readSavedLocale(),
  setLocale: (value) => {
    const locale = normalizeLocale(value);
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      /* Language still changes for this session if storage is unavailable. */
    }
    set({ locale });
  },
}));
export const getLocale = (): Locale => useLocaleStore.getState().locale;
