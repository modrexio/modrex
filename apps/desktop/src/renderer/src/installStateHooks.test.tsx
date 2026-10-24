// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import {
    acceptNexusInstall,
    beginInstall,
    clearInstallError,
    finishArchiveInstall,
    finishInstall,
    finishResourceInstall,
    getInstallOperations,
    updateInstall,
    useModInstall,
    useModInstallBusy,
    useModInstallError,
    useSourceInstallError,
    type InstallTarget,
} from './installState'

afterEach(() => {
    cleanup()
    for (const gameId of ['pd3', 'ron']) {
        for (const operation of getInstallOperations(gameId)) finishInstall(operation.id)
    }
})

function InstallRow({
    name,
    target,
    onRender,
}: {
    name: string
    target: InstallTarget
    onRender?: () => void
}) {
    const operation = useModInstall(target.gameId, target.source, target.modId, target.fileId)
    onRender?.()
    return (
        <span data-testid={name}>{operation ? `${operation.id}:${operation.phase}` : 'idle'}</span>
    )
}

test('progress renders only its row among a populated same-game library', () => {
    const active = beginInstall({ gameId: 'pd3', source: 'modworkshop', modId: 42 })
    beginInstall({ gameId: 'pd3', source: 'modworkshop', modId: 100 })
    const rows = Array.from({ length: 250 }, (_, index) => ({ modId: index + 1, renders: 0 }))
    render(
        <>
            {rows.map((row) => (
                <InstallRow
                    key={row.modId}
                    name={String(row.modId)}
                    target={{ gameId: 'pd3', source: 'modworkshop', modId: row.modId }}
                    onRender={() => row.renders++}
                />
            ))}
        </>
    )
    const affected = rows.find((row) => row.modId === 42)!
    const before = affected.renders
    const unrelated = () => rows.filter((row) => row !== affected).map((row) => row.renders)
    const unrelatedBefore = unrelated()
    for (let index = 1; index <= 100; index++) {
        act(() =>
            updateInstall(active.id, {
                phase: 'downloading',
                downloaded: index * 16384,
                total: 1073741824,
            })
        )
    }
    expect(affected.renders - before).toBe(100)
    expect(unrelated()).toEqual(unrelatedBefore)
})

test('file selectors preserve source, game, wildcard and active-before-failed matching', () => {
    const target: InstallTarget = { gameId: 'pd3', source: 'modworkshop', modId: 12 }
    const first = beginInstall({ ...target, fileId: 34 })
    const second = beginInstall({ ...target, fileId: 35 })
    const nexus = beginInstall({ ...target, source: 'nexus', fileId: 34 })
    const otherGame = beginInstall({ ...target, gameId: 'ron', fileId: 34 })
    const counts = { first: 0, second: 0, nexus: 0, otherGame: 0 }
    render(
        <>
            <InstallRow name="mod" target={target} />
            <InstallRow name="first" target={first.target} onRender={() => counts.first++} />
            <InstallRow name="second" target={second.target} onRender={() => counts.second++} />
            <InstallRow name="nexus" target={nexus.target} onRender={() => counts.nexus++} />
            <InstallRow
                name="otherGame"
                target={otherGame.target}
                onRender={() => counts.otherGame++}
            />
        </>
    )
    const before = { ...counts }
    act(() => updateInstall(first.id, { phase: 'downloading', downloaded: 5, total: 0 }))
    expect(counts).toEqual({ ...before, first: before.first + 1 })
    expect(screen.getByTestId('mod').textContent).toBe(`${first.id}:downloading`)
    act(() => updateInstall(first.id, { phase: 'failed', error: 'Download failed' }))
    expect(screen.getByTestId('mod').textContent).toBe(`${second.id}:preparing`)
    expect(screen.getByTestId('first').textContent).toBe(`${first.id}:failed`)
    act(() => finishInstall(second.id))
    expect(screen.getByTestId('mod').textContent).toBe(`${first.id}:failed`)
    act(() => clearInstallError(first.id))
    let wildcard!: ReturnType<typeof beginInstall>
    act(() => {
        wildcard = beginInstall(target)
        updateInstall(wildcard.id, { phase: 'installing' })
    })
    expect(screen.getByTestId('first').textContent).toBe(`${wildcard.id}:installing`)
    expect(screen.getByTestId('second').textContent).toBe(`${wildcard.id}:installing`)
})

