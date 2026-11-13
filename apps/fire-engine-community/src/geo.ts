/**
 * Location emulation. Without a geo-targeted proxy the service can only make
 * the browser *claim* a location (locale, Accept-Language, timezone); the
 * egress IP does not change. Operators who need real geo egress configure a
 * proxy whose username contains `{country}` (see config.resolveProxy).
 */
const COUNTRY_DEFAULTS: Record<string, { locale: string; timezone: string }> = {
  us: { locale: "en-US", timezone: "America/New_York" },
  ca: { locale: "en-CA", timezone: "America/Toronto" },
  mx: { locale: "es-MX", timezone: "America/Mexico_City" },
  br: { locale: "pt-BR", timezone: "America/Sao_Paulo" },
  ar: { locale: "es-AR", timezone: "America/Argentina/Buenos_Aires" },
  gb: { locale: "en-GB", timezone: "Europe/London" },
  ie: { locale: "en-IE", timezone: "Europe/Dublin" },
  de: { locale: "de-DE", timezone: "Europe/Berlin" },
  fr: { locale: "fr-FR", timezone: "Europe/Paris" },
  es: { locale: "es-ES", timezone: "Europe/Madrid" },
  it: { locale: "it-IT", timezone: "Europe/Rome" },
  nl: { locale: "nl-NL", timezone: "Europe/Amsterdam" },
  be: { locale: "nl-BE", timezone: "Europe/Brussels" },
  ch: { locale: "de-CH", timezone: "Europe/Zurich" },
  at: { locale: "de-AT", timezone: "Europe/Vienna" },
  se: { locale: "sv-SE", timezone: "Europe/Stockholm" },
  no: { locale: "nb-NO", timezone: "Europe/Oslo" },
  dk: { locale: "da-DK", timezone: "Europe/Copenhagen" },
  fi: { locale: "fi-FI", timezone: "Europe/Helsinki" },
  pl: { locale: "pl-PL", timezone: "Europe/Warsaw" },
  pt: { locale: "pt-PT", timezone: "Europe/Lisbon" },
  cz: { locale: "cs-CZ", timezone: "Europe/Prague" },
  gr: { locale: "el-GR", timezone: "Europe/Athens" },
  tr: { locale: "tr-TR", timezone: "Europe/Istanbul" },
  ru: { locale: "ru-RU", timezone: "Europe/Moscow" },
  ua: { locale: "uk-UA", timezone: "Europe/Kyiv" },
  il: { locale: "he-IL", timezone: "Asia/Jerusalem" },
  ae: { locale: "ar-AE", timezone: "Asia/Dubai" },
  sa: { locale: "ar-SA", timezone: "Asia/Riyadh" },
  eg: { locale: "ar-EG", timezone: "Africa/Cairo" },
  za: { locale: "en-ZA", timezone: "Africa/Johannesburg" },
  ng: { locale: "en-NG", timezone: "Africa/Lagos" },
  ke: { locale: "en-KE", timezone: "Africa/Nairobi" },
  in: { locale: "en-IN", timezone: "Asia/Kolkata" },
  pk: { locale: "en-PK", timezone: "Asia/Karachi" },
  bd: { locale: "bn-BD", timezone: "Asia/Dhaka" },
  cn: { locale: "zh-CN", timezone: "Asia/Shanghai" },
  hk: { locale: "zh-HK", timezone: "Asia/Hong_Kong" },
  tw: { locale: "zh-TW", timezone: "Asia/Taipei" },
  jp: { locale: "ja-JP", timezone: "Asia/Tokyo" },
  kr: { locale: "ko-KR", timezone: "Asia/Seoul" },
  sg: { locale: "en-SG", timezone: "Asia/Singapore" },
  my: { locale: "ms-MY", timezone: "Asia/Kuala_Lumpur" },
  th: { locale: "th-TH", timezone: "Asia/Bangkok" },
  vn: { locale: "vi-VN", timezone: "Asia/Ho_Chi_Minh" },
  id: { locale: "id-ID", timezone: "Asia/Jakarta" },
  ph: { locale: "en-PH", timezone: "Asia/Manila" },
  au: { locale: "en-AU", timezone: "Australia/Sydney" },
  nz: { locale: "en-NZ", timezone: "Pacific/Auckland" },
};

export interface LocationProfile {
  country: string | undefined;
  locale: string;
  languages: string[];
  acceptLanguage: string;
  timezone: string | undefined;
}

export function normalizeCountry(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const lower = country.trim().toLowerCase();
  if (lower === "us-generic" || lower === "us-whitelist") return "us";
  return /^[a-z]{2}$/.test(lower) ? lower : undefined;
}

export function resolveLocation(geolocation: { country?: string; languages?: string[] } | null | undefined): LocationProfile {
  const country = normalizeCountry(geolocation?.country);
  const defaults = country ? COUNTRY_DEFAULTS[country] : undefined;
  const requested = (geolocation?.languages ?? []).filter(lang => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang));
  const locale = requested[0] ?? defaults?.locale ?? "en-US";
  const languages = requested.length > 0 ? requested : [locale, locale.split("-")[0] ?? "en"].filter((v, i, a) => a.indexOf(v) === i);
  const acceptLanguage = languages
    .map((lang, index) => (index === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`))
    .join(",");
  return {
    country,
    locale,
    languages,
    acceptLanguage,
    timezone: defaults?.timezone,
  };
}
