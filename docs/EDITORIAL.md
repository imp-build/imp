# Imp documentation editorial standard

This standard applies to maintained Markdown, rule `DOC.md` files, and source
JSDoc that generates the Imp API references. It applies to human authors,
reviewers, and AI agents. It does not apply to vendored files or generated
reference output. Change the source input instead of generated output.

## Audiences

Write for one primary audience at a time. Name the audience when it changes
the required context. These roles describe documentation needs, not strict
organizational boundaries. One person may have more than one role.

- **Users** install, configure, run, observe, troubleshoot, and consume Imp.
  This includes build engineers and other people who operate Imp in local,
  CI, daemon, packaging, or deployment environments.
- **Rule authors** write JavaScript rule modules and expose graph-native APIs.
- **Contributors** change the repository, rules, tests, documentation, and
  workflows.
- **Maintainers** review changes, manage releases, own compatibility, and
  resolve documentation drift.

## Voice and language

- Use short sentences and one main idea per paragraph.
- Use active voice and direct instructions: “Declare the tool” is better than
  “The tool must be declared.”
- Use `Imp` for the project and `imp` for the command, module, or namespace.
- Use the exact spelling of commands, target addresses, symbols, paths, and
  configuration fields. Put them in backticks.
- Define an uncommon term before using it. Do not use one role label as a
  synonym for every contributor or user.
- Prefer concrete verbs such as “declare”, “select”, “build”, “cache”, and
  “verify”. Avoid vague verbs such as “handle”, “support”, or “manage” when a
  more precise verb is available.
- Do not hide important limits in subordinate clauses. State the limit near
  the behavior it limits.
- Do not use “simply”, “obviously”, or “just” to dismiss work or failure.

Use `must` for a required action, `should` for a strong recommendation, and
`may` for an allowed choice. Do not use “will” for behavior that is not
verified.

## Structure

Start a page with its purpose and the result the reader will get. Then give
the prerequisites, the smallest useful procedure, expected results, limits,
and links to deeper material.

- Use headings that describe a task or concept, not the writing process.
- Keep procedures ordered. Number steps when order matters; use bullets for
  independent facts.
- Explain a term at first use, then use the same term consistently.
- Link to the deeper guide or API reference instead of repeating it.
- State platform, version, workspace, or profile conditions when they change
  the result.
- Keep examples close to the rule or API they demonstrate.

## Commands and code examples

Every command example must make its context clear. State the working
directory, required files or imports, and the expected result when these are
not obvious. Use safe placeholder names and values. Never include credentials,
private URLs, or machine-specific paths.

Label an example as **Runnable example** only when the repository or a listed
procedure can reproduce it. Label a code fragment as **Illustrative example**
when it omits setup, uses pseudocode, or depends on an unstated environment.
Do not present implementation-only exports as user API examples.

Use the current command form. For example:

```sh
# From the workspace root, after `imp init` created imp.workspace.js:
imp build //:hello
```

If output varies by platform, toolchain, or environment, describe the stable
part and say what can vary. Do not promise that a command writes a workspace
file when it produces a graph or CAS artifact instead.

## Warnings, failures, and uncertainty

Put a warning before the action or claim that can cause harm, data loss, or a
misleading result:

> **Warning:** This command writes the generated file into the workspace.

Describe failures with the symptom, the likely cause when known, and the next
diagnostic action. Separate an environment failure from an Imp or rule error.

Use one of these labels when the status of a claim matters:

- **Verified:** behavior checked against the current source, tests, or a
  reproducible command. Include the version or date when it may change.
- **Planned:** intended behavior that is not available or committed. Do not
  write it as present behavior.
- **Unknown:** not verified. State what is missing and, when useful, how to
  verify it.

For a limitation, state what Imp guarantees, what it does not guarantee, and
the practical consequence. For a deprecated API or command, state that it is
deprecated, name the replacement, explain the compatibility window or removal
status when known, and link to the migration guidance.

## Accessibility

- Use descriptive link text. Do not use “click here”.
- Keep heading levels in order.
- Give images useful alt text, or mark decorative images as decorative.
- Do not rely on colour, position, or formatting alone to convey meaning.
- Keep tables small and give every column a clear heading.
- Write error and status text so it remains meaningful when read without the
  surrounding page.

## Review checklist

### Markdown pages

- [ ] The page names its primary audience, purpose, prerequisites, and result.
- [ ] Commands identify their context and use current syntax.
- [ ] Runnable and illustrative examples are distinguished.
- [ ] Claims label verified, planned, and unknown behavior where needed.
- [ ] Warnings, limits, failures, and deprecated behavior are actionable.
- [ ] Links, headings, tables, and alt text meet the accessibility rules.

### Rule `DOC.md` files

- [ ] The guide names the rule namespace and the workflows or products it
      provides.
- [ ] Public configuration, target, toolchain, and output behavior uses the
      current API and target-address syntax.
- [ ] Sandbox, cache, platform, and generated-file limits are stated when
      they affect use.
- [ ] Examples declare the required imports and do not expose implementation-
      only details as user API.
- [ ] Capability markers and links remain in the format consumed by the docs
      build.

### Source JSDoc

- [ ] Each public export has a concise summary that states its action or
      result.
- [ ] Every public parameter has the correct name, type, optional marker, and
      useful description.
- [ ] `@returns` describes the returned handle, value, or promise when one
      exists.
- [ ] `@category` is present and uses a supported user-reference category when
      the export belongs in the curated API reference.
- [ ] Examples and terminology follow this standard and describe current
      behavior.
- [ ] The wording remains clear in both the generated user API and JS code
      reference; do not rely on source-only context.