test('Nexus refinement reselects files and resource review survives remount and archive completion', () => {
    const target: InstallTarget = { gameId: 'ron', source: 'nexus', modId: 12 }
    const waiting = beginInstall(target, 'awaitingNexus')
    const first = render(
        <>
            <InstallRow name="selected" target={{ ...target, fileId: 34 }} />
            <InstallRow name="other" target={{ ...target, fileId: 35 }} />
        </>
    )
    expect(screen.getByTestId('other').textContent).toBe(`${waiting.id}:awaitingNexus`)
    act(() => acceptNexusInstall({ ...target, fileId: 34 }))
    expect(screen.getByTestId('selected').textContent).toBe(`${waiting.id}:preparing`)
    expect(screen.getByTestId('other').textContent).toBe('idle')
    act(() =>
        updateInstall(waiting.id, {
            phase: 'review',
            archiveHandle: 'archive',
            reviewHandle: 'resources',
        })
    )
    first.unmount()
    render(<InstallRow name="remounted" target={{ ...target, fileId: 34 }} />)
    expect(screen.getByTestId('remounted').textContent).toBe(`${waiting.id}:review`)
    act(() => finishArchiveInstall('archive'))
    expect(screen.getByTestId('remounted').textContent).toBe(`${waiting.id}:review`)
    act(() => finishResourceInstall('resources'))
    expect(screen.getByTestId('remounted').textContent).toBe('idle')
})

test('changing a selector target follows each identity field and removes the old subscription', () => {
    const targets: InstallTarget[] = [
        { gameId: 'pd3', source: 'modworkshop', modId: 12, fileId: 34 },
        { gameId: 'pd3', source: 'modworkshop', modId: 12, fileId: 35 },
        { gameId: 'pd3', source: 'modworkshop', modId: 13, fileId: 35 },
        { gameId: 'pd3', source: 'nexus', modId: 13, fileId: 35 },
        { gameId: 'ron', source: 'nexus', modId: 13, fileId: 35 },
    ]
    const [first, ...rest] = targets.map((target) => beginInstall(target))
    let renders = 0
    const onRender = () => renders++
    let previous = first!
    const view = render(<InstallRow name="row" target={previous.target} onRender={onRender} />)
    for (const current of rest) {
        view.rerender(<InstallRow name="row" target={current.target} onRender={onRender} />)
        expect(screen.getByTestId('row').textContent).toBe(`${current.id}:preparing`)
        const before = renders
        act(() => updateInstall(previous.id, { phase: 'downloading', downloaded: 1, total: 10 }))
        expect(renders).toBe(before)
        act(() => updateInstall(current.id, { phase: 'installing' }))
        expect(screen.getByTestId('row').textContent).toBe(`${current.id}:installing`)
        previous = current
    }
    view.unmount()
    const unmounted = renders
    act(() => finishInstall(previous.id))
    expect(renders).toBe(unmounted)
})

test('list busy and error snapshots ignore byte progress and expose lifecycle errors', () => {
    const target: InstallTarget = { gameId: 'ron', source: 'nexus', modId: 12 }
    const operation = beginInstall(target)
    const sibling = beginInstall({ ...target, modId: 13 })
    let renders = 0
    function ListStatus() {
        const busy = useModInstallBusy(target.gameId, target.source, target.modId)
        const error = useModInstallError(target.gameId, target.source, target.modId)
        const sourceError = useSourceInstallError(target.gameId, target.source)
        renders++
        return <span data-testid="status">{JSON.stringify({ busy, error, sourceError })}</span>
    }
    render(<ListStatus />)
    const before = renders
    act(() => updateInstall(operation.id, { phase: 'downloading', downloaded: 1, total: 10 }))
    act(() => updateInstall(sibling.id, { phase: 'downloading', downloaded: 2, total: 10 }))
    act(() => updateInstall(operation.id, { phase: 'installing' }))
    expect(renders).toBe(before)
    act(() => updateInstall(sibling.id, { phase: 'failed', error: 'Sibling failed' }))
    expect(JSON.parse(screen.getByTestId('status').textContent!)).toEqual({
        busy: true,
        sourceError: 'Sibling failed',
    })
    act(() => updateInstall(operation.id, { phase: 'review', error: 'Review failed' }))
    expect(JSON.parse(screen.getByTestId('status').textContent!)).toEqual({
        busy: true,
        error: 'Review failed',
        sourceError: 'Review failed',
    })
    act(() => clearInstallError(operation.id))
    expect(JSON.parse(screen.getByTestId('status').textContent!)).toEqual({
        busy: true,
        sourceError: 'Sibling failed',
    })
    act(() => finishInstall(operation.id))
    expect(JSON.parse(screen.getByTestId('status').textContent!)).toEqual({
        busy: false,
        sourceError: 'Sibling failed',
    })
})
