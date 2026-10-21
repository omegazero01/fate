import {
  Bot,
  Brain,
  Bug,
  ClipboardList,
  FolderOpen,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Network,
  Plug,
  ScrollText,
  Settings2,
  ShieldAlert,
  Sparkles,
  Target,
  Terminal,
  Wrench,
} from "lucide-react";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    items: [
      { id: "tasks", title: "任务", url: "/function/tasks", icon: Target },
      { id: "findings", title: "发现", url: "/function/findings", icon: Bug },
      { id: "assets", title: "资产", url: "/function/assets", icon: Network },
      { id: "dashboard", title: "仪表盘", url: "/dashboard", icon: LayoutDashboard },
      { id: "chat", title: "独立会话", url: "/chat", icon: MessageSquare },
    ],
  },
  {
    id: 2,
    items: [
      {
        id: "system",
        title: "系统管理",
        icon: Settings2,
        subItems: [
          { id: "llm", title: "LLM", url: "/system/llm", icon: Brain },
          { id: "agents", title: "Agent", url: "/system/agents", icon: Bot },
          { id: "mcp", title: "MCP", url: "/system/mcp", icon: Plug },
          { id: "skills", title: "Skill", url: "/system/skills", icon: Sparkles },
          { id: "tools", title: "工具", url: "/system/tools", icon: Wrench },
          { id: "logs", title: "日志", url: "/system/logs", icon: ScrollText },
          { id: "settings", title: "系统配置", url: "/system/settings", icon: Settings2 },
        ],
      },
    ],
  },
];
