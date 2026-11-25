import { githubReleaseBody } from './changes.mts'

process.stdout.write(githubReleaseBody(await Bun.stdin.text()))
