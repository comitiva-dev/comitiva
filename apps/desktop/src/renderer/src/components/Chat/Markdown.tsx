import { memo, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

/** Code blocks get a copy button; the language, when given, shows as a label. */
function Pre({ children, node: _node, ...rest }: ComponentProps<'pre'> & { node?: unknown }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const code = (children as { props?: { children?: unknown; className?: string } } | undefined)
    ?.props;
  const text = String(code?.children ?? '').replace(/\n$/, '');
  const language = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1];
  return (
    <div data-testid="code-block" className="group relative">
      <div className="flex items-center justify-between rounded-t-md bg-neutral-200 px-3 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
        <span>{language ?? ''}</span>
        <button
          data-testid="copy-code"
          className="hover:text-neutral-900 dark:hover:text-neutral-100"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: Pre,
  // main opens https links in the system browser (setWindowOpenHandler); nothing navigates the app.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** Assistant text as Markdown (GFM). Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
