import { DisclosureSummary } from './ui/DisclosureSummary'
import { useEffect, useRef, useState } from 'react'
import { api, type MovieRecognitionScan } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { Button } from './ui/Button'
import { ResourceRecognition } from './ResourceRecognition'
import { displayPath } from '../lib/displayPath'

function scanSummary(scan: MovieRecognitionScan, findingCount: number): string {
    if (scan.movies.some((movie) => movie.recognition.status === 'unavailable'))
        return t('resources.recognition.scanUnavailable')
    if (scan.movies.length === 0) return t('resources.recognition.empty')
    if (findingCount === 0) return t('resources.recognition.noFindings')
    return t('resources.recognition.findings', { count: findingCount })
}

export function MovieResourceScan({ activeGame }: { activeGame: GameId }) {
    const [scan, setScan] = useState<MovieRecognitionScan | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const request = useRef(0)
    const findings =
        scan?.movies.filter(
            (movie) =>
                movie.recognition.status === 'matched' || movie.recognition.status === 'ambiguous'
        ) ?? []
    const unavailable = scan?.movies.some((movie) => movie.recognition.status === 'unavailable')

    useEffect(
        () => () => {
            request.current += 1
        },
        []
    )

    function clearResults() {
        request.current += 1
        setScan(null)
        setError(null)
        setBusy(false)
    }

    async function inspect() {
        const current = ++request.current
        setScan(null)
        setBusy(true)
        setError(null)
        try {
            const result = await api.inspectMovieResources(activeGame)
            if (current === request.current) setScan(result)
        } catch (failure) {
            if (current === request.current) setError(String(failure))
        } finally {
            if (current === request.current) setBusy(false)
        }
    }
    return (
        <div className="flex flex-col gap-3 px-3 py-2">
            <h3 className="text-sm font-medium">{t('resources.recognition.movies')}</h3>
            <p className="text-xs text-text-muted">{t('resources.recognition.description')}</p>
            <div className="flex items-center gap-2">
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void inspect()}
                >
                    {busy
                        ? t('common.loading')
                        : t(
                              scan || error
                                  ? 'resources.recognition.checkAgain'
                                  : 'resources.recognition.check'
                          )}
                </Button>
                {(scan || error) && (
                    <Button variant="ghost" size="sm" onClick={clearResults}>
                        {t('resources.recognition.clear')}
                    </Button>
                )}
            </div>
            {error && (
                <p role="alert" className="text-xs text-danger-text">
                    {error}
                </p>
            )}
            {scan && (
                <div className="flex flex-col gap-2 text-xs">
                    <p role="status" className="text-text-muted">
                        {scanSummary(scan, findings.length)}
                    </p>
                    {!unavailable && scan.movies.length > 0 && findings.length === 0 && (
                        <p className="text-text-subtle">
                            {t('resources.recognition.noFindingsHelp')}
                        </p>
                    )}
                    <p className="text-text-subtle">
                        {t('resources.recognition.checked', {
                            time: new Date(scan.checkedAt).toLocaleString(),
                        })}
                    </p>
                    {findings.map((movie) => (
                        <div
                            key={movie.path}
                            className="border border-border rounded-lg p-3 flex flex-col gap-1"
                        >
                            <ResourceRecognition recognition={movie.recognition} />
                            <span className="font-mono break-all text-text-muted">
                                {movie.path.split(/[\\/]/).at(-1)}
                            </span>
                            {movie.recognition.status === 'matched' && (
                                <p className="text-text-subtle">
                                    {t('resources.recognition.unmanaged')}
                                </p>
                            )}
                            <details className="text-text-subtle">
                                <DisclosureSummary className="cursor-pointer">
                                    {t('resources.details')}
                                </DisclosureSummary>
                                <p className="mt-1 break-all">{displayPath(movie.path)}</p>
                            </details>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
