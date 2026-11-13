"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { THEME_COOKIE, type ThemePreference } from "@/lib/theme";

function apply(preference: ThemePreference) {
  const root = document.documentElement;
  const dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  root.dataset.themePreference = preference;
  document.cookie = `${THEME_COOKIE}=${preference}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [preference, setPreference] = useState<ThemePreference>(initial);

  const Icon = preference === "dark" ? MoonIcon : preference === "light" ? SunIcon : MonitorIcon;

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Theme" data-testid="theme-toggle" />}>
        <Icon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            const next = value as ThemePreference;
            setPreference(next);
            apply(next);
          }}
        >
          <MenuRadioItem value="light">
            <SunIcon /> Light
          </MenuRadioItem>
          <MenuRadioItem value="dark">
            <MoonIcon /> Dark
          </MenuRadioItem>
          <MenuRadioItem value="system">
            <MonitorIcon /> System
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
