export const THEME_COOKIE = "fc-dashboard-theme";
export type ThemePreference = "light" | "dark" | "system";

export function parseTheme(value: string | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
