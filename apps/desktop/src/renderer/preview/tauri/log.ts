export const error = (message: string) => Promise.resolve(console.error(message))
export const warn = (message: string) => Promise.resolve(console.warn(message))
export const info = (message: string) => Promise.resolve(console.info(message))
export const debug = (message: string) => Promise.resolve(console.debug(message))
