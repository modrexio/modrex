export function invoke(cmd: string): Promise<never> {
    return Promise.reject(new Error(`preview: no handler for command ${cmd}`))
}

export function convertFileSrc(filePath: string, protocol = 'asset'): string {
    if (protocol === 'thumb') return `https://storage.modworkshop.net/mods/images/${filePath}`
    throw new Error(`preview: no url for ${protocol}://${filePath}`)
}
