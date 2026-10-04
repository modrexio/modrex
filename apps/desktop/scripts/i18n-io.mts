export type CliOutput = { write(text: string): unknown; isTTY?: boolean; columns?: number }
export type CliIO = { stdout?: CliOutput; stderr?: CliOutput; env?: NodeJS.ProcessEnv }

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
