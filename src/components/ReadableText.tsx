import { parseReadableText } from '../readable-text';

export interface ReadableTextProps {
  text: string;
  className?: string;
}

export function ReadableText({ text, className }: ReadableTextProps) {
  const blocks = parseReadableText(text);
  const classes = className ? `readable-text ${className}` : 'readable-text';

  return (
    <div className={classes}>
      {blocks.map((block, index) => {
        if (block.type === 'paragraph') return <p key={index}>{block.lines.join('\n')}</p>;
        if (block.ordered) {
          const start = block.items[0]?.ordinal;
          return <ol key={index} {...(start !== undefined && start !== 1 ? { start } : {})}>
            {block.items.map((item, itemIndex) => <li key={itemIndex} {...(item.ordinal !== undefined ? { value: item.ordinal } : {})}>{item.text}</li>)}
          </ol>;
        }
        return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item.text}</li>)}</ul>;
      })}
    </div>
  );
}
