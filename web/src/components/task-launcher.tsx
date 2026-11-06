"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { PaperclipIcon, SlidersHorizontalIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Task, TaskCategory, Company, LLMProfile, ChatAttachment } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@/components/ui/combobox";
import { TablePagination } from "@/components/table-pagination";
import { StatusBadge } from "@/components/status-badge";
import { TaskLLMProfileChain } from "@/components/task-llm-profile-chain";
const MAX_SOURCE_TASKS = 8;
// fmtBytes renders a human file size for the upload manifest.
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

// UPLOAD_MARKER labels the auto-appended block of uploaded-file paths inside the task
// description, so re-uploads append under the same block instead of adding a new header.
const UPLOAD_MARKER = "【上传文件（绝对路径）】";

// appendUploads folds newly-uploaded files' ABSOLUTE paths into the description as a
// Read/Bash-friendly manifest — the worker opens them by path. Keeps one marked block:
// first upload adds the header, later uploads append bullets under it.
function appendUploads(desc: string, atts: ChatAttachment[]): string {
  const bullets = atts.map((a) => `- ${a.abs ?? a.path}（${fmtBytes(a.size)}）`).join("\n");
  if (desc.includes(UPLOAD_MARKER)) {
    return `${desc.replace(/\s*$/, "")}\n${bullets}\n`;
  }
  const head = desc.trim() ? `${desc.replace(/\s*$/, "")}\n\n` : "";
  return `${head}${UPLOAD_MARKER} worker 可用 Read/Bash 按路径打开：\n${bullets}\n`;
}

