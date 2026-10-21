"use client";

import * as React from "react";
import { SettingsDialog, SettingsPanel } from "@/components/settings-dialog";
import { PaletteIcon } from "lucide-react";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type FontKey, fontOptions } from "@/lib/fonts/registry";
import type { ContentLayout, NavbarStyle, SidebarCollapsible, SidebarVariant } from "@/lib/preferences/layout";
import {
  applyContentLayout,
  applyFont,
  applyNavbarStyle,
  applySidebarCollapsible,
  applySidebarVariant,
} from "@/lib/preferences/layout-utils";
import { PREFERENCE_DEFAULTS } from "@/lib/preferences/preferences-config";
import { persistPreference } from "@/lib/preferences/preferences-storage";
import { THEME_PRESET_OPTIONS, type ThemeMode, type ThemePreset } from "@/lib/preferences/theme";
import { applyThemePreset } from "@/lib/preferences/theme-utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

export function AppearancePreferences() {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedThemeMode = usePreferencesStore((s) => s.resolvedThemeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const setThemePreset = usePreferencesStore((s) => s.setThemePreset);
  const contentLayout = usePreferencesStore((s) => s.contentLayout);
  const setContentLayout = usePreferencesStore((s) => s.setContentLayout);
  const navbarStyle = usePreferencesStore((s) => s.navbarStyle);
  const setNavbarStyle = usePreferencesStore((s) => s.setNavbarStyle);
  const variant = usePreferencesStore((s) => s.sidebarVariant);
  const setSidebarVariant = usePreferencesStore((s) => s.setSidebarVariant);
  const collapsible = usePreferencesStore((s) => s.sidebarCollapsible);
  const setSidebarCollapsible = usePreferencesStore((s) => s.setSidebarCollapsible);
  const font = usePreferencesStore((s) => s.font);
  const setFont = usePreferencesStore((s) => s.setFont);

  const onThemePresetChange = (preset: ThemePreset) => {
    applyThemePreset(preset);
    setThemePreset(preset);
    void persistPreference("theme_preset", preset);
  };

  const onThemeModeChange = (mode: ThemeMode | "") => {
    if (!mode) return;
    setThemeMode(mode);
    void persistPreference("theme_mode", mode);
  };

  const onContentLayoutChange = (layout: ContentLayout | "") => {
    if (!layout) return;
    applyContentLayout(layout);
    setContentLayout(layout);
    void persistPreference("content_layout", layout);
  };

  const onNavbarStyleChange = (style: NavbarStyle | "") => {
    if (!style) return;
    applyNavbarStyle(style);
    setNavbarStyle(style);
    void persistPreference("navbar_style", style);
  };

  const onSidebarStyleChange = (value: SidebarVariant | "") => {
    if (!value) return;
    setSidebarVariant(value);
    applySidebarVariant(value);
    void persistPreference("sidebar_variant", value);
  };

  const onSidebarCollapseModeChange = (value: SidebarCollapsible | "") => {
    if (!value) return;
    setSidebarCollapsible(value);
    applySidebarCollapsible(value);
    void persistPreference("sidebar_collapsible", value);
  };

  const onFontChange = (value: FontKey | "") => {
    if (!value) return;
    applyFont(value);
    setFont(value);
    void persistPreference("font", value);
  };

  const handleRestore = () => {
    onThemePresetChange(PREFERENCE_DEFAULTS.theme_preset);
    onThemeModeChange(PREFERENCE_DEFAULTS.theme_mode);
    onContentLayoutChange(PREFERENCE_DEFAULTS.content_layout);
    onNavbarStyleChange(PREFERENCE_DEFAULTS.navbar_style);
    onSidebarStyleChange(PREFERENCE_DEFAULTS.sidebar_variant);
    onSidebarCollapseModeChange(PREFERENCE_DEFAULTS.sidebar_collapsible);
    onFontChange(PREFERENCE_DEFAULTS.font);
  };

  return (
    <div className="flex flex-col gap-6 **:data-[slot=toggle-group]:w-full **:data-[slot=toggle-group-item]:flex-1 **:data-[slot=toggle-group-item]:text-sm">
      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">主题预设</Label>
        <Select value={themePreset} onValueChange={onThemePresetChange}>
          <SelectTrigger size="sm" className="w-full text-sm">
            <SelectValue placeholder="选择主题" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {THEME_PRESET_OPTIONS.map((preset) => (
                <SelectItem key={preset.value} className="text-sm" value={preset.value}>
                  <span
                    className="size-2.5 rounded-full"
                    style={{
                      backgroundColor:
                        (resolvedThemeMode ?? "light") === "dark" ? preset.primary.dark : preset.primary.light,
                    }}
                  />
                  {preset.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">字体</Label>
        <Select value={font} onValueChange={onFontChange}>
          <SelectTrigger size="sm" className="w-full text-sm">
            <SelectValue placeholder="选择字体" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {fontOptions.map((font) => (
                <SelectItem key={font.key} className="text-sm" value={font.key}>
                  {font.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">外观</Label>
        <ToggleGroup
          size="sm"
          spacing={0}
          variant="outline"
          type="single"
          value={themeMode}
          onValueChange={onThemeModeChange}
        >
          <ToggleGroupItem value="light" aria-label="Toggle light">
            浅色
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="Toggle dark">
            深色
          </ToggleGroupItem>
          <ToggleGroupItem value="system" aria-label="Toggle system">
            跟随系统
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">页面布局</Label>
        <ToggleGroup
          size="sm"
          spacing={0}
          variant="outline"
          type="single"
          value={contentLayout}
          onValueChange={onContentLayoutChange}
        >
          <ToggleGroupItem value="centered" aria-label="Toggle centered">
            居中
          </ToggleGroupItem>
          <ToggleGroupItem value="full-width" aria-label="Toggle full-width">
            铺满
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">导航栏</Label>
        <ToggleGroup
          size="sm"
          spacing={0}
          variant="outline"
          type="single"
          value={navbarStyle}
          onValueChange={onNavbarStyleChange}
        >
          <ToggleGroupItem value="sticky" aria-label="Toggle sticky">
            固定
          </ToggleGroupItem>
          <ToggleGroupItem value="scroll" aria-label="Toggle scroll">
            跟随滚动
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">侧栏样式</Label>
        <ToggleGroup
          size="sm"
          spacing={0}
          variant="outline"
          type="single"
          value={variant}
          onValueChange={onSidebarStyleChange}
        >
          <ToggleGroupItem value="inset" aria-label="Toggle inset">
            嵌入
          </ToggleGroupItem>
          <ToggleGroupItem value="sidebar" aria-label="Toggle sidebar">
            标准
          </ToggleGroupItem>
          <ToggleGroupItem value="floating" aria-label="Toggle floating">
            悬浮
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-medium text-sm">侧栏收起方式</Label>
        <ToggleGroup
          size="sm"
          spacing={0}
          variant="outline"
          type="single"
          value={collapsible}
          onValueChange={onSidebarCollapseModeChange}
        >
          <ToggleGroupItem value="icon" aria-label="Toggle icon">
            图标
          </ToggleGroupItem>
          <ToggleGroupItem value="offcanvas" aria-label="Toggle offcanvas">
            完全隐藏
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Button type="button" size="sm" variant="outline" className="w-full text-sm" onClick={handleRestore}>
        恢复默认
      </Button>
    </div>
  );
}

export function LayoutControls() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="外观设置" onClick={() => setOpen(true)}>
        <Settings />
      </Button>
      <SettingsDialog
        open={open}
        onOpenChange={setOpen}
        title="个人设置"
        description="偏好设置即时保存，仅影响你的界面。"
        sections={[{ key: "appearance", label: "外观与布局", icon: PaletteIcon }]}
        section="appearance"
        onSectionChange={() => {}}
      >
        <SettingsPanel value="appearance">
          <AppearancePreferences />
        </SettingsPanel>
      </SettingsDialog>
    </>
  );
}
