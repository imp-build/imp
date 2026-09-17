# Workspace initialization

The `//rules/init` module supplies the catalog and renderer used by `imp init`.
The command detects common project files, lets the user select integrations,
and writes the corresponding workspace imports and configuration declarations.

## Public API

`catalog()` and `render()` are host-facing protocol helpers. They are not
BUILD target constructors and are not part of the curated user API. The stable
user interface is the `imp init` command documented in the getting-started
guide. The module's catalog data is the source of truth for supported
initialization choices.
