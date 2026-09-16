type Handler = (event: { event: string; id: number; payload: unknown }) => void

const listeners = new Map<string, Set<Handler>>()
let nextId = 0

export function listen<T>(
    event: string,
    handler: (event: { event: string; id: number; payload: T }) => void
): Promise<() => void> {
    const set = listeners.get(event) ?? new Set()
    listeners.set(event, set)
    set.add(handler as Handler)
    return Promise.resolve(() => {
        set.delete(handler as Handler)
    })
}

export function emit(event: string, payload?: unknown): Promise<void> {
    const id = ++nextId
    for (const handler of listeners.get(event) ?? []) handler({ event, id, payload })
    return Promise.resolve()
}
