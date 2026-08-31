export type LatestRequestToken = Readonly<{
  controller: AbortController
  generation: number
}>

export class LatestRequestGate {
  private active: LatestRequestToken | null = null
  private generation = 0

  begin(): LatestRequestToken {
    this.active?.controller.abort()
    const token = {
      controller: new AbortController(),
      generation: this.generation + 1,
    }
    this.generation = token.generation
    this.active = token
    return token
  }

  owns(token: LatestRequestToken) {
    return (
      this.active === token
      && this.generation === token.generation
      && !token.controller.signal.aborted
    )
  }

  cancel(token?: LatestRequestToken) {
    if (token && this.active !== token) return
    this.generation += 1
    this.active?.controller.abort()
    this.active = null
  }

  finish(token: LatestRequestToken) {
    if (this.active === token) this.active = null
  }
}
