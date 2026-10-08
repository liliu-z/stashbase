/** A persona's sample reply, rendered the way the same reply reads in a Chat. */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { MARKDOWN_PROSE_CLASS } from '@/shared/ui/markdown-prose';

/* A sample is publisher text, not the reader's project: links stay text and
 * images never load, so the page reaches nothing the index did not carry. */
const COMPONENTS: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
};

export default function SampleMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className={MARKDOWN_PROSE_CLASS}>
      <ReactMarkdown components={COMPONENTS} remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
