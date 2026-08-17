import {
    parseSourceValue,
    parseTargetValue,
    placeholderDifferences,
    TARGET_VALUE_KIND,
    UNTRANSLATED_PREFIX,
} from '../src/shared/i18n-values.js'
import { inspectUnicode } from './i18n-diagnostics.mjs'

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function flattenBundle(value, localeId, errors, prefix = '', issues = []) {
    const flat = Object.create(null)
    if (!isPlainObject(value)) {
        errors.push(`'${localeId}' must contain a JSON object`)
        issues.push({ type: 'invalid-root' })
        return flat
    }

    for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof child === 'string') {
            if (child.trim().length === 0) {
                errors.push(`'${localeId}' key '${path}' is empty`)
                issues.push({ type: 'empty', key: path })
            }
            flat[path] = child
            continue
        }
        if (isPlainObject(child)) {
            Object.assign(flat, flattenBundle(child, localeId, errors, path, issues))
            continue
        }
        errors.push(`'${localeId}' key '${path}' must be a string or object`)
        issues.push({ type: 'invalid-value', key: path })
    }
    return flat
}

function appendUnicodeFindings(value, key, localeId, source, errors, issues, warnings) {
    for (const finding of inspectUnicode(value, { source })) {
        const diagnostic = { type: 'unicode', key, ...finding }
        if (finding.severity === 'error') {
            errors.push(
                `'${localeId}' key '${key}' contains ${finding.codePoint ?? finding.description}`
            )
            issues.push(diagnostic)
        } else {
            warnings.push(diagnostic)
        }
    }
}

function parseTargetForInspection(id, key, storedValue, errors, issues) {
    try {
        return parseTargetValue(storedValue)
    } catch (error) {
        errors.push(`'${id}' key '${key}' has invalid workflow marker syntax: ${error.message}`)
        issues.push({
            type: 'invalid-marker',
            key,
            localeValue: storedValue,
            detail: error.message,
        })
        return undefined
    }
}

function placeholderIssue(key, sourceText, targetText, targetContract, sourceContract) {
    const { missing, unexpected } = placeholderDifferences(sourceContract, targetContract)
    if (missing.length === 0 && unexpected.length === 0) return undefined
    return {
        key,
        sourceValue: sourceText,
        localeValue: targetText,
        missing,
        unexpected,
    }
}

function workflowMarkerPayload(targetValue) {
    if (targetValue?.kind === TARGET_VALUE_KIND.PENDING) return targetValue.targetText
    if (targetValue?.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
        return targetValue.sourceText
    }
    return undefined
}

export function inspectSourceBundle(bundle, id) {
    const errors = []
    const issues = []
    const warnings = []
    const strings = flattenBundle(bundle, id, errors, '', issues)
    const keys = Object.keys(strings)
    if (keys.length === 0) {
        errors.push(`Source locale '${id}' has no strings`)
        issues.push({ type: 'empty-source' })
    }
    for (const [key, value] of Object.entries(strings)) {
        appendUnicodeFindings(value, key, id, true, errors, issues, warnings)
    }
    return { errors, issues, warnings, strings, keys }
}

export function singularPluralPairs(sourceKeys) {
    return sourceKeys
        .filter((key) => key.endsWith('Single'))
        .map((single) => [single.slice(0, -'Single'.length), single])
        .filter(([plural]) => sourceKeys.includes(plural))
}

