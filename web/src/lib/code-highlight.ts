import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import http from 'highlight.js/lib/languages/http';
for (const [name, grammar] of Object.entries({javascript,typescript,json,bash,python,sql,xml,css,http})) hljs.registerLanguage(name,grammar);
export function highlightCode(text:string,language:string):string|undefined {
  if(text.length>32768||!hljs.getLanguage(language))return undefined;
  return hljs.highlight(text,{language,ignoreIllegals:true}).value;
}
