const HARD_CONTROL_RANGES = [
    [0x0000, 0x0008],
    [0x000b, 0x000c],
    [0x000e, 0x001f],
    [0x007f, 0x009f],
]

const BIDI_CONTROLS = new Set([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])

const CODE_POINT_NAMES = new Map([
    [0x0000, 'NUL'],
    [0x000d, 'carriage return'],
    [0x00a0, 'no-break space'],
    [0x00ad, 'soft hyphen'],
    [0x061c, 'Arabic letter mark'],
    [0x200b, 'zero-width space'],
    [0x200c, 'zero-width non-joiner'],
    [0x200d, 'zero-width joiner'],
    [0x2026, 'horizontal ellipsis'],
    [0x2014, 'em dash'],
    [0x202f, 'narrow no-break space'],
    [0x2060, 'word joiner'],
    [0x2192, 'rightwards arrow'],
    [0xfeff, 'byte order mark'],
    [0xfffd, 'replacement character'],
])

function codePointLabel(codePoint) {
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

function isInRanges(codePoint, ranges) {
    return ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
}

function isPrivateUse(codePoint) {
    return (
        (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
        (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
        (codePoint >= 0x100000 && codePoint <= 0x10fffd)
    )
}

function finding(severity, codePoint, position, description) {
    return {
        severity,
        codePoint: codePointLabel(codePoint),
        name: CODE_POINT_NAMES.get(codePoint),
        position,
        description,
    }
}

export function inspectUnicode(value, { source = false } = {}) {
    const findings = []
    let position = 0
    for (const character of value) {
        const codePoint = character.codePointAt(0)
        if (
            isInRanges(codePoint, HARD_CONTROL_RANGES) ||
            codePoint === 0xfeff ||
            codePoint === 0xfffd
        ) {
            findings.push(finding('error', codePoint, position, 'unsafe Unicode code point'))
        } else if (codePoint === 0x000d) {
            findings.push(finding('warning', codePoint, position, 'use LF line endings in values'))
        } else if (BIDI_CONTROLS.has(codePoint)) {
            findings.push(
                finding(
                    source ? 'error' : 'warning',
                    codePoint,
                    position,
                    source
                        ? 'bidirectional control is not allowed in English source text'
                        : 'bidirectional control requires locale-specific review'
                )
            )
        } else if ([0x200b, 0x2060, 0x00ad].includes(codePoint)) {
            findings.push(finding('warning', codePoint, position, 'invisible formatting character'))
        } else if (source && [0x200c, 0x200d, 0x00a0, 0x202f].includes(codePoint)) {
            findings.push(
                finding('warning', codePoint, position, 'unusual character in English source text')
            )
        } else if (isPrivateUse(codePoint)) {
            findings.push(finding('warning', codePoint, position, 'private-use character'))
        }
        position += character.length
    }

    if (value !== value.normalize('NFC')) {
        findings.push({
            severity: 'warning',
            description: 'text is not NFC-normalized',
        })
    }

    if (source) {
        for (const [character, description] of [
            ['…', "prefer '...' over U+2026 horizontal ellipsis"],
            ['—', 'review U+2014 em dash punctuation'],
            ['→', "use '>' for simple textual navigation paths"],
        ]) {
            if (!value.includes(character)) continue
            findings.push({ severity: 'warning', description })
        }
    }

    return findings
}
