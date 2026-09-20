import { neon } from '@neondatabase/serverless'

export interface Statement {
    text: string
    values: unknown[]
}
export interface Database {
    query<T>(text: string, values?: unknown[]): Promise<T[]>
    transaction(statements: Statement[]): Promise<void>
}

export function connectDatabase(): Database {
    const url = process.env.INDEX_DATABASE_URL
    if (!url) throw new Error('INDEX_DATABASE_URL is required')
    const sql = neon(url)
    return {
        query: async <T>(text: string, values: unknown[] = []) =>
            (await sql.query(text, values)) as T[],
        async transaction(statements) {
            await sql.transaction(statements.map(({ text, values }) => sql.query(text, values)))
        },
    }
}
