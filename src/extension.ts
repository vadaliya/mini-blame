import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The activate function is the entry point of the extension.
 * It runs exactly once when the extension is loaded by VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    
    // --- 1. UI INITIALIZATION ---
    
    // Create a Status Bar item pinned to the Right side (priority 100 keeps it near the edge)
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem); // Ensure it gets cleaned up when extension deactivates

    // Define the styling for the inline "Ghost Text" that appears at the end of the line
    const decorationType = vscode.window.createTextEditorDecorationType({
        after: { 
            margin: '0 0 0 3em', // Adds a 3-character space between the code and the ghost text
            color: new vscode.ThemeColor('editorGhostText.foreground'), // Adapts to user's theme
            fontStyle: 'italic' 
        }
    });

    // --- 2. EVENT LISTENERS ---

    // If a file is already open when the extension starts, run the tracker immediately
    if (vscode.window.activeTextEditor) {
        updateDecoration(vscode.window.activeTextEditor);
    }

    // Trigger whenever the user switches between different file tabs
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) updateDecoration(editor);
        else statusBarItem.hide(); // Hide status bar if no text editor is active (e.g., settings page)
    });

    // Trigger whenever the user clicks around or moves their cursor inside the current file
    vscode.window.onDidChangeTextEditorSelection(e => updateDecoration(e.textEditor));

    /**
     * Core function that fetches Git data for the currently selected line and updates the UI.
     */
    async function updateDecoration(editor: vscode.TextEditor) {
        // Get zero-indexed line number from cursor, and add 1 for Git (which uses 1-indexed lines)
        const line = editor.selection.active.line;
        const currentLineNumber = line + 1;
        
        const filePath = editor.document.fileName;
        
        // Find the root folder of the current workspace to use as the Git execution directory
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;

        // Abort if the file isn't part of an open workspace
        if (!workspaceFolder) { statusBarItem.hide(); return; }

        try {
            // --- 3. FETCH GIT BLAME DATA ---
            
            // Execute git blame for this specific line. '--porcelain' provides machine-readable output.
            const blameRaw = execSync(`git blame -l -L ${currentLineNumber},${currentLineNumber} --porcelain "${filePath}"`, { cwd: workspaceFolder, encoding: 'utf8' }).toString();
            
            // The first line of porcelain output looks like: <hash> <originalLine> <currentLine> <groupSize>
            const blameParts = blameRaw.split('\n')[0].split(' ');
            const commitHash = blameParts[0];
            const originalLineNumber = parseInt(blameParts[1], 10); // Crucial for tracking lines that moved over time

            // If hash is all zeros, the line is uncommitted (modified locally). Clear UI and abort.
            if (commitHash.startsWith('00000000')) { 
                editor.setDecorations(decorationType, []); 
                statusBarItem.hide(); 
                return; 
            }

            // --- 4. FETCH METADATA ---
            
            // Fetch detailed metadata using a custom format string. 
            // %P=Parent, %an=AuthorName, %ae=AuthorEmail, %ar=RelativeDate, %ad=AbsoluteDate, %s=Subject, %b=Body
            const metadataRaw = execSync(`git show -s --format="%P%n%an%n%ae%n%ar%n%ad%n%s%n%b" --date=format:"%B %d, %Y %I:%M %p" ${commitHash}`, { cwd: workspaceFolder, encoding: 'utf8' }).toString();
            
            // Strip out non-ASCII characters to prevent UI rendering bugs, then split by newlines
            const metadata = metadataRaw.replace(/[^\x00-\x7F]/g, "").split('\n');
            
            // Extract individual data points from the metadata array
            const parentHash = metadata[0].trim().split(' ')[0] || commitHash; // Fallback to commitHash if no parent exists (initial commit)
            const author = metadata[1];
            const email = metadata[2].trim();
            let relDate = metadata[3];
            const fullDate = metadata[4].replace(/ 0(\d:)/, ' $1'); // Removes leading zero from the hour (e.g., 04:00 -> 4:00)
            const subject = metadata[5];
            const bodyLines = metadata.slice(6).filter(l => l.trim() !== ""); // Everything else is the body. Remove empty lines.

            // Custom tweak: Git natively outputs "1 year ago", but we want it to match GitLens's "12 months ago"
            if (relDate === '1 year ago') {
                relDate = '12 months ago';
            }

            // --- 5. PARSE CUSTOM COMMIT MESSAGES ---
            
            let displaySubject = subject;
            let extraDetails = bodyLines;
            
            // If the subject contains "->", split it to format it nicely into a bulleted list later
            if (subject.includes('->')) {
                const parts = subject.split('->').map(p => p.trim());
                displaySubject = parts[0]; // The main title (before the first '->')
                extraDetails = [...parts.slice(1), ...extraDetails]; // Everything else becomes bullet points
            }

            // --- 6. EXTRACT CONTEXTUAL DATA (Branch & PRs) ---
            
            let branchName = "";
            try {
                // Find the nearest branch name associated with this commit
                const nameRevRaw = execSync(`git name-rev --name-only --exclude=tags/* ${commitHash}`, { cwd: workspaceFolder, encoding: 'utf8' }).toString().trim();
                if (nameRevRaw && !nameRevRaw.includes("undefined")) {
                    // Clean up Git's output (e.g., "remotes/origin/feature~2" becomes "feature")
                    branchName = nameRevRaw.replace(/^remotes\/[^\/]+\//, '').split(/[\~^]/)[0];
                }
            } catch {}

            // Combine subject and body to search for a Pull Request number (e.g., "#123")
            const fullMessage = subject + '\n' + bodyLines.join('\n');
            const prMatch = fullMessage.match(/#(\d+)/);
            const prNumber = prMatch ? prMatch[0] : "";

            // --- 7. EXTRACT EXACT LINE DIFF ---
            
            // Get the unified diff for this file in this specific commit with 0 context lines
            const diffOutput = execSync(`git show --unified=0 ${commitHash} -- "${filePath}"`, { cwd: workspaceFolder, encoding: 'utf8' }).toString();
            const diffLines = diffOutput.split('\n');
            let targetLineDiff: string[] = [];
            
            // Loop through the diff to find the exact line the user is hovering over
            for (let i = 0; i < diffLines.length; i++) {
                const match = diffLines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/); // Find diff hunk headers
                if (match) {
                    const hunkNewStart = parseInt(match[1], 10); // Start line of the new chunk
                    const hunkNewLen = parseInt(match[2] !== undefined ? match[2] : "1", 10); // Length of the new chunk

                    // Check if our original line number falls inside this specific modified chunk
                    if (originalLineNumber >= hunkNewStart && originalLineNumber < (hunkNewStart + hunkNewLen)) {
                        let currentNew = hunkNewStart;
                        let tempDeletions: string[] = [];

                        // Iterate through the lines inside this chunk to isolate the single line we care about
                        for (let j = i + 1; j < diffLines.length && !diffLines[j].startsWith('@@'); j++) {
                            const dLine = diffLines[j];
                            if (dLine.startsWith('-')) {
                                tempDeletions.push(dLine); // Store deleted lines in case this is a modification
                            } else if (dLine.startsWith('+')) {
                                if (currentNew === originalLineNumber) {
                                    // Found our exact line! Add any deletions that preceded it, then the new line.
                                    targetLineDiff.push(...tempDeletions);
                                    targetLineDiff.push(dLine);
                                    break; // Stop searching once found
                                }
                                currentNew++;
                                tempDeletions = []; // Reset deletions if they belonged to a previous line in the chunk
                            }
                        }
                        break; // Stop searching through chunks once we processed the correct one
                    }
                }
            }

            // --- 8. BUILD THE HOVER MARKDOWN ---
            
            const md = new vscode.MarkdownString("", true);
            md.supportHtml = true;      // Required for <span> coloring
            md.supportThemeIcons = true; // Required for $(icon-name) syntax
            md.isTrusted = true;         // Required to execute commands from links

            // Build Header: Icon, Name (mailto link), Date
            const authorText = author === 'You' ? 'You' : author;
            md.appendMarkdown(`$(account) [**${authorText}**](mailto:${email} "Email ${author} (${email})") &nbsp; $(history) ${relDate}&nbsp;(${fullDate})\n\n`);
            md.appendMarkdown(`${displaySubject}\n\n`);

            // Build Bullet Points: Iterate through extraDetails and add chevron icons
            if (extraDetails.length > 0) {
                md.appendMarkdown(`${extraDetails.map(d => `&nbsp;&nbsp;&nbsp;&nbsp;$(chevron-right) ${d}`).join('  \n')}\n\n`);
            }

            md.appendMarkdown(`--- \n`); // Horizontal rule separator
            
            // Build Action Bar Links (Encoding JSON arrays to pass arguments cleanly via URI)
            const actionLinks: string[] = [];
            
            const shaArgs = encodeURIComponent(JSON.stringify([commitHash, "Commit SHA"]));
            actionLinks.push(`$(git-commit) [${commitHash.substring(0, 7)}](command:mini-blame.copyText?${shaArgs} "Copy Commit SHA")`);

            const diffArgs = encodeURIComponent(JSON.stringify([filePath, commitHash, parentHash]));
            actionLinks.push(`[$(git-compare)](command:mini-blame.openDiff?${diffArgs} "Open changes with previous revision")`);

            if (branchName) {
                const branchArgs = encodeURIComponent(JSON.stringify([branchName, "Branch Name"]));
                actionLinks.push(`[$(git-branch) ${branchName}](command:mini-blame.copyText?${branchArgs} "Copy Branch Name")`);
            }

            if (prNumber) {
                const prArgs = encodeURIComponent(JSON.stringify([prNumber, "PR Number"]));
                actionLinks.push(`[$(git-pull-request) PR ${prNumber}](command:mini-blame.copyText?${prArgs} "Copy PR Number")`);
            }

            // Add the "More Actions" ellipsis dropdown at the end
            const moreArgs = encodeURIComponent(JSON.stringify([filePath, commitHash]));
            actionLinks.push(`[$(ellipsis)](command:mini-blame.moreActions?${moreArgs} "Show more actions")`);

            // Render the Action Bar
            md.appendMarkdown(actionLinks.join(' &nbsp;| &nbsp;') + '\n\n');

            // Build Code Diff Block
            const codeDiff = targetLineDiff.length > 0 ? targetLineDiff.join('\n') : "No direct code changes detected.";
            md.appendCodeblock(codeDiff, 'diff');
            
            // Build Footer (Showing Parent <-> Current hashes)
            const parentArgs = encodeURIComponent(JSON.stringify([parentHash, "Parent SHA"]));
            md.appendMarkdown(`\n<span style="color:#ffffff;">Changes &nbsp;[$(git-commit) ${parentHash.substring(0, 7)}](command:mini-blame.copyText?${parentArgs} "Copy Parent SHA") ⟷ [$(git-commit) ${commitHash.substring(0, 7)}](command:mini-blame.copyText?${shaArgs} "Copy Commit SHA")</span>`);

            // --- 9. APPLY UI UPDATES ---
            
            // Apply the inline Ghost Text at the end of the line
            editor.setDecorations(decorationType, [{
                range: new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length),
                hoverMessage: md, // Attach our Markdown string to the hover event
                renderOptions: { after: { contentText: ` ${authorText}, ${relDate} • ${subject.substring(0, 50)}${subject.length > 50 ? '...' : ''}` } }
            }]);

            // Apply text and tooltip to the Status Bar
            statusBarItem.text = `$(git-commit) ${authorText}, ${relDate}`;
            statusBarItem.tooltip = `${subject}`;
            statusBarItem.show();

        } catch (e) { 
            // If anything fails (e.g., file not in Git, terminal error), cleanly hide decorations
            editor.setDecorations(decorationType, []); 
            statusBarItem.hide();
        }
    }

    // --- 10. COMMAND REGISTRATIONS ---

    // Command: Generic Copy Text (Handles SHAs, Branch Names, and PR Numbers)
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.copyText', (textToCopy: string, textType: string) => {
        vscode.env.clipboard.writeText(textToCopy);
        const label = textType || "Text"; 
        vscode.window.showInformationMessage(`${label} copied: ${textToCopy}`);
    }));

    // Command: Open Side-by-Side Diff View
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.openDiff', (filePath: string, currentHash: string, parentHash: string) => {
        const workspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath;
        if (!workspace) return;
        try {
            // Convert file path to relative path with forward slashes (required for Git commands)
            const relPath = path.relative(workspace, filePath).replace(/\\/g, '/');
            
            // Helper function to extract file contents at a specific hash
            const getGitFile = (hash: string) => {
                try { return execSync(`git show ${hash}:"${relPath}"`, { cwd: workspace, encoding: 'utf8' }).toString(); } 
                catch { return ""; } // Returns empty string if file didn't exist in that commit
            };
            
            // Save contents to temporary OS files so VS Code can read them
            const parentTmp = path.join(os.tmpdir(), `${parentHash.substring(0,7)}_${path.basename(filePath)}`);
            const currentTmp = path.join(os.tmpdir(), `${currentHash.substring(0,7)}_${path.basename(filePath)}`);
            fs.writeFileSync(parentTmp, getGitFile(parentHash));
            fs.writeFileSync(currentTmp, getGitFile(currentHash));
            
            // Launch VS Code's native diff viewer
            vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(parentTmp), vscode.Uri.file(currentTmp), `${path.basename(filePath)} (${parentHash.substring(0,7)} ⟷ ${currentHash.substring(0,7)})`);
        } catch (error: any) { vscode.window.showErrorMessage(`Error: ${error.message}`); }
    }));

    // Command: Open Old File (Triggered via More Actions)
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.openOldFile', async (filePath: string, commitHash: string) => {
        const workspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath;
        if (!workspace) return;
        try {
            const relPath = path.relative(workspace, filePath).replace(/\\/g, '/');
            
            // Extract the entire file as it existed in this specific commit
            const fileContent = execSync(`git show ${commitHash}:"${relPath}"`, { cwd: workspace, encoding: 'utf8' }).toString();
            
            // Write it to a temporary file
            const tmpPath = path.join(os.tmpdir(), `${commitHash.substring(0,7)}_${path.basename(filePath)}`);
            fs.writeFileSync(tmpPath, fileContent);
            
            // Open the temporary file in a new editor tab
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not extract old file: ${error.message}`);
        }
    }));

    // Command: Render the "More Actions" QuickPick Dropdown
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.moreActions', async (filePath: string, commitHash: string) => {
        // Define the options for the dropdown menu
        const options = [
            { label: '$(go-to-file) Browse File at Revision', action: 'browse' },
            { label: '$(history) Blame Prior to Commit', action: 'todo' },
            { label: '$(discard) Revert Commit...', action: 'todo' }
        ];
        
        // Display the menu and wait for user selection
        const choice = await vscode.window.showQuickPick(options, { placeHolder: 'Select an action' });
        
        // Execute logic based on user selection
        if (choice?.action === 'browse') {
            vscode.commands.executeCommand('mini-blame.openOldFile', filePath, commitHash);
        } else if (choice) {
            vscode.window.showInformationMessage('Feature coming soon!');
        }
    }));
}