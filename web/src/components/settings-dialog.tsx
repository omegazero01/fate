"use client";
import { useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { XIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
export type SettingsSection = { key: string; label: string; icon: LucideIcon };
export function SettingsPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsContent value={value} forceMount className={`settings-panel ${className ?? ""}`}>
      {children}
    </TabsContent>
  );
}
export function SettingsDialog({
  open,
  onOpenChange,
  title,
  description,
  sections,
  section,
  onSectionChange,
  children,
  footer,
  links,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  sections: SettingsSection[];
  section: string;
  onSectionChange: (value: string) => void;
  children: ReactNode;
  footer?: ReactNode;
  links?: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const mobile = useIsMobile();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="settings-dialog"
        showCloseButton={false}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <Tabs
          value={section}
          onValueChange={onSectionChange}
          orientation={mobile ? "horizontal" : "vertical"}
          className="settings-layout"
        >
          <aside className="settings-sidebar">
            <p className="settings-kicker">{title}</p>
            <TabsList className="settings-nav" aria-label={title}>
              {sections.map(({ key, label, icon: Icon }) => (
                <TabsTrigger key={key} value={key}>
                  <Icon aria-hidden="true" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            {links && <div className="settings-links">{links}</div>}
          </aside>
          <div className="settings-main">
            <header className="settings-heading">
              <div>
                <DialogTitle>{sections.find((s) => s.key === section)?.label ?? title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </div>
              <DialogClose asChild>
                <Button variant="ghost" size="icon" aria-label="关闭设置">
                  <XIcon />
                </Button>
              </DialogClose>
            </header>
            <div className="settings-body">{children}</div>
            {footer && <footer className="settings-footer">{footer}</footer>}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
