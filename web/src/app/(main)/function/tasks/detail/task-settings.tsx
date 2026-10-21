"use client";
import * as React from "react";
import Link from "next/link";
import { BrainIcon, GaugeIcon, PaletteIcon, ArchiveIcon, ArrowUpRightIcon, ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { SettingsDialog, SettingsPanel } from "@/components/settings-dialog";
import { TaskLLMProfileChain } from "@/components/task-llm-profile-chain";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { FieldSet, FieldLegend, FieldDescription, Field, FieldLabel } from "@/components/ui/field";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AppearancePreferences } from "../../../_components/sidebar/layout-controls";
import { ExecutionControl } from "./execution-control";
import { api } from "@/lib/api";
import { settingsProfiles, taskModelSelection } from "@/lib/task-model-settings";
import type { LLMProfile, Task } from "@/lib/types";

const sections = [
  { key: "model", label: "模型", icon: BrainIcon },
  { key: "execution", label: "执行模式", icon: GaugeIcon },
  { key: "appearance", label: "外观与布局", icon: PaletteIcon },
  { key: "archive", label: "归档", icon: ArchiveIcon },
];
export function TaskSettings({
  task,
  profiles,
  onClose,
  onUpdated,
  archive,
}: {
  task: Task;
  profiles: LLMProfile[];
  onClose: () => void;
  onUpdated: () => void;
  archive: React.ReactNode;
}) {
  const [section, setSection] = React.useState("model");
  // Only initialize when the dialog opens, never from the task polling response.
  const normalizedProfiles = React.useMemo(() => settingsProfiles(profiles), [profiles]);
  const [ids, setIDs] = React.useState(() => taskModelSelection(task).ids);
  const [active, setActive] = React.useState(() => taskModelSelection(task).active);
  const [saved, setSaved] = React.useState(() =>
    JSON.stringify([taskModelSelection(task).ids, taskModelSelection(task).active]),
  );
  const [saving, setSaving] = React.useState(false),
    [error, setError] = React.useState("");
  const portal = React.useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify([ids, active]) !== saved;
  const exhausted = task.llm_failover_state === "chain_exhausted";
  const changeIDs = (next: string[]) => {
    setIDs(next);
    setActive((current) => (next.includes(current) ? current : (next[0] ?? "")));
  };
  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await api.updateTaskLLMProfiles(task.id, ids.map(Number), active ? Number(active) : undefined);
      setSaved(JSON.stringify([ids, active]));
      toast.success(result.switch_event?.summary ?? "模型配置已保存");
      onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsDialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title="任务设置"
      description={`${task.name || task.description || "任务"} · #${task.id}`}
      sections={sections}
      section={section}
      onSectionChange={setSection}
      links={
        <>
          <p className="settings-kicker">平台管理</p>
          {[
            ["LLM 配置", "llm"],
            ["MCP 服务", "mcp"],
            ["Skill", "skills"],
            ["自定义工具", "tools"],
          ].map(([label, path]) => (
            <Button asChild key={path} variant="ghost">
              <Link href={`/system/${path}`}>
                {label}
                <ArrowUpRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          ))}
        </>
      }
      footer={
        section === "model" ? (
          <>
            <span className="mr-auto text-sm text-muted-foreground">{dirty ? "有未保存的更改" : "当前配置已保存"}</span>
            <Button onClick={() => void save()} disabled={saving || (!dirty && !exhausted)}>
              {saving && <Spinner />}
              {saving ? "保存中…" : exhausted ? "保存并重置" : "保存更改"}
            </Button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">
            {section === "appearance" ? "外观偏好即时保存" : "操作以服务端确认结果为准"}
          </span>
        )
      }
    >
      <SettingsPanel value="model">
        <div ref={portal} className="flex flex-col gap-7">
          <FieldSet>
            <FieldLegend>本任务使用的模型</FieldLegend>
            <FieldDescription>
              仅覆盖本任务；未指定时跟随 Agent 或全局默认。保存后从下一次模型调用生效。
            </FieldDescription>
            {exhausted && (
              <Alert variant="destructive">
                <AlertDescription>
                  {task.llm_failover_reason || "配置链已耗尽，请选择可用模型并保存重置。"}
                </AlertDescription>
              </Alert>
            )}
            <RadioGroup
              value={ids.length ? active : "default"}
              disabled={saving}
              onValueChange={(id) => {
                if (id === "default") {
                  setIDs([]);
                  setActive("");
                } else {
                  setIDs([id, ...ids.filter((v) => v !== id)]);
                  setActive(id);
                }
              }}
              aria-label="本任务使用的模型"
              className="model-options"
            >
              {[
                { id: "default", name: "跟随默认配置", model: "使用 Agent 绑定或全局默认模型" },
                ...normalizedProfiles,
              ].map((profile) => (
                <Field
                  key={profile.id}
                  orientation="horizontal"
                  className="model-option"
                  data-selected={(ids.length ? active : "default") === profile.id}
                >
                  <RadioGroupItem id={`task-model-${profile.id}`} value={profile.id} />
                  <FieldLabel htmlFor={`task-model-${profile.id}`}>
                    <BrainIcon aria-hidden="true" />
                    <span>
                      <strong>{profile.name}</strong>
                      <small>{profile.model}</small>
                    </span>
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                候补配置与顺序 {ids.length > 0 ? `· ${ids.length} 项` : ""}
                <ChevronDownIcon />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              <TaskLLMProfileChain
                profiles={normalizedProfiles}
                value={ids}
                onValueChange={changeIDs}
                activeProfileId={active}
                onActiveProfileChange={setActive}
                disabled={saving}
                portalContainer={portal}
              />
            </CollapsibleContent>
          </Collapsible>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </SettingsPanel>
      <SettingsPanel value="execution" className="flex flex-col gap-5">
        <h3 className="font-medium">任务执行</h3>
        <p className="text-muted-foreground">
          托管模式由 Planner 自动规划；手工模式由用户或主 Agent 下发意图。切换不会改变当前意图的授权。
        </p>
        <ExecutionControl task={task} onUpdated={onUpdated} />
      </SettingsPanel>
      <SettingsPanel value="appearance">
        <AppearancePreferences />
      </SettingsPanel>
      <SettingsPanel value="archive" className="flex flex-col gap-5">
        <h3 className="font-medium">归档任务</h3>
        <p className="text-muted-foreground">
          将任务图谱、关联记录、工作文件与模型历史保存到冷存储。归档后可从任务列表还原。
        </p>
        {archive}
      </SettingsPanel>
    </SettingsDialog>
  );
}
