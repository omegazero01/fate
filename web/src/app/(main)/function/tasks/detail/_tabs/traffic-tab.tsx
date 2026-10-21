"use client";
import * as React from "react";
import Link from "next/link";
import { Download, RefreshCw, Search, Globe, ChevronRight, X, Copy, Network, Filter } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { appendEvidencePage, type EvidenceText } from "@/lib/evidence-pages";
import type { TrafficExchange, TrafficResp, TrafficDetail, TrafficHost } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TablePagination } from "@/components/table-pagination";
import { WorkspaceEmpty, WorkspaceError } from "@/components/workspace";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
type Side = "request" | "response";
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
function Method({ value }: { value: string }) {
  return (
    <Badge variant="secondary" className="network-method" data-method={value}>
      {value}
    </Badge>
  );
}
function HostBranch({
  taskId,
  row,
  selected,
  path,
  onSelect,
  revision,
}: {
  taskId: string;
  row: TrafficHost;
  selected: boolean;
  path: string;
  onSelect: (path: string) => void;
  revision: number;
}) {
  const [open, setOpen] = React.useState(false),
    [paths, setPaths] = React.useState<{ path: string; count: number }[]>([]),
    [total, setTotal] = React.useState(0),
    [page, setPage] = React.useState(0),
    [loading, setLoading] = React.useState(false),
    [error, setError] = React.useState("");
  const [retry, retryPaths] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    setPage(0);
    setPaths([]);
    setTotal(0);
  }, [revision]);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    void api
      .trafficPaths(taskId, row.host, page)
      .then((r) => {
        if (live) {
          setPaths((old) => (page ? [...old.slice(0, page * 100), ...r.paths] : r.paths));
          setTotal(r.total);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [taskId, row.host, open, page, revision, retry]);
  return (
    <Collapsible
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setPage(0);
      }}
    >
      <div className={cn("network-host", selected && !path && "is-selected")}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"} ${row.host}`}>
            <ChevronRight className={cn(open && "rotate-90")} />
          </Button>
        </CollapsibleTrigger>
        <Button variant="ghost" onClick={() => onSelect("")} aria-pressed={selected && !path}>
          <Globe data-icon="inline-start" />
          <span className="truncate">{row.host}</span>
          <span className="network-count">{row.count}</span>
        </Button>
      </div>
      <CollapsibleContent className="network-paths">
        {error ? (
          <WorkspaceError error={error} onRetry={retryPaths} />
        ) : (
          paths.map((p) => (
            <Button
              key={p.path}
              variant={selected && path === p.path ? "secondary" : "ghost"}
              title={p.path}
              aria-pressed={selected && path === p.path}
              onClick={() => onSelect(p.path)}
            >
              <span className="truncate">{p.path}</span>
              <span className="network-count">{p.count}</span>
            </Button>
          ))
        )}
        {loading && (
          <span className="text-muted-foreground text-xs" role="status">
            正在读取路径…
          </span>
        )}
        {!error && paths.length < total && (
          <Button variant="ghost" disabled={loading} onClick={() => setPage((p) => p + 1)}>
            更多路径…
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
export function TrafficTab({ taskId }: { taskId: string }) {
  return <TaskNetwork key={taskId} taskId={taskId} />;
}
function TaskNetwork({ taskId }: { taskId: string }) {
  const [hosts, setHosts] = React.useState<TrafficHost[] | null>(null),
    [hostError, setHostError] = React.useState("");
  const [host, setHost] = React.useState(""),
    [path, setPath] = React.useState("");
  const [data, setData] = React.useState<TrafficResp | null>(null),
    [error, setError] = React.useState("");
  const [q, setQ] = React.useState(""),
    [bodyQuery, setBodyQuery] = React.useState(""),
    [method, setMethod] = React.useState(""),
    [status, setStatus] = React.useState(""),
    [statusClass, setStatusClass] = React.useState(""),
    [advanced, setAdvanced] = React.useState(false);
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(50),
    [revision, refresh] = React.useReducer((n) => n + 1, 0),
    [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<TrafficExchange | null>(null),
    [detail, setDetail] = React.useState<TrafficDetail | null>(null),
    [detailError, setDetailError] = React.useState("");
  const [bodies, setBodies] = React.useState<Partial<Record<Side, EvidenceText>>>({}),
    [reading, setReading] = React.useState<Partial<Record<Side, boolean>>>({}),
    [bodyErrors, setBodyErrors] = React.useState<Partial<Record<Side, string>>>({});
  const selectedRef = React.useRef<string | null>(null),
    epoch = React.useRef(0),
    tokens = React.useRef({ request: 0, response: 0 });
  React.useEffect(() => {
    let live = true;
    void api
      .trafficHosts(taskId)
      .then((r) => {
        if (live) {
          setHosts(r.hosts);
          setHostError("");
        }
      })
      .catch((e) => {
        if (live) setHostError(e.message);
      });
    return () => {
      live = false;
    };
  }, [taskId, revision]);
  React.useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .taskTraffic(taskId, {
          page: String(page - 1),
          size: String(size),
          q,
          body: bodyQuery,
          ...(host ? { host } : {}),
          ...(path ? { path_exact: path } : {}),
          ...(method ? { method } : {}),
          ...(status ? { status } : {}),
          ...(statusClass ? { status_class: statusClass } : {}),
        })
        .then((r) => {
          if (live) {
            setData(r);
            setError("");
          }
        })
        .catch((e) => {
          if (live) {
            setData(null);
            setError(e.message);
          }
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [taskId, page, size, q, bodyQuery, host, path, method, status, statusClass, revision]);
  React.useEffect(
    () => () => {
      epoch.current++;
      selectedRef.current = null;
    },
    [],
  );
  async function read(row: TrafficExchange, which: Side, offset = 0) {
    const token = ++tokens.current[which],
      run = epoch.current;
    setReading((v) => ({ ...v, [which]: true }));
    try {
      const result = await api.trafficBody(taskId, row.id, which, offset);
      if (selectedRef.current !== row.id || epoch.current !== run || tokens.current[which] !== token) return;
      setBodies((v) => ({ ...v, [which]: appendEvidencePage(offset ? v[which] : undefined, result) }));
      setBodyErrors((v) => ({ ...v, [which]: "" }));
    } catch (e) {
      if (epoch.current === run && tokens.current[which] === token)
        setBodyErrors((v) => ({ ...v, [which]: (e as Error).message }));
    } finally {
      if (epoch.current === run && tokens.current[which] === token) setReading((v) => ({ ...v, [which]: false }));
    }
  }
  function close() {
    epoch.current++;
    selectedRef.current = null;
    setSelected(null);
  }
  function select(row: TrafficExchange) {
    const run = ++epoch.current;
    selectedRef.current = row.id;
    setSelected(row);
    setDetail(null);
    setBodies({});
    setBodyErrors({});
    setDetailError("");
    void api
      .trafficExchange(row.id, taskId)
      .then((r) => {
        if (epoch.current === run) setDetail(r);
      })
      .catch((e) => {
        if (epoch.current === run) setDetailError(e.message);
      });
    void read(row, "request");
    void read(row, "response");
  }
  function filter(fn: () => void) {
    fn();
    setPage(1);
    close();
  }
  const total = hosts?.reduce((n, h) => n + h.count, 0);
  return (
    <div className="network-workspace">
      <aside className="network-tree" aria-label="流量主机与路径">
        <div className="network-tree-title">
          <Network className="size-4" />
          <span>网络流量</span>
          <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="刷新流量">
            <RefreshCw />
          </Button>
        </div>
        <Button
          className="network-all"
          variant={!host ? "secondary" : "ghost"}
          aria-pressed={!host}
          onClick={() =>
            filter(() => {
              setHost("");
              setPath("");
            })
          }
        >
          全部请求<span className="network-count">{total ?? "…"}</span>
        </Button>
        {hostError ? (
          <WorkspaceError error={hostError} onRetry={refresh} />
        ) : hosts === null ? (
          <div className="p-4">
            <Spinner />
          </div>
        ) : (
          hosts.map((row) => (
            <HostBranch
              key={row.host}
              taskId={taskId}
              row={row}
              selected={host === row.host}
              path={path}
              revision={revision}
              onSelect={(next) =>
                filter(() => {
                  setHost(row.host);
                  setPath(next);
                })
              }
            />
          ))
        )}
        {hosts?.length === 0 && <p className="p-4 text-xs text-muted-foreground">暂无录制主机</p>}
      </aside>
      <div className="network-main">
        <header className="network-toolbar">
          <div className="network-scope">
            <span className="truncate" title={host + path}>
              {host || "全部请求"}
              {path}
            </span>
            <span className="text-xs text-muted-foreground">
              {data && !loading ? `${data.total ?? 0} 条请求` : "加载中…"}
            </span>
          </div>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="搜索流量 URL"
              placeholder="筛选 URL 或路径…"
              value={q}
              onChange={(e) => filter(() => setQ(e.target.value))}
            />
          </InputGroup>
          <div className="network-filters">
            <ToggleGroup
              type="single"
              size="sm"
              value={method}
              onValueChange={(v) => filter(() => setMethod(v))}
              aria-label="HTTP 方法"
            >
              {methods.map((m) => (
                <ToggleGroupItem key={m} value={m}>
                  {m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              type="single"
              size="sm"
              value={statusClass}
              onValueChange={(v) =>
                filter(() => {
                  setStatusClass(v);
                  setStatus("");
                })
              }
              aria-label="状态码分组"
            >
              {["2", "3", "4", "5"].map((v) => (
                <ToggleGroupItem key={v} value={v}>
                  {v}xx
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button
              variant={advanced ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="更多流量筛选"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
            >
              <Filter />
            </Button>
          </div>
          {advanced && (
            <div className="flex flex-wrap gap-2">
              <Input
                className="w-28"
                aria-label="精确状态码"
                placeholder="状态码"
                value={status}
                onChange={(e) =>
                  filter(() => {
                    setStatus(e.target.value);
                    setStatusClass("");
                  })
                }
              />
              <Input
                className="min-w-40 flex-1"
                aria-label="搜索响应正文"
                placeholder="搜索响应正文"
                value={bodyQuery}
                onChange={(e) => filter(() => setBodyQuery(e.target.value))}
              />
            </div>
          )}
        </header>
        <div className={cn("network-requests", selected && "has-detail")} aria-busy={loading}>
          {error && <WorkspaceError error={error} onRetry={refresh} />}
          <Table className="network-table" aria-label="已录制请求">
            <colgroup>
              <col className="w-10" />
              <col className="w-16" />
              <col />
              <col className="w-14" />
              <col className="w-14" />
              <col className="w-14" />
            </colgroup>
            <TableHeader>
              <TableRow className="network-column-head">
                {["#", "方法", "URL", "状态", "大小", "时间"].map((t) => (
                  <TableHead key={t}>{t}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.exchanges?.map((row, i) => (
                <TableRow
                  key={row.id}
                  className="network-row"
                  data-state={selected?.id === row.id ? "selected" : undefined}
                  onClick={() => select(row)}
                >
                  <TableCell className="network-count">{(page - 1) * size + i + 1}</TableCell>
                  <TableCell>
                    <Method value={row.method} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      className="network-url"
                      title={row.url}
                      aria-label={`查看请求 ${row.method} ${row.url}`}
                      aria-pressed={selected?.id === row.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(row);
                      }}
                    >
                      <span className="truncate font-mono">{row.url.replace(/^https?:\/\//, "")}</span>
                    </Button>
                  </TableCell>
                  <TableCell className="network-status" data-class={Math.floor(row.status / 100)}>
                    {row.status || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{(row.resp_len / 1024).toFixed(1)}k</TableCell>
                  <TableCell className="text-muted-foreground" title={new Date(row.ts).toLocaleString()}>
                    {new Date(row.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!data?.exchanges?.length && !error && (
            <WorkspaceEmpty
              title={loading ? "正在加载请求…" : "没有匹配的请求"}
              description="这里只显示实际录制的流量。"
            />
          )}
        </div>
        {data && (
          <div className="network-pagination">
            <TablePagination
              page={page}
              pageSize={size}
              total={data.total ?? 0}
              onPageChange={(p) => {
                setPage(p);
                close();
              }}
              onPageSizeChange={(v) => filter(() => setSize(v))}
            />
          </div>
        )}
        {selected && (
          <section className="network-detail" aria-label="请求详情">
            <header className="network-detail-heading">
              <Method value={selected.method} />
              <span className="network-status" data-class={Math.floor(selected.status / 100)}>
                {selected.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono" title={selected.url}>
                {selected.url}
              </span>
              <Button variant="ghost" size="icon-sm" aria-label="关闭请求详情" onClick={close}>
                <X />
              </Button>
            </header>
            {detailError && <WorkspaceError error={detailError} onRetry={() => select(selected)} />}
            <div className="network-payloads">
              {(["request", "response"] as const).map((which) => (
                <article className="network-payload" key={which}>
                  <header>
                    <span>{which === "request" ? "请求" : "响应"}</span>
                    <span className="network-count">{bodies[which] ? `${bodies[which]!.page.total} B` : "…"}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`复制${which === "request" ? "请求" : "响应"}已加载内容`}
                      disabled={!detail || !bodies[which]}
                      onClick={() => {
                        const head = (which === "request" ? detail?.req : detail?.resp)?.split("\r\n\r\n")[0] ?? "";
                        void navigator.clipboard.writeText(head + "\r\n\r\n" + (bodies[which]?.text ?? "")).then(
                          () => toast.success("已复制已加载内容"),
                          () => toast.error("复制失败"),
                        );
                      }}
                    >
                      <Copy />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`下载${which === "request" ? "请求" : "响应"}原始正文`}
                      onClick={() =>
                        void api.downloadTrafficBody(taskId, selected.id, which).catch((e) => toast.error(e.message))
                      }
                    >
                      <Download />
                    </Button>
                  </header>
                  {bodyErrors[which] && (
                    <WorkspaceError error={bodyErrors[which]!} onRetry={() => void read(selected, which)} />
                  )}
                  <pre>
                    {(which === "request" ? detail?.req : detail?.resp)?.split("\r\n\r\n")[0] ?? "正在读取头部…"}
                    {"\n\n"}
                    {bodies[which]?.text ?? (reading[which] ? "正在读取正文…" : "")}
                  </pre>
                  {bodies[which]?.page.truncated && (
                    <Button
                      variant="outline"
                      disabled={reading[which]}
                      onClick={() => void read(selected, which, bodies[which]!.page.next_offset)}
                    >
                      继续读取（{bodies[which]!.page.next_offset} / {bodies[which]!.page.total} 字节）
                    </Button>
                  )}
                </article>
              ))}
            </div>
            <footer className="network-detail-footer">
              {selected.intent_id && <span>意图 #{selected.intent_id}</span>}
              <Button asChild variant="link" size="sm">
                <Link href={`/function/tasks/detail?id=${taskId}&tab=findings`}>在发现详情中绑定证据</Link>
              </Button>
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}
