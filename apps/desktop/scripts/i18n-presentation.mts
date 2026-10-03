import type { Inspection } from './i18n-inspection.mts'
import type { LocaleInspection } from './i18n-current.mts'

export type SourceStatusSummary = { kind: 'source'; locale: string; total: number }
export type TargetStatusSummary = {
    kind: 'target'
    locale: string
    total: number
    accepted: number
    pendingCompatible: number
    pendingPlaceholderIncompatible: number
    missing: number
}

const SOURCE_LOCALE = 'en'

function assertCount(name: string, value: number) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid presentation count '${name}': ${value}`)
    }
    return value
}

function assertSummaryInvariant(summary: TargetStatusSummary) {
    const counts = [
        'accepted',
        'pendingCompatible',
        'pendingPlaceholderIncompatible',
        'missing',
    ] as const
    for (const name of counts) assertCount(name, summary[name])
    assertCount('total', summary.total)
    if (summary.total <= 0) throw new Error(`Invalid presentation total: ${summary.total}`)
    const counted = counts.reduce((sum, name) => sum + summary[name], 0)
    if (counted !== summary.total) {
        throw new Error(
            `Presentation count invariant failed for '${summary.locale}': ${counted} !== ${summary.total}`
        )
    }
}

export function formatPresentationPercentage(translated: number, total: number) {
    assertCount('translated', translated)
    assertCount('total', total)
    if (total <= 0 || translated > total) {
        throw new Error(`Invalid presentation percentage inputs: ${translated}/${total}`)
    }
    const percentage = Math.round((translated / total) * 1000) / 10
    return Number.isInteger(percentage) ? `${percentage}%` : `${percentage.toFixed(1)}%`
}

export function buildSourceStatusSummary(inspection: Inspection): SourceStatusSummary {
    if (inspection.sourceErrors.length > 0) {
        throw new Error(`Source validation failed:\n${inspection.sourceErrors.join('\n')}`)
    }
    const summary: SourceStatusSummary = {
        kind: 'source',
        locale: SOURCE_LOCALE,
        total: inspection.totalCount,
    }
    assertCount('total', summary.total)
    if (summary.total <= 0) throw new Error('Source presentation total must be positive')
    return summary
}

export function buildTargetStatusSummary(
    locale: LocaleInspection,
    total: number
): TargetStatusSummary {
    const pendingPlaceholderIncompatible = locale.pendingPlaceholderIncompatibleCount
    const summary: TargetStatusSummary = {
        kind: 'target',
        locale: locale.id,
        total,
        accepted: locale.acceptedCount,
        pendingCompatible: locale.pendingCount - pendingPlaceholderIncompatible,
        pendingPlaceholderIncompatible,
        missing: locale.missingCount,
    }
    assertSummaryInvariant(summary)
    return summary
}

export function buildStatusSummaries(inspection: Inspection) {
    const source = buildSourceStatusSummary(inspection)
    if (inspection.locales.some((locale) => locale.errors.length > 0)) {
        const errors = inspection.locales.flatMap((locale) => locale.errors)
        throw new Error(`Target validation failed:\n${errors.join('\n')}`)
    }
    return {
        source,
        targets: inspection.locales.map((locale) => buildTargetStatusSummary(locale, source.total)),
    }
}

export function deriveTargetStatus(summary: TargetStatusSummary) {
    assertSummaryInvariant(summary)
    const pending = summary.pendingCompatible + summary.pendingPlaceholderIncompatible
    const translated = summary.accepted + pending
    const translatedRatio = translated / summary.total
    const translatedPercentage = formatPresentationPercentage(translated, summary.total)
    return {
        ...summary,
        pending,
        translated,
        translatedRatio,
        translatedPercentage,
        usesEnglishFallback: summary.pendingPlaceholderIncompatible,
        label: summary.accepted === summary.total ? 'Complete' : translatedPercentage,
    }
}

export function targetFallbackLabel(count: number) {
    assertCount('fallback', count)
    return `${count} ${count === 1 ? 'uses' : 'use'} English fallback`
}

export type StatusSummaries = ReturnType<typeof buildStatusSummaries>
export type TargetStatus = ReturnType<typeof deriveTargetStatus>
