import {EventEmitter} from 'node:events';
/** Best-effort local latency hint; durable cursors remain the cross-process authority. */
export const streamChanges=new EventEmitter();
streamChanges.setMaxListeners(0);
