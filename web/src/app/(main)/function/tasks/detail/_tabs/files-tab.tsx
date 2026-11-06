"use client";
import * as React from "react";
import { Folder, FileText, Download, ChevronRight, ArrowLeft, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { TaskFileEntry, FileContentPage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { WorkspaceToolbar, WorkspaceEmpty, WorkspaceError } from "@/components/workspace";
import { toast } from "sonner";
export function FilesTab({ taskId }: { taskId: string }) {
  const [directory, setDirectory] = React.useState(""),
    [items, setItems] = React.useState<TaskFileEntry[]>([]),
    [cursor, setCursor] = React.useState<string | null>(null),
    [error, setError] = React.useState(""),
    [loading, setLoading] = React.useState(false),
    [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<TaskFileEntry | null>(null),
    [content, setContent] = React.useState<FileContentPage | null>(null),
    [previewError, setPreviewError] = React.useState(""),
    [reading, setReading] = React.useState(false);
  const request = React.useRef(0),
    previewRequest = React.useRef(0);
  const load = React.useCallback(
    async (after = "") => {
      const token = ++request.current;
      setLoading(true);
      try {
        const r = await api.taskFiles(taskId, directory, after);
        if (token !== request.current) return;
        setItems((old) => (after ? [...old, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError("");
      } catch (e) {
        if (token === request.current) setError((e as Error).message);
      } finally {
        if (token === request.current) setLoading(false);
      }
    },
    [taskId, directory],
  );
  React.useEffect(() => {
    setItems([]);
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  const read = React.useCallback(
    async (file: TaskFileEntry, offset = 0, version = "") => {
      const token = ++previewRequest.current;
      setReading(true);
      try {
        const r = await api.taskFileContent(taskId, file.ref, offset, version);
        if (token !== previewRequest.current) return;
        setContent((old) => ({ ...r, content: offset ? (old?.content ?? "") + r.content : r.content }));
        setPreviewError("");
      } catch (e) {
        if (token === previewRequest.current) setPreviewError((e as Error).message);
      } finally {
        if (token === previewRequest.current) setReading(false);
      }
    },
    [taskId],
  );
  function select(file: TaskFileEntry) {
    if (file.kind === "directory") {
      setDirectory(file.ref);
      setQuery("");
      return;
    }
    setSelected(file);
    setContent(null);
    setPreviewError("");
    void read(file);
  }
  const parent = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
  return (
    <div className="flex flex-col gap-6">
      <WorkspaceToolbar>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw />
          刷新
        </Button>
        {directory && (
          <Button variant="ghost" size="icon-sm" aria-label="返回上级目录" onClick={() => setDirectory(parent)}>
            <ArrowLeft />
          </Button>
        )}
        <Button variant="ghost" onClick={() => setDirectory("")}>
          全部文件
        </Button>
        {directory && (
          <>
            <ChevronRight className="size-4" />
            <span className="min-w-0 truncate text-sm">{directory.replace("work:", "")}</span>
          </>
        )}
        <Input
          className="ml-auto max-w-xs"
          placeholder="搜索当前目录"
          aria-label="搜索文件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </WorkspaceToolbar>
      {error && <WorkspaceError error={error} onRetry={() => void load()} />}
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>大小</TableHead>
              <TableHead>修改时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items
              .filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
              .map((f) => (
                <TableRow key={f.ref}>
                  <TableCell>
                    <Button variant="ghost" className="max-w-full justify-start" onClick={() => select(f)}>
                      {f.kind === "directory" ? <Folder /> : <FileText />}
                      <span className="truncate">{f.name}</span>
                    </Button>
                  </TableCell>
                  <TableCell>{f.origin === "attachment" ? "上传附件" : `意图 #${f.intent_id}`}</TableCell>
                  <TableCell>{f.kind === "directory" ? "—" : `${(f.size / 1024).toFixed(1)} KB`}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(f.modified_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        {!items.length && !error && (
          <WorkspaceEmpty
            title={loading ? "正在读取文件…" : "暂无文件"}
            description="上传附件或执行器生成工作文件后会显示在这里。"
          />
        )}
      </div>
      {cursor && (
        <Button variant="outline" disabled={loading} onClick={() => void load(cursor)}>
          加载更多
        </Button>
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) {
            setSelected(null);
            previewRequest.current++;
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>{selected?.name}</SheetTitle>
            <SheetDescription>
              只读预览 · {selected?.origin === "attachment" ? "上传附件" : `意图 #${selected?.intent_id}`}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {selected && (
              <Button
                variant="outline"
                onClick={() =>
                  api.downloadTaskFile(taskId, selected.ref, selected.name).catch((e) => toast.error(e.message))
                }
              >
                <Download />
                下载原文件
              </Button>
            )}
            {previewError && selected && <WorkspaceError error={previewError} onRetry={() => void read(selected)} />}
            <pre className="min-h-40 max-h-[60dvh] shrink-0 overflow-auto rounded-xl border bg-muted/40 p-4 text-xs leading-relaxed">
              {content?.binary ? "二进制文件，请下载查看。" : content?.content || (reading ? "正在读取…" : "空文件")}
            </pre>
            {content?.has_more && !content.binary && selected && (
              <Button
                disabled={reading}
                variant="outline"
                onClick={() => void read(selected, content.next_offset, content.version)}
              >
                继续读取（{content.next_offset} / {content.total} 字节）
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
