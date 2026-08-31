export function routePreviewColor(value, routeId) {
  const normalized = String(value ?? '').replace(/^#/, '').trim()
  if (/^[0-9a-f]{6}$/i.test(normalized)) return `#${normalized}`
  const palette = ['#2d7ff9', '#16a394', '#7d65d8', '#d16837', '#c34b72', '#4f8f3a', '#b47b12', '#277d9c']
  let hash = 0
  for (const character of String(routeId)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}
