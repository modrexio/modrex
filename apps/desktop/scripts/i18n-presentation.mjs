const SOURCE_LOCALE = 'en'

function assertCount(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid presentation count '${name}': ${value}`)
    }
    return value
}

function assertSummaryInvariant(summary) {
    const counts = ['accepted', 'pendingCompatible', 'pendingPlaceholderIncompatible', 'missing']
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

export function formatPresentationPercentage(translated, total) {
    assertCount('translated', translated)
    assertCount('total', total)
    if (total <= 0 || translated > total) {
        throw new Error(`Invalid presentation percentage inputs: ${translated}/${total}`)
    }
    const percentage = Math.round((translated / total) * 1000) / 10
    return Number.isInteger(percentage) ? `${percentage}%` : `${percentage.toFixed(1)}%`
}

export function buildSourceStatusSummary(inspection) {
    if (inspection.sourceErrors.length > 0) {
        throw new Error(`Source validation failed:\n${inspection.sourceErrors.join('\n')}`)
    }
    const summary = { kind: 'source', locale: SOURCE_LOCALE, total: inspection.totalCount }
    assertCount('total', summary.total)
    if (summary.total <= 0) throw new Error('Source presentation total must be positive')
    return summary
}

export function buildTargetStatusSummary(locale, total) {
    const pendingPlaceholderIncompatible = locale.pendingPlaceholderIncompatibleCount
    const summary = {
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

export function buildStatusSummaries(inspection) {
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

export function deriveTargetStatus(summary) {
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

export function targetFallbackLabel(count) {
    assertCount('fallback', count)
    return `${count} ${count === 1 ? 'uses' : 'use'} English fallback`
}
