# Change Log

All notable changes to the "mini-blame" extension will be documented in this file.

## [0.0.4]

### Added
- Packaging/building guide documentation (`mini-blame-vsix-build.md`).

### Fixed
- Add support for Git submodule folders.
- Dynamically resolve the Git repository root (main or submodule repository) using `git rev-parse --show-toplevel` on the containing file's directory.
- Execute all Git commands (blame, diff, show, name-rev, etc.) relative to the resolved Git root.
- Update `openDiff` and `openOldFile` command handlers to correctly compute and query submodule relative paths.

## [0.0.3]

### Fixed
- Prevent blame text flickering during active typing.
- Implement a 1-second debounce timer for cursor movement and text editing events.
- Hide ghost text and status bar instantly upon keystroke to eliminate visual noise.
- Restore blame annotations automatically after 1 second of user inactivity (idle timer).
- Commented out `onDidSaveTextDocument` listener to prevent double-firing and UI clashes for users with auto-save enabled.

## [0.0.2]

### Added
- Dual-view uncommitted changes and live editor events.
- GitLens-style inline annotations for uncommitted lines using file system timestamps.
- Stacked hover popup displaying both the active Working Tree diff and the previous commit history simultaneously.
- Interactive Markdown action links (Copy SHA, Open Diff, Copy Branch) for both uncommitted and committed states.
- `onDidChangeTextDocument` listener to hide stale ghost text instantly during active typing.
- `onDidSaveTextDocument` listener to force a live Git refresh the moment a file is saved.
- Restrict hover popup hitbox to zero-width at the end of the line so it only triggers on the ghost text, keeping code clean.

### Changed
- Refine Git shell commands to accurately fetch parent SHAs, branch names (ignoring tags), and targeted line diffs via `--unified=0`.
- Sync `engines.vscode` and `@types/vscode` to `^1.80.0` to guarantee correct backwards compatibility.

## [0.0.1]

### Added
- Initial release of the `mini-blame` extension with core functionality.
- `package.json` to define extension metadata and dependencies.
- Main extension logic in `src/extension.ts` for Git blame tracking.
- Basic test suite in `src/test/extension.test.ts`.
- TypeScript settings in `tsconfig.json`.
- `vsc-extension-quickstart.md` for extension usage instructions.