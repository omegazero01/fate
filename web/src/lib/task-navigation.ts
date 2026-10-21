export type TaskView = "sessions" | "findings" | "graph" | "files" | "traffic";
export function taskNavigation(params: Pick<URLSearchParams, "get">) {
  const tab = params.get("tab") || "sessions";
  const explore = tab === "coverage" || tab === "assets" ? tab : params.get("explore") || "graph";
  const legacyPanel = ["overview", "broadcast"].includes(tab) ? tab : null;
  const requestedPanel = legacyPanel || params.get("panel");
  const detailPanel = requestedPanel === "overview" || requestedPanel === "broadcast";
  const section = detailPanel ? requestedPanel : params.get("section") || "chat";
  const view: TaskView =
    tab === "retests"
      ? "findings"
      : ["graph", "coverage", "assets"].includes(tab)
        ? "graph"
        : ["sessions", "findings", "files", "traffic"].includes(tab)
          ? (tab as TaskView)
          : "sessions";
  return {
    view: detailPanel ? "sessions" as const : view,
    section: ["chat", "overview", "broadcast"].includes(section) ? section : "chat",
    explore: ["graph", "coverage", "assets"].includes(explore) ? explore : "graph",
    panel: requestedPanel === "settings" ? "settings" : null,
  };
}
export function taskViewURL(search: string, patch: Record<string, string | null>) {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(patch)) v === null ? p.delete(k) : p.set(k, v);
  return `/function/tasks/detail?${p}`;
}
