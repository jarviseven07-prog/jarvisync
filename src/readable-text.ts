export type ReadableParagraph = {
  type: 'paragraph';
  lines: string[];
};

export type ReadableListItem = {
  text: string;
  ordinal?: number;
};

export type ReadableList = {
  type: 'list';
  ordered: boolean;
  items: ReadableListItem[];
};

export type ReadableBlock = ReadableParagraph | ReadableList;

type ListMarker = {
  ordered: boolean;
  text: string;
  ordinal?: number;
};

function listMarker(line: string): ListMarker | null {
  const ordered = /^\s*([1-9]\d*)\.[\t ]+(.*)$/.exec(line);
  if (ordered) return { ordered: true, ordinal: Number(ordered[1]), text: ordered[2] };
  const unordered = /^\s*[-*][\t ]+(.*)$/.exec(line);
  if (unordered) return { ordered: false, text: unordered[1] };
  return null;
}

/** Turns plainly entered text into paragraphs and line-based lists without parsing markup. */
export function parseReadableText(text: string): ReadableBlock[] {
  const blocks: ReadableBlock[] = [];
  let paragraph: string[] = [];
  let list: ReadableList | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length > 0) blocks.push(list);
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    const marker = listMarker(line);
    if (!marker) {
      flushList();
      paragraph.push(line);
      continue;
    }
    flushParagraph();
    if (!list || list.ordered !== marker.ordered) {
      flushList();
      list = { type: 'list', ordered: marker.ordered, items: [] };
    }
    list.items.push({ text: marker.text, ...(marker.ordered ? { ordinal: marker.ordinal } : {}) });
  }
  flush();
  return blocks;
}