function SourceTaskPicker({
  tasks: initialTasks,
  value,
  onValueChange,
  portalContainer,
}: {
  tasks: Task[];
  value: string[];
  onValueChange: (value: string[]) => void;
  portalContainer?: React.RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = React.useState(""),
    [sourcePage, setSourcePage] = React.useState(1);
  const [tasks, setTasks] = React.useState<Task[]>(initialTasks),
    [sourceTotal, setSourceTotal] = React.useState(0);
  const [error, setError] = React.useState(""),
    [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api
        .tasks({ page: sourcePage, page_size: 20, q: query })
        .then((r) => {
          if (active) {
            setTasks(r.tasks);
            setSourceTotal(r.total ?? 0);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("来源任务读取失败");
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, sourcePage, retry]);
  const tasksByID = React.useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const taskIDs = React.useMemo(() => tasks.map((task) => task.id), [tasks]);
  const atLimit = value.length >= MAX_SOURCE_TASKS;

  const handleValueChange = (next: string[]) => {
    onValueChange(next.slice(0, MAX_SOURCE_TASKS));
  };

  return (
    <>
      {error && (
        <p role="alert">
          {error}
          <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((v) => v + 1)}>
            重试
          </Button>
        </p>
      )}
      <Combobox
        items={taskIDs}
        filter={null}
        inputValue={query}
        onInputValueChange={(text) => {
          setQuery(text);
          setSourcePage(1);
        }}
        itemToStringValue={(taskID) => {
          const task = tasksByID.get(taskID);
          return task ? `${task.id} ${task.description} ${task.goal}` : taskID;
        }}
        multiple
        value={value}
        onValueChange={handleValueChange}
      >
        <ComboboxChips>
          <ComboboxValue>
            {value.map((taskID) => (
              <ComboboxChip key={taskID}>#{taskID}</ComboboxChip>
            ))}
          </ComboboxValue>
          <ComboboxChipsInput
            id="source-tasks"
            placeholder={atLimit ? `最多关联 ${MAX_SOURCE_TASKS} 个任务` : "搜索任务 ID、描述或目标"}
            disabled={atLimit}
          />
        </ComboboxChips>
        <ComboboxContent portalContainer={portalContainer}>
          <ComboboxEmpty>没有匹配的任务</ComboboxEmpty>
          <ComboboxList>
            {(taskID) => {
              const task = tasksByID.get(taskID);
              return (
                <ComboboxItem key={taskID} value={taskID} disabled={atLimit && !value.includes(taskID)}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        #{taskID} · {task?.description ?? "未知任务"}
                      </p>
                      {task?.goal && <p className="text-muted-foreground truncate text-xs">{task.goal}</p>}
                    </div>
                    {task && <StatusBadge domain="task" value={task.status} />}
                  </div>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
          <TablePagination
            page={sourcePage}
            pageSize={20}
            pageSizeOptions={[20]}
            total={sourceTotal}
            onPageChange={setSourcePage}
            onPageSizeChange={() => {}}
          />
        </ComboboxContent>
      </Combobox>
    </>
  );
}

// CategoryPicker 是新建任务里的单选分类选择器：可搜索已有分类；输入库里没有的名称后
// 回车（或点下拉里的「创建」）即时新建分类并选中，选中项以可移除的 tag 展示。分类是
// 全局资源，这里即时创建与「分类管理」里手动新建等价。只允许一个分类。
function CategoryPicker({
  categories,
  value,
  onValueChange,
  onCategoryCreated,
  portalContainer,
}: {
  categories: TaskCategory[];
  value?: number;
  onValueChange: (categoryID?: number) => void;
  onCategoryCreated: () => void;
  portalContainer?: React.RefObject<HTMLElement | null>;
}) {
  const [inputValue, setInputValue] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  // 新建的分类要等父层重新拉取才回流到 categories，先本地留一份，避免选中的 chip 和
  // 下拉在这段窗口里显示成「未知分类」。
  const [localExtra, setLocalExtra] = React.useState<TaskCategory[]>([]);

  const allCategories = React.useMemo(() => {
    const byID = new Map<number, TaskCategory>();
    for (const category of categories) byID.set(category.id, category);
    for (const category of localExtra) if (!byID.has(category.id)) byID.set(category.id, category);
    return [...byID.values()];
  }, [categories, localExtra]);

  const byID = React.useMemo(() => new Map(allCategories.map((c) => [String(c.id), c])), [allCategories]);
  const categoryIDs = React.useMemo(() => allCategories.map((c) => String(c.id)), [allCategories]);
  const selectedIDs = value != null ? [String(value)] : [];

  const trimmed = inputValue.trim();
  const lower = trimmed.toLowerCase();
  // 与 base-ui 默认子串过滤保持一致，用来判断「有没有相关分类」。
  const matchCount = trimmed
    ? allCategories.filter((c) => c.name.toLowerCase().includes(lower)).length
    : allCategories.length;

  const createAndSelect = async () => {
    if (!trimmed || creating) return;
    // 精确同名已存在则直接选中，不重复创建。
    const existing = allCategories.find((c) => c.name.toLowerCase() === lower);
    if (existing) {
      onValueChange(existing.id);
      setInputValue("");
      return;
    }
    setCreating(true);
    try {
      const created = await api.createTaskCategory(trimmed);
      setLocalExtra((prev) => [...prev, created]);
      onValueChange(created.id);
      setInputValue("");
      onCategoryCreated();
      toast.success(`已创建分类「${created.name}」`);
    } catch (e) {
      toast.error(`创建分类失败：${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Combobox
      items={categoryIDs}
      itemToStringValue={(id) => byID.get(id)?.name ?? id}
      multiple
      value={selectedIDs}
      onValueChange={(next: string[]) => {
        // 单选：取最新选中的一个；移除 chip（清空）则回到未分类。
        const last = next[next.length - 1];
        onValueChange(last ? Number(last) : undefined);
        setInputValue("");
      }}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
    >
      <ComboboxChips>
        <ComboboxValue>
          {selectedIDs.map((id) => (
            <ComboboxChip key={id}>{byID.get(id)?.name ?? "未知分类"}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          id="task-category"
          placeholder={selectedIDs.length ? "" : "搜索分类，或输入新名称后回车创建"}
          onKeyDown={(e) => {
            // 完全无匹配时回车 = 创建；有匹配项时保留 base-ui 的「回车选中高亮项」。
            if (
              e.key === "Enter" &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.nativeEvent.isComposing &&
              matchCount === 0 &&
              trimmed
            ) {
              e.preventDefault();
              void createAndSelect();
            }
          }}
        />
      </ComboboxChips>
      <ComboboxContent portalContainer={portalContainer}>
        <ComboboxList>
          {(id: string) => (
            <ComboboxItem key={id} value={id}>
              {byID.get(id)?.name ?? id}
            </ComboboxItem>
          )}
        </ComboboxList>
        {matchCount === 0 &&
          (trimmed ? (
            <button
              type="button"
              disabled={creating}
              onClick={() => void createAndSelect()}
              className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              {creating ? <Spinner className="size-4" /> : <PlusIcon className="size-4" />}
              创建分类「{trimmed}」
            </button>
          ) : (
            <div className="px-2 py-2 text-sm text-muted-foreground">输入名称以搜索或创建分类</div>
          ))}
      </ComboboxContent>
    </Combobox>
  );
}

const COMPANY_SCOPE_LABELS: Record<string, string> = {
  domain: "域名",
  ip: "IP",
  cidr: "CIDR",
  icp: "ICP",
  keyword: "关键词",
};

function companyScopeSummary(company: Company): string {
  const rows = company.scope ?? [];
  if (rows.length === 0) return "未配置资产范围";
  const preview = rows.slice(0, 3).map((row) => {
    const value = row.raw || row.value || row.domain || row.net || "";
    return `${COMPANY_SCOPE_LABELS[row.kind] ?? row.kind}：${value}`;
  });
  return `${preview.join(" · ")}${rows.length > preview.length ? ` · 另 ${rows.length - preview.length} 条` : ""}`;
}

function CompanyPicker({
  companies,
  value,
  onValueChange,
  portalContainer,
}: {
  companies: Company[];
  value: number[];
  onValueChange: (value: number[]) => void;
  portalContainer?: React.RefObject<HTMLElement | null>;
}) {
  const companiesByID = React.useMemo(
    () => new Map(companies.map((company) => [String(company.id), company])),
    [companies],
  );
  const companyIDs = React.useMemo(() => companies.map((company) => String(company.id)), [companies]);
  const selectedIDs = React.useMemo(() => value.map(String), [value]);

  return (
    <Combobox
      items={companyIDs}
      itemToStringValue={(companyID) => {
        const company = companiesByID.get(companyID);
        return company ? `${company.name} ${companyScopeSummary(company)}` : companyID;
      }}
      multiple
      value={selectedIDs}
      onValueChange={(next) => onValueChange(next.map(Number).filter(Number.isFinite))}
    >
      <ComboboxChips>
        <ComboboxValue>
          {selectedIDs.map((companyID) => (
            <ComboboxChip key={companyID}>{companiesByID.get(companyID)?.name ?? `企业 #${companyID}`}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput id="task-companies" placeholder="搜索企业名称或资产范围" />
      </ComboboxChips>
      <ComboboxContent portalContainer={portalContainer}>
        <ComboboxEmpty>没有匹配的企业</ComboboxEmpty>
        <ComboboxList>
          {(companyID) => {
            const company = companiesByID.get(companyID);
            return (
              <ComboboxItem key={companyID} value={companyID}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{company?.name ?? `企业 #${companyID}`}</span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {company?.asset_count ?? 0} 个资产
                    </span>
                  </div>
                  {company && (
                    <span className="text-muted-foreground truncate text-xs" title={companyScopeSummary(company)}>
                      {companyScopeSummary(company)}
                    </span>
                  )}
                </div>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export function TaskLauncher() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false),
    [categories, setCategories] = React.useState<TaskCategory[]>([]);
  const [optionsError, setOptionsError] = React.useState(""),
    [loadingOptions, setLoadingOptions] = React.useState(false);
  const [submitError, setSubmitError] = React.useState(""),
    [uploadError, setUploadError] = React.useState("");
  const busy = React.useRef(false),
    optionsRequest = React.useRef(0),
    settingTarget = React.useRef("source-tasks"),
    categoryRequest = React.useRef(0);
  React.useEffect(
    () => () => {
      optionsRequest.current++;
      categoryRequest.current++;
    },
    [],
  );
  const [categoryError, setCategoryError] = React.useState("");
  const [loadingCategories, setLoadingCategories] = React.useState(false);
  const [name, setName] = React.useState("");
  const [categoryID, setCategoryID] = React.useState<number | undefined>(undefined);
  const [description, setDescription] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [companies, setCompanies] = React.useState<Company[]>([]);
  const [sourceTaskIDs, setSourceTaskIDs] = React.useState<string[]>([]);
  const [companyIDs, setCompanyIDs] = React.useState<number[]>([]);
  const [assetIDs] = React.useState<number[]>([]);
  const [llmProfileIDs, setLLMProfileIDs] = React.useState<string[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [timeoutMin, setTimeoutMin] = React.useState(""); // 任务级超时(分钟);空/0 = 不限时
  const [heartbeatMin, setHeartbeatMin] = React.useState("10"); // planner 心跳(分钟);默认10,下限10(与后端一致)
  const [seedFirstIntent, setSeedFirstIntent] = React.useState(false); // 创建时下发种子意图,worker 免等首轮 planner 直接开跑;默认关闭,走标准先规划再执行
  const [coverageEnabled, setCoverageEnabled] = React.useState(true); // 资产覆盖度功能;默认开。关闭=不计算/展示覆盖度、不累积范围、隐藏范围类工具(company 关联不受影响)
  // 方式1 文件上传:建任务前把文件暂存到 drafts/<draftId>/uploads/,拿回绝对路径追加进描述。
  const [uploading, setUploading] = React.useState(false);
  const [uploadNames, setUploadNames] = React.useState<string[]>([]);
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const draftIdRef = React.useRef<string>("");
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const sheetContentRef = React.useRef<HTMLDivElement>(null);

  const loadCategories = React.useCallback(async () => {
    const version = ++categoryRequest.current;
    setLoadingCategories(true);
    setCategoryError("");
    try {
      const result = await api.taskCategories();
      if (version === categoryRequest.current) setCategories(result);
    } catch {
      if (version === categoryRequest.current) setCategoryError("分类读取失败，已有选择已保留。");
    } finally {
      if (version === categoryRequest.current) setLoadingCategories(false);
    }
  }, []);
  React.useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const loadOptions = React.useCallback(async () => {
    const version = ++optionsRequest.current;
    setLoadingOptions(true);
    setOptionsError("");
    const results = await Promise.allSettled([api.companies(), api.llmProfiles()]);
    if (version !== optionsRequest.current) return;
    const [co, l] = results;
    if (co.status === "fulfilled") setCompanies(co.value);
    if (l.status === "fulfilled") setProfiles(l.value);
    const failed = results.map((r, i) => (r.status === "rejected" ? ["企业", "模型配置"][i] : "")).filter(Boolean);
    setOptionsError(failed.length ? `${failed.join("、")}读取失败，请重试；已有选择已保留。` : "");
    setLoadingOptions(false);
  }, []);
  React.useEffect(() => {
    if (open) void loadOptions();
  }, [open, loadOptions]);
  async function pickFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy.current || uploading) return;
    // crypto.randomUUID 仅在安全上下文可用(https/localhost);经 IP+http 访问时降级。
    if (!draftIdRef.current) {
      draftIdRef.current =
        globalThis.crypto?.randomUUID?.() ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
    busy.current = true;
    setUploading(true);
    setUploadError("");
    setUploadNames(Array.from(files, (file) => file.name));
    try {
      const r = await api.chatUpload("staging", draftIdRef.current, Array.from(files));
      setDescription((prev) => appendUploads(prev, r.attachments));
      setAttachments((prev) => [...prev, ...r.attachments]);
      setUploadNames([]);
    } catch (e) {
      setUploadError("上传失败：" + (e as Error).message);
    } finally {
      busy.current = false;
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = ""; // allow re-picking the same file
    }
  }

  async function createTask() {
    if (busy.current) return;
    setSubmitError("");
    if (!description.trim() || !goal.trim()) {
      setSubmitError("请填写测试对象与约束，以及期望达成的目标");
      return;
    }
    if (sourceTaskIDs.length > MAX_SOURCE_TASKS) {
      toast.error(`最多关联 ${MAX_SOURCE_TASKS} 个来源任务`);
      return;
    }
    busy.current = true;
    setCreating(true);
    try {
      const timeoutSec = Math.max(0, Math.floor(Number(timeoutMin) || 0)) * 60;
      const heartbeatSec = Math.max(10, Math.floor(Number(heartbeatMin) || 10)) * 60; // 下限 10min，与后端归一一致
      const task = await api.createTask({
        name: name.trim(),
        categoryId: categoryID,
        description: description.trim(),
        goal: goal.trim(),
        llmProfileIds: llmProfileIDs.map(Number),
        sourceTaskIds: sourceTaskIDs,
        companyIds: companyIDs,
        assetIds: assetIDs,
        timeoutSeconds: timeoutSec,
        seedFirstIntent,
        planHeartbeatSeconds: heartbeatSec,
        coverageEnabled,
      });
      toast.success("任务已创建");
      router.push(`/function/tasks/detail?id=${task.id}&tab=sessions&section=chat`);
    } catch (e) {
      setSubmitError("创建失败：" + (e as Error).message);
    } finally {
      busy.current = false;
      setCreating(false);
    }
  }

  const summaries = [
    ...(sourceTaskIDs.length ? [`关联任务 ${sourceTaskIDs.length}`] : []),
    ...(companyIDs.length ? [`企业范围 ${companyIDs.length}`] : []),
    ...(llmProfileIDs.length ? [`模型配置 ${llmProfileIDs.length}`] : []),
    ...(Number(timeoutMin) > 0 ? [`限时 ${timeoutMin} 分钟`] : []),
    ...(heartbeatMin !== "10" ? [`心跳 ${heartbeatMin} 分钟`] : []),
    ...(seedFirstIntent ? ["直接下发首个意图"] : []),
    ...(!coverageEnabled ? ["覆盖度关闭"] : []),
  ];
  return (
    <main className="task-launcher">
      <div className="task-launcher-inner">
        <header>
          <h1>开始一项新的安全任务</h1>
          <p>描述测试对象与背景，接下来确认目标和执行配置。</p>
        </header>
        <form
          className="task-launcher-form"
          onSubmit={(e) => {
            e.preventDefault();
            void createTask();
          }}
          onKeyDown={(e) => {
            if (e.defaultPrevented || e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void createTask();
            } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
          }}
        >
          <fieldset disabled={creating} className="task-launcher-fields">
            <div className="task-launcher-card">
              <FieldGroup>
                <Field className="task-launcher-field">
                  <FieldLabel htmlFor="description" className="sr-only">
                    测试对象、背景与约束
                  </FieldLabel>
                  <Textarea
                    id="description"
                    required
                    value={description}
                    disabled={creating}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="描述你希望完成的任务…"
                  />
                </Field>
              </FieldGroup>
              <div className="task-launcher-toolbar">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="上传附件"
                  aria-label="上传附件"
                  disabled={creating || uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? <Spinner /> : <PaperclipIcon />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="任务设置"
                  aria-label="任务设置"
                  disabled={creating}
                  onClick={() => {
                    settingTarget.current = "source-tasks";
                    setOpen(true);
                  }}
                >
                  <SlidersHorizontalIcon />
                </Button>
                <span>支持上传测试资料</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => void pickFiles(e.target.files)}
                />
              </div>
            </div>
            {uploadError && (
              <p role="alert" className="text-sm text-destructive">
                {uploadError}（{uploadNames.join("、")}），请重新选择文件上传。
              </p>
            )}
            {uploading && (
              <p role="status" className="text-sm text-muted-foreground">
                正在上传：{uploadNames.join("、")}…
              </p>
            )}
            {attachments.length > 0 && (
              <ul aria-label="已上传附件" className="flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <li key={`${a.path}:${i}`} className="max-w-full break-all rounded-md border px-2 py-1 text-xs">
                    {a.name} · {fmtBytes(a.size)}
                  </li>
                ))}
              </ul>
            )}
            {summaries.length > 0 && (
              <div aria-label="已选任务配置" className="flex flex-wrap gap-2">
                {summaries.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-auto max-w-full whitespace-normal break-all"
                    onClick={() => {
                      settingTarget.current = s.startsWith("关联")
                        ? "source-tasks"
                        : s.startsWith("企业")
                          ? "task-companies"
                          : s.startsWith("模型")
                            ? "llm-profiles"
                            : "advanced-settings";
                      setOpen(true);
                    }}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            )}

            <Card className="task-launcher-confirmation">
              <CardHeader>
                <CardTitle>
                  <h2>确认任务目标</h2>
                </CardTitle>
                <CardDescription>确认后创建任务；高级选项沿用当前系统默认值。</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="name">名称（可选）</FieldLabel>
                    <Input
                      id="name"
                      value={name}
                      disabled={creating}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="给任务起个便于识别的名字，例如：Acme 官网渗透"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="task-category">任务分类</FieldLabel>
                    <CategoryPicker
                      categories={categories}
                      value={categoryID}
                      onValueChange={setCategoryID}
                      onCategoryCreated={() => void loadCategories()}
                    />
                    {loadingCategories && (
                      <p role="status" className="text-sm text-muted-foreground">
                        正在读取分类…
                      </p>
                    )}
                    {categoryError && (
                      <p role="alert" className="text-sm text-destructive">
                        {categoryError}
                        <Button type="button" size="sm" variant="ghost" onClick={() => void loadCategories()}>
                          重试
                        </Button>
                      </p>
                    )}
                    <FieldDescription>可选，单个分类；用于任务列表筛选和归档，不影响 Agent 执行。</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="goal">目标（必填）</FieldLabel>
                    <Textarea
                      id="goal"
                      required
                      value={goal}
                      disabled={creating}
                      onChange={(e) => setGoal(e.target.value)}
                      placeholder="描述期望达成的目标，例如：确认是否存在可复现的高风险权限问题，并保存证据与修复建议。"
                    />
                  </Field>
                </FieldGroup>
              </CardContent>
              <CardFooter className="flex-wrap justify-between gap-3">
                <span className="text-sm text-muted-foreground">Ctrl / ⌘ + Enter 创建任务</span>
                <Button type="submit" disabled={!description.trim() || !goal.trim() || uploading || creating}>
                  {creating && <Spinner data-icon="inline-start" />}
                  {creating ? "正在创建…" : "创建任务"}
                </Button>
              </CardFooter>
            </Card>
            {submitError && (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            )}
          </fieldset>
        </form>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            onOpenAutoFocus={(e) => {
              const target = sheetContentRef.current?.querySelector<HTMLElement>(`#${settingTarget.current}`);
              if (target) {
                e.preventDefault();
                target.focus();
              }
            }}
            ref={sheetContentRef}
            className="w-full gap-0 p-0 sm:max-w-xl"
          >
            <SheetHeader className="border-b p-5">
              <SheetTitle>任务设置</SheetTitle>
              <SheetDescription>按需配置，关闭后保留当前输入。</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {loadingOptions && <p role="status">正在读取配置…</p>}
              {optionsError && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  {optionsError}
                  <Button type="button" size="sm" variant="ghost" onClick={() => void loadOptions()}>
                    重试
                  </Button>
                </p>
              )}
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="source-tasks">关联任务</FieldLabel>
                  <SourceTaskPicker
                    tasks={[]}
                    value={sourceTaskIDs}
                    onValueChange={setSourceTaskIDs}
                    portalContainer={sheetContentRef}
                  />
                  <FieldDescription>
                    最多关联 {MAX_SOURCE_TASKS}{" "}
                    个任务。实时只读继承所选任务的持久化黑板、资产范围及相关流量；新任务写入独立黑板。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="task-companies">关联企业资产范围</FieldLabel>
                  <CompanyPicker
                    companies={companies}
                    value={companyIDs}
                    onValueChange={setCompanyIDs}
                    portalContainer={sheetContentRef}
                  />
                  <FieldDescription>
                    创建任务时会将所选企业当前已有资产加入“测试资产”，并将域名、IP、CIDR、ICP 和企业关键词提供给 Agent
                    作为范围上下文；不会自动生成意图或强制改变执行目标。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="llm-profiles">LLM 配置链</FieldLabel>
                  <TaskLLMProfileChain
                    profiles={profiles}
                    value={llmProfileIDs}
                    onValueChange={setLLMProfileIDs}
                    inputId="llm-profiles"
                    portalContainer={sheetContentRef}
                  />
                  <FieldDescription>
                    按列表顺序故障转移；第一项为当前配置，仅在明确额度不足时切换下一项。
                  </FieldDescription>
                </Field>

                {/* 高级参数默认折叠:超时/心跳/首个意图,展开才占空间,常用路径保持清爽。 */}
                <Collapsible>
                  <CollapsibleTrigger
                    id="advanced-settings"
                    className="group flex w-full items-center gap-2 border-t pt-4 text-sm font-medium"
                  >
                    <ChevronRightIcon className="text-muted-foreground size-4 transition-transform group-data-[state=open]:rotate-90" />
                    高级设置
                    <span className="text-muted-foreground ml-auto text-xs font-normal">超时 · 心跳 · 首个意图</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-5 pt-5">
                    <div className="grid gap-2">
                      <Label htmlFor="timeout-min">任务超时（分钟，可选）</Label>
                      <Input
                        id="timeout-min"
                        type="number"
                        min={0}
                        className="w-40"
                        placeholder="留空 = 不限时"
                        value={timeoutMin}
                        onChange={(e) => setTimeoutMin(e.target.value)}
                      />
                      <p className="text-muted-foreground text-xs">
                        到点后触发优雅收尾（各 agent 写回 + planner 终局判定），任务进入 timeout 终态。
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="heartbeat-min">planner 心跳（分钟）</Label>
                      <Input
                        id="heartbeat-min"
                        type="number"
                        min={10}
                        className="w-40"
                        placeholder="默认 10"
                        value={heartbeatMin}
                        onChange={(e) => setHeartbeatMin(e.target.value)}
                      />
                      <p className="text-muted-foreground text-xs">
                        距上轮规划结束/任务开始满该时长且期间无触发，自动触发一轮规划（兜底卡死 + 唤醒去监督在跑的
                        worker）。下限 10 分钟。
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <label htmlFor="seed-first-intent" className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id="seed-first-intent"
                          checked={seedFirstIntent}
                          onCheckedChange={(v) => setSeedFirstIntent(!!v)}
                        />
                        直接下发首个意图（描述+目标）
                      </label>
                      <p className="text-muted-foreground text-xs">
                        开启后先完成约束提取和目标保存，再把「描述+目标」作为首条意图交给 Worker，跑完再由 Planner
                        接手判定/补充。CTF 等常一个 work 直接解决的场景推荐开启；关闭则走标准的先规划再执行。
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <label htmlFor="coverage-enabled" className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id="coverage-enabled"
                          checked={coverageEnabled}
                          onCheckedChange={(v) => setCoverageEnabled(!!v)}
                        />
                        资产覆盖度功能
                      </label>
                      <p className="text-muted-foreground text-xs">
                        默认开启：计算并展示测试覆盖度、态势图显示测试进度、自动累积测试范围。关闭后不再计算/展示覆盖度，
                        态势图仅展示资产不显示进度，agent 也不再获得范围类工具。关闭不影响「关联企业资产范围」。
                      </p>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </FieldGroup>
            </div>
            <SheetFooter className="border-t p-4">
              <Button type="button" onClick={() => setOpen(false)}>
                完成设置
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    </main>
  );
}
