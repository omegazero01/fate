"use client";
import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Brain, Bot, Plug, Sparkles, Wrench, ScrollText, Settings2, Palette } from "lucide-react";
import { SettingsDialog, SettingsPanel } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { SettingsPanelActive } from "./panel-scope";
import { closeSystemSettings, openSystemSettings, settingsSection, type SystemSettingKey } from "@/lib/system-settings";
const loading = () => (
  <p role="status" className="text-muted-foreground">
    正在加载配置…
  </p>
);
const panels = {
  llm: dynamic(() => import("@/app/(main)/system/llm/panel"), { loading }),
  agents: dynamic(() => import("@/app/(main)/system/agents/panel"), { loading }),
  mcp: dynamic(() => import("@/app/(main)/system/mcp/panel"), { loading }),
  skills: dynamic(() => import("@/app/(main)/system/skills/panel"), { loading }),
  tools: dynamic(() => import("@/app/(main)/system/tools/panel"), { loading }),
  logs: dynamic(() => import("@/app/(main)/system/logs/panel"), { loading }),
  settings: dynamic(() => import("@/app/(main)/system/settings/panel"), { loading }),
  appearance: dynamic(
    () => import("@/app/(main)/_components/sidebar/layout-controls").then((m) => m.AppearancePreferences),
    { loading },
  ),
};
const sections = [
  { key: "llm", label: "模型配置", icon: Brain },
  { key: "agents", label: "Agent", icon: Bot },
  { key: "mcp", label: "MCP", icon: Plug },
  { key: "skills", label: "Skill", icon: Sparkles },
  { key: "tools", label: "工具", icon: Wrench },
  { key: "logs", label: "系统日志", icon: ScrollText },
  { key: "settings", label: "系统配置", icon: Settings2 },
  { key: "appearance", label: "外观与布局", icon: Palette },
];
function SettingsHost() {
  const params = useSearchParams(),
    open = params.get("settings") === "true";
  const section = settingsSection(params.get("settingsTab"));
  const agentKey = params.get("settingsAgent") ?? undefined;
  const [visited, setVisited] = useState<SystemSettingKey[]>([]);
  useEffect(() => {
    if (open) setVisited((old) => (old.includes(section) ? old : [...old, section]));
    else setVisited([]);
  }, [open, section]);
  const loaded = open ? [...new Set([...visited, section])] : visited;
  return (
    <SettingsDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) closeSystemSettings();
      }}
      className="system-settings-dialog"
      title="系统设置"
      description="统一管理平台配置与个人界面偏好。"
      sections={sections}
      section={section}
      onSectionChange={(value) => openSystemSettings(settingsSection(value))}
      footer={
        <>
          <p className="mr-auto text-xs text-muted-foreground">请使用各项保存按钮提交修改，开关按说明即时生效。</p>
          <Button variant="outline" onClick={closeSystemSettings}>
            关闭
          </Button>
        </>
      }
    >
      {loaded.map((key) => {
        const Panel = panels[key];
        return (
          <SettingsPanel key={key} value={key} className="system-settings-panel">
            <SettingsPanelActive value={open && section === key}>
              {key === "agents" ? <panels.agents initialAgentKey={agentKey} /> : <Panel />}
            </SettingsPanelActive>
          </SettingsPanel>
        );
      })}
    </SettingsDialog>
  );
}
export function SystemSettingsHost() {
  return (
    <Suspense fallback={null}>
      <SettingsHost />
    </Suspense>
  );
}
