import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import postcss from 'postcss'

const rootDirectory = resolve(import.meta.dirname, '..')
const sourceDirectory = resolve(rootDirectory, 'src')
const entryPath = resolve(sourceDirectory, 'App.css')
const entrySource = readFileSync(entryPath, 'utf8')
const write = process.argv.includes('--write')
const runtimeSourceExtensions = new Set(['.html', '.js', '.m', '.mjs', '.ts', '.tsx'])
// These classes are assembled from closed runtime unions. Keep the list
// explicit so an obsolete dynamic selector cannot hide behind a broad prefix.
const generatedClassNames = new Set([
  'accent-blue',
  'accent-dot-blue',
  'accent-dot-graphite',
  'accent-dot-teal',
  'accent-graphite',
  'accent-teal',
  'appearance-dark',
  'appearance-light',
  'is-analyze',
  'is-complete',
  'is-drive',
  'is-bike',
  'is-explore',
  'is-finished',
  'is-pathfinder',
  'is-ride',
  'is-running',
  'is-segment',
  'is-starting',
  'is-stop',
  'is-transfer',
  'is-vehicle',
  'is-walk',
  'page-project',
  'page-projects',
  'state-ready',
  'state-working',
  'tone-empty',
  'tone-watch',
])
const libraryClassPrefixes = ['lucide-', 'maplibregl-']
// Conditional group rules only narrow where a rule applies, so a later rule
// with the same selectors outside them still wins wherever the earlier matches.
const conditionalAtRules = new Set(['container', 'media', 'supports'])
// Longhands each shorthand sets in Electron's Chromium. A declaration is
// overridden once later declarations set every longhand it sets.
const shorthandLonghands = new Map(Object.entries({
  animation: 'animation-duration animation-timing-function animation-delay animation-iteration-count animation-direction animation-fill-mode animation-play-state animation-name animation-timeline animation-range-start animation-range-end',
  background: 'background-image background-position-x background-position-y background-size background-repeat background-attachment background-origin background-clip background-color',
  'background-position': 'background-position-x background-position-y',
  border: 'border-top-color border-top-style border-top-width border-right-color border-right-style border-right-width border-bottom-color border-bottom-style border-bottom-width border-left-color border-left-style border-left-width border-image-source border-image-slice border-image-width border-image-outset border-image-repeat',
  'border-block': 'border-block-start-color border-block-start-style border-block-start-width border-block-end-color border-block-end-style border-block-end-width',
  'border-bottom': 'border-bottom-width border-bottom-style border-bottom-color',
  'border-color': 'border-top-color border-right-color border-bottom-color border-left-color',
  'border-inline': 'border-inline-start-color border-inline-start-style border-inline-start-width border-inline-end-color border-inline-end-style border-inline-end-width',
  'border-left': 'border-left-width border-left-style border-left-color',
  'border-radius': 'border-top-left-radius border-top-right-radius border-bottom-right-radius border-bottom-left-radius',
  'border-right': 'border-right-width border-right-style border-right-color',
  'border-style': 'border-top-style border-right-style border-bottom-style border-left-style',
  'border-top': 'border-top-width border-top-style border-top-color',
  'border-width': 'border-top-width border-right-width border-bottom-width border-left-width',
  container: 'container-name container-type',
  flex: 'flex-grow flex-shrink flex-basis',
  'flex-flow': 'flex-direction flex-wrap',
  font: 'font-style font-variant-ligatures font-variant-caps font-variant-numeric font-variant-east-asian font-variant-alternates font-variant-position font-variant-emoji font-weight font-stretch font-size line-height font-family font-optical-sizing font-size-adjust font-kerning font-feature-settings font-variation-settings font-language-override',
  'font-variant': 'font-variant-ligatures font-variant-caps font-variant-alternates font-variant-numeric font-variant-east-asian font-variant-position font-variant-emoji',
  gap: 'row-gap column-gap',
  'grid-area': 'grid-row-start grid-column-start grid-row-end grid-column-end',
  'grid-column': 'grid-column-start grid-column-end',
  'grid-row': 'grid-row-start grid-row-end',
  'grid-template': 'grid-template-rows grid-template-columns grid-template-areas',
  inset: 'top right bottom left',
  'list-style': 'list-style-position list-style-image list-style-type',
  margin: 'margin-top margin-right margin-bottom margin-left',
  'margin-block': 'margin-block-start margin-block-end',
  'margin-inline': 'margin-inline-start margin-inline-end',
  outline: 'outline-color outline-style outline-width',
  overflow: 'overflow-x overflow-y',
  'overscroll-behavior': 'overscroll-behavior-x overscroll-behavior-y',
  padding: 'padding-top padding-right padding-bottom padding-left',
  'padding-block': 'padding-block-start padding-block-end',
  'padding-inline': 'padding-inline-start padding-inline-end',
  'place-content': 'align-content justify-content',
  'place-items': 'align-items justify-items',
  'place-self': 'align-self justify-self',
  'text-decoration': 'text-decoration-line text-decoration-thickness text-decoration-style text-decoration-color',
  transition: 'transition-property transition-duration transition-timing-function transition-delay transition-behavior',
}).map(([shorthand, longhands]) => [shorthand, longhands.split(' ')]))
const entryStylePaths = [...entrySource.matchAll(/@import\s+["']([^"']+)["'];/g)]
  .map((match) => resolve(dirname(entryPath), match[1]))

