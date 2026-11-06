"use client";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { TaskConstraintSource } from "@/lib/types";

export function ConstraintSource({ source }: { source?: TaskConstraintSource }) {
  const quote = source?.context_quote || source?.quote;
  if (!quote) return <span className="text-xs text-muted-foreground">来源未记录</span>;
  const label = source?.field === "goal" ? "目标栏原文" : source?.field === "description" ? "描述原文" : source?.field === "user_message" ? "用户消息原文" : "原文来源";
  return (
    <Collapsible>
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm">查看{label}</Button></CollapsibleTrigger>
      <CollapsibleContent className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {quote}
      </CollapsibleContent>
    </Collapsible>
  );
}
