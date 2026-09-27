import type { ReactNode } from "react";

// 작은 마크다운 렌더러. HTML 을 주입하지 않고 React 요소로만 만든다.
// 지원: # 제목, - / 1. 목록, - [ ] 체크리스트, ``` 코드블록, > 인용, **굵게**, `코드`, [링크](url), 수평선

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const key = out.length;
    if (t.startsWith("**")) out.push(<strong key={key}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={key} className="rounded bg-zinc-100 px-1 text-[0.9em] dark:bg-zinc-800">{t.slice(1, -1)}</code>);
    else {
      const [, label, href] = t.match(/\[([^\]]+)\]\(([^)\s]+)\)/)!;
      const safe = /^(https?:|mailto:|\/)/.test(href) ? href : "#";
      out.push(<a key={key} href={safe} className="link" target={safe.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{label}</a>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = blocks.length;
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(<pre key={key} className="overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-800"><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      const cls = ["text-xl font-semibold mt-6", "text-lg font-semibold mt-5", "font-semibold mt-4"][h[1].length - 1];
      blocks.push(<div key={key} role="heading" aria-level={h[1].length} className={cls}>{inline(h[2])}</div>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key} className="my-4 border-zinc-200 dark:border-zinc-700" />);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        const text = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "");
        const task = text.match(/^\[( |x|X)\]\s+(.*)/);
        items.push(
          task ? (
            <li key={i} className="list-none -ml-5 flex gap-2">
              <input type="checkbox" disabled defaultChecked={task[1] !== " "} className="mt-1" />
              <span className={task[1] !== " " ? "muted line-through" : ""}>{inline(task[2])}</span>
            </li>
          ) : (
            <li key={i}>{inline(text)}</li>
          ),
        );
      }
      blocks.push(ordered ? <ol key={key} className="ml-5 list-decimal space-y-1">{items}</ol> : <ul key={key} className="ml-5 list-disc space-y-1">{items}</ul>);
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key} className="muted border-l-2 border-zinc-300 pl-3 dark:border-zinc-600">{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
    blocks.push(<p key={key}>{inline(para.join(" "))}</p>);
  }
  return <div className="space-y-3 text-sm leading-relaxed">{blocks}</div>;
}
