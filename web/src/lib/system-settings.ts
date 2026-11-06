export const SYSTEM_SETTING_KEYS = [
  "llm",
  "agents",
  "mcp",
  "skills",
  "tools",
  "logs",
  "settings",
  "appearance",
] as const;
export type SystemSettingKey = (typeof SYSTEM_SETTING_KEYS)[number];
export function settingsSection(value: string | null): SystemSettingKey {
  if (value === "model") return "llm";
  return SYSTEM_SETTING_KEYS.includes(value as SystemSettingKey) ? (value as SystemSettingKey) : "llm";
}
/** Only touch modal-owned parameters; task/session/graph locations remain intact. */
export function systemSettingsURL(current: string, section: SystemSettingKey | null, agentKey?: string) {
  const url = new URL(current, "http://local");
  for (const key of ["settings", "settingsTab", "settingsAgent"]) url.searchParams.delete(key);
  if (section) {
    url.searchParams.set("settings", "true");
    url.searchParams.set("settingsTab", section);
    if (section === "agents" && agentKey) url.searchParams.set("settingsAgent", agentKey);
  }
  return url.pathname + url.search + url.hash;
}
export function openSystemSettings(section: SystemSettingKey = "llm", agentKey?: string) {
  const alreadyOpen = new URLSearchParams(window.location.search).get("settings") === "true";
  window.history[alreadyOpen ? "replaceState" : "pushState"](
    null,
    "",
    systemSettingsURL(window.location.href, section, agentKey),
  );
}
export function closeSystemSettings() {
  window.history.replaceState(null, "", systemSettingsURL(window.location.href, null));
}
export function legacySettingsSection(path: string): SystemSettingKey | null {
  const match = path.replace(/\/+$/, "").match(/^\/system\/(llm|agents|mcp|skills|tools|logs|settings)(?:\/detail)?$/);
  return match ? (match[1] as SystemSettingKey) : null;
}
