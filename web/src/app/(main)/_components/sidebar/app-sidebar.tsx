"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import * as React from "react";
import {CirclePlusIcon} from "lucide-react";
import {RecentTasks} from "./recent-tasks";
import {ThemeSwitcher} from "./theme-switcher";
import {LayoutControls} from "./layout-controls";

import { useShallow } from "zustand/react/shallow";

import {
  Sidebar,
  useSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarTrigger,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { NavMain } from "./nav-main";


export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname=usePathname();
  const {setOpenMobile}=useSidebar();
  React.useEffect(()=>setOpenMobile(false),[pathname,setOpenMobile]);
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.sidebarVariant,
      sidebarCollapsible: s.sidebarCollapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  return (
    <Sidebar {...props} variant={variant} collapsible={collapsible}>
      <SidebarHeader className="app-sidebar-header">
        <Link prefetch={false} href="/function/tasks" className="app-sidebar-brand" aria-label={`${APP_CONFIG.name} · 任务首页`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/series-icon.svg" alt="" width={24} height={24} />
          <span>{APP_CONFIG.name}</span>
        </Link>
        <SidebarTrigger className="app-sidebar-toggle" aria-label="收起侧栏" title="收起侧栏（⌘B / Ctrl+B）" />
      </SidebarHeader>
      <SidebarContent className="app-sidebar-content">
        <SidebarGroup>
          <SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild tooltip="新建任务"><Link href="/function/tasks?create=1" onClick={event=>{setOpenMobile(false);if(pathname.replace(/\/$/,'')==='/function/tasks'){event.preventDefault();window.dispatchEvent(new Event("series:create-task"));}}}><CirclePlusIcon/><span>新建任务</span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        </SidebarGroup>
        <NavMain items={sidebarItems} />
        <React.Suspense><RecentTasks/></React.Suspense>
        {/* <NavSecondary items={data.navSecondary} className="mt-auto" /> */}
      </SidebarContent>
      <SidebarFooter className="shrink-0 flex-row items-center gap-2 border-t p-3 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:p-1"><ThemeSwitcher/><LayoutControls/></SidebarFooter>
    </Sidebar>
  );
}
