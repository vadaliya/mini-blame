# Change Log

All notable changes to the "mini-blame" extension will be documented in this file.

## [0.0.5]

### Added
- **Interactive Line History Webview:** A vertical timeline-based Line History panel traced via `git log -L`, replacing the confusing "Browse File at Revision" actions.
- **Robust Rename & Addition Tracking:** Integrated automatic rename/addition detection using `git diff-tree` and existence checks during history walkback to resolve missing paths gracefully.
- **Copy Icon in Hover Tooltip:** Added a separate copy icon next to the commit SHA link in the hover tooltip to copy the hash to the clipboard.
- **Historical Filename Tracing:** Parsed and stored original filenames from porcelain blame metadata to query git show/diff using the correct pathspec, resolving path-mismatch bugs for historically renamed or moved files.
- **Compare with Working Tree:** Added side-by-side diff comparisons of the file at the blamed commit against the active workspace editor file (with rename support).
- **Copy Commit Message:** Added a dropdown option to copy the full commit message body to the clipboard.
- **Create Branch and Tag at Commit:** Added options to create a git branch or tag directly from the target commit.
- **Native VS Code HoverProvider:** Registered a native hover provider (`vscode.languages.registerHoverProvider`) allowing users to view git blame information by hovering anywhere on any line, even without placing the cursor there.
- **Promise-Based Blame Caching:** Implemented `blamePromiseCache` to prevent spawning duplicate concurrent git blame processes for the same file.
- **Compiled Hover Markdown Cache:** Added `hoverMarkdownCache` to cache fully rendered Markdown hovers per commit-line, eliminating redundant terminal processes on repeated hovers.

### Changed
- **On-Demand Webview Diff Loading:** Refactored the Commit Details Webview to query diffs dynamically on-demand, resolving `maxBuffer` errors.
- **Clean Diff Output:** Stripped redundant commit metadata and git diff headers from all Webview diff views.
- **Commit Link in Hover Tooltip:** Clicking the commit SHA link in the hover tooltip now directly opens the Commit Details Webview instead of copying the SHA.
- **Relative Pathspecs:** Configured all git show/diff queries to use paths relative to the Git repository root (with forward slashes), resolving Windows absolute pathspec mismatch bugs for newly created files.
- **Ellipsis Menus Cleanup:** Removed the redundant "Copy Commit SHA" option from all More Actions dropdown menus.
- Make **Files Changed** sidebar list items interactive in the Commit Details Webview: clicking a file displays only its specific diff, auto-selecting the first file on load.
- **Reduced Annotation Debounce Delay:** Reduced default `"mini-blame.debounceDelay"` from `1000`ms to `200`ms to make inline ghost annotations feel snappy.
- **Hover Duplication Prevention:** Removed duplicate decoration-attached hovers to let the native HoverProvider display clean merged tooltips.

### Fixed
- Increase child_process execution `maxBuffer` to 100MB to prevent "stdout maxBuffer length exceeded" errors when viewing details/diffs of large commits.
- Clear ghost text annotations and status bar instantly on cursor movement/selection change to prevent rendering lag.
- Cleaned up ESLint brace warnings regarding missing curly brackets in single-line if blocks.

## [0.0.4]

### Added
- Packaging/building guide documentation (`mini-blame-vsix-build.md`).
- **Blame Prior to Commit (History Walkback):** Support recursively walking back blame history using parent commits from the More Actions menu.
- **Configurable Settings:** Customize debounce delay (`mini-blame.debounceDelay`), annotation formats (`mini-blame.annotationFormat`), and ignore whitespace differences (`mini-blame.ignoreWhitespace`).
- **Remote Git Integration:** Provide clickable links to GitHub/GitLab/Bitbucket commits, files, and pull requests in the hover tooltip.
- **Commit Details Webview:** A split Webview panel displaying commit metadata, message body, files changed list, and a syntax-colored diff.
- **In-Memory Blame Caching:** Cache blame information per-file for instant cursor-hover responsiveness, with automatic modification invalidation.

### Fixed
- Add support for Git submodule folders.
- Dynamically resolve the Git repository root (main or submodule repository) using `git rev-parse --show-toplevel` on the containing file's directory.
- Execute all Git commands (blame, diff, show, name-rev, etc.) relative to the resolved Git root asynchronously.
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