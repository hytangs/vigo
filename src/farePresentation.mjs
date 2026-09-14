const currencies = new Set(Intl.supportedValuesOf('currency'))
const formats = new Map()

function currencyFormat(currency) {
  if (!currencies.has(currency)) return null
  if (!formats.has(currency)) formats.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency }))
  return formats.get(currency)
}

// Validate decimal text in minor units before converting to a display number.
// Rounding a malformed price would turn invalid evidence into a different fare.
export function parseFareAmount(amount, currency) {
  const format = currencyFormat(currency)
  const text = String(amount ?? '')
  if (!format || text.length > 32 || !/^\d+(?:\.\d+)?$/.test(text)) return null
  const digits = format.resolvedOptions().maximumFractionDigits
  const [whole, fraction = ''] = text.split('.')
  if (/[^0]/.test(fraction.slice(digits))) return null
  const units = Number(whole + fraction.slice(0, digits).padEnd(digits, '0'))
  if (!Number.isSafeInteger(units)) return null
  const number = units / 10 ** digits
  const [storedWhole, storedFraction = ''] = String(number).split('.')
  return Number(storedWhole + storedFraction.padEnd(digits, '0')) === units ? number : null
}

export function farePriceLabel(options = []) {
  const groups = new Map()
  for (const option of options) {
    const amount = parseFareAmount(option.amount, option.currency)
    if (amount === null) continue
    const range = groups.get(option.currency)
    groups.set(option.currency, range ? [Math.min(range[0], amount), Math.max(range[1], amount)] : [amount, amount])
  }
  return [...groups].map(([currency, [min, max]]) => {
    const format = currencyFormat(currency)
    return min === max ? format.format(min) : `${format.format(min)}–${format.format(max)}`
  }).join(' / ')
}
