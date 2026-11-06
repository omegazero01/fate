"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {CopyIcon} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {toast} from 'sonner';

function CodeBlock({text,language}:{text:string;language:string}) {
  const [highlight,setHighlight]=React.useState<{text:string;language:string;html:string}>();
  React.useEffect(()=>{
    let active=true;
    const timer=setTimeout(()=>{
      if(!language||text.length>32768)return;
      void import('@/lib/code-highlight').then(({highlightCode})=>{
        if(!active)return;
        const html=highlightCode(text,language);
        if(html)setHighlight({text,language,html});
      }).catch(()=>{/* Plain text remains readable if highlighting is unavailable. */});
    },150);
    return()=>{active=false;clearTimeout(timer);};
  },[text,language]);
  const html=highlight?.text===text&&highlight.language===language?highlight.html:undefined;
  return <div className="markdown-code-block">
    <div className="markdown-code-heading"><span>{language||'纯文本'}</span><Button size="sm" variant="ghost" aria-label="复制代码" onClick={async()=>{try{await navigator.clipboard.writeText(text);toast.success('已复制代码');}catch{toast.error('复制失败');}}}><CopyIcon data-icon="inline-start"/>复制</Button></div>
    <pre>{html?<code dangerouslySetInnerHTML={{__html:html}}/>:<code>{text}</code>}</pre>
  </div>;
}


// Tailwind-styled element overrides (no typography plugin in this project, so we
// style each element). `node` is stripped — it's not a valid DOM attribute.
const components: Components = {
  h1: ({ node, ...p }) => <h1 className="mt-2.5 text-xl font-semibold" {...p} />,
  h2: ({ node, ...p }) => <h2 className="mt-2 text-lg font-semibold" {...p} />,
  h3: ({ node, ...p }) => <h3 className="mt-1.5 text-base font-semibold" {...p} />,
  h4: ({ node, ...p }) => <h4 className="mt-1.5 text-base font-semibold" {...p} />,
  p: ({ node, ...p }) => <p className="leading-relaxed" {...p} />,
  ul: ({ node, ...p }) => <ul className="my-1 list-disc pl-6" {...p} />,
  ol: ({ node, ...p }) => <ol className="my-1 list-decimal pl-6" {...p} />,
  strong: ({ node, ...p }) => <strong className="font-semibold" {...p} />,
  a: ({ node, ...p }) => (
    <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />
  ),
  hr: () => <hr className="my-2 border-border" />,
  blockquote: ({ node, ...p }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2.5 text-muted-foreground" {...p} />
  ),
  pre: ({children}) => {
    const child=React.Children.toArray(children)[0];
    if(React.isValidElement<{children?:React.ReactNode;className?:string}>(child)) {
      const language=/language-([\w+-]+)/.exec(child.props.className??'')?.[1]??'';
      return <CodeBlock text={String(child.props.children??'')} language={language}/>;
    }
    return <pre>{children}</pre>;
  },
  code: ({node,className,children,...rest}) => <code className={className} {...rest}>{children}</code>,
  table: ({ node, ...p }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...p} />
    </div>
  ),
  th: ({ node, ...p }) => (
    <th className="border border-border bg-muted/60 px-2 py-1 text-left font-medium" {...p} />
  ),
  td: ({ node, ...p }) => <td className="border border-border px-2 py-1 align-top" {...p} />,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="transcript-markdown flex min-w-0 flex-col gap-2 text-base [&>*:first-child]:mt-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
