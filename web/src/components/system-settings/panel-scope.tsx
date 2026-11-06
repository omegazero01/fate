"use client";
import { createContext, useContext, useState, type ComponentProps } from "react";
import { Dialog } from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Sheet } from "@/components/ui/sheet";
export const SettingsPanelActive = createContext(true);
export const useSettingsPanelActive = () => useContext(SettingsPanelActive);
// Retain editor state across tab changes, but hide its portal and focus trap.
export function SettingsPanelDialog(props: ComponentProps<typeof Dialog>) {
  const active = useSettingsPanelActive();
  return (
    <Dialog
      {...props}
      open={active && props.open}
      onOpenChange={(open) => {
        if (active) props.onOpenChange?.(open);
      }}
    />
  );
}
export function SettingsPanelSheet(props: ComponentProps<typeof Sheet>) {
  const active = useSettingsPanelActive();
  return (
    <Sheet
      {...props}
      open={active && props.open}
      onOpenChange={(open) => {
        if (active) props.onOpenChange?.(open);
      }}
    />
  );
}

export function SettingsPanelAlertDialog(props: ComponentProps<typeof AlertDialog>) {
  const active = useSettingsPanelActive();
  const [localOpen, setLocalOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? localOpen;
  return (
    <AlertDialog
      {...props}
      open={active && open}
      onOpenChange={(value) => {
        if (!active) return;
        setLocalOpen(value);
        props.onOpenChange?.(value);
      }}
    />
  );
}
