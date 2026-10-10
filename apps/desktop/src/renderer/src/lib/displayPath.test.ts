import { expect, test } from 'vitest'
import { displayPath } from './displayPath'

test('displays a canonical Windows drive path in familiar form', () => {
    const canonical = String.raw`\\?\G:\SteamLibrary\steamapps\common\PAYDAY3\PAYDAY3\Content\Movies\BG_LoginVideo_01.bk2`
    expect(displayPath(canonical)).toBe(
        String.raw`G:\SteamLibrary\steamapps\common\PAYDAY3\PAYDAY3\Content\Movies\BG_LoginVideo_01.bk2`
    )
})

test('preserves the network share prefix of a canonical UNC path', () => {
    expect(displayPath(String.raw`\\?\UNC\server\share\Movies\Intro.bk2`)).toBe(
        String.raw`\\server\share\Movies\Intro.bk2`
    )
    expect(displayPath(String.raw`\\?\unc\server\share\Engine.ini`)).toBe(
        String.raw`\\server\share\Engine.ini`
    )
})

test.each([
    String.raw`G:\SteamLibrary\PAYDAY3`,
    String.raw`\\server\share\Engine.ini`,
    '/home/oleh/games/PAYDAY3/Content/Movies/Intro.bk2',
    String.raw`\\?\Volume{guid}\Movies\Intro.bk2`,
    String.raw`\\.\PhysicalDrive0`,
    String.raw`notes/\\?\G:\Intro.bk2`,
    String.raw`\\?\G:Intro.bk2`,
])('leaves other path forms unchanged: %s', (path) => {
    expect(displayPath(path)).toBe(path)
})
