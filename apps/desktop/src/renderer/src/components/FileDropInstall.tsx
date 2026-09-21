import {
    createContext,
    useContext,
    useLayoutEffect,
    useState,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
} from 'react'
import { GAMES } from '../../../shared/types'
import { refreshInstalled } from '../gameData'
import { useFileDropInstall, type FileDropTarget } from '../hooks/useFileDropInstall'
import { FileDropOverlay, FileDropStatus } from './FileDropOverlay'
import { ZipPickerModal } from './ZipPickerModal'
import { HostPackModal } from './HostPackModal'
import { CrimeBossFlatArchiveModal } from './CrimeBossFlatArchiveModal'
import { Ue4ssReplaceModal } from './Ue4ssReplaceModal'

const DropTargetContext = createContext<Dispatch<SetStateAction<FileDropTarget | null>> | null>(
    null
)

export function useFileDropTarget(target: FileDropTarget) {
    const setTarget = useContext(DropTargetContext)
    if (!setTarget) throw new Error('File-drop target requires FileDropInstall')
    const { activeGame, gamePath, installed } = target
    useLayoutEffect(() => {
        setTarget({ activeGame, gamePath, installed })
        return () => setTarget(null)
    }, [setTarget, activeGame, gamePath, installed])
}

export function FileDropInstall({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<FileDropTarget | null>(null)
    const {
        dragging: fileDragging,
        installing: fileInstalling,
        progress: dropProgress,
        result: dropResult,
        dismissResult,
        prompt,
        resolvePrompt,
        operationTarget,
    } = useFileDropInstall(target)
    const displayTarget = fileInstalling ? operationTarget : target
    return (
        <DropTargetContext value={setTarget}>
            {children}
            {displayTarget && (
                <FileDropOverlay
                    active={(target !== null && fileDragging) || fileInstalling}
                    installing={fileInstalling}
                    progress={dropProgress}
                    gameName={GAMES[displayTarget.activeGame].name}
                />
            )}
            {dropResult && <FileDropStatus result={dropResult} onDismiss={dismissResult} />}
            {prompt?.sentinel.kind === 'zip' && (
                <ZipPickerModal
                    payload={prompt.sentinel.payload}
                    gamePath={prompt.target.gamePath}
                    installedFiles={prompt.target.installed}
                    gameId={prompt.target.activeGame}
                    onRefreshInstalled={() => refreshInstalled(prompt.target.activeGame)}
                    onClose={resolvePrompt}
                />
            )}
            {prompt?.sentinel.kind === 'host' && (
                <HostPackModal
                    payload={prompt.sentinel.payload}
                    gamePath={prompt.target.gamePath}
                    installed={prompt.target.installed}
                    gameId={prompt.target.activeGame}
                    onRefreshInstalled={() => refreshInstalled(prompt.target.activeGame)}
                    onClose={resolvePrompt}
                />
            )}
            {prompt?.sentinel.kind === 'cb' && (
                <CrimeBossFlatArchiveModal
                    payload={prompt.sentinel.payload}
                    gamePath={prompt.target.gamePath}
                    onRefreshInstalled={() => refreshInstalled(prompt.target.activeGame)}
                    onClose={resolvePrompt}
                />
            )}
            {prompt?.sentinel.kind === 'loader' && (
                <Ue4ssReplaceModal
                    payload={prompt.sentinel.payload}
                    gameId={prompt.target.activeGame}
                    gamePath={prompt.target.gamePath}
                    onRefreshInstalled={() => refreshInstalled(prompt.target.activeGame)}
                    onClose={resolvePrompt}
                />
            )}
        </DropTargetContext>
    )
}
