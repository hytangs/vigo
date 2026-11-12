import { nativeStableKeySuffix } from './native-routing-kernel.mjs'

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Plan IDs are display and selection keys, not security primitives. A small
// deterministic 64-bit suffix keeps them compact without making every route
// identity pay for a cryptographic digest.
export function stableKeySuffix(value) {
  return nativeStableKeySuffix(String(value))
}
