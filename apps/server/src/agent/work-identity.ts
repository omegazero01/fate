import {createHash} from 'node:crypto';
import type {IntentContract} from './intent-contract.js';
import {stableJSON} from '../db/operation-journal.js';

export interface WorkAsset {id:number;type:string;url?:string|null;method?:string|null;params?:unknown[];domain?:string|null;ip?:string|null;port?:number|null;}
export interface WorkKey {version:3;key:string;family:string;resource:string;targets:string[];strength:'structured'|'legacy_text';}
const digest=(v:unknown)=>createHash('sha256').update(stableJSON(v)).digest('hex');
export function canonicalWorkResource(value:string){
  const raw=value.trim();
  try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?u.href:raw;}catch{return raw;}
}
/** Fold prose only: URL paths, parameters, fragments and credentials remain case-sensitive. */
export function directionIdentity(summary:string){
  return summary.trim().split(/(https?:\/\/[^\s<>"，。；]+)/gi).map((part,i)=>
    i%2?canonicalWorkResource(part):part.toLowerCase().replace(/\s+/g,' ')).join('');
}
const category=(s:string)=>s.trim().toLowerCase().replace(/\s+/g,' ');
function assetKey(a:WorkAsset){
  // Never use DNS resolution to merge a hostname with an IP: virtual hosts may differ.
  // Parameters/fingerprints are discoveries, not new directions in the dispatch queue.
  if(a.url)return stableJSON([a.type,canonicalWorkResource(a.url),(a.method??'').toUpperCase()]);
  return stableJSON([a.type,a.domain?.toLowerCase()??'',a.ip??'',a.port??null,a.id]);
}
export function workIdentity(contract:IntentContract,summary:string,anchors:number[],assets:ReadonlyMap<number,WorkAsset>):WorkKey{
  const targets=[...new Set(anchors.map(id=>assets.has(id)?assetKey(assets.get(id)!):`asset:${id}`))].sort();
  let resource=contract.work?.resource.trim()??'';
  const assetRef=/^asset:([1-9][0-9]*)$/.exec(resource),asset=assetRef?assets.get(Number(assetRef[1])):undefined;
  if(asset?.url)resource=asset.url;
  resource=canonicalWorkResource(resource);
  const family=contract.work?[category(contract.work.question_key),category(contract.work.method_class),contract.work.identity.trim()]:[directionIdentity(summary)];
  return {version:3,key:digest([resource,digest(family),targets]),family:digest(family),resource,targets,
    strength:contract.work?'structured':'legacy_text'};
}
/** Use the dispatch-time snapshot, including older host-produced snapshots.
 * Later discoveries add graph anchors but never broaden the original assignment. */
export function storedWorkIdentity(value:unknown):WorkKey|undefined {
  const v=value as WorkKey|undefined;
  if(!v||![2,3].includes(v.version)||typeof v.family!=='string'||typeof v.resource!=='string'||
    !Array.isArray(v.targets)||v.targets.some(t=>typeof t!=='string')||!['structured','legacy_text'].includes(v.strength))return;
  const targets=[...new Set(v.targets.map(t=>{
    try{const p=JSON.parse(t);if(Array.isArray(p)&&p.length===4&&typeof p[1]==='string'&&/^https?:/.test(p[1]))return stableJSON(p.slice(0,3));}catch{/* Opaque historical asset key. */}
    return t;
  }))].sort();
  return {...v,version:3,targets,key:digest([v.resource,v.family,targets])};
}
export function overlappingWork(a:WorkKey,b:WorkKey){
  return a.strength==='structured'&&b.strength==='structured'&&a.family===b.family&&a.resource===b.resource&&a.key!==b.key&&a.targets.some(t=>b.targets.includes(t));
}
