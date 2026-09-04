# Vendored Lucide assets

Source: `lucide-static@1.40.0` (<https://lucide.dev>), ISC license — see
`LICENSE` in this directory. Only the icons the UI actually uses are
vendored; `scripts/gen-icons.mjs` generates
`web-src/src/common/components/icons.tsx` from them.

Pinned in-repo on purpose: the UI icon set is a design decision, so its
geometry is checked in rather than floating on a registry dependency.
To adopt a newer Lucide revision, re-vendor the files at the new pin and
regenerate.
