import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import postcss from 'postcss'

const rootDirectory = resolve(import.meta.dirname, '..')
const entryPath = resolve(rootDirectory, 'src/App.css')
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
  'is-explore',
  'is-finished',
  'is-pathfinder',
  'is-running',
  'is-segment',
  'is-starting',
  'is-stop',
  'is-vehicle',
  'is-walk',
  'page-project',
  'page-projects',
  'state-ready',
  'state-working',
  'tone-empty',
])
const libraryClassPrefixes = ['lucide-', 'maplibregl-']
const stylePaths = [...entrySource.matchAll(/@import\s+["']([^"']+)["'];/g)]
  .map((match) => resolve(dirname(entryPath), match[1]))

function runtimeSourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) return runtimeSourcePaths(entryPath)
    return runtimeSourceExtensions.has(extname(entry.name)) ? [entryPath] : []
  })
}

const runtimeSource = [
  readFileSync(resolve(rootDirectory, 'index.html'), 'utf8'),
  ...runtimeSourcePaths(resolve(rootDirectory, 'src')).map((path) => readFileSync(path, 'utf8')),
  ...runtimeSourcePaths(resolve(rootDirectory, 'desktop')).map((path) => readFileSync(path, 'utf8')),
].join('\n')

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
  return runtimeSource.includes(className)
    || generatedClassNames.has(className)
    || libraryClassPrefixes.some((prefix) => className.startsWith(prefix))
}

function atRuleContext(rule) {
  const context = []
  for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    if (parent.type === 'atrule') context.unshift(`@${parent.name} ${parent.params}`)
  }
  return context.join('|')
}

const styles = stylePaths.map((path) => ({
  path,
  root: postcss.parse(readFileSync(path, 'utf8'), { from: path }),
}))
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
    rules.push({
      rule,
      key: `${atRuleContext(rule)}||${rule.selector}`,
    })
  })
}

const laterProperties = new Map()
let removedDeclarations = 0

for (let index = rules.length - 1; index >= 0; index -= 1) {
  const { rule, key } = rules[index]
  const declarations = rule.nodes.filter((node) => node.type === 'decl')
  const retained = []

  for (const declaration of declarations) {
    const later = laterProperties.get(`${key}||${declaration.prop}`)
    const isOverridden = later && (!declaration.important || later.important)
    if (isOverridden) {
      declaration.remove()
      removedDeclarations += 1
    } else {
      retained.push(declaration)
    }
  }

  const propertyStrength = new Map()
  for (const declaration of retained) {
    propertyStrength.set(
      declaration.prop,
      Boolean(propertyStrength.get(declaration.prop) || declaration.important),
    )
  }
  for (const [property, important] of propertyStrength) {
    laterProperties.set(`${key}||${property}`, { important })
  }

  if (!rule.nodes.some((node) => node.type !== 'comment')) {
    rule.remove()
    removedRules += 1
  }
}

let removedCustomProperties = 0
let removedCustomPropertiesThisPass = 0
do {
  removedCustomPropertiesThisPass = 0
  const referencedCustomProperties = new Set(
    [...[runtimeSource, ...styles.map((style) => style.root.toString())]
      .join('\n')
      .matchAll(/var\(\s*(--[-_a-zA-Z0-9]+)/g)]
      .map((match) => match[1]),
  )
  for (const style of styles) {
    style.root.walkDecls(/^--/, (declaration) => {
      if (referencedCustomProperties.has(declaration.prop)) return
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

let removedAtRules = 0
let removedKeyframes = 0
for (const style of styles) {
  const atRules = []
  style.root.walkAtRules((atRule) => atRules.push(atRule))
  for (const atRule of atRules.reverse()) {
    if (atRule.name.endsWith('keyframes')) {
      const namePattern = new RegExp(`(^|[^-\\w])${atRule.params.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^-\\w])`)
      const referenced = styles.some((candidate) => {
        let found = false
        candidate.root.walkDecls(/^animation(?:-name)?$/, (declaration) => {
          if (!isInside(declaration, atRule) && namePattern.test(declaration.value)) found = true
        })
        return found
      })
      if (!referenced) {
        atRule.remove()
        removedAtRules += 1
        removedKeyframes += 1
        continue
      }
    }
    if (atRule.nodes && !atRule.nodes.some((node) => node.type !== 'comment')) {
      atRule.remove()
      removedAtRules += 1
    }
  }
}

if (write) {
  for (const style of styles) writeFileSync(style.path, style.root.toString())
  console.log(JSON.stringify({
    status: 'cleaned',
    removedAtRules,
    removedCustomProperties,
    removedDeclarations,
    removedKeyframes,
    removedRules,
    removedSelectors,
    unusedClasses: [...unusedClasses].sort(),
  }))
} else if (removedAtRules || removedCustomProperties || removedDeclarations || removedKeyframes || removedRules || removedSelectors) {
  console.error(JSON.stringify({
    status: 'redundant-css',
    removedAtRules,
    removedCustomProperties,
    removedDeclarations,
    removedKeyframes,
    removedRules,
    removedSelectors,
    unusedClasses: [...unusedClasses].sort(),
  }))
  console.error('Run `npm run clean:css` and review the production CSS diff.')
  process.exitCode = 1
} else {
  console.log('CSS check passed: no unreachable selectors or overridden declarations.')
}
