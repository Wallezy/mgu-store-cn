# Contributing

A pull request description has `AI:` and `Tested:` fields, and
`Human review:` when an AI agent wrote it (AGENTS.md, "Pull requests by
AI agents").

## Versions

Leave every version number alone: the release gives each component it
publishes its next version and writes it into the tree. CI fails a pull
request that changes a version (a tool's `component.json`, the Store's
`mgu-app.json` and `package/` files).

- **Patch** is the default.
- **Minor or major:** say so in the pull request; the maintainer adds the
  label `release:minor` or `release:major`. The label covers every component
  the pull request changes.

## CHANGELOG

A component with a CHANGELOG (`native/<id>/CHANGELOG.md`,
`deploy/CHANGELOG.md`, the Store's `apps/robertn_store/package/CHANGELOG.md`)
lists what your pull request changes under `## Unreleased` at the top:

```md
# app-privacy changelog

## Unreleased

- What changes, in a sentence or two for the people who use it.

## 1.7.1
...
```

The release moves those lines under the new version's heading and leaves an
empty `## Unreleased` for the next pull requests. CI fails a pull request
that changes such a component without an Unreleased entry.

When another pull request added its lines first, GitHub reports a conflict
in the CHANGELOG. Merge `main` into your branch locally
(`git merge origin/main`): the repository's `.gitattributes` keeps both
sets of lines, so there is nothing to resolve by hand.

## Requiring another component's next release

When your change needs a change to another component of this repository in
the same or an earlier pull request, require that component's next release
with `"next"` in `"requires"` (a tool's `component.json`, the Store's
`release.json`):

```json
"requires": { "mgu-python": "next" }
```

The release writes the real version in and publishes both. Keep a
component that is already released at its number (`"mgu-deploy": "0.8.4"`).

## Updates in any order

Cars update each component on its own, in any order. A component that
needs a newer partner says so in `requires`; otherwise it keeps working
with the partners' published versions (AGENTS.md, "Updates must work in
any order").

## CN user-facing update notes

Each CN release updates `release/notes.json`: `version: "next"` for the new entry (stamped to its CN version), upstream
version and CN revision, newest first. Write 1–3 short Chinese bullets (at most
32 characters each) describing visible features or fixed problems. Avoid commit
IDs, file names, implementation terms and vague “优化体验”. Keep prior CN entries;
never infer CN notes by matching duplicate upstream CHANGELOG headings.

`releaseNotes` is optional for older catalogs. A missing entry means no notes
were supplied; never invent historical changes. Maintainers include notes for
changed applications in their channel catalog and preserve Beta-only packages.
