// Some compatible providers omit the opening reasoning marker but retain its
// closing tag. Text before that boundary must not enter answers or history.
export function publicReply(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : ''
  const cleaned = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '')
  const closing = [...cleaned.matchAll(/<\/think\s*>/gi)].at(-1)
  const reply = (closing ? cleaned.slice(closing.index + closing[0].length) : cleaned).trim()
  // Some compatible endpoints put an explicitly labelled private draft in
  // content instead of a reasoning field. Only accept its separate final
  // answer; an unfinished draft uses Ask's existing bounded retry.
  if (/^(?:#{1,6}\s*|\*\*)?(?:Thinking Process|Internal Reasoning)(?:\*\*)?\s*:/i.test(reply)) {
    const final = /^(?:#{1,6}\s*|\*\*)?Final Answer(?:\*\*)?\s*:(?:\*\*)?\s*/im.exec(reply)
    return final ? reply.slice(final.index + final[0].length).trim() : ''
  }
  return reply
}
