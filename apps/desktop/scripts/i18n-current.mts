import {
    parseSourceValue,
    parseTargetValue,
    placeholderDifferences,
    TARGET_VALUE_KIND,
    UNTRANSLATED_PREFIX,
    type TargetValue,
} from '../src/shared/i18n-values.mts'
import { inspectUnicode, type UnicodeFinding } from './i18n-diagnostics.mts'
import type { LocaleBundle } from './i18n-files.mts'
import type { Inspection } from './i18n-inspection.mts'

type IssueContext = { key?: string; message?: string; detail?: string }
export type LocaleIssue = IssueContext &
    (
        | {
              type:
                  | 'invalid-root'
                  | 'empty-source'
                  | 'empty'
                  | 'invalid-value'
                  | 'invalid-marker'
                  | 'empty-marker'
                  | 'invalid-json'
                  | 'obsolete-target'
              localeValue?: unknown
          }
        | { type: 'unknown-key'; key: string; localeValue: string }
        | { type: 'stale-scaffold'; key: string; sourceValue: string; localeValue: string }
        | {
              type: 'placeholder' | 'pending-placeholder'
              key: string
              sourceValue: string
              localeValue: string
              missing: string[]
              unexpected: string[]
          }
        | ({ type: 'unicode'; key: string } & UnicodeFinding)
    )
export type FillPlan =
    | { errors: LocaleIssue[] }
    | {
          errors: []
          bundle: LocaleBundle
          addedScaffolds: number
          refreshedScaffolds: number
          removedScaffolds: number
      }

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function flattenBundle(
    value: unknown,
    localeId: string,
    errors: string[],
    prefix = '',
    issues: LocaleIssue[] = []
): Record<string, string> {
    const flat: Record<string, string> = Object.create(null)
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

function appendUnicodeFindings(
    value: string,
    key: string,
    localeId: string,
    source: boolean,
    errors: string[],
    issues: LocaleIssue[],
    warnings: LocaleIssue[]
) {
    for (const finding of inspectUnicode(value, { source })) {
        const diagnostic: LocaleIssue = { type: 'unicode', key, ...finding }
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

function parseTargetForInspection(
    id: string,
    key: string,
    storedValue: string | undefined,
    errors: string[],
    issues: LocaleIssue[]
): TargetValue | undefined {
    try {
        return parseTargetValue(storedValue)
    } catch (error) {
        errors.push(
            `'${id}' key '${key}' has invalid workflow marker syntax: ${error instanceof Error ? error.message : String(error)}`
        )
        issues.push({
            type: 'invalid-marker',
            key,
            localeValue: storedValue,
            detail: error instanceof Error ? error.message : String(error),
        })
        return undefined
    }
}

function placeholderIssue(
    key: string,
    sourceText: string,
    targetText: string,
    targetContract: string[],
    sourceContract: string[]
) {
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

function workflowMarkerPayload(targetValue: TargetValue | undefined) {
    if (targetValue?.kind === TARGET_VALUE_KIND.PENDING) return targetValue.targetText
    if (targetValue?.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
        return targetValue.sourceText
    }
    return undefined
}

export function inspectSourceBundle(bundle: unknown, id: string) {
    const errors: string[] = []
    const issues: LocaleIssue[] = []
    const warnings: LocaleIssue[] = []
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

// Issues the synchronizer resolves by itself. A scaffold quoting superseded English gets
// refreshed and an obsolete key holding only a scaffold gets removed, so neither is a
// contributor's problem. An obsolete key holding real translated text is not in this set:
// nothing may delete a translation mechanically.
export function isMechanicalSyncDebt(
    locale: Pick<LocaleInspection, 'targetValues'>,
    issue: LocaleIssue
) {
    if (issue.type === 'stale-scaffold') return true
    if (issue.type !== 'unknown-key') return false
    return locale.targetValues[issue.key!]?.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD
}

export function singularPluralPairs(sourceKeys: string[]) {
    return sourceKeys
        .filter((key) => key.endsWith('Single'))
        .map((single): [string, string] => [single.slice(0, -'Single'.length), single])
        .filter(([plural]) => sourceKeys.includes(plural))
}

export function inspectTranslationBundle(
    id: string,
    bundle: unknown,
    sourceFlat: Record<string, string>,
    sourceKeys: string[]
) {
    const errors: string[] = []
    const issues: LocaleIssue[] = []
    const warnings: LocaleIssue[] = []
    const reviewNotices: LocaleIssue[] = []
    const bundleFlat = flattenBundle(bundle, id, errors, '', issues)
    const targetValues: Record<string, TargetValue | undefined> = Object.create(null)
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

    for (const key of extraKeys) {
        const message = `'${id}' key '${key}' is not present in en.json`
        errors.push(message)
        issues.push({ type: 'unknown-key', key, localeValue: bundleFlat[key]!, message })
    }

    const pendingPlaceholderIncompatibleKeys = []
    for (const key of sourceKeys) {
        const sourceValue = parseSourceValue(sourceFlat[key]!)
        const targetValue = targetValues[key]
        if (!targetValue) continue
        if (workflowMarkerPayload(targetValue)?.trim().length === 0) continue

        if (targetValue.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
            if (targetValue.sourceText === sourceValue.sourceText) continue
            const message = `'${id}' key '${key}' has a stale untranslated scaffold`
            errors.push(message)
            issues.push({
                type: 'stale-scaffold',
                key,
                sourceValue: sourceValue.sourceText,
                localeValue: targetValue.sourceText,
                message,
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

        const message = `'${id}' key '${key}' has interpolation vars [${targetValue.placeholderContract.join(',')}], expected [${sourceValue.placeholderContract.join(',')}]`
        errors.push(message)
        issues.push({ type: 'placeholder', ...placeholder, message })
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

export function buildOrderedLocale(
    source: LocaleBundle,
    translated: Record<string, string>,
    prefix = ''
): LocaleBundle {
    const locale: LocaleBundle = {}
    for (const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'string') {
            if (Object.hasOwn(translated, path)) locale[key] = translated[path]!
            continue
        }

        const child = buildOrderedLocale(value, translated, path)
        if (Object.keys(child).length > 0) locale[key] = child
    }
    return locale
}

export function planFilledLocale(inspection: Inspection, locale: LocaleInspection): FillPlan {
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

    const strings: Record<string, string> = Object.create(null)
    let addedScaffolds = 0
    let refreshedScaffolds = 0
    for (const key of inspection.sourceKeys) {
        const targetValue = locale.targetValues[key]
        if (
            targetValue?.kind === TARGET_VALUE_KIND.ACCEPTED ||
            targetValue?.kind === TARGET_VALUE_KIND.PENDING
        ) {
            strings[key] = locale.strings[key]!
            continue
        }

        strings[key] = `${UNTRANSLATED_PREFIX}${inspection.sourceStrings[key]}`
        if (targetValue?.kind === TARGET_VALUE_KIND.ABSENT) addedScaffolds += 1
        else if (targetValue?.sourceText !== inspection.sourceStrings[key]) refreshedScaffolds += 1
    }

    return {
        errors: [],
        bundle: buildOrderedLocale(inspection.sourceBundle as LocaleBundle, strings),
        addedScaffolds,
        refreshedScaffolds,
        removedScaffolds: locale.extraKeys.length,
    }
}

export type LocaleInspection = ReturnType<typeof inspectTranslationBundle> & { bundle?: unknown }
