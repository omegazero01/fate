"use client";
import {useVisiblePoll} from "@/hooks/use-visible-poll";
import * as React from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
export function RecentTasks() {
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const params = useSearchParams();
  const pathname = usePathname();
  const read=React.useCallback(async(signal:AbortSignal)=>{const r=await api.tasks({page:1,page_size:8,recent:true,sort:'created'});if(!signal.aborted)setTasks(r.tasks);},[pathname]);
  useVisiblePoll(read,30000);
  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>最近任务</SidebarGroupLabel>
      <SidebarMenu>
        {tasks.map((t) => (
          <SidebarMenuItem key={t.id}>
            <SidebarMenuButton
              asChild
              isActive={pathname.includes("/tasks/detail") && params.get("id") === String(t.id)}
              tooltip={t.name || t.description}
            >
              <Link href={`/function/tasks/detail?id=${t.id}`}>
                <MessageSquare />
                <span>{t.name || t.description || `任务 #${t.id}`}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
