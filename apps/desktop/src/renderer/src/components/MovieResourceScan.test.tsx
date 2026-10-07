// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { api, type MovieRecognitionScan } from '../api'
import { MovieResourceScan } from './MovieResourceScan'

vi.mock('../api', () => ({ api: { inspectMovieResources: vi.fn() } }))

const matchedMovie: MovieRecognitionScan['movies'][number] = {
    path: String.raw`\\?\G:\PAYDAY3\PAYDAY3\Content\Movies\StartUp_SBZ.bk2`,
    sha256: 'a'.repeat(64),
    recognition: {
        status: 'matched',
        source: 'modworkshop',
        modRemoteId: 47773,
        modName: 'Skip startup movies',
        entries: [],
    },
}

beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

test('reports unavailable identification once without presenting original files as findings', async () => {
    vi.mocked(api.inspectMovieResources).mockResolvedValue({
        checkedAt: '2026-10-06T21:00:00Z',
        movies: ['BG_LoginVideo_01.bk2', 'LoadingScreen.bk2', 'StartUp_SBZ.bk2'].map((name) => ({
            path: `G:/PAYDAY3/PAYDAY3/Content/Movies/${name}`,
            sha256: null,
            recognition: { status: 'unavailable' },
        })),
    })
    render(<MovieResourceScan activeGame="pd3" />)
    fireEvent.click(screen.getByRole('button', { name: 'Check existing movies' }))
    expect((await screen.findByRole('status')).textContent).toContain(
        'could not identify movie mods'
    )
    expect(screen.queryByText('BG_LoginVideo_01.bk2')).toBeNull()
    expect(screen.queryByText('LoadingScreen.bk2')).toBeNull()
    expect(screen.queryByText('StartUp_SBZ.bk2')).toBeNull()
    expect(screen.queryByText('Technical details')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear results' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear results' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check existing movies' })).toBeTruthy()
    expect(api.inspectMovieResources).toHaveBeenCalledExactlyOnceWith('pd3')
})

test('reports no known matches without claiming the files are verified originals', async () => {
    vi.mocked(api.inspectMovieResources).mockResolvedValue({
        checkedAt: '2026-10-06T21:00:00Z',
        movies: [{ ...matchedMovie, recognition: { status: 'noMatch' } }],
    })
    render(<MovieResourceScan activeGame="pd3" />)
    fireEvent.click(screen.getByRole('button', { name: 'Check existing movies' }))
    expect((await screen.findByRole('status')).textContent).toBe(
        'No known movie mod matches found.'
    )
    expect(
        screen.getByText('This check cannot confirm whether every movie is an original game file.')
    ).toBeTruthy()
    expect(screen.queryByText('StartUp_SBZ.bk2')).toBeNull()
})

test('shows known mod-file matches and ambiguous matches while omitting unmatched files', async () => {
    vi.mocked(api.inspectMovieResources).mockResolvedValue({
        checkedAt: '2026-10-06T21:00:00Z',
        movies: [
            matchedMovie,
            {
                path: 'G:/PAYDAY3/PAYDAY3/Content/Movies/Intro.bk2',
                sha256: 'b'.repeat(64),
                recognition: { status: 'ambiguous' },
            },
            {
                path: 'G:/PAYDAY3/PAYDAY3/Content/Movies/LoadingScreen.bk2',
                sha256: null,
                recognition: { status: 'noMatch' },
            },
        ],
    })
    render(<MovieResourceScan activeGame="pd3" />)
    fireEvent.click(screen.getByRole('button', { name: 'Check existing movies' }))
    expect((await screen.findByRole('status')).textContent).toBe(
        'Movies matching known mod files: 2'
    )
    expect(screen.getByText('Matches Skip startup movies')).toBeTruthy()
    expect(screen.getByText('Intro.bk2')).toBeTruthy()
    expect(screen.queryByText('LoadingScreen.bk2')).toBeNull()
    expect(
        screen.getByText(
            'This match alone does not make the file managed by Modrex or provide an earlier copy to restore.'
        )
    ).toBeTruthy()
})

test('discards the previous report during a new check, including when the new check fails', async () => {
    vi.mocked(api.inspectMovieResources).mockResolvedValueOnce({
        checkedAt: '2026-10-06T21:00:00Z',
        movies: [matchedMovie],
    })
    let failCheck!: (error: Error) => void
    vi.mocked(api.inspectMovieResources).mockImplementationOnce(
        () =>
            new Promise((_, reject) => {
                failCheck = reject
            })
    )
    render(<MovieResourceScan activeGame="pd3" />)
    fireEvent.click(screen.getByRole('button', { name: 'Check existing movies' }))
    await screen.findByText('Matches Skip startup movies')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.queryByText('Matches Skip startup movies')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    failCheck(new Error('Could not read the Movies folder'))
    expect((await screen.findByRole('alert')).textContent).toBe(
        'Error: Could not read the Movies folder'
    )
    expect(screen.queryByText('Matches Skip startup movies')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear results' }))
    expect(screen.queryByRole('alert')).toBeNull()
})
