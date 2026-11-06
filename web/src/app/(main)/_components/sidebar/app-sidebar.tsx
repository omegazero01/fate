"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import * as React from "react";
import {CirclePlusIcon} from "lucide-react";
import {ThemeSwitcher} from "./theme-switcher";
import {LayoutControls} from "./layout-controls";

import { useShallow } from "zustand/react/shallow";

import {
  Sidebar,
  useSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
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
      <SidebarContent className="app-sidebar-content">
        <SidebarGroup>
          <SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild tooltip="新建任务"><Link href="/function/tasks/new" onClick={()=>setOpenMobile(false)}><CirclePlusIcon/><span>新建任务</span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        </SidebarGroup>
        <NavMain items={sidebarItems} />
      </SidebarContent>
      <SidebarFooter className="shrink-0 flex-row items-center gap-2 border-t p-3 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:p-1"><ThemeSwitcher/><LayoutControls/></SidebarFooter>
    </Sidebar>
  );
}
