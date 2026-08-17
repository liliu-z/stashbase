import sanitizeHtml from 'sanitize-html';

/** DOCX uses the same preview trust policy as Markdown, except Mammoth emits
 *  embedded document images as data URLs. Scripts, event handlers, style,
 *  navigation-breaking tags, and unsafe link schemes remain disallowed. */
export function sanitizeDocxHtml(html: string): string {
  return sanitizeHtml(html, {
    ...docxSanitizePolicy(),
    transformTags: {
      ...(MARKDOWN_SANITIZE_OPTIONS.transformTags ?? {}),
      img: (_tagName, attributes) => {
        const { src, ...safeAttributes } = attributes;
        if (src && isSafeDocxImageSource(src)) safeAttributes.src = src;
        return { tagName: 'img', attribs: safeAttributes };
      },
    },
  });
}

/** Serializable portion of the DOCX trust policy. The durable Node worker
 * receives this object through workerData, keeping parsing and sanitization
 * inside the same terminable boundary without duplicating the allow-list. */
export function docxSanitizePolicy(): sanitizeHtml.IOptions {
  return {
    allowedTags: MARKDOWN_SANITIZE_OPTIONS.allowedTags,
    allowedAttributes: MARKDOWN_SANITIZE_OPTIONS.allowedAttributes,
    allowedClasses: MARKDOWN_SANITIZE_OPTIONS.allowedClasses,
    allowedSchemes: MARKDOWN_SANITIZE_OPTIONS.allowedSchemes,
    allowedSchemesByTag: {
      ...((MARKDOWN_SANITIZE_OPTIONS.allowedSchemesByTag as Record<string, string[]> | undefined) ?? {}),
      img: ['http', 'https', 'data'],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  };
}

function isSafeDocxImageSource(src: string): boolean {
  if (!src.toLowerCase().startsWith('data:')) return true;
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(src);
}

const MARKDOWN_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br',
    'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
    'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li',
    'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
    'span', 'strong', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'path',
  ],
  allowedAttributes: {
    '*': ['id', 'title', 'dir', 'lang', 'aria-*', 'role'],
    a: ['href', 'class', 'data-footnote:ref', 'data-footnote:backref', 'aria-describedby'],
    blockquote: ['cite'],
    code: ['class'],
    col: ['span'],
    colgroup: ['span'],
    del: ['cite', 'datetime'],
    details: ['open'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    input: ['type', 'checked', 'disabled'],
    ins: ['cite', 'datetime'],
    li: ['class', 'value'],
    ol: ['start', 'reversed', 'type'],
    q: ['cite'],
    td: ['colspan', 'rowspan', 'headers', 'align'],
    th: ['colspan', 'rowspan', 'headers', 'scope', 'align'],
    section: ['class', 'data-footnotes'],
    span: ['class'],
    sup: ['class'],
    svg: ['class', 'viewbox', 'width', 'height', 'aria-hidden'],
    path: ['d'],
    ul: ['class'],
  },
  allowedClasses: {
    a: ['footnote-backref'],
    section: ['footnotes'],
    sup: ['footnote-ref'],
    h2: ['sr-only'],
    div: [/^markdown-alert(?:-(?:note|tip|important|warning|caution))?$/],
    p: ['markdown-alert-title'],
    // Highlight.js token vocabulary: `hljs-<scope>` plus v11 sub-scope
    // classes (bare words with trailing underscores, e.g. `function_`).
    span: [/^hljs-[a-z0-9_-]+$/, /^[a-z][a-z0-9-]*_{1,2}$/],
    svg: ['octicon', 'mr-2', /^octicon-[a-z-]+$/],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https'],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    input: (_tagName, attributes) => ({
      tagName: 'input',
      attribs: {
        type: 'checkbox',
        disabled: '',
        ...(Object.hasOwn(attributes, 'checked') ? { checked: '' } : {}),
      },
    }),
  },
};
