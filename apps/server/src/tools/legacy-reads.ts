import {nodeDetailTool,searchWorkerTracesTool,getWorkerTraceTool} from './graph.js';
import {graphIndexTool,expandDigestTool} from './graph_read.js';
import type {ToolRunContext} from './context.js';

/** Candidates only. Registration requires an old session/explicit reference and a live binding. */
export function legacyReadCandidates(ctx:ToolRunContext) {
 return [nodeDetailTool(ctx),searchWorkerTracesTool(ctx),getWorkerTraceTool(ctx),
  graphIndexTool(ctx),graphIndexTool(ctx,'list_facts'),expandDigestTool(ctx)];
}
