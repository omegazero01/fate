/** Build-artifact packaging only: no database access, executor start or deploy.
 * Preserve the workspace dependency layout, but relocate every symlink so a
 * release never imports a mutable dependency from the development checkout. */
import assert from 'node:assert/strict';
import {constants,createReadStream} from 'node:fs';
import {cp,lstat,mkdir,readdir,realpath,symlink,unlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export type Mapping={from:string;to:string};
const inside=(parent:string,file:string)=>{const rel=path.relative(parent,file);return rel===''||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
const relative=(file:string)=>{assert(file&&file!=='.'&&!path.isAbsolute(file)&&!file.split(path.sep).includes('..'),`Expected relative artifact path: ${file}`);return file;};
async function* entries(root:string):AsyncGenerator<string>{
 for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const file=path.join(root,entry.name);if(entry.isDirectory())yield* entries(file);else yield file;
 }
}
async function fileHash(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

export async function copyIndependentTree(sourceRoot:string,destination:string,mappings:Mapping[]){
 const source=await realpath(sourceRoot);
 await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
 const target=path.join(await realpath(path.dirname(destination)),path.basename(destination));
 assert(!inside(source,target)&&!inside(target,source),'Release directory must be outside the source checkout');
 const resolved=mappings.map(m=>({from:path.join(source,relative(m.from)),to:path.join(target,relative(m.to))}));
 for(let i=0;i<resolved.length;i++)for(let j=i+1;j<resolved.length;j++)
  assert(!inside(resolved[i]!.to,resolved[j]!.to)&&!inside(resolved[j]!.to,resolved[i]!.to),'Artifact destination mappings overlap');
 // mkdir without recursive rejects an existing release instead of overwriting it.
 await mkdir(target,{mode:0o700});
 for(const m of resolved){await mkdir(path.dirname(m.to),{recursive:true});
  await cp(m.from,m.to,{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});}
 let links=0;
 for await(const file of entries(target))if((await lstat(file)).isSymbolicLink()){
  const mapping=resolved.find(m=>inside(m.to,file));assert(mapping);
  const original=path.join(mapping.from,path.relative(mapping.to,file));
  const dependency=await realpath(original);
  assert(inside(source,dependency),`External dependency is not packaged: ${path.relative(source,original)}`);
  const dependencyMapping=resolved.find(m=>inside(m.from,dependency));
  // Workspace links target the package directory, while releases copy its
  // manifest and compiled output separately. An explicitly copied manifest
  // identifies that package's release root without copying source or data.
  const packageMapping=resolved.find(m=>m.from===path.join(dependency,'package.json'));
  assert(dependencyMapping||packageMapping,`Dependency outside copied artifacts: ${path.relative(source,dependency)}`);
  const relocated=dependencyMapping
   ?path.join(dependencyMapping.to,path.relative(dependencyMapping.from,dependency))
   :path.dirname(packageMapping!.to);
  await unlink(file);await symlink(path.relative(path.dirname(file),relocated),file);links++;
 }
 const treeHash=createHash('sha256');let files=0,bytes=0;
 for await(const file of entries(target)){
  const stat=await lstat(file),name=path.relative(target,file);
  if(stat.isSymbolicLink()){
   const dependency=await realpath(file);assert(inside(target,dependency),`Unresolved external release link: ${name}`);
   treeHash.update(JSON.stringify([name,'link',path.relative(target,dependency)])+'\n');
  }else{assert(stat.isFile(),`Unsupported artifact: ${name}`);files++;bytes+=stat.size;treeHash.update(JSON.stringify([name,stat.size,await fileHash(file)])+'\n');}
 }
 return {target,files,bytes,links,tree_sha256:treeHash.digest('hex')};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [destination,backend='dist-long-chain-stage',frontend='.next-long-chain-stage']=process.argv.slice(2);
 assert(destination,'Usage: long-chain-stage-release.mts ABSOLUTE_DESTINATION [BACKEND_BUILD] [FRONTEND_BUILD]');
 assert(path.isAbsolute(destination),'Release destination must be absolute');relative(backend);relative(frontend);
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 for(const file of [`apps/server/${backend}/index.js`,`apps/server/${backend}/db/sql/schema.sql`,`web/${frontend}/BUILD_ID`])assert((await lstat(path.join(root,file))).isFile(),`Missing verified build: ${file}`);
 const mappings:Mapping[]=[
  {from:'node_modules',to:'node_modules'},
  {from:'apps/server/node_modules',to:'apps/server/node_modules'},
  {from:`apps/server/${backend}`,to:'apps/server/dist'},
  {from:'apps/server/package.json',to:'apps/server/package.json'},
  {from:'web/node_modules',to:'web/node_modules'},
  {from:`web/${frontend}`,to:`web/${frontend}`},
  ...['web/public','web/package.json','web/package-lock.json','web/next.config.mjs','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','patches'].map(file=>({from:file,to:file})),
 ];
 const audit=await copyIndependentTree(root,destination,mappings);
 const manifest={at:new Date().toISOString(),status:'staged_not_deployed',...audit,backend:'apps/server/dist/index.js',frontend_dist:frontend,
  limits:'Original data, config and authentication keys are not copied by this artifact packager. Runtime smoke, migration rehearsal and controlled switch remain separate gates.'};
 await writeFile(path.join(destination,'artifact-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(manifest));
}
