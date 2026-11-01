import type { Ref } from 'react'
import * as RadixSlider from '@radix-ui/react-slider'
import { cn } from '../lib/cn'

interface Props {
    value: number
    min: number
    max: number
    onChange: (value: number) => void
    /** A position marked on the track, such as the default. */
    mark?: number
    ariaLabel: string
    ariaValueText: string
    thumbRef?: Ref<HTMLSpanElement>
    className?: string
}

export function Slider({
    value,
    min,
    max,
    onChange,
    mark,
    ariaLabel,
    ariaValueText,
    thumbRef,
    className,
}: Props) {
    return (
        <RadixSlider.Root
            value={[value]}
            min={min}
            max={max}
            step={1}
            // Radix reports one value per thumb, and this slider renders exactly one.
            onValueChange={([next]) => onChange(next!)}
            className={cn(
                'relative flex h-5 cursor-pointer touch-none select-none items-center',
                className
            )}
        >
            {/* Track and knob follow the corner scale the way Toggle does, see the note there. */}
            <RadixSlider.Track className="relative h-1 grow overflow-hidden rounded-[calc(2px*var(--modrex-radius-scale))] bg-surface-active">
                <RadixSlider.Range className="absolute h-full bg-accent" />
            </RadixSlider.Track>
            {mark !== undefined && (
                <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-light ring-1 ring-surface"
                    style={{ left: `${((mark - min) / (max - min)) * 100}%` }}
                />
            )}
            <RadixSlider.Thumb
                ref={thumbRef}
                aria-label={ariaLabel}
                aria-valuetext={ariaValueText}
                className="block h-4 w-4 bg-white shadow-sm"
                // Inline, because the global focus-visible rule in index.css sets a smaller radius
                // on whatever has focus and would change the knob's shape while it is keyboard driven.
                style={{ borderRadius: 'calc(8px * var(--modrex-radius-scale))' }}
            />
        </RadixSlider.Root>
    )
}
