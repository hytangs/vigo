// Compatible providers sometimes JSON-encode nested objects/arrays or numbers
// as strings. Decode only a schema-declared type; names and IDs stay strings.
// The normal validator still rejects unknown fields and invalid values.
export function normalizeArguments(value, schema) {
  if (!schema) return value
  if (schema.anyOf) {
    // A valid literal string must win over interpreting it as encoded JSON,
    // regardless of branch order (for example a place name or identifier).
    for (const option of schema.anyOf) {
      try { validateArguments(value, option); return value } catch { /* Try another declared shape. */ }
    }
    for (const option of schema.anyOf) {
      const candidate = normalizeArguments(value, option)
      try { validateArguments(candidate, option); return candidate } catch { /* Try the other declared shape. */ }
    }
    return value
  }
  if (typeof value === 'string' && value.length <= 8000 && ['object', 'array'].includes(schema.type)) {
    try {
      const decoded = JSON.parse(value)
      if (schema.type === 'array' ? Array.isArray(decoded) : decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) value = decoded
    } catch { /* Preserve malformed input for the ordinary validation error. */ }
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeArguments(item, schema.properties?.[key])]))
  if (schema.type === 'array' && Array.isArray(value)) return value.map(item => normalizeArguments(item, schema.items))
  if (['integer', 'number'].includes(schema.type) && typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value)
  return value
}

export function validateArguments(value, schema, name = 'arguments') {
  if (schema.anyOf) {
    const matching = schema.anyOf.filter(option => option.type === typeof value)
    if (!matching.length) throw new Error(`${name} must be a place name or location object.`)
    let failure
    for (const option of matching) {
      try { return validateArguments(value, option, name) } catch (error) { failure ??= error }
    }
    throw failure
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw new Error(`Invalid ${name} size.`)
    value.forEach((item, index) => validateArguments(item, schema.items, `${name}[${index}]`))
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`)
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown ${name}.${key}.`)
      validateArguments(value[key], schema.properties[key], `${name}.${key}`)
    }
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${name}.${key} is required.`)
  } else {
    if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error(`Invalid ${name}.`)
    if (schema.type === 'number' && !Number.isFinite(value)) throw new Error(`Invalid ${name}.`)
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${name}.`)
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new Error(`Out-of-range ${name}.`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`Invalid ${name}. Expected ${schema.description || `format ${schema.pattern}`}`)
    if (typeof value === 'string' && value.length > (schema.maxLength ?? 8000)) throw new Error(`${name} is too long.`)
    if (typeof value === 'string' && value.length < (schema.minLength ?? 0)) throw new Error(`${name} is empty.`)
  }
}
