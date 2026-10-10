import { useImperativeHandle, useLayoutEffect, useRef, type ComponentProps } from 'react'
import { overlayScrollbar } from '@modrex/scrollbars'

type Props = ComponentProps<'div'> & { hostClassName?: string }

export function ScrollArea({ children, hostClassName, ref, ...props }: Props) {
    const host = useRef<HTMLDivElement>(null)
    const viewport = useRef<HTMLDivElement>(null)

    useImperativeHandle(ref, () => viewport.current!, [])
    useLayoutEffect(() => {
        const instance = overlayScrollbar(viewport.current!, host.current!)
        return () => instance.destroy()
    }, [])

    return (
        <div ref={host} className={`modrex-scrollbar-host ${hostClassName ?? ''}`}>
            <div {...props} ref={viewport}>
                {children}
            </div>
        </div>
    )
}
