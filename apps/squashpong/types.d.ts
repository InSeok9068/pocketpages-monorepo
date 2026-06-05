declare namespace types {
  type SquashpongCandidate = Record<string, any>

  type SquashpongRoom = {
    code: string
    speedMode: 'normal' | 'fast' | 'turbo'
    createdAt: string
    updatedAt: string
    offer: Record<string, any> | null
    answer: Record<string, any> | null
    hostCandidates: SquashpongCandidate[]
    guestCandidates: SquashpongCandidate[]
  }
}
