// Some compatible providers omit the opening reasoning marker but retain its
// closing tag. Text before that boundary must not enter answers or history.
export function publicReply(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : ''
  const cleaned = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '')
  const closing = [...cleaned.matchAll(/<\/think\s*>/gi)].at(-1)
  return (closing ? cleaned.slice(closing.index + closing[0].length) : cleaned).trim()
}
