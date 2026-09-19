import { commands, options } from './commands.mjs'

export class CliUsageError extends Error {
  constructor(message, command = '') {
    super(message)
    this.command = command
  }
}

export const value = (args, name, fallback = '') => args.get(name)?.at(-1) ?? fallback
export const values = (args, name) => args.get(name) ?? []
export const enabled = (args, name) => ['1', 'true', 'yes'].includes(value(args, name).toLowerCase())

export function parseArguments(argv) {
  const args = new Map()
  const positionals = []
  const fail = message => { throw new CliUsageError(message, positionals[0] === 'help' ? positionals[1] : positionals[0]) }
  let endOfOptions = false
  for (let index = 0; index < argv.length; index += 1) {
    let token = argv[index]
    if (token === '--' && !endOfOptions) { endOfOptions = true; continue }
    if (endOfOptions || !token.startsWith('-')) { positionals.push(token); continue }
    if (token === '-h') token = '--help'
    if (token === '-V') token = '--version'
    if (!token.startsWith('--')) fail(`Unknown option: ${token}. Use --help to see supported options.`)
    const equals = token.indexOf('=')
    const name = token.slice(2, equals < 0 ? undefined : equals)
    if (!Object.hasOwn(options, name)) {
      if (name === 'routing-preference') fail('Unknown routing option; use --objective=earliest_arrival')
      if (name === 'radius') fail('Unknown Reach extent; use --extent-radius or extentRadiusKm')
      fail(`Unknown option: --${name}. Use --help to see supported options.`)
    }
    const [, , kind] = options[name]
    let optionValue = equals < 0 ? undefined : token.slice(equals + 1)
    if (kind === 'flag') {
      if (optionValue !== undefined) fail(`--${name} does not take a value`)
      optionValue = 'true'
    } else if (kind === 'boolean') {
      if (optionValue === undefined && /^(?:true|false|yes|no|1|0)$/iu.test(argv[index + 1] ?? '')) optionValue = argv[++index]
      optionValue ??= 'true'
      if (!/^(?:true|false|yes|no|1|0)$/iu.test(optionValue)) fail(`--${name} expects true or false`)
    } else {
      if (optionValue === undefined) {
        const next = argv[index + 1]
        if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d/u.test(next))) {
          fail(`--${name} requires a value. For a value starting with -, use --${name}=VALUE.`)
        }
        optionValue = argv[++index]
      }
      if (!optionValue.trim()) fail(`--${name} requires a non-empty value`)
    }
    if (args.has(name) && kind !== 'repeat') fail(`--${name} may only be supplied once`)
    args.set(name, [...(args.get(name) ?? []), optionValue])
  }
  const helpCommand = positionals[0] === 'help'
  const implicitRoute = [...args.keys()].some(name => name !== 'help' && name !== 'version')
  const command = helpCommand ? positionals[1] ?? '' : positionals[0] ?? (implicitRoute ? 'route' : '')
  if (positionals.length > (helpCommand ? 2 : 1)) fail(`Unexpected argument: ${positionals.at(-1)}. Use named options after the command.`)
  if (command && !Object.hasOwn(commands, command)) fail(`Unknown command: ${command}`)
  if (helpCommand) args.set('help', ['true'])
  const allowed = new Set([...(commands[command]?.options ?? []), 'help', 'version'])
  for (const name of args.keys()) {
    if (!allowed.has(name)) throw new CliUsageError(`--${name} is not an option for ${command || 'global help'}`, command)
  }
  return { command, args }
}

// Check command shape before opening databases or starting a build worker.
export function validateInvocation(command, args) {
  const fail = message => { throw new CliUsageError(message, command) }
  const requireOption = name => { if (!args.has(name)) fail(`${command} requires --${name}`) }
  if (['build', 'inspect', 'route', 'matrix', 'reach', 'compare'].includes(command)) {
    if (command === 'build') { requireOption('gtfs'); requireOption('osm'); requireOption('output') }
    else if (command === 'compare') { requireOption('before'); requireOption('after') }
    else requireOption('city')
  }
  if (['route', 'matrix', 'reach'].includes(command)) {
    if (command === 'route') {
      if (args.has('input') && args.has('request')) fail('Use either --request JSON or --input CSV, not both')
      if (!args.has('input') && !args.has('request')) fail('route requires --request JSON or --input CSV')
      if (args.has('input')) {
        requireOption('output')
        if (value(args, 'output') === '-') fail('CSV batches require an --output file; the JSON summary uses stdout')
        if (value(args, 'mode', 'transit') !== 'transit') fail('CSV batches support transit only; use --request for walk or drive')
      }
    } else requireOption('request')
    requireOption('service-date')
  }
  if (command === 'build' && value(args, 'output') === '-') fail('build requires a City output directory, not -')
}
