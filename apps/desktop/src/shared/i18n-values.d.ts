export const TARGET_VALUE_KIND: Readonly<{
    ABSENT: 'absent'
    ACCEPTED: 'accepted'
    PENDING: 'pending'
    UNTRANSLATED_SCAFFOLD: 'untranslated-scaffold'
}>

export const UNTRANSLATED_PREFIX: '! '
export const PENDING_PREFIX: '? '

export type SourceValue = {
    kind: 'source'
    sourceText: string
    placeholderContract: string[]
}

export type TargetValue =
    | { kind: 'absent' }
    | { kind: 'untranslated-scaffold'; sourceText: string }
    | { kind: 'pending'; targetText: string; placeholderContract: string[] }
    | { kind: 'accepted'; targetText: string; placeholderContract: string[] }

export function placeholderContract(text: string): string[]
export function placeholderDifferences(
    expected: readonly string[],
    actual: readonly string[]
): { missing: string[]; unexpected: string[] }
export function parseSourceValue(sourceText: string): SourceValue
export function parseTargetValue(storedValue: string | undefined): TargetValue
export function resolveTargetValue(sourceValue: SourceValue, targetValue: TargetValue): string
