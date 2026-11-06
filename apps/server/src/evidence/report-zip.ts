import {crc32} from 'node:zlib';
/** ZIP store format; bounded, UTF-8 paths, no external command or temporary files. */
export function reportZip(files:Array<{name:string;bytes:Buffer}>):Buffer{
 if(files.length>65535||files.reduce((n,f)=>n+f.bytes.length,0)>128*1024*1024)throw Object.assign(new Error('报告包过大，请缩小导出范围'),{statusCode:413});
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),size=file.bytes.length,crc=crc32(file.bytes),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(size,18);h.writeUInt32LE(size,22);h.writeUInt16LE(name.length,26);
 const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(size,20);c.writeUInt32LE(size,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
 local.push(h,name,file.bytes);central.push(c,name);offset+=h.length+name.length+size;}
 const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,dir,end]);
}
