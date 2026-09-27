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
    else if (t.startsWith("`")) out.push(<code key={key} className="mono bg-inset px-1 text-[0.92em] text-primary-fg">{t.slice(1, -1)}</code>);
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
      blocks.push(<pre key={key} className="mono overflow-x-auto border border-line bg-inset p-3 text-[12px]"><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      const cls = ["text-[17px] font-semibold mt-5 border-b border-line pb-1", "text-[14.5px] font-semibold mt-4", "font-semibold mt-3 text-fg-2"][h[1].length - 1];
      blocks.push(<div key={key} role="heading" aria-level={h[1].length} className={cls}>{inline(h[2])}</div>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key} className="my-4 border-line" />);
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
              <input type="checkbox" disabled defaultChecked={task[1] !== " "} className="mt-1 accent-primary" />
              <span className={task[1] !== " " ? "text-fg-4 line-through" : ""}>{inline(task[2])}</span>
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
      blocks.push(<blockquote key={key} className="border-l-2 border-line-strong pl-3 text-fg-2">{inline(quote.join(" "))}</blockquote>);
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
  return <div className="space-y-2.5 text-[13px] leading-relaxed">{blocks}</div>;
}
