export type CliOutput = { write(text: string): unknown; isTTY?: boolean; columns?: number }
export type CliIO = { stdout?: CliOutput; stderr?: CliOutput; env?: NodeJS.ProcessEnv }
