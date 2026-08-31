export async function readResponseBodyLimited(response, maximumBytes, label = 'response') {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError('maximumBytes must be a positive safe integer')
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    const error = new Error(`${label} exceeds the ${maximumBytes}-byte limit.`)
    error.code = 'response_too_large'
    throw error
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
        const error = new Error(`${label} exceeds the ${maximumBytes}-byte limit.`)
        error.code = 'response_too_large'
        throw error
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
