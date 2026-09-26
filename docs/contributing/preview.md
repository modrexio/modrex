# Modrex app preview

The preview is the Modrex desktop interface running in a web browser. It is for reviewing
layouts, wording, and different app states without installing Modrex or a game. It uses sample
data, cannot change real game files, and resets changes when the page reloads.

The stable link shows the latest version from `main`:

<https://app-preview.modrex.net/>

Use the **Preview state** controls in the bottom right to change what the app shows. The address
updates automatically. Copy the full address from the browser to share that exact view.

## Screens to review

| What you want to see      | What it shows                                      | Open                                                            |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| Normal app                | Online, game detected, no installed mods           | <https://app-preview.modrex.net/>                               |
| Example installed library | Six mods with common installed states              | <https://app-preview.modrex.net/?library=demo>                  |
| Large installed library   | 120 mods for reviewing long lists and layouts      | <https://app-preview.modrex.net/?library=large>                 |
| Offline error             | Remote requests fail                               | <https://app-preview.modrex.net/?network=offline>               |
| Slow loading              | Remote requests and downloads are delayed          | <https://app-preview.modrex.net/?network=slow>                  |
| Game not installed        | No game installation is detected                   | <https://app-preview.modrex.net/?games=missing>                 |
| First launch              | The welcome and telemetry consent screens          | <https://app-preview.modrex.net/?onboarding=first-run>          |
| Large library offline     | A large installed library with failed remote calls | <https://app-preview.modrex.net/?library=large&network=offline> |

The part after `?` selects a state. Use `&` to combine states in one link.

## Reviewing a pull request

A pull request contains changes that have not reached `main` yet. Its preview lets you review
those changes without replacing the stable preview at <https://app-preview.modrex.net/>.

Every pull request has a number next to its title on GitHub. Put that number after `/pr/`:

`https://app-preview.modrex.net/pr/<pull-request-number>`

The `/pr/` address belongs to the pull request, not to one commit. Keep using the same address
while the pull request is open. After a new commit is pushed and its preview is built, the same
address opens the updated version. While the build runs the address shows **Building**, and it
says so if the build failed or no preview exists for the latest commit.

A comment on every pull request lists this address together with the site preview at
`https://site-preview.modrex.net/pr/<pull-request-number>`, which opens the same commit of
modrex.net.

Preview state parameters also work after the pull request number:

`https://app-preview.modrex.net/pr/<pull-request-number>?library=large`
