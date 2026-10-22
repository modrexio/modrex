// The standard library types JSON.parse and Response.json as any, which switches off
// checking for everything read from the result. Returning unknown makes each caller state
// the shape it reads, through a type assertion or by narrowing.
interface JSON {
    parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown
}

interface Body {
    json(): Promise<unknown>
}
