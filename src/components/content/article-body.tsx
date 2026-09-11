import { CodeEnhancer } from './code-enhancer'

/**
 * The rendered document body.
 *
 * `dangerouslySetInnerHTML` is correct here and the safety argument is worth
 * stating once rather than repeating at every call site: the HTML is produced
 * by `renderMarkdown`, which runs `rehype-sanitize` with an allow-list schema
 * before anything reaches this component, and the Markdown itself comes from a
 * local file written by the site owner. Nothing in this path is user input.
 *
 * `data-article-body` is the hook `CodeEnhancer` uses. It is an attribute
 * rather than a ref because the enhancer is a client component and the body is
 * server-rendered: there is no ref to hand across that boundary without making
 * the body itself client-side, which would ship the whole post as JavaScript.
 */
export function ArticleBody({
  html,
  contentKey,
}: {
  html: string
  /** Changes when the document changes, so client navigation re-enhances. */
  contentKey: string
}) {
  return (
    <CodeEnhancer contentKey={contentKey}>
      <div
        className="prose"
        data-article-body=""
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </CodeEnhancer>
  )
}