export function inspectTranslationBundle(id, bundle, sourceFlat, sourceKeys) {
    const errors = []
    const issues = []
    const warnings = []
    const reviewNotices = []
    const bundleFlat = flattenBundle(bundle, id, errors, '', issues)
    const targetValues = Object.create(null)
    for (const key of sourceKeys) {
        targetValues[key] = parseTargetForInspection(id, key, bundleFlat[key], errors, issues)
    }
    for (const [key, value] of Object.entries(bundleFlat)) {
        if (!Object.hasOwn(targetValues, key)) {
            targetValues[key] = parseTargetForInspection(id, key, value, errors, issues)
        }
        appendUnicodeFindings(value, key, id, false, errors, issues, warnings)
    }

    for (const key of sourceKeys) {
        const markerPayload = workflowMarkerPayload(targetValues[key])
        if (markerPayload === undefined || markerPayload.trim().length > 0) continue
        errors.push(`'${id}' key '${key}' has an empty workflow marker payload`)
        issues.push({ type: 'empty-marker', key, localeValue: bundleFlat[key] })
    }

    const acceptedKeys = sourceKeys.filter(
        (key) => targetValues[key]?.kind === TARGET_VALUE_KIND.ACCEPTED
    )
    const pendingKeys = sourceKeys.filter(
        (key) => targetValues[key]?.kind === TARGET_VALUE_KIND.PENDING
    )
    const missingKeys = sourceKeys.filter((key) => {
        const kind = targetValues[key]?.kind
        return kind === TARGET_VALUE_KIND.ABSENT || kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD
    })
    const extraKeys = Object.keys(bundleFlat).filter((key) => !Object.hasOwn(sourceFlat, key))

    if (extraKeys.length > 0) {
        errors.push(`'${id}' has key(s) not present in en.json:\n  ${extraKeys.join('\n  ')}`)
        for (const key of extraKeys) {
            issues.push({ type: 'unknown-key', key, localeValue: bundleFlat[key] })
        }
    }

    const pendingPlaceholderIncompatibleKeys = []
    for (const key of sourceKeys) {
        const sourceValue = parseSourceValue(sourceFlat[key])
        const targetValue = targetValues[key]
        if (!targetValue) continue
        if (workflowMarkerPayload(targetValue)?.trim().length === 0) continue

        if (targetValue.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
            if (targetValue.sourceText === sourceValue.sourceText) continue
            errors.push(`'${id}' key '${key}' has a stale untranslated scaffold`)
            issues.push({
                type: 'stale-scaffold',
                key,
                sourceValue: sourceValue.sourceText,
                localeValue: targetValue.sourceText,
            })
            continue
        }

        if (
            targetValue.kind !== TARGET_VALUE_KIND.ACCEPTED &&
            targetValue.kind !== TARGET_VALUE_KIND.PENDING
        ) {
            continue
        }

        const placeholder = placeholderIssue(
            key,
            sourceValue.sourceText,
            targetValue.targetText,
            targetValue.placeholderContract,
            sourceValue.placeholderContract
        )
        if (!placeholder) continue

        if (targetValue.kind === TARGET_VALUE_KIND.PENDING) {
            pendingPlaceholderIncompatibleKeys.push(key)
            reviewNotices.push({ type: 'pending-placeholder', ...placeholder })
            continue
        }

        errors.push(
            `'${id}' key '${key}' has interpolation vars [${targetValue.placeholderContract.join(',')}], expected [${sourceValue.placeholderContract.join(',')}]`
        )
        issues.push({ type: 'placeholder', ...placeholder })
    }

    const translatedKeys = sourceKeys.filter((key) => {
        const kind = targetValues[key]?.kind
        return kind === TARGET_VALUE_KIND.ACCEPTED || kind === TARGET_VALUE_KIND.PENDING
    })

    return {
        id,
        errors,
        issues,
        warnings,
        reviewNotices,
        strings: bundleFlat,
        targetValues,
        acceptedKeys,
        pendingKeys,
        pendingPlaceholderIncompatibleKeys,
        translatedKeys,
        missingKeys,
        extraKeys,
        translatedCount: translatedKeys.length,
        acceptedCount: acceptedKeys.length,
        pendingCount: pendingKeys.length,
        pendingPlaceholderIncompatibleCount: pendingPlaceholderIncompatibleKeys.length,
        missingCount: missingKeys.length,
        totalCount: sourceKeys.length,
    }
}

export function buildOrderedLocale(source, translated, prefix = '') {
    const locale = {}
    for (const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'string') {
            if (Object.hasOwn(translated, path)) locale[key] = translated[path]
            continue
        }

        const child = buildOrderedLocale(value, translated, path)
        if (Object.keys(child).length > 0) locale[key] = child
    }
    return locale
}

export function planFilledLocale(inspection, locale) {
    const blockingIssues = locale.issues.filter((issue) => {
        if (issue.type === 'stale-scaffold') return false
        return issue.type !== 'unknown-key'
    })
    if (blockingIssues.length > 0) {
        return { errors: blockingIssues }
    }

    const obsoleteTargetKeys = locale.extraKeys.filter((key) => {
        const kind = locale.targetValues[key]?.kind
        return kind === TARGET_VALUE_KIND.ACCEPTED || kind === TARGET_VALUE_KIND.PENDING
    })
    if (obsoleteTargetKeys.length > 0) {
        return {
            errors: obsoleteTargetKeys.map((key) => ({
                type: 'obsolete-target',
                key,
                localeValue: locale.strings[key],
            })),
        }
    }

    const strings = Object.create(null)
    let addedScaffolds = 0
    let refreshedScaffolds = 0
    for (const key of inspection.sourceKeys) {
        const targetValue = locale.targetValues[key]
        if (
            targetValue?.kind === TARGET_VALUE_KIND.ACCEPTED ||
            targetValue?.kind === TARGET_VALUE_KIND.PENDING
        ) {
            strings[key] = locale.strings[key]
            continue
        }

        strings[key] = `${UNTRANSLATED_PREFIX}${inspection.sourceStrings[key]}`
        if (targetValue?.kind === TARGET_VALUE_KIND.ABSENT) addedScaffolds += 1
        else if (targetValue?.sourceText !== inspection.sourceStrings[key]) refreshedScaffolds += 1
    }

    return {
        errors: [],
        bundle: buildOrderedLocale(inspection.sourceBundle, strings),
        addedScaffolds,
        refreshedScaffolds,
        removedScaffolds: locale.extraKeys.length,
    }
}