function sourcePaths(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourcePaths(entryPath, extensions)
    return extensions.has(extname(entry.name)) ? [entryPath] : []
  })
}

// Components import the remaining sheets, so module order places them in the
// cascade. Each of them is checked as a cascade of its own.
const componentStylePaths = sourcePaths(sourceDirectory, new Set(['.css']))
  .filter((path) => path !== entryPath && !entryStylePaths.includes(path))
  .sort()

const runtimeSource = [
  readFileSync(resolve(rootDirectory, 'index.html'), 'utf8'),
  ...sourcePaths(sourceDirectory, runtimeSourceExtensions).map((path) => readFileSync(path, 'utf8')),
  ...['public/main.mjs', 'public/preload.cjs'].map((path) => readFileSync(resolve(rootDirectory, path), 'utf8')),
].join('\n')
// Longer class names and asset names must not keep retired selectors alive.
// Custom properties and keyframes that runtime code names stay alive too.
const runtimeTokens = new Set(runtimeSource.match(/[-_a-zA-Z0-9]+/g))

function selectorList(selector) {
  const selectors = []
  let quote = ''
  let depth = 0
  let start = 0

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(' || character === '[') {
      depth += 1
    } else if (character === ')' || character === ']') {
      depth -= 1
    } else if (character === ',' && depth === 0) {
      selectors.push(selector.slice(start, index).trim())
      start = index + 1
    }
  }

  selectors.push(selector.slice(start).trim())
  return selectors.filter(Boolean)
}

// Whitespace and list order do not change what a selector list matches.
// Selectors with strings or escapes keep their spelling.
function selectorKey(selector) {
  return selectorList(selector)
    .map((part) => (/["'\\]/.test(part) ? part : part.replace(/\s+/g, ' ').replace(/ ?([>+~()]) ?/g, '$1')))
    .sort()
    .join(',')
}

function selectorClassNames(selector) {
  return [...selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)]
    .map((match) => match[1])
}

function selectorIndentation(rule) {
  return rule.raws.before?.match(/\n([ \t]*)$/)?.[1] ?? ''
}

function isInside(node, ancestor) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent === ancestor) return true
  }
  return false
}

function runtimeOwnsClass(className) {
  return runtimeTokens.has(className)
    || generatedClassNames.has(className)
    || libraryClassPrefixes.some((prefix) => className.startsWith(prefix))
}

function atRuleContexts(node) {
  const contexts = []
  for (let parent = node.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    if (parent.type === 'atrule') contexts.unshift(parent)
  }
  return contexts
}

function contextKey(contexts) {
  return contexts.map((atRule) => `@${atRule.name} ${atRule.params.replace(/\s+/g, ' ')}`).join('|')
}

// Contexts whose later rules always apply where a rule in these contexts does.
function overridingContextKeys(contexts) {
  const keys = [contextKey(contexts)]
  for (let length = contexts.length; length > 0 && conditionalAtRules.has(contexts[length - 1].name); length -= 1) {
    keys.push(contextKey(contexts.slice(0, length - 1)))
  }
  return keys
}

const styles = [entryStylePaths, ...componentStylePaths.map((path) => [path])]
  .flatMap((paths, cascade) => paths.map((path) => ({
    path,
    cascade,
    root: postcss.parse(readFileSync(path, 'utf8'), { from: path }),
  })))
const rules = []
const unusedClasses = new Set()
let removedSelectors = 0
let removedRules = 0

for (const style of styles) {
  style.root.walkRules((rule) => {
    const selectors = selectorList(rule.selector)
    const retained = selectors.filter((selector) => {
      const unused = selectorClassNames(selector).filter((className) => !runtimeOwnsClass(className))
      for (const className of unused) unusedClasses.add(className)
      if (!unused.length) return true
      removedSelectors += 1
      return false
    })

    if (!retained.length) {
      rule.remove()
      removedRules += 1
    } else if (retained.length !== selectors.length) {
      rule.selector = retained.join(`,\n${selectorIndentation(rule)}`)
    }
  })
}

for (const style of styles) {
  style.root.walkRules((rule) => {
    const contexts = atRuleContexts(rule)
    const selectors = selectorKey(rule.selector)
    rules.push({
      rule,
      key: `${style.cascade}|${contextKey(contexts)}||${selectors}`,
      overridingKeys: overridingContextKeys(contexts).map((context) => `${style.cascade}|${context}||${selectors}`),
    })
  })
}

const laterProperties = new Map()
let removedDeclarations = 0

