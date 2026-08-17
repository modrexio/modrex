export const TARGET_VALUE_KIND = Object.freeze({
    ABSENT: 'absent',
    ACCEPTED: 'accepted',
    PENDING: 'pending',
    UNTRANSLATED_SCAFFOLD: 'untranslated-scaffold',
})

export const PENDING_PREFIX = '? '
export const UNTRANSLATED_PREFIX = '! '

export function placeholderContract(text) {
    return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

function missingPlaceholders(expected, actual) {
    const remaining = [...actual]
    return expected.filter((name) => {
        const index = remaining.indexOf(name)
        if (index === -1) return true
        remaining.splice(index, 1)
        return false
    })
}

export function placeholderDifferences(expected, actual) {
    return {
        missing: missingPlaceholders(expected, actual),
        unexpected: missingPlaceholders(actual, expected),
    }
}

export function parseSourceValue(sourceText) {
    if (typeof sourceText !== 'string') {
        throw new TypeError('Source locale values must be strings')
    }

    return {
        kind: 'source',
        sourceText,
        placeholderContract: placeholderContract(sourceText),
    }
}

export function parseTargetValue(storedValue) {
    if (storedValue === undefined) return { kind: TARGET_VALUE_KIND.ABSENT }
    if (typeof storedValue !== 'string') {
        throw new TypeError('Target locale values must be strings or absent')
    }

    if (storedValue.startsWith(UNTRANSLATED_PREFIX)) {
        const sourceText = storedValue.slice(UNTRANSLATED_PREFIX.length)
        if (sourceText.length === 0) {
            throw new Error('Untranslated scaffold payload must not be empty')
        }
        return { kind: TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD, sourceText }
    }

    if (storedValue.startsWith(PENDING_PREFIX)) {
        const targetText = storedValue.slice(PENDING_PREFIX.length)
        if (targetText.length === 0) {
            throw new Error('Pending target payload must not be empty')
        }
        if (targetText.startsWith(UNTRANSLATED_PREFIX) || targetText.startsWith(PENDING_PREFIX)) {
            throw new Error('Pending target payload must not begin with a workflow marker')
        }
        return {
            kind: TARGET_VALUE_KIND.PENDING,
            targetText,
            placeholderContract: placeholderContract(targetText),
        }
    }

    return {
        kind: TARGET_VALUE_KIND.ACCEPTED,
        targetText: storedValue,
        placeholderContract: placeholderContract(storedValue),
    }
}

export function resolveTargetValue(sourceValue, targetValue) {
    if (
        targetValue.kind === TARGET_VALUE_KIND.ABSENT ||
        targetValue.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD
    ) {
        return sourceValue.sourceText
    }

    const { missing, unexpected } = placeholderDifferences(
        sourceValue.placeholderContract,
        targetValue.placeholderContract
    )
    if (missing.length > 0 || unexpected.length > 0) return sourceValue.sourceText
    return targetValue.targetText
}
