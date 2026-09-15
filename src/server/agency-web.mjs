import { fetchSafeRealtimeBody } from './realtime-url-security.mjs'
import { pageText, readablePage } from '../agency/webResearch.mjs'

export async function readPublicPage(url, signal) {
  const timeout = AbortSignal.timeout(20_000)
  let response
  try {
    response = await fetchSafeRealtimeBody(url, { maximumBytes: 2_000_000, timeoutMs: 20_000, maximumRedirects: 3, allowPrivate: false,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'text/html,text/plain', 'User-Agent': 'VIGO-Agency (https://github.com/vigo-developers/vigo-agency)' } })
  } catch (error) {
    signal?.throwIfAborted()
    if (timeout.aborted) throw new Error('This page did not respond within 20 seconds. Retry or use another public source.')
    throw new Error(error.message.replaceAll('GTFS-RT', 'Web page'))
  }
  if (!/^text\/(html|plain)(?:;|$)/i.test(response.contentType || '')) throw new Error('This URL is not a readable HTML or text page.')
  const html = Buffer.from(response.body).toString('utf8')
  const { content, links, footer } = /^text\/html(?:;|$)/i.test(response.contentType) ? readablePage(html, response.url) : { content: html.trim(), links: [], footer: '' }
  const title = pageText(html.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1] || '').slice(0, 300)
  return { url: response.url, title, links, content: content.slice(0, 14_000), footer: footer.slice(0, 2000), truncated: content.length > 14_000 || footer.length > 2000,
    coverage: 'Public page text only; scripts are not executed. Retrieval time is not publication time. Check dates and incident identity before citing a cause.' }
}
