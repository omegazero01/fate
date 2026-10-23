import {openDatabase} from '../src/db/index.js';
import {runGoalsDecompose} from '../src/agent/roles.js';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
const db=await openDatabase(),task=(await db.tasks().getTask(Number(process.argv[2])))!;
const faux=fauxProvider({provider:'crash-child'}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'deny',text:'禁止写入生产数据；仅本地合成资料。'}]})]),async()=>{process.send?.({checkpoint:true});await new Promise(()=>{});return fauxAssistantMessage('unreachable');}]);
await runGoalsDecompose({db,taskID:task.id,expID:task.exploration_id,description:task.description,model:{modelRuntime,model:faux.getModel() as never},dataDir:process.argv[3]!});
