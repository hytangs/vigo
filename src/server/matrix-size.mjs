// Bound materialized results, without capping either endpoint set separately.
export function assertMatrixSize(originCount, destinationCount) {
  if (!Number.isSafeInteger(originCount) || originCount < 1
    || !Number.isSafeInteger(destinationCount) || destinationCount < 1) {
    throw new Error('Matrix routing requires non-empty origins and destinations arrays.')
  }
  if (destinationCount > Math.floor(100_000 / originCount)) {
    const error = new Error('Matrix routing is limited to 100,000 OD pairs per request; either one-to-many or many-to-one supports up to 100,000 endpoints.')
    error.statusCode = 413
    throw error
  }
}
