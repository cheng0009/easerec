import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

const resources = {
  "zh-CN": { translation: zhCN },
  en: { translation: en },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh-CN",
    lng: "zh-CN",               // 默认简体中文
    interpolation: {
      escapeValue: false,        // React already safe from XSS
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "directorcam_lang",
    },
  });

export default i18n;
