import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render untrusted assistant text without HTML, executable URLs or remote image requests. */
export function AssistantMarkdown({ content }: { content: string }) {
  return <div className="message-body assistant-markdown">
    <Markdown skipHtml remarkPlugins={[remarkGfm]}
      urlTransform={(url) => /^https?:\/\//i.test(url) ? url : ""}
      components={{
        a: ({ href, children }) => href
          ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span>{alt ?? ""}</span>,
      }}>{content}</Markdown>
  </div>;
}
