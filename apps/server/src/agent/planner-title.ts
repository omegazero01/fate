/** Display-only convention, never evidence of dispatch or goal completion. */
export const PLANNER_TITLE_PROTOCOL = '展示约定：本轮最终总结首行输出 <planning_title>整体规划方向</planning_title>，随后正常总结。标题建议 8–24 字，最多 40 字，单行纯文本，概括本轮整体方向，不罗列接口、编号或执行步骤；没有派单也可概括等待、复核或收官方向。该字段仅作界面标题，不证明工作已下发或完成。';

export function plannerTitle(text: string | undefined): string | null {
  if (!text) return null;
  const lines = text.trim().split(/\r?\n/);
  const match = /^<planning_title>([^<>\r\n]+)<\/planning_title>$/.exec(lines[0]!);
  if (!match || (text.match(/<planning_title>/g)?.length ?? 0) !== 1) return null;
  const title = match[1]!.trim();
  return title && Array.from(title).length <= 40 && !/[\x00-\x1f\x7f]/.test(title) ? title : null;
}
