import { createInterface } from 'node:readline/promises'

export type CliOutput = { write(text: string): unknown; isTTY?: boolean; columns?: number }
export type CliIO = { stdout?: CliOutput; stderr?: CliOutput; env?: NodeJS.ProcessEnv }
export type Ask = (question: string) => Promise<string>

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

// readline leaves a pending question unsettled when input that is not a terminal ends, so
// Node exits with code 13 and Bun waits forever. Aborting on the stream's end turns that into
// an error. Ctrl+C in a terminal does not end the stream and keeps readline's own rejection.
export async function withPrompt<T>(
    stdin: NodeJS.ReadableStream,
    stdout: CliOutput,
    run: (ask: Ask) => Promise<T>
) {
    const input = createInterface({ input: stdin, output: stdout as NodeJS.WritableStream })
    const ended = new AbortController()
    const abort = () => ended.abort()
    stdin.once('end', abort)
    try {
        return await run(async (question) => {
            try {
                return await input.question(question, { signal: ended.signal })
            } catch (error) {
                if (!ended.signal.aborted) throw error
                throw new Error(
                    'Input ended before the session finished. Progress already written remains saved.',
                    { cause: error }
                )
            }
        })
    } finally {
        stdin.removeListener('end', abort)
        input.close()
    }
}
