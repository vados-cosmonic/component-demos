#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
commit=$(node -p 'require("./pin.json").commit')
run=$(node -p 'require("./pin.json").run')
repo=bytecodealliance/jco
# Publish the new build only after preparation succeeds.
stage=$(mktemp -d main/build.XXXXXX)
case "${1:-ci}" in
    ci)
        if [[ $(gh run view "$run" --repo "$repo" --json headSha --jq .headSha) != "$commit" ]]; then
            echo "The CI run was built from a different commit" >&2
            exit 1
        fi
        npm ci --prefix main
        gh run download "$run" --repo "$repo" --name jco-transpile-dist --name jco-transpile-vendor --dir "$stage"
        mv "$stage/jco-transpile-dist" "$stage/dist"
        mv "$stage/jco-transpile-vendor" "$stage/vendor"
        ;;
    --source)
        git init -q "$stage/source"
        (
            cd "$stage/source"
            git fetch --depth 1 "https://github.com/$repo.git" "$commit"
            git checkout -q --detach "$commit"
            pnpm install --frozen-lockfile
            pnpm --filter '@bytecodealliance/jco-transpile' run build
        )
        ln -s source/packages/jco-transpile/dist "$stage/dist"
        ln -s source/packages/jco-transpile/vendor "$stage/vendor"
        ;;
    *) echo "Usage: $0 [ci|--source]" >&2; exit 2 ;;
esac
echo "$commit" > "$stage/commit"
ln -sfn "$(basename "$stage")" main/current
