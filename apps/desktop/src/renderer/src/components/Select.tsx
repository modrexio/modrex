import * as RadixSelect from '@radix-ui/react-select'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

// Radix Select.Item rejects empty-string values; use a sentinel internally.
const EMPTY = '__empty__'
const toRadix = (v: string) => v || EMPTY
const fromRadix = (v: string) => (v === EMPTY ? '' : v)

interface Option {
    value: string
    label: string
    icon?: ReactNode
}

interface Props {
    value: string
    onChange: (value: string) => void
    options: Option[]
    placeholder?: string
    disabled?: boolean
    icon?: ReactNode
    ariaLabel?: string
}

export function Select({
    value,
    onChange,
    options,
    placeholder,
    disabled,
    icon,
    ariaLabel,
}: Props) {
    const selected = options.find((o) => o.value === value)

    return (
        <RadixSelect.Root
            value={toRadix(value)}
            onValueChange={(v) => onChange(fromRadix(v))}
            disabled={disabled}
        >
            <RadixSelect.Trigger
                aria-label={ariaLabel}
                className="group text-sm px-3 py-1.5 rounded bg-surface-hover border border-border text-text flex items-center gap-2 hover:bg-surface-active disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
                <span className="flex items-center gap-1.5">
                    {icon}
                    {selected?.icon}
                    <RadixSelect.Value
                        placeholder={
                            placeholder ? (
                                <span className="text-text-subtle">{placeholder}</span>
                            ) : undefined
                        }
                    />
                </span>
                <RadixSelect.Icon asChild>
                    <ChevronDown className="w-3 h-3 text-text-subtle shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                </RadixSelect.Icon>
            </RadixSelect.Trigger>

            <RadixSelect.Portal>
                <RadixSelect.Content
                    position="popper"
                    sideOffset={4}
                    className="z-50 min-w-[var(--radix-select-trigger-width)] bg-surface-raised border border-border rounded shadow-lg overflow-hidden"
                >
                    <RadixSelect.Viewport style={{ maxHeight: '240px' }}>
                        {options.map((o) => (
                            <RadixSelect.Item
                                key={o.value}
                                value={toRadix(o.value)}
                                className="text-sm px-3 py-2 flex items-center gap-1.5 cursor-pointer select-none outline-none text-text data-[state=checked]:bg-accent-fill data-[state=checked]:text-white data-[highlighted]:bg-surface-hover transition-colors"
                            >
                                {o.icon}
                                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                            </RadixSelect.Item>
                        ))}
                    </RadixSelect.Viewport>
                </RadixSelect.Content>
            </RadixSelect.Portal>
        </RadixSelect.Root>
    )
}
