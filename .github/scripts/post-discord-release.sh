#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?usage: post-discord-release.sh <tag>}"

# Discord caps an embed description at 4096 characters. The margin below leaves
# room for the trailing link and absorbs the byte-vs-character difference.
DESCRIPTION_LIMIT=3900

RELEASE=$(gh api "repos/$REPOSITORY/releases/tags/$TAG")
BODY=$(jq -r '.body // ""' <<<"$RELEASE")
URL=$(jq -r '.html_url' <<<"$RELEASE")

if [ -z "${BODY//[[:space:]]/}" ]; then
    echo "Release $TAG has no notes to post." >&2
    exit 1
fi

DESCRIPTION="$BODY"

if [ "${#BODY}" -gt "$DESCRIPTION_LIMIT" ]; then
    # Whole lines only, so a multibyte character cannot be split into invalid UTF-8.
    DESCRIPTION=''
    while IFS= read -r line; do
        if [ -z "$DESCRIPTION" ]; then
            candidate="$line"
        else
            candidate="$DESCRIPTION"$'\n'"$line"
        fi
        if [ "${#candidate}" -gt "$DESCRIPTION_LIMIT" ]; then
            break
        fi
        DESCRIPTION="$candidate"
    done <<<"$BODY"
    DESCRIPTION="$DESCRIPTION"$'\n\n'"…"$'\n\n'"Read the full changelog: $URL"
fi

# 16284982 is 0xf87d36, the modrex-accent-bright token from
# apps/desktop/src/renderer/src/index.css, as the decimal int Discord wants.
PAYLOAD=$(jq -n \
    --arg tag "$TAG" \
    --arg body "$DESCRIPTION" \
    --arg url "$URL" \
    '{username:"Modrex",avatar_url:"https://github.com/modrexio.png",embeds:[{title:$tag,description:$body,url:$url,color:16284982}]}')

# Without --fail-with-body curl exits 0 on Discord's 400, so the job would
# report success while the release went unannounced.
curl --fail-with-body -sS \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD" \
    "$DISCORD_WEBHOOK"
