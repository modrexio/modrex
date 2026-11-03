import { useRef } from 'react'
import { RotateCcw } from 'lucide-react'
import { t } from '../i18n'
import {
    CORNER_POSITION_MAX,
    DEFAULT_CORNER_POSITION,
    DEFAULT_CORNER_SCALE,
    cornerPositionFromScale,
    cornerScaleFromPosition,
    setCornerScale,
    useCornerScale,
} from '../cornerRadius'
import { cn } from '../lib/cn'
import { SettingsSection as Section } from './SettingsSection'
import { Slider } from './Slider'
import { Tooltip } from './Tooltip'
import { Button } from './ui/Button'

function CornerGlyph({ round }: { round: boolean }) {
    return (
        <svg
            viewBox="0 0 16 16"
            aria-hidden
            className="w-3.5 h-3.5 shrink-0 text-text-subtle"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
        >
            <path d={round ? 'M3 13V9a6 6 0 0 1 6-6h4' : 'M3 13V3h10'} />
        </svg>
    )
}

export function CornerRadiusSetting() {
    const scale = useCornerScale()
    const thumbRef = useRef<HTMLSpanElement>(null)
    const atDefault = scale === DEFAULT_CORNER_SCALE
    const valueText = atDefault
        ? t('settings.cornerRadius.default')
        : t('settings.cornerRadius.percent', { percent: Math.round(scale * 100) })

    return (
        <Section
            title={t('settings.cornerRadius.title')}
            description={t('settings.cornerRadius.description')}
        >
            <div className="mt-1 flex items-center gap-4">
                <div className="flex w-64 items-center gap-2.5">
                    <CornerGlyph round={false} />
                    <Slider
                        className="grow"
                        value={cornerPositionFromScale(scale)}
                        min={0}
                        max={CORNER_POSITION_MAX}
                        mark={DEFAULT_CORNER_POSITION}
                        onChange={(position) => setCornerScale(cornerScaleFromPosition(position))}
                        ariaLabel={t('settings.cornerRadius.title')}
                        ariaValueText={valueText}
                        thumbRef={thumbRef}
                    />
                    <CornerGlyph round />
                </div>
                {/* Kept in the layout while hidden so the bar does not shift when it appears. */}
                <Tooltip content={t('settings.cornerRadius.reset')}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            'focus-visible:ring-2 focus-visible:ring-accent/60',
                            atDefault && 'invisible'
                        )}
                        aria-label={t('settings.cornerRadius.reset')}
                        onClick={() => {
                            setCornerScale(DEFAULT_CORNER_SCALE)
                            // The button hides itself at the default, so focus would fall to the page.
                            thumbRef.current?.focus()
                        }}
                    >
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden />
                    </Button>
                </Tooltip>
            </div>
        </Section>
    )
}
