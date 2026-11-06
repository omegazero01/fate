import {incrementalColdGraph} from "./coldgraph-incremental.js";

export interface ColdNode { id: number; kind: string; state: string; coldSince: number | null; }
export interface ColdEdge { from: number; to: number; }
/** Original ARTEX semantics: live intents, all their ancestors and immediate children stay hot. */
export function coldBlocks(nodes: ColdNode[], edges: ColdEdge[], round: number, age = 6): { cold: Set<number>; blocks: number[][] } {
  const byID = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map<number, number[]>(), children = new Map<number, number[]>();
  for (const e of edges) {
    if (!byID.has(e.from) || !byID.has(e.to)) continue;
    if(!parents.has(e.to))parents.set(e.to,[]);
    if(!children.has(e.from))children.set(e.from,[]);
    parents.get(e.to)!.push(e.from);children.get(e.from)!.push(e.to);
  }
  const live = nodes.filter((n) => n.kind === "intent" && ["open", "running", "paused"].includes(n.state));
  const hot = new Set<number>(), stack = live.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (hot.has(id)) continue;
    hot.add(id);for(const parent of parents.get(id)??[])stack.push(parent);
  }
  for (const n of live) for (const id of children.get(n.id) ?? []) hot.add(id);
  const cold = new Set(nodes.filter((n) => ["intent", "fact"].includes(n.kind) && n.state !== "origin" && !hot.has(n.id)).map((n) => n.id));
  const eligible = new Set(nodes.filter((n) => cold.has(n.id) && n.coldSince !== null && round - n.coldSince >= age).map((n) => n.id));
  const components: number[][] = [], visited = new Set<number>();
  for (const id of eligible) {
    if (visited.has(id)) continue;
    const group: number[] = [], todo = [id];
    while (todo.length) {
      const next = todo.pop()!;
      if (visited.has(next) || !eligible.has(next)) continue;
      visited.add(next); group.push(next);
      for(const related of [parents.get(next),children.get(next)])for(const id of related??[])todo.push(id);
    }
    components.push(group);
  }
  // Only rescue singleton siblings. A hot shared parent is never folded into the block.
  const singles = components.filter((g) => g.length === 1).flat();
  const roots = new Map(singles.map((id) => [id, id]));
  const root = (id: number): number => { while (roots.get(id) !== id) id = roots.get(id)!; return id; };
  const siblings = new Map<number, number>();
  for (const id of singles) for (const parent of parents.get(id) ?? []) {
    const sibling = siblings.get(parent);
    if (sibling !== undefined) roots.set(root(id), root(sibling)); else siblings.set(parent, id);
  }
  const rescued = new Map<number, number[]>();
  for (const id of singles) {const key=root(id);if(!rescued.has(key))rescued.set(key,[]);rescued.get(key)!.push(id);}
  return { cold, blocks: [...components.filter((g) => g.length > 1), ...rescued.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b)) };
}

export interface ColdGraphResult {
  status:'unchanged'|'updated'|'busy'|'stale';pending:boolean;scanned_nodes:number;changed_nodes:number;created_digests:number;
  classified_nodes?:number;regrouped_nodes?:number;scanned_edges?:number;
  retry_reason?:'lock'|'timeout'|'deadlock';
}
/** Derived maintenance is incremental; original graph semantics remain in
 * coldBlocks as the differential oracle for fixtures and compatibility tests. */
export const compactColdGraph=incrementalColdGraph;
