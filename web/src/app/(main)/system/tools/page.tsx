"use client";
import { PageHeading } from "@/components/workspace";

import * as React from "react";
import { toast } from "sonner";
import { PlayIcon, PlusIcon, RotateCcwIcon, SaveIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { Agent, Tool, RoleToolPreview } from "@/lib/types";

const historic = (t: Tool) => t.implementation_status === "retired" || t.implementation_status === "unsupported";
const stateLabel = { active: "当前实现", compatibility: "兼容入口", retired: "已退役", unsupported: "无当前实现" };
// Older catalogs may omit source. Keep their platform entries visible without
// exposing pi or MCP helpers in this management view.
const NON_PLATFORM_LEGACY_KEYS = new Set([
  "read", "bash", "write", "edit", "tool_search",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
]);
const isPlatformTool = (tool: Tool) =>
  tool.system && (tool.source ? tool.source === "platform" : !NON_PLATFORM_LEGACY_KEYS.has(tool.key));

// Traffic tools are host tools gated by the global 流量捕获 switch: bindable, but
// only usable when capture is on. Keep in sync with traffic.SeedToolMetas.
const TRAFFIC_TOOL_KEYS = new Set(["traffic_search", "traffic_get"]);

// paramRows flattens schema.properties into an ordered row list for editing.
// name/type/required are read-only (welded to the Go handler); description/default
// are editable. Non-scalar params (array/object) can't carry an editable default.
// parentKey is set for rows that live inside an array param's items.properties.
type ParamRow = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultStr: string; // "" = no default declared
  scalar: boolean;
  parentKey?: string; // set when this is a sub-field of an array param's items
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRows(schema: Record<string, any>): ParamRow[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>((schema?.required as string[]) ?? []);
  const rows: ParamRow[] = [];
  for (const [name, p] of Object.entries(props)) {
    const type = String(p?.type ?? "");
    const hasDefault = p != null && "default" in p && (p as Record<string, unknown>).default != null;
    rows.push({
      name,
      type,
      required: required.has(name),
      description: String(p?.description ?? ""),
      defaultStr: hasDefault ? String((p as Record<string, unknown>).default) : "",
      scalar: ["string", "integer", "number", "boolean"].includes(type),
    });
    // Expand items.properties for array params so sub-fields are editable.
    if (type === "array") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemProps = (p as any)?.items?.properties as Record<string, Record<string, unknown>> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemRequired = new Set<string>(((p as any)?.items?.required as string[]) ?? []);
      if (itemProps) {
        for (const [subName, subP] of Object.entries(itemProps)) {
          const subType = String((subP as Record<string, unknown>)?.type ?? "");
          const subHasDefault = subP != null && "default" in subP && subP.default != null;
          rows.push({
            name: subName,
            type: subType,
            required: itemRequired.has(subName),
            description: String(subP?.description ?? ""),
            defaultStr: subHasDefault ? String(subP.default) : "",
            scalar: ["string", "integer", "number", "boolean"].includes(subType),
            parentKey: name,
          });
        }
      }
    }
  }
  return rows;
}

// coerceDefault turns the edited default string back into a typed JSON value, or
// undefined to drop the "default" key entirely.
function coerceDefault(type: string, raw: string): unknown {
  const s = raw.trim();
  if (s === "") return undefined;
  if (type === "integer" || type === "number") {
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === "boolean") return s === "true";
  return raw;
}

// applyRows writes edited rows back into a deep-copied schema (structure untouched).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRows(schema: Record<string, any>, rows: ParamRow[]): Record<string, any> {
  const next = structuredClone(schema ?? {});
  const props = (next.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const r of rows) {
    if (r.parentKey) {
      // Sub-field of an array param's items.properties
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parent = props[r.parentKey] as any;
      const subP = parent?.items?.properties?.[r.name] as Record<string, unknown> | undefined;
      if (!subP) continue;
      subP.description = r.description;
      if (r.scalar) {
        const dv = coerceDefault(r.type, r.defaultStr);
        if (dv === undefined) delete subP.default;
        else subP.default = dv;
      }
    } else {
      const p = props[r.name];
      if (!p) continue;
      p.description = r.description;
      if (r.scalar) {
        const dv = coerceDefault(r.type, r.defaultStr);
        if (dv === undefined) delete p.default;
        else p.default = dv;
      }
    }
  }
  return next;
}

