import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { failedToolResult, toolDefinitions, validateArguments } from './toolRegistry.mjs'

const allowed = new Map(toolDefinitions.map((tool) => [tool.name, tool]))
function validate(skill) {
  if (!skill || !/^[a-z][a-z0-9-]{2,60}$/.test(skill.id) || typeof skill.name !== 'string' || skill.name.length > 100 || typeof skill.description !== 'string' || skill.description.length > 1000 || typeof skill.instructions !== 'string' || skill.instructions.length > 20_000) throw new Error('A skill needs an ID, name, description, and method instructions.')
  if (skill.version !== undefined && typeof skill.version !== 'string') throw new Error('Skill version must be text.')
  if (!Array.isArray(skill.inputs) || skill.inputs.length > 8 || new Set(skill.inputs.map(input => input?.key)).size !== skill.inputs.length || skill.inputs.some((input) => !input || (input.required !== undefined && typeof input.required !== 'boolean') || (input.label !== undefined && typeof input.label !== 'string') || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(input.key) || !['route', 'date', 'stop', 'time', 'minutes'].includes(input.type))) throw new Error('Unsupported skill inputs.')
  if (!Array.isArray(skill.steps) || !skill.steps.length || skill.steps.length > 8 || skill.steps.some((step) => !step || !allowed.has(step.tool) || (step.label !== undefined && typeof step.label !== 'string') || (step.arguments !== undefined && (!step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments))))) throw new Error('A skill can use up to eight installed transit tools.')
  return { ...skill, inputs: skill.inputs.map(input => ({ ...input, label: input.label || input.key })), version: skill.version || '1.0', source: 'vigo', status: 'ready', enabled: true, requiredInputs: skill.inputs.filter((item) => item.required).map((item) => item.key), tools: skill.steps.map((step) => step.tool), outputType: 'Research note · evidence · CSV' }
}

export function createSkillRegistry({ directory = path.resolve('public/agency-skills'), installedDirectory, preferences = {} } = {}) {
  const skills = new Map(), warnings = []
  for (const root of [directory, installedDirectory].filter(Boolean)) if (existsSync(root)) {
    for (const folder of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const file = path.join(root, folder.name, 'skill.json')
      if (!existsSync(file)) continue
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        const instructions = readFileSync(path.join(root, folder.name, 'SKILL.md'), 'utf8')
        const skill = validate({ ...manifest, instructions })
        if (skills.has(skill.id)) throw new Error('Duplicate skill ID; the earlier method is retained.')
        skills.set(skill.id, { ...skill, source: root === installedDirectory ? 'external' : 'vigo', enabled: preferences[skill.id] !== false })
      } catch (error) {
        warnings.push(`Research skill “${folder.name}” could not be loaded. ${error instanceof SyntaxError ? 'Invalid JSON.' : error.code ? 'Required method files could not be read.' : error.message}`)
      }
    }
  }
  return {
    list: () => structuredClone([...skills.values()]),
    warnings: () => [...warnings],
    install(input) {
      if (!installedDirectory) throw new Error('This City has no skill directory.')
      const skill = validate(input)
      if (skills.has(skill.id)) throw new Error('A skill with this ID already exists. Give the new method a different ID.')
      const directory = path.join(installedDirectory, skill.id)
      mkdirSync(directory, { recursive: true })
      const { instructions, ...manifest } = input
      writeFileSync(path.join(directory, 'skill.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      writeFileSync(path.join(directory, 'SKILL.md'), instructions)
      skills.set(skill.id, { ...skill, source: 'external' })
      return this.list()
    },
    setEnabled(id, enabled) {
      const skill = skills.get(id)
      if (!skill) throw new Error('Unknown skill.')
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean.')
      skill.enabled = enabled
      return { ...skill }
    },
    async run(id, input, callTool, onProgress = () => {}, { signal, generatedAt = new Date().toISOString() } = {}) {
      const skill = skills.get(id)
      if (!skill || !skill.enabled) throw new Error('This skill is unavailable or disabled.')
      for (const key of skill.requiredInputs) if (input[key] === undefined || input[key] === '') throw new Error(`${key} is required.`)
      const bind = (value) => {
        if (typeof value === 'string' && value.startsWith('$input.')) return input[value.slice(7)]
        if (Array.isArray(value)) return value.map(bind)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item)]).filter(([, item]) => item !== undefined && item !== ''))
        return value
      }
      const results = []
      let status = 'complete'
      for (const [index, step] of skill.steps.entries()) {
        if (signal?.aborted) { status = 'stopped'; break }
        const args = bind(step.arguments ?? {})
        onProgress({ phase: `skill-${index}`, progress: 0, detail: step.label || `Running ${step.tool.replaceAll('_', ' ')}…` })
        let result
        try {
          validateArguments(args, allowed.get(step.tool).parameters)
          result = await callTool(step.tool, args)
        } catch (error) { result = failedToolResult(error, generatedAt) }
        results.push({ tool: step.tool, arguments: args, result })
        onProgress({ phase: `skill-${index}`, progress: 1, detail: result.ok ? `${step.label || step.tool.replaceAll('_', ' ')} — complete` : result.warnings[0] || 'This check could not be completed.' })
        if (!result.ok) { status = 'failed'; break }
      }
      return { skill: { ...skill }, results, status: signal?.aborted ? 'stopped' : status }
    },
  }
}
