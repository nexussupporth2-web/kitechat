import type { ReactNode } from 'react';

// Message formatting (WhatsApp style):
//   *bold*  _italic_  ~strikethrough~  `inline code`  ```monospace```
//   "* " or "- " bullets, "1. " numbered lists, "> " quotes, and formats inside each other (*_text_*).

const MARKS: Record<string, 'b' | 'i' | 's'> = { '*': 'b', _: 'i', '~': 's' };
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => !c || /\s/.test(c);

function wrap(kind: 'b' | 'i' | 's', key: number, kids: ReactNode) {
  if (kind === 'b') return <strong key={key} className="font-bold">{kids}</strong>;
  if (kind === 'i') return <em key={key} className="italic">{kids}</em>;
  return <s key={key}>{kids}</s>;
}

/** Formats one stretch of text on a single line. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  let k = 0;
  const flush = () => {
    if (plain) out.push(plain);
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // ```monospace``` on one line
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end > i + 3) {
        flush();
        out.push(<code key={k++} className="mono">{text.slice(i + 3, end)}</code>);
        i = end + 3;
        continue;
      }
    }
    // `inline code`
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={k++} className="inline">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    if (MARKS[c] && !isWord(text[i - 1]) && !isSpace(text[i + 1]) && text[i + 1] !== c) {
      let end = -1;
      for (let j = i + 2; j < text.length; j++) {
        if (text[j] === c && !isSpace(text[j - 1]) && !isWord(text[j + 1])) {
          end = j;
          break;
        }
      }
      if (end > 0) {
        flush();
        out.push(wrap(MARKS[c], k++, inline(text.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

/** Turns a message into formatted lines. */
export function formatMessage(text: string): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let k = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    // ``` block over several lines
    if (line.trimStart().startsWith('```') && !line.trim().slice(3).includes('```')) {
      let end = -1;
      for (let m = n + 1; m < lines.length; m++) {
        if (lines[m].includes('```')) {
          end = m;
          break;
        }
      }
      if (end > n) {
        const body = [line.trimStart().slice(3), ...lines.slice(n + 1, end), lines[end].slice(0, lines[end].indexOf('```'))].join('\n').replace(/^\n/, '');
        blocks.push(<pre key={k++} className="mono">{body}</pre>);
        n = end;
        continue;
      }
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:\*|-) (.*)$/))) {
      blocks.push(
        <div key={k++} className="flex gap-2">
          <span aria-hidden>•</span>
          <span className="min-w-0 break-words">{inline(m[1])}</span>
        </div>
      );
    } else if ((m = line.match(/^(\d+)\. (.*)$/))) {
      blocks.push(
        <div key={k++} className="flex gap-2">
          <span className="shrink-0">{m[1]}.</span>
          <span className="min-w-0 break-words">{inline(m[2])}</span>
        </div>
      );
    } else if ((m = line.match(/^> ?(.*)$/))) {
      blocks.push(
        <div key={k++} className="border-l-4 border-current/40 pl-3 opacity-80" style={{ borderLeftColor: 'color-mix(in srgb, currentColor 40%, transparent)' }}>
          {inline(m[1])}
        </div>
      );
    } else {
      blocks.push(
        <div key={k++} className="whitespace-pre-wrap break-words min-h-[1em]">
          {inline(line)}
        </div>
      );
    }
  }
  return blocks;
}
