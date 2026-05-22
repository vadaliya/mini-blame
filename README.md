# Mini Blame

A lightning-fast, lightweight Git blame extension for VS Code. It provides instant inline Git history, detailed hover popups, and quick actions without the massive memory footprint of larger Git extensions.

## Features

* **Inline Ghost Text:** Instantly see the author, date, and commit message of the current line fading unobtrusively into the background.
* **Status Bar Integration:** Keep track of the active line's Git history right from the VS Code Status Bar.
* **Rich Hover Details:** Hover over the inline text to see the full commit subject, body, and exact diff changes for that specific line.
* **Quick Actions:** Easily copy Commit SHAs, PR numbers, or Branch names directly from the hover popup.
* **Native Diff Viewer:** Instantly open a side-by-side comparison of the file's previous revision with a single click.
* **Time Travel:** Browse the entire file exactly as it existed during that historical commit.

## Why Mini Blame?

Designed for high performance, Mini Blame relies purely on local shell commands (`git blame`, `git show`) rather than spinning up heavy webviews, external APIs, or background indexers. It gives you exactly the Git data you need, right when you need it.

---
*Built for developers who want speed and simplicity.*