const argumentsList = process.argv.slice(2)

export function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const match = argumentsList.find((argument) => argument.startsWith(prefix))
  return match?.slice(prefix.length) ?? fallback
}

export function argValues(name) {
  const prefix = `--${name}=`
  return argumentsList
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length))
}
