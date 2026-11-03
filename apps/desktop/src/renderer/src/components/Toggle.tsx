interface Props {
    checked: boolean
    onChange: (checked: boolean) => void
    disabled?: boolean
    title?: string
}

// Each radius is half the part's height times the corner scale. That is a pill at the default,
// stays one above it because a radius past half the height still draws a pill, and squares off
// toward the sharp end of the corner setting.
export function Toggle({ checked, onChange, disabled, title }: Props) {
    return (
        <button
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            title={title}
            onClick={() => onChange(!checked)}
            className={`relative shrink-0 w-9 h-5 rounded-[calc(10px*var(--modrex-radius-scale))] transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none ${
                checked ? 'bg-accent' : 'bg-surface-active'
            }`}
        >
            <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-[calc(8px*var(--modrex-radius-scale))] bg-white shadow-sm transition-transform duration-200 ${
                    checked ? 'translate-x-4' : 'translate-x-0'
                }`}
            />
        </button>
    )
}