// ToolEditor is the full edit form for one tool, rendered inside the drawer.
function ToolEditor({
  tool,
  agents,
  captureOn,
  onSaved,
  onClose,
}: {
  tool: Tool;
  agents: Agent[];
  captureOn: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  // traffic tools can't be bound/enabled until the global 流量捕获 switch is on.
  const readOnly = historic(tool);
  const schemaReadOnly = tool.schema_read_only !== false;
  const trafficGated = readOnly || TRAFFIC_TOOL_KEYS.has(tool.key) && !captureOn;
  const [description, setDescription] = React.useState(tool.description);
  const [bound, setBound] = React.useState<string[]>(tool.agents);
  const [enabled, setEnabled] = React.useState(tool.enabled);
  const [rows, setRows] = React.useState<ParamRow[]>(() => toRows(tool.schema));
  const [saving, setSaving] = React.useState(false);

  const setRow = (i: number, patch: Partial<ParamRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleAgent = (k: string) => setBound((b) => (b.includes(k) ? b.filter((x) => x !== k) : [...b, k]));

  async function save() {
    setSaving(true);
    try {
      await api.saveTool(tool.key, {
        description,
        ...(schemaReadOnly ? {} : {schema: applyRows(tool.schema, rows)}),
        agents: bound,
        enabled,
      });
      toast.success(`已保存工具「${tool.key}」`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function reset() {
    try {
      await api.resetTool(tool.key);
      toast.success(`已恢复「${tool.key}」为代码默认`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error("恢复失败：" + (e as Error).message);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
        {readOnly && <p className="text-muted-foreground text-sm">历史配置仅供查看，此工具不能启用或执行。</p>}
        {trafficGated && !readOnly && (
          <div className="border-amber-500/40 bg-amber-500/10 text-muted-foreground rounded-md border px-3 py-2 text-xs">
            该工具依赖<b>流量捕获</b>。请先在「系统配置」开启流量捕获，才能绑定给 Agent 并启用。
          </div>
        )}
        {/* binding + switch */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground text-xs">绑定 Agent（决定该工具给哪些 Agent）</Label>
            <div className="flex flex-wrap gap-3">
              {agents.map((ag) => (
                <label key={ag.key} htmlFor={`system-tool-agent-${ag.key}`} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`system-tool-agent-${ag.key}`}
                    checked={bound.includes(ag.key)}
                    disabled={trafficGated}
                    onCheckedChange={() => toggleAgent(ag.key)}
                  />
                  {ag.name}
                  <span className="text-muted-foreground font-mono text-xs">{ag.key}</span>
                </label>
              ))}
              {agents.length === 0 && <span className="text-muted-foreground text-xs">（无 Agent）</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch disabled={readOnly} checked={enabled} onCheckedChange={setEnabled} id={`en-${tool.key}`} />
            <Label htmlFor={`en-${tool.key}`} className="text-sm">
              启用
            </Label>
          </div>
        </div>

        {/* description */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground text-xs">工具描述（发送给模型）</Label>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            value={description}
            readOnly={readOnly}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* params */}
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">{tool.schema_source === "unavailable" ? "历史参数 Schema（无当前实现，只读）" : "参数 Schema（来自实际实现，只读）"}</Label>
          {rows.length === 0 && <span className="text-muted-foreground text-xs">（无参数）</span>}
          {rows.map((r, i) => (
            <div
              key={(r.parentKey ?? "") + "." + r.name}
              className={
                r.parentKey ? "border-l-2 border-muted ml-3 pl-3 grid gap-2 py-2" : "grid gap-2 rounded-md border p-3"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {r.parentKey && <span className="text-muted-foreground font-mono text-[10px]">↳</span>}
                <span className="font-mono text-sm">{r.name}</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {r.type || "?"}
                </Badge>
                {r.required && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    必填
                  </Badge>
                )}
                {r.parentKey && <span className="text-muted-foreground text-[10px]">items 子字段</span>}
              </div>
              <div className="grid gap-2">
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-[11px]">描述</Label>
                  <Input
                    className="text-xs"
                    value={r.description}
                    readOnly={schemaReadOnly}
                    onChange={(e) => setRow(i, { description: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-[11px]">默认值</Label>
                  <Input
                    className="text-xs"
                    placeholder={r.scalar ? "（空=无默认）" : "仅标量支持"}
                    disabled={schemaReadOnly || !r.scalar}
                    value={r.defaultStr}
                    onChange={(e) => setRow(i, { defaultStr: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Separator className="mt-4" />
      <div className="flex flex-wrap gap-2 p-4">
        <Button size="sm" onClick={save} disabled={saving || readOnly}>
          <SaveIcon /> 保存
        </Button>
        <Button size="sm" variant="outline" disabled={readOnly} onClick={reset}>
          <RotateCcwIcon /> 恢复默认
        </Button>
      </div>
    </div>
  );
}

// ToolGridCard is one clickable tile in the catalog grid.
function ToolGridCard({ tool, onClick }: { tool: Tool; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-ring flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{tool.key}</span>
        {tool.system ? (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            平台
          </Badge>
        ) : (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            自定义·{tool.kind}
          </Badge>
        )}
        {tool.implementation_status && <Badge variant="outline">{stateLabel[tool.implementation_status]}</Badge>}
        {tool.canonical_name && tool.canonical_name !== tool.key && <span className="text-xs text-muted-foreground">→ {tool.canonical_name}</span>}
        {tool.deferred && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            deferred
          </Badge>
        )}
        {!tool.enabled && (
          <Badge variant="outline" className="text-destructive px-1.5 py-0 text-[10px]">
            已停用
          </Badge>
        )}
        <Badge
          variant="secondary"
          className="ml-auto px-1.5 py-0 text-[10px] tabular-nums"
          title={tool.calls == null ? "历史统计未记录" : `累计调用 ${tool.calls} 次`}
        >
          调用 {tool.calls ?? "未记录"}
        </Badge>
      </div>
      <p className="text-muted-foreground line-clamp-1 h-4 text-xs">{tool.description || "（无描述）"}</p>
      <div className="mt-auto flex flex-wrap gap-1 pt-1">
        {tool.agents.length === 0 && <span className="text-muted-foreground text-[10px]">（未绑定 Agent）</span>}
        {tool.agents.map((a) => (
          <Badge key={a} variant="outline" className="px-1.5 py-0 text-[10px]">
            {a}{tool.loading?.[a] ? ` · ${tool.loading[a] === "resident" ? "常驻" : "按需"}` : ""}
          </Badge>
        ))}
      </div>
    </button>
  );
}

export default function ToolsPage() {
  const [tools, setTools] = React.useState<Tool[]>([]);
  const [roles, setRoles] = React.useState<RoleToolPreview[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [captureOn, setCaptureOn] = React.useState(false);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [customEdit, setCustomEdit] = React.useState<Tool | "new" | null>(null);

  const reload = React.useCallback(() => {
    api
      .toolCatalog()
      .then((r) => { setTools(r.tools); setRoles(r.roles ?? []); })
      .catch((error: Error) => toast.error("工具列表读取失败：" + error.message));
  }, []);
  React.useEffect(() => {
    reload();
    api
      .agents()
      .then(setAgents)
      .catch(() => {
        /* optional page data */
      });
    api
      .settings()
      .then((s) => setCaptureOn(!!s.traffic_capture))
      .catch(() => {
        /* optional page data */
      });
  }, [reload]);

  const [query, setQuery] = React.useState("");

  const platformTools = tools.filter(isPlatformTool);
  const platformKeys = new Set(platformTools.map((t) => t.key));
  const selected = platformTools.find((t) => t.key === selectedKey) ?? null;
  const matchTool = React.useCallback(
    (t: Tool) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        t.key.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.agents.some((a) => a.toLowerCase().includes(q))
      );
    },
    [query],
  );
  const currentPlatformTools = platformTools.filter((t) => !historic(t) && t.implementation_status !== "compatibility");
  const historicPlatformTools = platformTools.filter((t) => historic(t) || t.implementation_status === "compatibility");
  const systemTools = currentPlatformTools.filter(matchTool);
  const customTools = tools.filter((t) => !t.system && matchTool(t));
  const historyTools = historicPlatformTools.filter(matchTool);
  const allSystemCount = currentPlatformTools.length;
  const allCustomCount = tools.filter((t) => !t.system).length;
  // clicking a built-in tool opens the binding drawer; a custom tool opens its full editor.
  const openTool = (t: Tool) => (t.system ? setSelectedKey(t.key) : setCustomEdit(t));

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageHeading title={<>工具</>}/>
          <p className="text-muted-foreground text-sm">
            平台内置工具的描述/绑定，以及自定义工具(shell/command/script/http)
          </p>
        </div>
        <div className="relative w-64">
          <SearchIcon className="text-muted-foreground absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            className="h-8 pl-8 text-sm"
            placeholder="搜索工具名、描述、Agent…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {roles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>角色装配预览</CardTitle>
            <CardDescription>
              工具数量仅统计平台内置工具；运行 Schema 含 pi 和自定义工具。新会话使用当前绑定，独立会话按已绑定任务预览。MCP Schema 未连接、不计入。旧会话及自定义提示词可能保留兼容工具。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {roles.map((r) => (
              <div key={r.role} className="rounded-md border p-3 text-sm">
                <strong>{r.role}</strong>
                <p>平台常驻 {r.resident.filter((key) => platformKeys.has(key)).length} · 平台按需 {r.deferred.filter((key) => platformKeys.has(key)).length}</p>
                <p className="text-muted-foreground text-xs">运行 Schema（含 pi 和自定义工具）{(r.schema_bytes.resident / 1024).toFixed(1)} KiB</p>
                <p className="text-muted-foreground text-xs">{r.policy_version}</p>
                {r.fallback && <p className="text-xs">{r.fallback}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Tabs defaultValue="system">
        <TabsList>
          <TabsTrigger value="system">现行工具</TabsTrigger>
          <TabsTrigger value="history">历史与兼容</TabsTrigger>
          <TabsTrigger value="custom">自定义工具</TabsTrigger>
        </TabsList>

        <TabsContent value="system">
          <Card>
            <CardHeader>
              <CardTitle>平台内置工具</CardTitle>
              <CardDescription>
                {query.trim()
                  ? `${systemTools.length} / ${allSystemCount} 个匹配，点击卡片编辑描述、只读参数及 Agent 绑定`
                  : `共 ${allSystemCount} 个，点击卡片编辑描述、只读参数及 Agent 绑定`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {systemTools.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  {query.trim() ? "没有匹配的平台内置工具" : "暂无平台内置工具"}
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {systemTools.map((t) => (
                    <ToolGridCard key={t.key} tool={t} onClick={() => openTool(t)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>平台历史与兼容工具</CardTitle>
              <CardDescription>
                {query.trim() ? `${historyTools.length} / ${historicPlatformTools.length} 个匹配。` : `共 ${historicPlatformTools.length} 个。`}
                兼容入口保留旧绑定和子能力开关；已退役及无实现条目不可运行，原配置仍可查阅。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {historyTools.map((t) => <ToolGridCard key={t.key} tool={t} onClick={() => openTool(t)} />)}
              {historyTools.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  {query.trim() ? "没有匹配的平台历史工具" : "暂无平台历史与兼容工具"}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="custom">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>自定义工具</CardTitle>
                  <CardDescription>
                    {query.trim()
                      ? `shell/command/script/http，${customTools.length} / ${allCustomCount} 个匹配，点击卡片编辑`
                      : `shell(bash 声明) / command(命令) / script(Python) / http(API)，共 ${allCustomCount} 个，点击卡片编辑`}
                  </CardDescription>
                </div>
                <Button size="sm" onClick={() => setCustomEdit("new")}>
                  <PlusIcon /> 新建自定义工具
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {customTools.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  {query.trim() ? "没有匹配的自定义工具" : "（暂无自定义工具，点击右上角「新建自定义工具」）"}
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {customTools.map((t) => (
                    <ToolGridCard key={t.key} tool={t} onClick={() => openTool(t)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelectedKey(null)}>
        <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader className="px-4">
                <SheetTitle className="font-mono">{selected.key}</SheetTitle>
                <SheetDescription>编辑描述、只读参数及 Agent 绑定</SheetDescription>
              </SheetHeader>
              <ToolEditor
                key={selected.key}
                tool={selected}
                agents={agents}
                captureOn={captureOn}
                onSaved={reload}
                onClose={() => setSelectedKey(null)}
              />
            </>
          )}
        </SheetContent>
      </Sheet>

      <CustomToolDialog
        edit={customEdit}
        tools={tools}
        agents={agents}
        onClose={() => setCustomEdit(null)}
        onSaved={() => {
          setCustomEdit(null);
          reload();
        }}
      />
    </div>
  );
}

// ---- 自定义工具编辑器 ----

type ExecState = {
  command: string;
  code: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  timeout_ms: string;
  proxy: string;
  use_recording_proxy: boolean;
};

function CustomToolDialog({
  tools,
  edit,
  agents,
  onClose,
  onSaved,
}: {
  tools: Tool[];
  edit: Tool | "new" | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = edit === "new";
  const tool = edit && edit !== "new" ? edit : null;
  const [key, setKey] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [kind, setKind] = React.useState<"shell" | "command" | "script" | "http">("shell");
  const [executable, setExecutable] = React.useState("");
  const [testCommand, setTestCommand] = React.useState("");
  const testAbort = React.useRef<AbortController | null>(null);
  React.useEffect(
    () => () => {
      testAbort.current?.abort();
    },
    [],
  );
  const [directory, setDirectory] = React.useState("");
  const [usageHelp, setUsageHelp] = React.useState("");
  const [whenToUse, setWhenToUse] = React.useState("");
  const [ex, setEx] = React.useState<ExecState>({
    command: "",
    code: "",
    method: "GET",
    url: "",
    headers: "",
    body: "",
    timeout_ms: "",
    proxy: "",
    use_recording_proxy: false,
  });
  const [schemaText, setSchemaText] = React.useState("");
  const [bound, setBound] = React.useState<string[]>([]);
  const [deferred, setDeferred] = React.useState(false);
  const [enabled, setEnabled] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [paramsText, setParamsText] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{
    output: string;
    is_error: boolean;
    duration_ms?: number;
  } | null>(null);

  // (re)load form state when opening.
  React.useEffect(() => {
    testAbort.current?.abort();
    testAbort.current = null;
    if (!edit) return;
    setParamsText("");
    setTestResult(null);
    setTestCommand("");
    setTesting(false);
    if (edit === "new") {
      setKey("");
      setDescription("");
      setKind("shell");
      setExecutable("");
      setDirectory("");
      setUsageHelp("");
      setWhenToUse("");
      setEx({
        command: "",
        code: "",
        method: "GET",
        url: "",
        headers: "",
        body: "",
        timeout_ms: "",
        proxy: "",
        use_recording_proxy: false,
      });
      setSchemaText("");
      setBound([]);
      setDeferred(false);
      setEnabled(true);
      return;
    }
    const t = edit;
    const e = (t.exec ?? {}) as Record<string, unknown>;
    setKey(t.key);
    setDescription(t.description);
    setKind((t.kind as "shell" | "command" | "script" | "http") ?? "shell");
    setExecutable(t.executable ?? "");
    setDirectory(t.directory ?? "");
    setUsageHelp(t.usage_help ?? "");
    setWhenToUse(t.when_to_use ?? "");
    setEx({
      command: String(e.command ?? ""),
      code: String(e.code ?? ""),
      method: String(e.method ?? "GET"),
      url: String(e.url ?? ""),
      headers: e.headers ? JSON.stringify(e.headers, null, 2) : "",
      body: String(e.body ?? ""),
      timeout_ms: e.timeout_ms ? String(e.timeout_ms) : "",
      proxy: String(e.proxy ?? ""),
      use_recording_proxy: !!e.use_recording_proxy,
    });
    setSchemaText(t.schema && Object.keys(t.schema).length ? JSON.stringify(t.schema, null, 2) : "");
    setBound(t.agents ?? []);
    setDeferred(!!t.deferred);
    setEnabled(t.enabled);
  }, [edit]);

  const commandName = executable.trim() || key;
  const conflicts = tools.filter(
    (other) =>
      other.key !== key &&
      other.kind === "shell" &&
      other.enabled &&
      enabled &&
      other.agents.some((agent) => bound.includes(agent)) &&
      ((other.executable?.trim() || other.key) === commandName ||
        (!(other.executable?.trim() || other.key).includes("/") &&
          (other.executable?.trim() || other.key) === commandName.split("/").pop()) ||
        (!commandName.includes("/") && (other.executable?.trim() || other.key).split("/").pop() === commandName)),
  );
  const toggleAgent = (k: string) => setBound((b) => (b.includes(k) ? b.filter((x) => x !== k) : [...b, k]));

  function buildExec(): Record<string, unknown> {
    if (kind === "shell") return {};
    const t = ex.timeout_ms ? Number(ex.timeout_ms) : undefined;
    if (kind === "command") return { command: ex.command, timeout_ms: t };
    if (kind === "script") return { code: ex.code, timeout_ms: t };
    let headers: Record<string, string> = {};
    if (ex.headers.trim()) {
      try {
        headers = JSON.parse(ex.headers);
      } catch {
        /* validated on save */
      }
    }
    return {
      method: ex.method,
      url: ex.url,
      headers,
      body: ex.body,
      timeout_ms: t,
      proxy: ex.proxy,
      use_recording_proxy: ex.use_recording_proxy,
    };
  }

  async function save() {
    if (isNew && !/^[a-z][a-z0-9_]*$/.test(key.trim())) {
      toast.error("key 需小写字母开头，仅含小写字母/数字/下划线");
      return;
    }
    let schema: Record<string, unknown> = {};
    if (schemaText.trim()) {
      try {
        schema = JSON.parse(schemaText);
      } catch {
        toast.error("参数 JSON Schema 格式错误");
        return;
      }
    }
    if (kind === "http" && ex.headers.trim()) {
      try {
        JSON.parse(ex.headers);
      } catch {
        toast.error("headers JSON 格式错误");
        return;
      }
    }
    if (kind === "http") {
      const props = (schema as { properties?: Record<string, unknown> }).properties;
      if (!props || Object.keys(props).length === 0) {
        toast.error("http 工具必须提供参数 JSON Schema（含 properties，不能留空）");
        return;
      }
    }
    setSaving(true);
    const isShell = kind === "shell";
    const payload = {
      description,
      schema: isShell ? {} : schema,
      agents: bound,
      enabled,
      kind,
      exec: buildExec(),
      deferred: isShell ? false : deferred,
      executable: isShell ? executable.trim() : "",
      directory: isShell ? directory.trim() : "",
      usage_help: isShell ? usageHelp.trim() : "",
      when_to_use: isShell ? whenToUse.trim() : "",
    };
    try {
      if (isNew) await api.createCustomTool({ key: key.trim(), ...payload });
      else await api.updateCustomTool(tool!.key, payload);
      toast.success(isNew ? "已创建自定义工具" : "已保存");
      onSaved();
    } catch (e) {
      toast.error("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function del() {
    if (!tool) return;
    try {
      await api.deleteCustomTool(tool.key);
      toast.success("已删除");
      onSaved();
    } catch (e) {
      toast.error("删除失败：" + (e as Error).message);
    }
  }
  // runTest dry-runs the CURRENT form (unsaved) with the sample params, so a
  // template/script/request can be debugged before saving.
  async function runTest(action: "check" | "run" = "run") {
    if (testing) return;
    const controller = new AbortController();
    testAbort.current = controller;
    let params: Record<string, unknown> = {};
    if (paramsText.trim()) {
      try {
        params = JSON.parse(paramsText);
      } catch {
        toast.error("测试参数 JSON 格式错误");
        return;
      }
    }
    if (kind === "http" && ex.headers.trim()) {
      try {
        JSON.parse(ex.headers);
      } catch {
        toast.error("headers JSON 格式错误");
        return;
      }
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testCustomTool(
        { kind, exec: buildExec(), params, key, executable, directory, action, command: testCommand },
        controller.signal,
      );
      if (testAbort.current === controller && !controller.signal.aborted) setTestResult(r);
    } catch (e) {
      if (testAbort.current === controller && !controller.signal.aborted)
        setTestResult({ output: (e as Error).message, is_error: true });
    } finally {
      if (testAbort.current === controller) setTesting(false);
    }
  }

  return (
    <Sheet open={!!edit} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:max-w-full data-[side=right]:sm:w-[45vw] data-[side=right]:sm:min-w-[480px] data-[side=right]:sm:max-w-[45vw]"
      >
        <SheetHeader className="px-4">
          <SheetTitle>{isNew ? "新建自定义工具" : `编辑 ${tool?.key}`}</SheetTitle>
          <SheetDescription>
            shell 用于声明 Bash 环境中的工具及调用提示；command/script/http 需填写执行规格。
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="grid gap-1.5">
            <Label className="text-xs">Key</Label>
            <Input
              className="font-mono"
              placeholder="如 nmap_scan"
              value={key}
              disabled={!isNew}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">描述(发给模型)</Label>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">类型</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "shell" | "command" | "script" | "http")}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="shell">shell（bash 环境声明）</SelectItem>
                  <SelectItem value="command">command（shell 命令模板）</SelectItem>
                  <SelectItem value="script">script（Python 脚本）</SelectItem>
                  <SelectItem value="http">http（API 请求）</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {kind === "shell" && (
              <p className="text-muted-foreground text-xs">
                名称、描述、目录、用法帮助和调用时机会追加到绑定 Agent 的 Bash 工具描述中。
              </p>
            )}
          </div>

          {kind === "shell" && (
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="custom-tool-executable">可执行命令</FieldLabel>
                <Input
                  id="custom-tool-executable"
                  value={executable}
                  onChange={(e) => setExecutable(e.target.value)}
                  placeholder={key || "如 nmap 或 /opt/nmap/bin/nmap"}
                />
                <FieldDescription>
                  留空使用 Key；命令名或绝对路径，不含参数。用于检测与 Bash 调用统计。
                </FieldDescription>
                {conflicts.length > 0 && (
                  <p role="alert" className="text-destructive text-xs">
                    命令归属与 {conflicts.map((tool) => tool.key).join("、")} 存在歧义，匹配多个配置时不计数。
                  </p>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-tool-directory">工具所在目录</FieldLabel>
                <Input
                  id="custom-tool-directory"
                  className="font-mono"
                  placeholder="如 /opt/nmap/bin"
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                />
                <FieldDescription>检测时优先查找此目录；不会改变 Bash 或其他工具的工作目录。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-tool-usage-help">工具用法帮助</FieldLabel>
                <Textarea
                  id="custom-tool-usage-help"
                  className="font-mono text-xs"
                  rows={4}
                  placeholder="如 nmap [options] target"
                  value={usageHelp}
                  onChange={(e) => setUsageHelp(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-tool-when-to-use">何时调用</FieldLabel>
                <Textarea
                  id="custom-tool-when-to-use"
                  rows={3}
                  placeholder="如需要探测端口和服务时"
                  value={whenToUse}
                  onChange={(e) => setWhenToUse(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}

          {kind === "command" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">
                命令模板（占位符 {"{param}"}，如 nmap -p {"{ports}"} {"{target}"}）
              </Label>
              <Textarea
                className="font-mono text-xs"
                rows={2}
                value={ex.command}
                onChange={(e) => setEx({ ...ex, command: e.target.value })}
              />
            </div>
          )}
          {kind === "script" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">Python 正文（参数走 stdin JSON / os.environ["TOOL_X"]）</Label>
              <Textarea
                className="font-mono text-xs"
                rows={10}
                value={ex.code}
                placeholder={"import json,sys\nargs=json.load(sys.stdin)\nprint(...)"}
                onChange={(e) => setEx({ ...ex, code: e.target.value })}
              />
            </div>
          )}
          {kind === "http" && (
            <div className="grid gap-2">
              <div className="flex gap-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Method</Label>
                  <Input
                    className="w-24"
                    value={ex.method}
                    onChange={(e) => setEx({ ...ex, method: e.target.value })}
                  />
                </div>
                <div className="grid flex-1 gap-1.5">
                  <Label className="text-xs">URL（可含 {"{param}"}）</Label>
                  <Input
                    className="font-mono text-xs"
                    value={ex.url}
                    onChange={(e) => setEx({ ...ex, url: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Headers（JSON，可含 {"{param}"}）</Label>
                <Textarea
                  className="font-mono text-xs"
                  rows={2}
                  value={ex.headers}
                  placeholder={'{"Authorization": "Bearer {token}"}'}
                  onChange={(e) => setEx({ ...ex, headers: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Body（可含 {"{param}"}）</Label>
                <Textarea
                  className="font-mono text-xs"
                  rows={2}
                  value={ex.body}
                  onChange={(e) => setEx({ ...ex, body: e.target.value })}
                />
              </div>
              <div className="flex items-center gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs">代理 URL（空=直连）</Label>
                  <Input
                    className="font-mono text-xs w-56"
                    value={ex.proxy}
                    onChange={(e) => setEx({ ...ex, proxy: e.target.value })}
                  />
                </div>
                <label htmlFor="custom-tool-recording-proxy" className="mt-4 flex items-center gap-2 text-sm">
                  <Checkbox
                    id="custom-tool-recording-proxy"
                    checked={ex.use_recording_proxy}
                    onCheckedChange={(v) => setEx({ ...ex, use_recording_proxy: !!v })}
                  />
                  走记录代理
                </label>
              </div>
            </div>
          )}

          {kind !== "shell" && (
            <div className="flex items-center gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">超时(ms，空=默认)</Label>
                <Input
                  type="number"
                  className="w-32"
                  value={ex.timeout_ms}
                  onChange={(e) => setEx({ ...ex, timeout_ms: e.target.value })}
                />
              </div>
            </div>
          )}

          {kind !== "shell" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">
                参数 JSON Schema
                {kind === "http" ? "（http 工具必填，需含 properties）" : "（留空 = 自动给 {args} 薄壳）"}
              </Label>
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={schemaText}
                placeholder={'{"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}'}
                onChange={(e) => setSchemaText(e.target.value)}
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label className="text-muted-foreground text-xs">绑定 Agent</Label>
            <div className="flex flex-wrap gap-3">
              {agents.map((a) => (
                <label key={a.key} htmlFor={`custom-tool-agent-${a.key}`} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`custom-tool-agent-${a.key}`}
                    checked={bound.includes(a.key)}
                    onCheckedChange={() => toggleAgent(a.key)}
                  />
                  {a.name}
                  <span className="text-muted-foreground font-mono text-xs">{a.key}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label htmlFor="custom-tool-enabled" className="flex items-center gap-2 text-sm">
              <Switch id="custom-tool-enabled" checked={enabled} onCheckedChange={setEnabled} /> 启用
            </label>
            {kind !== "shell" && (
              <label htmlFor="custom-tool-deferred" className="flex items-center gap-2 text-sm">
                <Switch id="custom-tool-deferred" checked={deferred} onCheckedChange={setDeferred} />{" "}
                deferred（大量不常用工具才开）
              </label>
            )}
          </div>

          <FieldGroup className="gap-3 rounded-md border p-3">
            <Field>
              <FieldLabel htmlFor="custom-tool-test-input">
                {kind === "shell" ? "检测与测试" : "测试运行"}（当前表单，不会保存）
              </FieldLabel>
              {kind === "shell" ? (
                <>
                  <Textarea
                    id="custom-tool-test-input"
                    className="font-mono"
                    rows={2}
                    value={testCommand}
                    placeholder="填写完整测试命令，例如 nmap --version"
                    onChange={(e) => setTestCommand(e.target.value)}
                  />
                  <FieldDescription>
                    显式点击才执行；30 秒超时。检测与测试不计入调用次数。目录提示不会改变工作目录。
                  </FieldDescription>
                </>
              ) : (
                <Textarea
                  id="custom-tool-test-input"
                  className="font-mono"
                  rows={2}
                  value={paramsText}
                  placeholder='示例参数 JSON，如 {"target":"example.com"}'
                  onChange={(e) => setParamsText(e.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              {kind === "shell" && (
                <Button size="sm" variant="outline" onClick={() => runTest("check")} disabled={testing}>
                  检测可用性
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => runTest()}
                disabled={testing || (kind === "shell" && !testCommand.trim())}
              >
                <PlayIcon />
                {testing ? "运行中…" : "测试运行"}
              </Button>
              {testing && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    testAbort.current?.abort();
                    setTesting(false);
                    setTestResult({ output: "已取消测试", is_error: true });
                  }}
                >
                  取消
                </Button>
              )}
            </div>
            {testResult && (
              <div role="status" className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  {testResult.is_error ? "失败" : "成功"}
                  {testResult.duration_ms != null ? ` · ${testResult.duration_ms} ms` : ""}
                </span>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                  {testResult.output || "（无输出）"}
                </pre>
              </div>
            )}
            {kind === "shell" && (
              <p className="text-muted-foreground text-xs">
                调用次数统计包含该工具的 Bash 执行请求，每请求最多一次；不推测脚本内部调用，不回填旧历史。
              </p>
            )}
          </FieldGroup>
        </div>

        <Separator />
        <div className="flex items-center gap-2 p-4">
          <Button size="sm" onClick={save} disabled={saving}>
            <SaveIcon /> {isNew ? "创建" : "保存"}
          </Button>
          {!isNew && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={del}>
              <Trash2Icon /> 删除
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
