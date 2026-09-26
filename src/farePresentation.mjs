const currencies = new Set(Intl.supportedValuesOf('currency'))
const formats = new Map()
// Supported currency scales have at most four decimal places (covered against
// the runtime's complete currency list in check-gtfs-fares). Whole-unit values
// below this bound are exact minor-unit integers at every supported scale.
const maximumWholeUnitFastAmount = Math.floor(Number.MAX_SAFE_INTEGER / 10 ** 4)

function currencyFormat(currency) {
  if (!currencies.has(currency)) return null
  if (!formats.has(currency)) formats.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency }))
  return formats.get(currency)
}

// Validate decimal text in minor units before converting to a display number.
// Rounding a malformed price would turn invalid evidence into a different fare.
export function parseFareAmount(amount, currency) {
  const text = String(amount ?? '')
  if (!currencies.has(currency) || text.length > 32 || !/^\d+(?:\.\d+)?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const wholeAmount = Number(whole)
  // Numeric fare results do not need localized currency symbols. Avoid the
  // formatter's first-use ICU cost for common, exactly representable prices.
  if (wholeAmount <= maximumWholeUnitFastAmount && !/[1-9]/.test(fraction)) return wholeAmount
  const digits = currencyFormat(currency).resolvedOptions().maximumFractionDigits
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
