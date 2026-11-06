"use client";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { systemSettingsURL, type SystemSettingKey } from "@/lib/system-settings";
function Redirect({ section, agentDetail }: { section: SystemSettingKey; agentDetail?: boolean }) {
  const router = useRouter(),
    params = useSearchParams();
  const key = agentDetail ? (params.get("key") ?? undefined) : undefined;
  useEffect(() => router.replace(systemSettingsURL("/function/tasks", section, key)), [router, section, key]);
  return <p role="status">正在打开系统设置…</p>;
}
export function LegacySystemSettings(props: { section: SystemSettingKey; agentDetail?: boolean }) {
  return (
    <Suspense fallback={null}>
      <Redirect {...props} />
    </Suspense>
  );
}
