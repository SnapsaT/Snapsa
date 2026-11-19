// src/i18n.js
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import af from "./locales/af.json";
import tn from "./locales/tn.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      af: { translation: af },
      tn: { translation: tn },
    },
    fallbackLng: "en",
    debug: false,

    interpolation: {
      escapeValue: false,
    },

    returnNull: false,
    returnEmptyString: false,
  });

export default i18n;