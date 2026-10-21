// Prioritize point queries (including departure windows) among query jobs. Preparation
// and unknown operations are ordering barriers; analytical work gets a turn
// after at most four bypasses. Running native work is never interrupted here.
const pointOperations = new Set(['route', 'street-route', 'window'])
const queryOperations = new Set([...pointOperations, 'street-route-batch'])
export const maximumPointBypasses = 4

export function takeRoutingJob(queue, fairness) {
  let index = 0
  if (queryOperations.has(queue[0]?.operation)
    && !pointOperations.has(queue[0].operation)
    && fairness.bypasses < maximumPointBypasses) {
    for (let i = 1; i < queue.length; i += 1) {
      if (!queryOperations.has(queue[i].operation)) break
      if (pointOperations.has(queue[i].operation)) {
        index = i
        break
      }
    }
  }
  fairness.bypasses = index > 0 ? fairness.bypasses + 1 : 0
  return queue.splice(index, 1)[0]
}