for (let index = rules.length - 1; index >= 0; index -= 1) {
  const { rule, key, overridingKeys } = rules[index]
  const declarations = rule.nodes.filter((node) => node.type === 'decl').reverse()

  for (const declaration of declarations) {
    const longhands = shorthandLonghands.get(declaration.prop) ?? [declaration.prop]
    const isOverridden = longhands.every((longhand) => overridingKeys.some((overridingKey) => {
      const later = laterProperties.get(`${overridingKey}||${longhand}`)
      return later && (!declaration.important || later.important)
    }))
    if (isOverridden) {
      declaration.remove()
      removedDeclarations += 1
      continue
    }
    for (const longhand of longhands) {
      const property = `${key}||${longhand}`
      laterProperties.set(property, { important: Boolean(laterProperties.get(property)?.important || declaration.important) })
    }
  }

  if (!rule.nodes.some((node) => node.type !== 'comment')) {
    rule.remove()
    removedRules += 1
  }
}

const unusedCustomProperties = new Set()
let removedCustomProperties = 0
let removedCustomPropertiesThisPass = 0
do {
  removedCustomPropertiesThisPass = 0
  const styleValues = []
  for (const style of styles) {
    style.root.walkDecls((declaration) => styleValues.push(declaration.value))
    style.root.walkAtRules((atRule) => styleValues.push(atRule.params))
  }
  const referencedCustomProperties = new Set(
    [...styleValues.join('\n').matchAll(/var\(\s*(--[-_a-zA-Z0-9]+)/g)].map((match) => match[1]),
  )
  for (const style of styles) {
    style.root.walkDecls(/^--/, (declaration) => {
      if (referencedCustomProperties.has(declaration.prop) || runtimeTokens.has(declaration.prop)) return
      unusedCustomProperties.add(declaration.prop)
      declaration.remove()
      removedCustomProperties += 1
      removedCustomPropertiesThisPass += 1
    })
  }
} while (removedCustomPropertiesThisPass)

for (const style of styles) {
  style.root.walkRules((rule) => {
    if (!rule.nodes.some((node) => node.type !== 'comment')) {
      rule.remove()
      removedRules += 1
    }
  })
}

const keyframesRules = styles.flatMap((style) => {
  const keyframes = []
  style.root.walkAtRules(/keyframes$/, (atRule) => {
    const contexts = atRuleContexts(atRule)
    keyframes.push({ atRule, cascade: style.cascade, key: contextKey(contexts), overridingKeys: overridingContextKeys(contexts) })
  })
  return keyframes
})

function keyframesApply(atRule) {
  const position = keyframesRules.findIndex((keyframes) => keyframes.atRule === atRule)
  const { cascade, overridingKeys } = keyframesRules[position]
  // A later @keyframes with the same name replaces this one wherever it applies.
  const replaced = keyframesRules.slice(position + 1).some((later) => later.cascade === cascade
    && later.atRule.name === atRule.name
    && later.atRule.params === atRule.params
    && overridingKeys.includes(later.key))
  if (replaced) return false
  if (runtimeTokens.has(atRule.params)) return true

  const namePattern = new RegExp(`(^|[^-\\w])${atRule.params.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^-\\w])`)
  return styles.some((candidate) => {
    let found = false
    candidate.root.walkDecls(/^(?:animation(?:-name)?|--.+)$/, (declaration) => {
      if (!isInside(declaration, atRule) && namePattern.test(declaration.value)) found = true
    })
    return found
  })
}

const unusedKeyframes = new Set()
let removedAtRules = 0
let removedKeyframes = 0
for (const style of styles) {
  const atRules = []
  style.root.walkAtRules((atRule) => atRules.push(atRule))
  for (const atRule of atRules.reverse()) {
    if (atRule.name.endsWith('keyframes') && !keyframesApply(atRule)) {
      unusedKeyframes.add(atRule.params)
      atRule.remove()
      removedAtRules += 1
      removedKeyframes += 1
      continue
    }
    if (atRule.nodes && !atRule.nodes.some((node) => node.type !== 'comment')) {
      atRule.remove()
      removedAtRules += 1
    }
  }
}

const report = {
  removedAtRules,
  removedCustomProperties,
  removedDeclarations,
  removedKeyframes,
  removedRules,
  removedSelectors,
  unusedClasses: [...unusedClasses].sort(),
  unusedCustomProperties: [...unusedCustomProperties].sort(),
  unusedKeyframes: [...unusedKeyframes].sort(),
}

if (write) {
  for (const style of styles) writeFileSync(style.path, style.root.toString())
  console.log(JSON.stringify({ status: 'cleaned', ...report }))
} else if (removedAtRules || removedCustomProperties || removedDeclarations || removedKeyframes || removedRules || removedSelectors) {
  console.error(JSON.stringify({ status: 'redundant-css', ...report }))
  console.error('Run `npm run clean:css` and review the production CSS diff.')
  process.exitCode = 1
} else {
  console.log('CSS check passed: no unreachable selectors, overridden declarations, unused custom properties or unused keyframes.')
}
