/** Count Unicode code points without allocating one array entry per character.
 * Optional bounds are UTF-16 offsets at character boundaries. Lone surrogates
 * retain the same one-character semantics as Array.from(string). */
export function unicodeLength(value:string,start=0,end=value.length){
 let count=0;
 for(let i=start;i<end;i++,count++){
  const high=value.charCodeAt(i);
  if(high>=0xd800&&high<=0xdbff&&i+1<end){const low=value.charCodeAt(i+1);if(low>=0xdc00&&low<=0xdfff)i++;}
 }
 return count;
}

/** Equivalent to Array.from(value).slice(start,end).join(''), retaining only
 * numeric offsets and the requested string fragment. */
export function unicodeSlice(value:string,start=0,end=Infinity){
 start=Math.trunc(start)||0;end=Math.trunc(end)||0;
 if(start<0||end<0){const length=unicodeLength(value);if(start<0)start=Math.max(0,length+start);if(end<0)end=Math.max(0,length+end);}
 if(end<=start)return '';
 let from=value.length,to=value.length,position=0;
 for(let i=0;i<value.length;position++){
  if(position===start)from=i;
  if(position===end){to=i;break;}
  const high=value.charCodeAt(i++);
  if(high>=0xd800&&high<=0xdbff&&i<value.length){const low=value.charCodeAt(i);if(low>=0xdc00&&low<=0xdfff)i++;}
 }
 return value.slice(from,to);
}
