import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkLegalDates } from './check-legal-dates.mts'
import { legalContent } from './legal-content.mts'

const PAGE = `---
const LAST_UPDATED = '2026-01-01'
---
<main>
    <h1>Policy</h1>
    <p>Last updated: {formatLastUpdated(LAST_UPDATED)}</p>
    <p>We collect no data.</p>
    <p>Read <a href="/privacy">Privacy Policy</a>.</p>
</main>
<style>p { color: black; }</style>
`
const TERMS = 'apps/site/src/pages/terms.astro'

describe('legalContent', () => {
    it('ignores imports, styling, comments, whitespace and the displayed date', () => {
        const reformatted = PAGE.replace('---\n', '---\nimport Nav from "./Nav.astro"\n')
            .replace('2026-01-01', '2026-01-02')
            .replace(
                '<p>We collect no data.</p>',
                '<!-- note --><p class="body">\n We collect\n no data.\n</p>'
            )
            .replace('color: black', 'color: white')

        expect(legalContent(reformatted)).toBe(legalContent(PAGE))
    })

    it('normalizes preview routing without ignoring changed link destinations', () => {
        const routed = PAGE.replace('href="/privacy"', "href={sitePath('/privacy')}")

        expect(legalContent(routed)).toBe(legalContent(PAGE))
        expect(legalContent(routed.replace("'/privacy'", "'/terms'"))).not.toBe(legalContent(PAGE))
    })

    it('detects changed wording and external policy URLs', () => {
        expect(legalContent(PAGE.replace('no data', 'usage data'))).not.toBe(legalContent(PAGE))
        expect(legalContent(PAGE.replace('/privacy', 'https://example.com/privacy'))).not.toBe(
            legalContent(PAGE)
        )
    })

    it('rejects content it cannot compare safely', () => {
        expect(() => legalContent(PAGE.replace('We collect no data.', '{getPolicy()}'))).toThrow(
            'static text'
        )
        expect(() => legalContent('<p>No main element</p>')).toThrow('no main element')
    })
})

describe('checkLegalDates', () => {
    let repo: string

    function git(...args: string[]) {
        return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    }

    function commit(date: string) {
        git('add', '.')
        execFileSync('git', ['commit', '-qm', 'Update policy fixture'], {
            cwd: repo,
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
                GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
            },
        })
    }

    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'modrex-legal-check-'))
        git('init', '-q')
        git('config', 'user.name', 'Legal date test')
        git('config', 'user.email', 'test@example.invalid')
        git('config', 'commit.gpgsign', 'false')
        git('config', 'core.autocrlf', 'false')
        git('config', 'core.hooksPath', join(repo, 'empty-hooks'))
        mkdirSync(join(repo, 'apps/site/src/pages'), { recursive: true })
        writeFileSync(join(repo, TERMS), PAGE)
        writeFileSync(join(repo, 'apps/site/src/pages/privacy.astro'), PAGE)
        commit('2026-01-01')
    })

    afterEach(() => {
        expect(dirname(repo)).toBe(tmpdir())
        expect(basename(repo)).toMatch(/^modrex-legal-check-/)
        rmSync(repo, { recursive: true, force: true })
    })

    it('allows routing-only changes before and after committing them', () => {
        writeFileSync(
            join(repo, TERMS),
            PAGE.replace('href="/privacy"', "href={sitePath('/privacy')}")
        )

        expect(checkLegalDates(repo, '2026-01-02').failures).toEqual([])
        commit('2026-01-02')
        expect(checkLegalDates(repo, '2026-01-03').failures).toEqual([])
    })

    it('requires a current date for uncommitted wording changes', () => {
        const revised = PAGE.replace('no data', 'usage data')
        writeFileSync(join(repo, TERMS), revised)

        expect(checkLegalDates(repo, '2026-01-02').failures).toHaveLength(1)
        writeFileSync(join(repo, TERMS), revised.replace('2026-01-01', '2026-01-02'))
        expect(checkLegalDates(repo, '2026-01-02').failures).toEqual([])
    })

    it('checks staged wording even when the working tree was reverted', () => {
        writeFileSync(join(repo, TERMS), PAGE.replace('no data', 'usage data'))
        git('add', TERMS)
        writeFileSync(join(repo, TERMS), PAGE)

        expect(checkLegalDates(repo, '2026-01-02').failures[0]).toContain('(index)')
    })

    it('does not let a later formatting commit hide an undated wording change', () => {
        writeFileSync(join(repo, TERMS), PAGE.replace('no data', 'usage data'))
        commit('2026-01-02')
        const formatted = readFileSync(join(repo, TERMS), 'utf8').replace('<p>', '<p class="body">')
        writeFileSync(join(repo, TERMS), formatted)
        commit('2026-01-03')

        const { failures } = checkLegalDates(repo, '2026-01-04')
        expect(failures).toHaveLength(1)
        expect(failures[0]).toContain('legal content changed on 2026-01-02')
    })

    it('keeps a correctly dated wording change valid after later formatting', () => {
        writeFileSync(
            join(repo, TERMS),
            PAGE.replace('no data', 'usage data').replace('2026-01-01', '2026-01-02')
        )
        commit('2026-01-02')
        writeFileSync(
            join(repo, TERMS),
            readFileSync(join(repo, TERMS), 'utf8').replace('color: black', 'color: white')
        )
        commit('2026-01-03')

        expect(checkLegalDates(repo, '2026-01-04').failures).toEqual([])
    })

    it('fails when the stated date is missing, invalid or history is shallow', () => {
        writeFileSync(join(repo, TERMS), PAGE.replace("const LAST_UPDATED = '2026-01-01'", ''))
        expect(checkLegalDates(repo, '2026-01-02').failures[0]).toContain('missing LAST_UPDATED')
        writeFileSync(join(repo, TERMS), PAGE.replace('2026-01-01', '2026-02-31'))
        expect(checkLegalDates(repo, '2026-01-02').failures[0]).toContain('invalid LAST_UPDATED')

        writeFileSync(join(repo, '.git/shallow'), `${git('rev-parse', 'HEAD')}\n`)
        expect(checkLegalDates(repo, '2026-01-02').failures[0]).toContain('full Git history')
    })
})
