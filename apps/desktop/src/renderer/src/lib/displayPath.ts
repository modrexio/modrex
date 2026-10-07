// Resource paths bind filesystem checks, so format only visible text.
export function displayPath(path: string): string {
    if (/^\\\\\?\\UNC\\/i.test(path)) return '\\\\' + path.slice(8)
    if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4)
    return path
}
