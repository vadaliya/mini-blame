import * as vscode from 'vscode';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Promise-based exec wrapper for asynchronous process execution.
 */
function execAsync(command: string, options: { cwd: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { ...options, maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Helper to find the Git repository root (main or submodule) for a given file asynchronously.
 */
async function getGitRoot(filePath: string): Promise<string | undefined> {
    try {
        const fileDir = path.dirname(filePath);
        const gitRoot = (await execAsync('git rev-parse --show-toplevel', { cwd: fileDir })).trim();
        return path.resolve(gitRoot);
    } catch {
        return undefined;
    }
}

/**
 * Cache data structures for git blame.
 */
interface CommitInfo {
    hash: string;
    author: string;
    email: string;
    time: number;
    summary: string;
    filename?: string;
}

interface LineBlame {
    commitHash: string;
    originalLineNumber: number;
    finalLineNumber: number;
    filename?: string;
}

interface FileBlameCache {
    commits: Map<string, CommitInfo>;
    lines: LineBlame[];
}

interface FullCommitMetadata {
    hash: string;
    parentHash: string;
    author: string;
    email: string;
    relDate: string;
    fullDate: string;
    subject: string;
    bodyLines: string[];
}

const blamePromiseCache = new Map<string, Promise<FileBlameCache>>();
const commitMetadataCache = new Map<string, FullCommitMetadata>();
const hoverMarkdownCache = new Map<string, vscode.MarkdownString>();

function getBlameCache(filePath: string, gitRoot: string, ignoreWs: boolean): Promise<FileBlameCache> {
    let promise = blamePromiseCache.get(filePath);
    if (!promise) {
        promise = (async () => {
            const wsFlag = ignoreWs ? ' -w' : '';
            const blameRaw = await execAsync(`git blame -l${wsFlag} --porcelain "${filePath}"`, { cwd: gitRoot });
            return parsePorcelainBlame(blameRaw);
        })();
        blamePromiseCache.set(filePath, promise);
    }
    return promise;
}

/**
 * Parser for git blame --porcelain output of an entire file.
 */
function parsePorcelainBlame(output: string): FileBlameCache {
    const lines = output.split(/\r?\n/);
    const commits = new Map<string, CommitInfo>();
    const lineBlames: LineBlame[] = [];
    
    let i = 0;
    while (i < lines.length) {
        const headerLine = lines[i];
        if (!headerLine) {
            i++;
            continue;
        }
        
        // Header: <hash> <original-line-number> <final-line-number> <number-of-lines-in-group>
        const match = headerLine.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?/);
        if (!match) {
            i++;
            continue;
        }
        
        const hash = match[1];
        const originalLineNumber = parseInt(match[2], 10);
        const finalLineNumber = parseInt(match[3], 10);
        
        if (!commits.has(hash)) {
            commits.set(hash, {
                hash,
                author: 'Unknown',
                email: '',
                time: 0,
                summary: ''
            });
        }
        
        const commitInfo = commits.get(hash)!;
        
        i++;
        while (i < lines.length) {
            const line = lines[i];
            if (line.startsWith('\t')) {
                i++; // Skip code line
                break;
            }
            
            if (line.startsWith('author ')) {
                commitInfo.author = line.substring(7).trim();
            } else if (line.startsWith('author-mail ')) {
                commitInfo.email = line.substring(12).trim().replace(/^<|>$/g, '');
            } else if (line.startsWith('author-time ')) {
                commitInfo.time = parseInt(line.substring(12).trim(), 10);
            } else if (line.startsWith('summary ')) {
                commitInfo.summary = line.substring(8).trim();
            } else if (line.startsWith('filename ')) {
                commitInfo.filename = line.substring(9).trim();
            }
            
            if (line.match(/^([0-9a-f]{40})\s+(\d+)/)) {
                break;
            }
            i++;
        }
        
        lineBlames[finalLineNumber] = {
            commitHash: hash,
            originalLineNumber,
            finalLineNumber,
            filename: commitInfo.filename
        };
    }
    
    return { commits, lines: lineBlames };
}

const remoteCache = new Map<string, { base: string, provider: 'github' | 'gitlab' | 'bitbucket' | 'unknown' } | null>();

/**
 * Resolves the Git remote origin URL and parses it into a base web URL and provider.
 */
async function getRemoteInfo(gitRoot: string): Promise<{ base: string, provider: 'github' | 'gitlab' | 'bitbucket' | 'unknown' } | null> {
    if (remoteCache.has(gitRoot)) {
        return remoteCache.get(gitRoot)!;
    }
    try {
        const remoteUrl = (await execAsync('git remote get-url origin', { cwd: gitRoot })).trim();
        let cleanUrl = remoteUrl;
        if (cleanUrl.endsWith('.git')) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.length - 4);
        }
        
        let base = '';
        let provider: 'github' | 'gitlab' | 'bitbucket' | 'unknown' = 'unknown';
        
        const sshMatch = cleanUrl.match(/^git@([^:]+):(.+)$/);
        if (sshMatch) {
            const domain = sshMatch[1];
            const pathStr = sshMatch[2];
            base = `https://${domain}/${pathStr}`;
        } else {
            const httpMatch = cleanUrl.match(/^(https?:\/\/)(?:[^@\n]+@)?([^\/\n]+)\/(.+)$/);
            if (httpMatch) {
                base = `https://${httpMatch[2]}/${httpMatch[3]}`;
            } else {
                base = cleanUrl;
            }
        }
        
        if (base.includes('github.com')) {
            provider = 'github';
        } else if (base.includes('gitlab.com')) {
            provider = 'gitlab';
        } else if (base.includes('bitbucket.org')) {
            provider = 'bitbucket';
        }
        
        const info = { base, provider };
        remoteCache.set(gitRoot, info);
        return info;
    } catch {
        remoteCache.set(gitRoot, null);
        return null;
    }
}

/**
 * Constructs URLs for viewing commits, files, and pull requests on the web dashboard.
 */
async function getWebLinks(gitRoot: string, hash: string, relPath: string, prNumber?: string): Promise<{ commitUrl?: string, fileUrl?: string, prUrl?: string }> {
    const remoteInfo = await getRemoteInfo(gitRoot);
    if (!remoteInfo) {
        return {};
    }
    
    const { base, provider } = remoteInfo;
    const links: { commitUrl?: string, fileUrl?: string, prUrl?: string } = {};
    
    if (provider === 'github') {
        links.commitUrl = `${base}/commit/${hash}`;
        links.fileUrl = `${base}/blob/${hash}/${relPath}`;
        if (prNumber) {
            links.prUrl = `${base}/pull/${prNumber}`;
        }
    } else if (provider === 'gitlab') {
        links.commitUrl = `${base}/-/commit/${hash}`;
        links.fileUrl = `${base}/-/blob/${hash}/${relPath}`;
        if (prNumber) {
            links.prUrl = `${base}/-/merge_requests/${prNumber}`;
        }
    } else if (provider === 'bitbucket') {
        links.commitUrl = `${base}/commits/${hash}`;
        links.fileUrl = `${base}/src/${hash}/${relPath}`;
        if (prNumber) {
            links.prUrl = `${base}/pull-requests/${prNumber}`;
        }
    }
    return links;
}

/**
 * Builds the compiled hover MarkdownString for a specific file, line, and commit.
 * Automatically checks and populates from hoverMarkdownCache when possible.
 */
async function getHoverMarkdown(
    filePath: string,
    originalLineNumber: number,
    gitRoot: string,
    commitHash: string,
    blameRelPath: string
): Promise<vscode.MarkdownString> {
    const isUncommitted = commitHash.startsWith('00000000');
    const cacheKey = `${commitHash}:${originalLineNumber}:${filePath}`;
    
    if (!isUncommitted) {
        const cached = hoverMarkdownCache.get(cacheKey);
        if (cached) {
            return cached;
        }
    }

    const ignoreWs = vscode.workspace.getConfiguration('mini-blame').get<boolean>('ignoreWhitespace', false);
    const md = new vscode.MarkdownString("", true);
    md.supportHtml = true;      // Required for <span> coloring
    md.supportThemeIcons = true; // Required for $(icon-name) syntax
    md.isTrusted = true;         // Required to execute commands from links

    if (isUncommitted) {
        // --- UNCOMMITTED CHANGES HANDLER ---
        // 1. Calculate uncommitted time
        const stats = fs.statSync(filePath);
        const mtime = stats.mtime;
        const fullDate = mtime.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

        // 2. Extract the uncommitted diff
        let targetLineDiff: string[] = [];
        try {
            const wsFlag = ignoreWs ? ' -w' : '';
            const diffOutput = await execAsync(`git diff${wsFlag} --unified=0 HEAD -- "${blameRelPath}"`, { cwd: gitRoot });
            const diffLines = diffOutput.split('\n');
            for (let i = 0; i < diffLines.length; i++) {
                const match = diffLines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
                if (match) {
                    const hunkNewStart = parseInt(match[1], 10);
                    const hunkNewLen = parseInt(match[2] !== undefined ? match[2] : "1", 10);
                    if (originalLineNumber >= hunkNewStart && originalLineNumber < (hunkNewStart + hunkNewLen)) {
                        let currentNew = hunkNewStart;
                        let tempDeletions: string[] = [];
                        for (let j = i + 1; j < diffLines.length && !diffLines[j].startsWith('@@'); j++) {
                            const dLine = diffLines[j];
                            if (dLine.startsWith('-')) {
                                tempDeletions.push(dLine);
                            } else if (dLine.startsWith('+')) {
                                if (currentNew === originalLineNumber) {
                                    targetLineDiff.push(...tempDeletions);
                                    targetLineDiff.push(dLine);
                                    break;
                                }
                                currentNew++;
                                tempDeletions = [];
                            }
                        }
                        break;
                    }
                }
            }
        } catch (e) {}

        // 3. FETCH PREVIOUS COMMIT DATA (What the line was before you edited it)
        let prevHashFull = "";
        let prevShortHash = "";
        let prevAuthor = "Unknown";
        let prevDateStr = "";
        let prevFullDate = "";
        let prevSummary = "";
        let prevBranch = "Unknown";
        let prevParentHash = "0000000";
        let prevDiffText = "";

        try {
            const wsFlag = ignoreWs ? ' -w' : '';
            const prevBlameOutputRaw = await execAsync(`git blame -p -L ${originalLineNumber},${originalLineNumber} HEAD -- "${filePath}"`, { cwd: gitRoot });
            const prevBlameOutput = prevBlameOutputRaw.split('\n');
            const prevBlameMatch = prevBlameOutput[0].match(/^([0-9a-f]{40}) (\d+) \d+ \d+/);
            if (prevBlameMatch) {
                prevHashFull = prevBlameMatch[1];
                const prevLineNumber = parseInt(prevBlameMatch[2], 10);
                prevShortHash = prevHashFull.substring(0, 7);

                let prevTime = 0;
                for (const pLine of prevBlameOutput) {
                    if (pLine.startsWith('author ')) {
                        prevAuthor = pLine.substring(7);
                    } else if (pLine.startsWith('author-time ')) {
                        prevTime = parseInt(pLine.substring(12), 10);
                    } else if (pLine.startsWith('summary ')) {
                        prevSummary = pLine.substring(8);
                    }
                }

                if (prevTime > 0) {
                    const pDate = new Date(prevTime * 1000);
                    const pDiffDays = Math.floor((Date.now() - pDate.getTime()) / 86400000);
                    if (pDiffDays > 365) {
                        const years = Math.floor(pDiffDays / 365);
                        const months = Math.floor((pDiffDays % 365) / 30);
                        prevDateStr = `${years} year${years > 1 ? 's' : ''}${months > 0 ? `, ${months} month${months > 1 ? 's' : ''}` : ''} ago`;
                    } else if (pDiffDays > 30) {
                        const months = Math.floor(pDiffDays / 30);
                        prevDateStr = `${months} month${months > 1 ? 's' : ''} ago`;
                    } else {
                        prevDateStr = pDiffDays > 0 ? `${pDiffDays} days ago` : `Recently`;
                    }
                    prevFullDate = pDate.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                }

                try {
                    const parentsRaw = await execAsync(`git log -1 --pretty="%P" ${prevHashFull}`, { cwd: gitRoot });
                    const parents = parentsRaw.trim().split(' ');
                    prevParentHash = parents[0] ? parents[0].substring(0, 7) : "0000000";
                } catch (e) {}

                try {
                    let branchOut = (await execAsync(`git name-rev --name-only --exclude=tags/* ${prevHashFull}`, { cwd: gitRoot })).trim();
                    if (branchOut.startsWith('remotes/origin/')) {
                        branchOut = branchOut.substring(15);
                    }
                    prevBranch = branchOut.split('~')[0].split('^')[0];
                } catch (e) {}

                try {
                    const prevShowOutputRaw = await execAsync(`git show${wsFlag} ${prevHashFull} --unified=0 -- "${filePath}"`, { cwd: gitRoot });
                    const prevShowOutput = prevShowOutputRaw.split('\n');
                    let inRightHunk = false;
                    let currentNewLine = 0;
                    let localDeletions: string[] = [];
                    let finalDiffLines: string[] = [];

                    for (const sLine of prevShowOutput) {
                        if (sLine.startsWith('@@')) {
                            const hMatch = sLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
                            if (hMatch) {
                                const hunkStart = parseInt(hMatch[1], 10);
                                const hunkLen = parseInt(hMatch[2] !== undefined ? hMatch[2] : "1", 10);
                                if (prevLineNumber >= hunkStart && prevLineNumber < (hunkStart + hunkLen)) {
                                    inRightHunk = true;
                                    currentNewLine = hunkStart;
                                    continue;
                                }
                            }
                            inRightHunk = false;
                        } else if (inRightHunk) {
                            if (sLine.startsWith('diff --git')) {
                                break;
                            }
                            if (sLine.startsWith('-')) {
                                localDeletions.push(sLine);
                            } else if (sLine.startsWith('+')) {
                                if (currentNewLine === prevLineNumber) {
                                    finalDiffLines.push(...localDeletions);
                                    finalDiffLines.push(sLine);
                                    break;
                                }
                                currentNewLine++;
                                localDeletions = [];
                            }
                        }
                    }
                    prevDiffText = finalDiffLines.length > 0 ? finalDiffLines.join('\n') : "No direct code changes detected.";
                } catch (e) {}
            }
        } catch (e) {}

        let headHash = "HEAD";
        let workingTreeHash = "0000000";
        let branchName = "Unknown";
        try {
            headHash = (await execAsync('git rev-parse --short HEAD', { cwd: gitRoot })).trim();
            workingTreeHash = (await execAsync(`git hash-object "${filePath}"`, { cwd: gitRoot })).trim().substring(0, 7);
            const bName = (await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: gitRoot })).trim();
            if (bName && bName !== "HEAD") {
                branchName = bName;
            }
        } catch (e) {}

        md.appendMarkdown(`$(account) **You**, &nbsp;&nbsp; Just now *(${fullDate})*\n\n`);
        md.appendMarkdown(`**Uncommitted changes**\n\n`);

        const topActionLinks: string[] = [];
        topActionLinks.push(`$(repo) Working Tree`);

        const topDiffArgs = encodeURIComponent(JSON.stringify([filePath, "0000000000000000000000000000000000000000", headHash]));
        topActionLinks.push(`[$(git-compare)](command:mini-blame.openDiff?${topDiffArgs} "Open changes with previous revision")`);

        if (branchName && branchName !== "Unknown") {
            const topBranchArgs = encodeURIComponent(JSON.stringify([branchName, "Branch Name"]));
            topActionLinks.push(`[$(git-branch) ${branchName}](command:mini-blame.copyText?${topBranchArgs} "Copy Branch Name")`);
        }

        const topMoreArgs = encodeURIComponent(JSON.stringify([filePath, "0000000000000000000000000000000000000000", originalLineNumber]));
        topActionLinks.push(`[$(ellipsis)](command:mini-blame.moreActions?${topMoreArgs} "Show more actions")`);

        md.appendMarkdown(topActionLinks.join(' &nbsp;|&nbsp; ') + '\n\n');

        const codeDiff = targetLineDiff.length > 0 ? targetLineDiff.join('\n') : "No direct code changes detected.";
        md.appendCodeblock(codeDiff, 'diff');

        const headCopyArgs = encodeURIComponent(JSON.stringify([headHash, "HEAD SHA"]));
        const wtCopyArgs = encodeURIComponent(JSON.stringify([workingTreeHash, "Working Tree SHA"]));
        md.appendMarkdown(`\n<span style="color:#ffffff;">Changes &nbsp;[$(git-commit) ${headHash.substring(0, 7)}](command:mini-blame.copyText?${headCopyArgs} "Copy HEAD SHA") ⟷ [$(git-commit) ${workingTreeHash.substring(0, 7)}](command:mini-blame.copyText?${wtCopyArgs} "Copy Working Tree SHA")</span>\n`);

        if (prevShortHash) {
            md.appendMarkdown(`\n---\n\n**previous changes**\n\n`);
            md.appendMarkdown(`$(account) **${prevAuthor}** &nbsp;&nbsp; $(history) ${prevDateStr} *(${prevFullDate})*\n\n`);
            md.appendMarkdown(`${prevSummary}\n\n`);

            const prevActionLinks: string[] = [];
            const prevShaArgs = encodeURIComponent(JSON.stringify([prevHashFull, "Commit SHA"]));
            prevActionLinks.push(`$(git-commit) [${prevShortHash}](command:mini-blame.copyText?${prevShaArgs} "Copy Commit SHA")`);

            const prevDiffArgs = encodeURIComponent(JSON.stringify([filePath, prevHashFull, prevParentHash]));
            prevActionLinks.push(`[$(git-compare)](command:mini-blame.openDiff?${prevDiffArgs} "Open changes with previous revision")`);

            if (prevBranch && prevBranch !== "Unknown") {
                const prevBranchArgs = encodeURIComponent(JSON.stringify([prevBranch, "Branch Name"]));
                prevActionLinks.push(`[$(git-branch) ${prevBranch}](command:mini-blame.copyText?${prevBranchArgs} "Copy Branch Name")`);
            }

            const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
            const webLinks = await getWebLinks(gitRoot, prevHashFull, relPath, prevSummary.match(/#(\d+)/)?.[1]);
            if (webLinks.commitUrl) {
                prevActionLinks.push(`[$(globe) Web Commit](${webLinks.commitUrl} "View Commit on Web")`);
            }

            const prevMoreArgs = encodeURIComponent(JSON.stringify([filePath, prevHashFull, originalLineNumber]));
            prevActionLinks.push(`[$(ellipsis)](command:mini-blame.moreActions?${prevMoreArgs} "Show more actions")`);

            md.appendMarkdown(prevActionLinks.join(' &nbsp;|&nbsp; ') + '\n\n');
            md.appendCodeblock(prevDiffText || "No diff available.", 'diff');

            const prevFooterParentArgs = encodeURIComponent(JSON.stringify([prevParentHash, "Parent SHA"]));
            md.appendMarkdown(`\n<span style="color:#ffffff;">Changes &nbsp;[$(git-commit) ${prevParentHash.substring(0, 7)}](command:mini-blame.copyText?${prevFooterParentArgs} "Copy Parent SHA") ⟷ [$(git-commit) ${prevShortHash}](command:mini-blame.copyText?${prevShaArgs} "Copy Commit SHA")</span>`);
        }
    } else {
        // --- COMMITTED CHANGES HANDLER ---
        let metadata = commitMetadataCache.get(commitHash);
        if (!metadata) {
            const metadataRaw = await execAsync(`git show -s --format="%P%n%an%n%ae%n%ar%n%ad%n%s%n%b" --date=format:"%B %d, %Y %I:%M %p" ${commitHash}`, { cwd: gitRoot });
            const metadataLines = metadataRaw.replace(/[^\x00-\x7F]/g, "").split('\n');

            const parentHash = metadataLines[0].trim().split(' ')[0] || commitHash;
            const author = metadataLines[1];
            const email = metadataLines[2].trim();
            let relDate = metadataLines[3];
            const fullDate = metadataLines[4].replace(/ 0(\d:)/, ' $1');
            const subject = metadataLines[5];
            const bodyLines = metadataLines.slice(6).filter(l => l.trim() !== "");

            if (relDate === '1 year ago') {
                relDate = '12 months ago';
            }

            metadata = {
                hash: commitHash,
                parentHash,
                author,
                email,
                relDate,
                fullDate,
                subject,
                bodyLines
            };
            commitMetadataCache.set(commitHash, metadata);
        }

        const parentHash = metadata.parentHash;
        const author = metadata.author;
        const email = metadata.email;
        const relDate = metadata.relDate;
        const fullDate = metadata.fullDate;
        const subject = metadata.subject;
        const bodyLines = metadata.bodyLines;

        let displaySubject = subject;
        let extraDetails = bodyLines;

        if (subject.includes('->')) {
            const parts = subject.split('->').map((p: string) => p.trim());
            displaySubject = parts[0];
            extraDetails = [...parts.slice(1), ...extraDetails];
        }

        let branchName = "";
        try {
            const nameRevRaw = (await execAsync(`git name-rev --name-only --exclude=tags/* ${commitHash}`, { cwd: gitRoot })).trim();
            if (nameRevRaw && !nameRevRaw.includes("undefined")) {
                branchName = nameRevRaw.replace(/^remotes\/[^\/]+\//, '').split(/[\~^]/)[0];
            }
        } catch {}

        const fullMessage = subject + '\n' + bodyLines.join('\n');
        const prMatch = fullMessage.match(/#(\d+)/);
        const prNumber = prMatch ? prMatch[0] : "";
        const rawPrNumberOnly = prMatch ? prMatch[1] : undefined;

        const wsFlag = ignoreWs ? ' -w' : '';
        const diffOutput = await execAsync(`git show${wsFlag} --unified=0 ${commitHash} -- "${blameRelPath}"`, { cwd: gitRoot });
        const diffLines = diffOutput.split('\n');
        let targetLineDiff: string[] = [];

        for (let i = 0; i < diffLines.length; i++) {
            const match = diffLines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                const hunkNewStart = parseInt(match[1], 10);
                const hunkNewLen = parseInt(match[2] !== undefined ? match[2] : "1", 10);

                if (originalLineNumber >= hunkNewStart && originalLineNumber < (hunkNewStart + hunkNewLen)) {
                    let currentNew = hunkNewStart;
                    let tempDeletions: string[] = [];

                    for (let j = i + 1; j < diffLines.length && !diffLines[j].startsWith('@@'); j++) {
                        const dLine = diffLines[j];
                        if (dLine.startsWith('-')) {
                            tempDeletions.push(dLine);
                        } else if (dLine.startsWith('+')) {
                            if (currentNew === originalLineNumber) {
                                targetLineDiff.push(...tempDeletions);
                                targetLineDiff.push(dLine);
                                break;
                            }
                            currentNew++;
                            tempDeletions = [];
                        }
                    }
                    break;
                }
            }
        }

        const authorText = author === 'You' ? 'You' : author;
        md.appendMarkdown(`$(account) [**${authorText}**](mailto:${email} "Email ${author} (${email})") &nbsp; $(history) ${relDate}&nbsp;(${fullDate})\n\n`);
        md.appendMarkdown(`${displaySubject}\n\n`);

        if (extraDetails.length > 0) {
            md.appendMarkdown(`${extraDetails.map((d: string) => `&nbsp;&nbsp;&nbsp;&nbsp;$(chevron-right) ${d}`).join('  \n')}\n\n`);
        }

        md.appendMarkdown(`--- \n`);

        const actionLinks: string[] = [];
        const detailsArgs = encodeURIComponent(JSON.stringify([commitHash, filePath]));
        const shaArgs = encodeURIComponent(JSON.stringify([commitHash, "Commit SHA"]));

        actionLinks.push(`$(git-commit) [${commitHash.substring(0, 7)}](command:mini-blame.showCommitDetails?${detailsArgs} "Show Commit Details") [$(copy)](command:mini-blame.copyText?${shaArgs} "Copy Commit SHA")`);

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

        const webLinks = await getWebLinks(gitRoot, commitHash, blameRelPath, rawPrNumberOnly);
        if (webLinks.commitUrl) {
            actionLinks.push(`[$(globe) Web Commit](${webLinks.commitUrl} "View Commit on Web")`);
        }

        const moreArgs = encodeURIComponent(JSON.stringify([filePath, commitHash, originalLineNumber]));
        actionLinks.push(`[$(ellipsis)](command:mini-blame.moreActions?${moreArgs} "Show more actions")`);

        md.appendMarkdown(actionLinks.join(' &nbsp;| &nbsp;') + '\n\n');

        const codeDiff = targetLineDiff.length > 0 ? targetLineDiff.join('\n') : "No direct code changes detected.";
        md.appendCodeblock(codeDiff, 'diff');

        const parentArgs = encodeURIComponent(JSON.stringify([parentHash, "Parent SHA"]));
        md.appendMarkdown(`\n<span style="color:#ffffff;">Changes &nbsp;[$(git-commit) ${parentHash.substring(0, 7)}](command:mini-blame.copyText?${parentArgs} "Copy Parent SHA") ⟷ [$(git-commit) ${commitHash.substring(0, 7)}](command:mini-blame.copyText?${shaArgs} "Copy Commit SHA")</span>`);

        hoverMarkdownCache.set(cacheKey, md);
    }

    return md;
}

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

    // Register native HoverProvider to display Git Blame information when hovering over lines
    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ scheme: 'file' }, {
            async provideHover(document, position, token) {
                const gitRoot = await getGitRoot(document.fileName);
                if (!gitRoot) {
                    return undefined;
                }

                try {
                    const ignoreWs = vscode.workspace.getConfiguration('mini-blame').get<boolean>('ignoreWhitespace', false);
                    const cache = await getBlameCache(document.fileName, gitRoot, ignoreWs);

                    const currentLineNumber = position.line + 1;
                    const lineBlame = cache.lines[currentLineNumber];
                    if (!lineBlame) {
                        return undefined;
                    }

                    const commitHash = lineBlame.commitHash;
                    const originalLineNumber = lineBlame.originalLineNumber;
                    const relPath = path.relative(gitRoot, document.fileName).replace(/\\/g, '/');
                    const blameRelPath = lineBlame.filename || relPath;

                    const md = await getHoverMarkdown(document.fileName, originalLineNumber, gitRoot, commitHash, blameRelPath);
                    const range = new vscode.Range(position.line, 0, position.line, document.lineAt(position.line).text.length);
                    return new vscode.Hover(md, range);
                } catch {
                    return undefined;
                }
            }
        })
    );

    // --- 2. EVENT LISTENERS ---

    // Create a timer variable to manage our 1-second debounce delay
    let debounceTimer: NodeJS.Timeout | undefined;

    // If a file is already open when the extension starts, run the tracker immediately
    if (vscode.window.activeTextEditor) {
        updateDecoration(vscode.window.activeTextEditor);
    }

    // Trigger whenever the user switches between different file tabs
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            updateDecoration(editor);
        } else {
            statusBarItem.hide(); 
        }
    });

    // Triggered when cursor moves (via mouse click or keyboard arrows)
    vscode.window.onDidChangeTextEditorSelection(e => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        
        // Instantly clear the UI when cursor/selection moves to another line
        e.textEditor.setDecorations(decorationType, []);
        statusBarItem.hide();
        
        const delay = vscode.workspace.getConfiguration('mini-blame').get<number>('debounceDelay', 200);
        debounceTimer = setTimeout(() => {
            updateDecoration(e.textEditor);
        }, delay);
    });

    // Hide the blame data the exact millisecond the user modifies text
    vscode.workspace.onDidChangeTextDocument(e => {
        // Invalidate the cache for this modified document
        blamePromiseCache.delete(e.document.fileName);
        for (const key of hoverMarkdownCache.keys()) {
            if (key.endsWith(`:${e.document.fileName}`)) {
                hoverMarkdownCache.delete(key);
            }
        }

        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) {
            // Instantly clear the UI while typing
            editor.setDecorations(decorationType, []);
            statusBarItem.hide();

            // Destroy the current timer to prevent the blinking effect
            if (debounceTimer) {
                clearTimeout(debounceTimer); 
            }

            // The "Idle Timer"
            const delay = vscode.workspace.getConfiguration('mini-blame').get<number>('debounceDelay', 200);
            debounceTimer = setTimeout(() => {
                updateDecoration(editor);
            }, delay);
        }
    });

    // Purge cache when document is closed to avoid leaks
    vscode.workspace.onDidCloseTextDocument(document => {
        blamePromiseCache.delete(document.fileName);
        for (const key of hoverMarkdownCache.keys()) {
            if (key.endsWith(`:${document.fileName}`)) {
                hoverMarkdownCache.delete(key);
            }
        }
    });

    // Clear caches when workspace configuration changes
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('mini-blame')) {
            blamePromiseCache.clear();
            hoverMarkdownCache.clear();
            commitMetadataCache.clear();
        }
    });

    /**
     * Core function that fetches Git data for the currently selected line and updates the UI.
     */
    async function updateDecoration(editor: vscode.TextEditor) {
        // Get zero-indexed line number from cursor, and add 1 for Git (which uses 1-indexed lines)
        const line = editor.selection.active.line;
        const currentLineNumber = line + 1;
        
        const filePath = editor.document.fileName;
        
        // Find the Git repository root (main or submodule) for the file
        const gitRoot = await getGitRoot(filePath);

        // Abort if the file isn't part of a Git repository
        if (!gitRoot) { statusBarItem.hide(); return; }

        try {
            // --- 3. FETCH GIT BLAME DATA (Cached & Async) ---
            const ignoreWs = vscode.workspace.getConfiguration('mini-blame').get<boolean>('ignoreWhitespace', false);
            const cache = await getBlameCache(filePath, gitRoot, ignoreWs);

            const lineBlame = cache.lines[currentLineNumber];
            if (!lineBlame) {
                editor.setDecorations(decorationType, []); 
                statusBarItem.hide();
                return;
            }

            const commitHash = lineBlame.commitHash;

            // If hash is all zeros, the line is uncommitted (modified locally). Clear UI and abort.
            if (commitHash.startsWith('00000000')) { 
                // Apply the inline Ghost Text at the end of the line
                editor.setDecorations(decorationType, [{
                    range: new vscode.Range(line, editor.document.lineAt(line).text.length, line, editor.document.lineAt(line).text.length),
                    renderOptions: { after: { contentText: ` You, Just now • Uncommitted changes` } }
                }]);

                statusBarItem.text = `$(git-commit) You, Just now`;
                statusBarItem.tooltip = `Uncommitted changes`;
                statusBarItem.show();
                return;
            }

            // --- 4. FETCH METADATA (From Cache or Async git show) ---
            let metadata = commitMetadataCache.get(commitHash);
            if (!metadata) {
                const metadataRaw = await execAsync(`git show -s --format="%P%n%an%n%ae%n%ar%n%ad%n%s%n%b" --date=format:"%B %d, %Y %I:%M %p" ${commitHash}`, { cwd: gitRoot });
                const metadataLines = metadataRaw.replace(/[^\x00-\x7F]/g, "").split('\n');
                
                const parentHash = metadataLines[0].trim().split(' ')[0] || commitHash;
                const author = metadataLines[1];
                const email = metadataLines[2].trim();
                let relDate = metadataLines[3];
                const fullDate = metadataLines[4].replace(/ 0(\d:)/, ' $1');
                const subject = metadataLines[5];
                const bodyLines = metadataLines.slice(6).filter(l => l.trim() !== "");

                if (relDate === '1 year ago') {
                    relDate = '12 months ago';
                }

                metadata = {
                    hash: commitHash,
                    parentHash,
                    author,
                    email,
                    relDate,
                    fullDate,
                    subject,
                    bodyLines
                };
                commitMetadataCache.set(commitHash, metadata);
            }

            const authorText = metadata.author === 'You' ? 'You' : metadata.author;
            const relDate = metadata.relDate;
            const subject = metadata.subject;

            // --- 9. APPLY UI UPDATES ---
            const formatTemplate = vscode.workspace.getConfiguration('mini-blame').get<string>('annotationFormat', '${author}, ${relDate} • ${subject}');
            const annotationText = formatTemplate
                .replace(/\${author}/g, authorText)
                .replace(/\${email}/g, metadata.email)
                .replace(/\${relDate}/g, relDate)
                .replace(/\${fullDate}/g, metadata.fullDate)
                .replace(/\${subject}/g, subject)
                .replace(/\${hash}/g, commitHash.substring(0, 7));

            // Apply the inline Ghost Text at the end of the line (No hoverMessage attached here to avoid duplication with HoverProvider)
            editor.setDecorations(decorationType, [{
                range: new vscode.Range(line, editor.document.lineAt(line).text.length, line, editor.document.lineAt(line).text.length),
                renderOptions: { after: { contentText: ` ${annotationText.substring(0, 80)}${annotationText.length > 80 ? '...' : ''}` } }
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
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.openDiff', async (filePath: string, currentHash: string, parentHash: string) => {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) {
            return;
        }
        try {
            // Convert file path to relative path with forward slashes (required for Git commands)
            const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
            
            // Helper function to extract file contents at a specific hash
            const getGitFile = async (hash: string) => {
                try { return await execAsync(`git show ${hash}:"${relPath}"`, { cwd: gitRoot }); } 
                catch { return ""; } // Returns empty string if file didn't exist in that commit
            };
            
            // Save contents to temporary OS files so VS Code can read them
            const parentTmp = path.join(os.tmpdir(), `${parentHash.substring(0,7)}_${path.basename(filePath)}`);
            const currentTmp = path.join(os.tmpdir(), `${currentHash.substring(0,7)}_${path.basename(filePath)}`);
            fs.writeFileSync(parentTmp, await getGitFile(parentHash));
            fs.writeFileSync(currentTmp, await getGitFile(currentHash));
            
            // Launch VS Code's native diff viewer
            vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(parentTmp), vscode.Uri.file(currentTmp), `${path.basename(filePath)} (${parentHash.substring(0,7)} ⟷ ${currentHash.substring(0,7)})`);
        } catch (error: any) { vscode.window.showErrorMessage(`Error: ${error.message}`); }
    }));

    // Command: Open Old File (Triggered via More Actions)
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.openOldFile', async (filePath: string, commitHash: string) => {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) {
            return;
        }
        try {
            const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
            
            // Extract the entire file as it existed in this specific commit
            const fileContent = await execAsync(`git show ${commitHash}:"${relPath}"`, { cwd: gitRoot });
            
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
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.moreActions', async (filePath: string, commitHash: string, lineNumber: number) => {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) {
            return;
        }

        // Define the options for the main dropdown menu
        const options = [
            { label: '$(history) Show Line History', action: 'history' },
            { label: '$(history) Blame Prior to Commit', action: 'walkback' },
            { label: '$(git-compare) Compare with Working Tree', action: 'compareWorking' },
            { label: '$(copy) Copy Commit Message', action: 'copyMessage' },
            { label: '$(git-branch) Create Branch at Commit...', action: 'createBranch' },
            { label: '$(tag) Create Tag at Commit...', action: 'createTag' }
        ];
        
        // Display the menu and wait for user selection
        const choice = await vscode.window.showQuickPick(options, { placeHolder: 'Select an action' });
        if (!choice) {
            return;
        }
        
        if (choice.action === 'history') {
            vscode.commands.executeCommand('mini-blame.showLineHistory', filePath, lineNumber);
        } else if (choice.action === 'compareWorking') {
            await compareWithWorking(gitRoot, commitHash, filePath);
        } else if (choice.action === 'copyMessage') {
            await copyCommitMessage(gitRoot, commitHash);
        } else if (choice.action === 'createBranch') {
            await createBranchAtCommit(gitRoot, commitHash);
        } else if (choice.action === 'createTag') {
            await createTagAtCommit(gitRoot, commitHash);
        } else if (choice.action === 'walkback') {
            try {
                let parentHash = "";
                if (commitHash.startsWith('00000000')) {
                    parentHash = "HEAD";
                } else {
                    const parentsRaw = await execAsync(`git log -1 --pretty="%P" ${commitHash}`, { cwd: gitRoot });
                    parentHash = parentsRaw.trim().split(' ')[0];
                }

                if (!parentHash) {
                    vscode.window.showErrorMessage('This is the initial commit (no parent exists).');
                    return;
                }

                const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
                let targetPath = filePath;
                let wasAdded = false;

                // Check if the file was renamed or added in this commit
                if (!commitHash.startsWith('00000000')) {
                    try {
                        const diffTreeOut = await execAsync(`git diff-tree --no-commit-id --name-status -r -M ${commitHash}`, { cwd: gitRoot });
                        const diffTreeLines = diffTreeOut.trim().split('\n');
                        for (const line of diffTreeLines) {
                            const parts = line.split(/\s+/);
                            if (parts.length >= 3 && parts[0].startsWith('R')) {
                                const oldPath = parts[1];
                                const newPath = parts[2];
                                if (newPath === relPath) {
                                    targetPath = path.resolve(gitRoot, oldPath);
                                    break;
                                }
                            } else if (parts.length >= 2 && parts[0] === 'A') {
                                const addedPath = parts[1];
                                if (addedPath === relPath) {
                                    wasAdded = true;
                                    break;
                                }
                            }
                        }
                    } catch {
                        // Fallback
                    }
                }

                // If it was newly added, there is no previous revision
                if (wasAdded) {
                    vscode.window.showInformationMessage(`This file was newly created/added in commit ${commitHash.substring(0, 7)}. No prior history exists.`);
                    return;
                }

                // Double check if file exists in parent commit
                const targetRelPath = path.relative(gitRoot, targetPath).replace(/\\/g, '/');
                try {
                    await execAsync(`git cat-file -e ${parentHash}:"${targetRelPath}"`, { cwd: gitRoot });
                } catch {
                    vscode.window.showInformationMessage(`File did not exist in commit ${parentHash.substring(0, 7)}. No prior history exists.`);
                    return;
                }

                const ignoreWs = vscode.workspace.getConfiguration('mini-blame').get<boolean>('ignoreWhitespace', false);
                const wsFlag = ignoreWs ? ' -w' : '';
                const blameOutputRaw = await execAsync(`git blame -l${wsFlag} -L ${lineNumber},${lineNumber} --porcelain ${parentHash} -- "${targetPath}"`, { cwd: gitRoot });
                const lines = blameOutputRaw.split('\n');
                const match = lines[0].match(/^([0-9a-f]{40}) (\d+) \d+ \d+/);
                
                if (!match) {
                    vscode.window.showErrorMessage('Could not find blame history for this line.');
                    return;
                }

                const ancestorHash = match[1];
                const ancestorLineNumber = parseInt(match[2], 10);

                if (ancestorHash.startsWith('00000000')) {
                    vscode.window.showInformationMessage('Uncommitted changes detected at revision.');
                    return;
                }

                const metadataRaw = await execAsync(`git show -s --format="%an%n%ar%n%s" ${ancestorHash}`, { cwd: gitRoot });
                const metaLines = metadataRaw.split('\n');
                const author = metaLines[0];
                const relDate = metaLines[1];
                const subject = metaLines[2];

                const ancestorOptions = [
                    { label: `$(history) Show Line History`, action: 'history', detail: `Show full evolution of this line` },
                    { label: `$(git-compare) Open Commit Diff`, action: 'diff' },
                    { label: `$(info) View Commit Details`, action: 'details' },
                    { label: `$(history) Blame Prior to Commit`, action: 'walkback' },
                    { label: `$(git-compare) Compare with Working Tree`, action: 'compareWorking' },
                    { label: `$(copy) Copy Commit Message`, action: 'copyMessage' },
                    { label: `$(git-branch) Create Branch at Commit...`, action: 'createBranch' },
                    { label: `$(tag) Create Tag at Commit...`, action: 'createTag' }
                ];

                const selection = await vscode.window.showQuickPick(ancestorOptions, {
                    placeHolder: `${author}, ${relDate} • ${subject}`
                });

                if (selection?.action === 'history') {
                    vscode.commands.executeCommand('mini-blame.showLineHistory', targetPath, ancestorLineNumber);
                } else if (selection?.action === 'diff') {
                    const parentsOfAncestorRaw = await execAsync(`git log -1 --pretty="%P" ${ancestorHash}`, { cwd: gitRoot });
                    const parentOfAncestor = parentsOfAncestorRaw.trim().split(' ')[0] || ancestorHash;
                    vscode.commands.executeCommand('mini-blame.openDiff', targetPath, ancestorHash, parentOfAncestor);
                } else if (selection?.action === 'details') {
                    vscode.commands.executeCommand('mini-blame.showCommitDetails', ancestorHash, targetPath);
                } else if (selection?.action === 'compareWorking') {
                    await compareWithWorking(gitRoot, ancestorHash, targetPath);
                } else if (selection?.action === 'copyMessage') {
                    await copyCommitMessage(gitRoot, ancestorHash);
                } else if (selection?.action === 'createBranch') {
                    await createBranchAtCommit(gitRoot, ancestorHash);
                } else if (selection?.action === 'createTag') {
                    await createTagAtCommit(gitRoot, ancestorHash);
                } else if (selection?.action === 'walkback') {
                    vscode.commands.executeCommand('mini-blame.moreActions', targetPath, ancestorHash, ancestorLineNumber);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`History Walkback failed: ${err.message}`);
            }
        }
    }));

    // Command: Show Detailed Commit Webview Panel
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.showCommitDetails', async (commitHash: string, filePath: string) => {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) {
            return;
        }

        try {
            // 1. Fetch Commit Info
            const showOutput = await execAsync(`git show -s --format="%an%n%ae%n%ad%n%s%n%b" --date=format:"%B %d, %Y %I:%M %p" ${commitHash}`, { cwd: gitRoot });
            const lines = showOutput.replace(/[^\x00-\x7F]/g, "").split('\n');
            const author = lines[0];
            const email = lines[1].trim();
            const date = lines[2];
            const subject = lines[3];
            const body = lines.slice(4).join('\n').trim();

            // 2. Fetch Files Changed
            const filesOutput = await execAsync(`git diff-tree --no-commit-id --name-status -r ${commitHash}`, { cwd: gitRoot });
            const filesLines = filesOutput.trim().split('\n').filter(l => l.trim() !== "");
            const fileListHtml = filesLines.map(fileLine => {
                const parts = fileLine.split(/\s+/);
                const status = parts[0] || 'M';
                const file = parts[1] || '';
                return `
                    <li class="file-item" data-file="${escapeHtml(file)}" onclick="selectFile('${escapeHtml(file)}')">
                        <span class="status-badge status-${status}">${status}</span>
                        <span class="file-name">${escapeHtml(file)}</span>
                    </li>
                `;
            }).join('');

            // 3. Create and Show Webview Panel
            const panel = vscode.window.createWebviewPanel(
                'commitDetails',
                `Commit Details: ${commitHash.substring(0, 7)}`,
                vscode.ViewColumn.One,
                { enableScripts: true }
            );

            // 4. Implement Webview Message Listener to fetch diffs on-demand
            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'fetchDiff') {
                    try {
                        const ignoreWs = vscode.workspace.getConfiguration('mini-blame').get<boolean>('ignoreWhitespace', false);
                        const wsFlag = ignoreWs ? ' -w' : '';
                        const diffOutput = await execAsync(`git show${wsFlag} ${commitHash} -- "${message.file}"`, { cwd: gitRoot });
                        
                        // Strip the redundant commit metadata header and only show the file diff
                        const gitIndex = diffOutput.indexOf('diff --git');
                        const cleanDiff = gitIndex !== -1 ? diffOutput.substring(gitIndex) : diffOutput;
                        
                        const diffHtml = renderDiffToHtml(cleanDiff);
                        panel.webview.postMessage({ command: 'diffLoaded', file: message.file, diffHtml });
                    } catch (error: any) {
                        panel.webview.postMessage({ command: 'diffFailed', file: message.file, error: error.message });
                    }
                }
            });

            // 5. Set HTML Content
            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body {
                            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
                            background-color: var(--vscode-editor-background);
                            color: var(--vscode-editor-foreground);
                            margin: 0;
                            padding: 20px;
                            display: flex;
                            flex-direction: column;
                            height: 100vh;
                            box-sizing: border-box;
                        }
                        .header {
                            border-bottom: 1px solid var(--vscode-widget-border);
                            padding-bottom: 15px;
                            margin-bottom: 15px;
                        }
                        .title {
                            font-size: 1.4em;
                            font-weight: bold;
                            margin: 0 0 10px 0;
                            color: var(--vscode-textLink-activeForeground);
                        }
                        .meta-row {
                            display: flex;
                            gap: 20px;
                            font-size: 0.9em;
                            color: var(--vscode-descriptionForeground);
                            margin-bottom: 8px;
                        }
                        .container {
                            display: flex;
                            flex: 1;
                            gap: 20px;
                            min-height: 0;
                        }
                        .sidebar {
                            flex: 1;
                            max-width: 320px;
                            display: flex;
                            flex-direction: column;
                            gap: 15px;
                            min-height: 0;
                        }
                        .main-panel {
                            flex: 2;
                            display: flex;
                            flex-direction: column;
                            min-height: 0;
                            border: 1px solid var(--vscode-widget-border);
                            border-radius: 4px;
                            background-color: var(--vscode-textCodeBlock-background);
                        }
                        .section-title {
                            font-size: 1em;
                            font-weight: bold;
                            border-bottom: 1px solid var(--vscode-widget-border);
                            padding: 8px 12px;
                            margin: 0;
                            background-color: var(--vscode-editorWidget-background);
                        }
                        .scrollable {
                            overflow: auto;
                            flex: 1;
                            padding: 12px;
                        }
                        .commit-body {
                            white-space: pre-wrap;
                            font-size: 0.9em;
                            line-height: 1.4;
                            font-family: var(--vscode-font-family, sans-serif);
                        }
                        .file-list {
                            list-style: none;
                            padding: 0;
                            margin: 0;
                            font-family: var(--vscode-editor-font-family, monospace);
                            font-size: 0.85em;
                        }
                        .file-item {
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            padding: 6px 8px;
                            cursor: pointer;
                            border-radius: 4px;
                            transition: background-color 0.12s ease;
                        }
                        .file-item:hover {
                            background-color: var(--vscode-list-hoverBackground);
                        }
                        .file-item.active {
                            background-color: var(--vscode-list-activeSelectionBackground);
                            color: var(--vscode-list-activeSelectionForeground);
                        }
                        .file-name {
                            overflow: hidden;
                            text-overflow: ellipsis;
                            white-space: nowrap;
                        }
                        .status-badge {
                            font-weight: bold;
                            font-size: 0.75em;
                            padding: 2px 6px;
                            border-radius: 3px;
                            min-width: 15px;
                            text-align: center;
                        }
                        .status-M { background-color: rgba(230, 162, 44, 0.2); color: #e6a23c; }
                        .status-A { background-color: rgba(103, 194, 58, 0.2); color: #67c23a; }
                        .status-D { background-color: rgba(245, 108, 108, 0.2); color: #f56c6c; }
                        .diff-container {
                            font-family: var(--vscode-editor-font-family, monospace);
                            font-size: 11.5px;
                            white-space: pre-wrap;
                            margin: 0;
                            line-height: 1.5;
                        }
                        .diff-line {
                            padding: 1px 8px;
                            min-height: 16px;
                        }
                        .diff-add {
                            background-color: rgba(103, 194, 58, 0.12);
                            color: #4ec9b0;
                        }
                        .diff-del {
                            background-color: rgba(245, 108, 108, 0.12);
                            color: #f44747;
                        }
                        .diff-hunk {
                            background-color: rgba(0, 122, 204, 0.12);
                            color: #85c5ec;
                            font-weight: bold;
                        }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <div class="title">${escapeHtml(subject)}</div>
                        <div class="meta-row">
                            <div><strong>Author:</strong> ${escapeHtml(author)} (${escapeHtml(email)})</div>
                            <div><strong>Date:</strong> ${escapeHtml(date)}</div>
                        </div>
                        <div class="meta-row">
                            <div><strong>Commit:</strong> ${commitHash}</div>
                        </div>
                    </div>
                    <div class="container">
                        <div class="sidebar">
                            <div class="main-panel">
                                <div class="section-title">Message Body</div>
                                <div class="scrollable">
                                    <div class="commit-body">${escapeHtml(body || 'No description provided.')}</div>
                                </div>
                            </div>
                            <div class="main-panel">
                                <div class="section-title">Files Changed</div>
                                <div class="scrollable">
                                    <ul class="file-list">
                                        ${fileListHtml || '<li class="file-item" style="cursor: default;">No files changed.</li>'}
                                    </ul>
                                </div>
                            </div>
                        </div>
                        <div class="main-panel">
                            <div class="section-title" id="diff-title">File Diff</div>
                            <div class="scrollable">
                                <div class="diff-container" id="diff-viewport"></div>
                            </div>
                        </div>
                    </div>

                    <script>
                        const vscode = acquireVsCodeApi();
                        let currentLoadingFile = null;

                        function selectFile(file) {
                            // Update active status in sidebar list
                            document.querySelectorAll('.file-item').forEach(item => {
                                if (item.getAttribute('data-file') === file) {
                                    item.classList.add('active');
                                } else {
                                    item.classList.remove('active');
                                }
                            });
                            
                            // Update viewport title and content
                            document.getElementById('diff-title').textContent = "File Diff: " + file;
                            const viewport = document.getElementById('diff-viewport');
                            viewport.innerHTML = '<div style="padding: 20px; color: var(--vscode-descriptionForeground);">Loading diff...</div>';
                            currentLoadingFile = file;

                            vscode.postMessage({
                                command: 'fetchDiff',
                                file: file
                            });
                        }

                        // Listen for messages from the extension
                        window.addEventListener('message', event => {
                            const message = event.data;
                            if (message.command === 'diffLoaded') {
                                if (message.file === currentLoadingFile) {
                                    const viewport = document.getElementById('diff-viewport');
                                    viewport.innerHTML = message.diffHtml || '<div style="padding: 20px; color: var(--vscode-descriptionForeground);">No diff available for this file.</div>';
                                }
                            } else if (message.command === 'diffFailed') {
                                if (message.file === currentLoadingFile) {
                                    const viewport = document.getElementById('diff-viewport');
                                    viewport.innerHTML = '<div style="padding: 20px; color: var(--vscode-errorForeground);">Failed to load diff: ' + escapeHtml(message.error) + '</div>';
                                }
                            }
                        });

                        function escapeHtml(unsafe) {
                            return unsafe
                                 .replace(/&/g, "&amp;")
                                 .replace(/</g, "&lt;")
                                 .replace(/>/g, "&gt;")
                                 .replace(/"/g, "&quot;")
                                 .replace(/'/g, "&#039;");
                        }

                        // Auto-select first file on load
                        window.addEventListener('DOMContentLoaded', () => {
                            const firstItem = document.querySelector('.file-item');
                            if (firstItem) {
                                const firstFile = firstItem.getAttribute('data-file');
                                if (firstFile) {
                                    selectFile(firstFile);
                                }
                            } else {
                                document.getElementById('diff-viewport').innerHTML = '<div style="padding: 20px; color: var(--vscode-descriptionForeground);">No files changed in this commit.</div>';
                            }
                        });
                    </script>
                </body>
                </html>
            `;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to show commit details: ${error.message}`);
        }
    }));

    // Command: Show Line History Webview Panel
    context.subscriptions.push(vscode.commands.registerCommand('mini-blame.showLineHistory', async (filePath: string, lineNumber: number) => {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) {
            return;
        }

        try {
            const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
            const ignoreWs = vscode.workspace.getConfiguration('mini-blame').get<boolean>('ignoreWhitespace', false);
            const wsFlag = ignoreWs ? ' -w' : '';
            
            // Fetch the history of the specific line range using git log -L
            const logOutput = await execAsync(`git log${wsFlag} --pretty=format:"%H|%an|%ae|%ad|%s" -L ${lineNumber},${lineNumber}:"${relPath}"`, { cwd: gitRoot });
            
            // Parse git log output into structured commit blocks
            const rawLines = logOutput.split('\n');
            interface LineCommitHistory {
                hash: string;
                author: string;
                email: string;
                date: string;
                subject: string;
                diff: string;
            }
            const commits: LineCommitHistory[] = [];
            let currentCommit: LineCommitHistory | null = null;
            let currentDiffLines: string[] = [];

            for (const line of rawLines) {
                const match = line.match(/^([0-9a-f]{40})\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/i);
                if (match) {
                    if (currentCommit) {
                        currentCommit.diff = currentDiffLines.join('\n');
                        commits.push(currentCommit);
                    }
                    currentCommit = {
                        hash: match[1],
                        author: match[2],
                        email: match[3],
                        date: match[4],
                        subject: match[5],
                        diff: ''
                    };
                    currentDiffLines = [];
                } else {
                    if (currentCommit) {
                        currentDiffLines.push(line);
                    }
                }
            }
            if (currentCommit) {
                currentCommit.diff = currentDiffLines.join('\n');
                commits.push(currentCommit);
            }

            if (commits.length === 0) {
                vscode.window.showInformationMessage(`No commit history found for line ${lineNumber} in ${path.basename(filePath)}.`);
                return;
            }

            // Create and Show Line History Webview Panel
            const panel = vscode.window.createWebviewPanel(
                'lineHistory',
                `Line History: ${path.basename(filePath)} (L${lineNumber})`,
                vscode.ViewColumn.One,
                { enableScripts: true }
            );

            // Handle messages from the webview
            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'showCommitDetails') {
                    vscode.commands.executeCommand('mini-blame.showCommitDetails', message.hash, filePath);
                } else if (message.command === 'copySHA') {
                    await vscode.env.clipboard.writeText(message.hash);
                    vscode.window.showInformationMessage(`Copied Commit SHA: ${message.hash.substring(0, 7)}`);
                }
            });

            // Map commits to layout and render
            const timelineHtml = commits.map((commit, index) => {
                const isFirst = index === 0;
                const authorInitials = commit.author.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                return `
                    <div class="timeline-item ${isFirst ? 'active' : ''}" data-hash="${commit.hash}" onclick="selectCommit('${commit.hash}')">
                        <div class="timeline-marker">
                            <div class="timeline-dot">${authorInitials}</div>
                            <div class="timeline-line"></div>
                        </div>
                        <div class="timeline-content">
                            <div class="commit-subject">${escapeHtml(commit.subject)}</div>
                            <div class="commit-meta-small">
                                <span class="commit-author">${escapeHtml(commit.author)}</span>
                                <span class="commit-date">${escapeHtml(commit.date)}</span>
                            </div>
                            <div class="commit-hash-badge">${commit.hash.substring(0, 7)}</div>
                        </div>
                    </div>
                `;
            }).join('');

            // Pre-process and serialize commits to JSON for client side
            const commitsData = commits.map(c => ({
                hash: c.hash,
                author: c.author,
                email: c.email,
                date: c.date,
                subject: c.subject,
                diffHtml: renderDiffToHtml(c.diff)
            }));

            // Set HTML Content
            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body {
                            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
                            background-color: var(--vscode-editor-background);
                            color: var(--vscode-editor-foreground);
                            margin: 0;
                            padding: 20px;
                            display: flex;
                            flex-direction: column;
                            height: 100vh;
                            box-sizing: border-box;
                        }
                        .header {
                            border-bottom: 1px solid var(--vscode-widget-border);
                            padding-bottom: 12px;
                            margin-bottom: 16px;
                        }
                        .title {
                            font-size: 1.3em;
                            font-weight: bold;
                            margin: 0 0 4px 0;
                            color: var(--vscode-textLink-activeForeground);
                        }
                        .subtitle {
                            font-size: 0.9em;
                            color: var(--vscode-descriptionForeground);
                        }
                        .container {
                            display: flex;
                            flex: 1;
                            gap: 20px;
                            min-height: 0;
                        }
                        .sidebar {
                            flex: 1;
                            max-width: 380px;
                            display: flex;
                            flex-direction: column;
                            border: 1px solid var(--vscode-widget-border);
                            border-radius: 6px;
                            background-color: var(--vscode-sideBar-background);
                            min-height: 0;
                        }
                        .sidebar-title {
                            font-size: 0.9em;
                            font-weight: bold;
                            border-bottom: 1px solid var(--vscode-widget-border);
                            padding: 10px 14px;
                            margin: 0;
                            background-color: var(--vscode-editorWidget-background);
                            color: var(--vscode-descriptionForeground);
                            letter-spacing: 0.5px;
                            text-transform: uppercase;
                        }
                        .timeline-container {
                            overflow-y: auto;
                            flex: 1;
                            padding: 16px 10px;
                        }
                        .timeline-item {
                            display: flex;
                            cursor: pointer;
                            position: relative;
                            padding-bottom: 16px;
                            transition: all 0.15s ease;
                        }
                        .timeline-item:last-child {
                            padding-bottom: 0;
                        }
                        .timeline-item:last-child .timeline-line {
                            display: none;
                        }
                        .timeline-marker {
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            margin-right: 12px;
                            position: relative;
                        }
                        .timeline-dot {
                            width: 24px;
                            height: 24px;
                            border-radius: 50%;
                            background-color: var(--vscode-button-secondaryBackground);
                            color: var(--vscode-button-secondaryForeground);
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 8.5px;
                            font-weight: bold;
                            z-index: 2;
                            border: 2px solid var(--vscode-sideBar-background);
                            transition: all 0.15s ease;
                        }
                        .timeline-line {
                            width: 2px;
                            flex: 1;
                            background-color: var(--vscode-widget-border);
                            z-index: 1;
                        }
                        .timeline-content {
                            flex: 1;
                            padding: 6px 12px;
                            background-color: var(--vscode-textCodeBlock-background);
                            border-radius: 6px;
                            border: 1px solid transparent;
                            transition: all 0.15s ease;
                            position: relative;
                            display: flex;
                            flex-direction: column;
                            gap: 4px;
                        }
                        .timeline-item:hover .timeline-content {
                            background-color: var(--vscode-list-hoverBackground);
                            border-color: var(--vscode-widget-border);
                        }
                        .timeline-item.active .timeline-content {
                            background-color: var(--vscode-list-activeSelectionBackground);
                            color: var(--vscode-list-activeSelectionForeground);
                            border-color: var(--vscode-focusBorder);
                            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                        }
                        .timeline-item.active .timeline-dot {
                            background-color: var(--vscode-button-background);
                            color: var(--vscode-button-foreground);
                            transform: scale(1.1);
                        }
                        .commit-subject {
                            font-size: 0.9em;
                            font-weight: 600;
                            line-height: 1.3;
                            display: -webkit-box;
                            -webkit-line-clamp: 2;
                            -webkit-box-orient: vertical;
                            overflow: hidden;
                        }
                        .commit-meta-small {
                            display: flex;
                            justify-content: space-between;
                            font-size: 0.8em;
                            color: var(--vscode-descriptionForeground);
                            gap: 8px;
                        }
                        .timeline-item.active .commit-meta-small {
                            color: inherit;
                            opacity: 0.85;
                        }
                        .commit-hash-badge {
                            position: absolute;
                            top: 6px;
                            right: 8px;
                            font-size: 8px;
                            font-family: monospace;
                            background-color: rgba(128,128,128,0.15);
                            padding: 2px 4px;
                            border-radius: 3px;
                            color: var(--vscode-descriptionForeground);
                        }
                        .timeline-item.active .commit-hash-badge {
                            background-color: rgba(255,255,255,0.15);
                            color: inherit;
                        }
                        .main-panel {
                            flex: 2;
                            display: flex;
                            flex-direction: column;
                            border: 1px solid var(--vscode-widget-border);
                            border-radius: 6px;
                            background-color: var(--vscode-editor-background);
                            min-height: 0;
                        }
                        .detail-header {
                            padding: 16px;
                            border-bottom: 1px solid var(--vscode-widget-border);
                            background-color: var(--vscode-editorWidget-background);
                            display: flex;
                            flex-direction: column;
                            gap: 12px;
                        }
                        .detail-subject {
                            font-size: 1.15em;
                            font-weight: bold;
                            margin: 0;
                        }
                        .detail-meta-grid {
                            display: grid;
                            grid-template-columns: auto 1fr;
                            gap: 6px 16px;
                            font-size: 0.85em;
                            color: var(--vscode-descriptionForeground);
                        }
                        .detail-meta-label {
                            font-weight: bold;
                        }
                        .action-bar {
                            display: flex;
                            gap: 10px;
                            margin-top: 4px;
                        }
                        .action-btn {
                            background-color: var(--vscode-button-background);
                            color: var(--vscode-button-foreground);
                            border: none;
                            padding: 6px 12px;
                            font-size: 0.85em;
                            font-weight: 500;
                            border-radius: 4px;
                            cursor: pointer;
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                            transition: background-color 0.15s ease;
                        }
                        .action-btn:hover {
                            background-color: var(--vscode-button-hoverBackground);
                        }
                        .action-btn.secondary {
                            background-color: var(--vscode-button-secondaryBackground);
                            color: var(--vscode-button-secondaryForeground);
                        }
                        .action-btn.secondary:hover {
                            background-color: var(--vscode-button-secondaryHoverBackground);
                        }
                        .detail-diff-panel {
                            flex: 1;
                            display: flex;
                            flex-direction: column;
                            min-height: 0;
                        }
                        .detail-diff-title {
                            font-size: 0.85em;
                            font-weight: bold;
                            padding: 8px 16px;
                            margin: 0;
                            border-bottom: 1px solid var(--vscode-widget-border);
                            background-color: var(--vscode-editorWidget-background);
                            color: var(--vscode-descriptionForeground);
                        }
                        .scrollable {
                            overflow: auto;
                            flex: 1;
                            padding: 16px;
                        }
                        .diff-container {
                            font-family: var(--vscode-editor-font-family, monospace);
                            font-size: 11.5px;
                            white-space: pre-wrap;
                            margin: 0;
                            line-height: 1.5;
                        }
                        .diff-line {
                            padding: 1px 8px;
                            min-height: 16px;
                        }
                        .diff-add {
                            background-color: rgba(103, 194, 58, 0.12);
                            color: #4ec9b0;
                        }
                        .diff-del {
                            background-color: rgba(245, 108, 108, 0.12);
                            color: #f44747;
                        }
                        .diff-hunk {
                            background-color: rgba(0, 122, 204, 0.12);
                            color: #85c5ec;
                            font-weight: bold;
                        }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <div class="title">Line History</div>
                        <div class="subtitle">Traced history for <strong>${escapeHtml(path.basename(filePath))}</strong> • Line ${lineNumber}</div>
                    </div>
                    
                    <div class="container">
                        <div class="sidebar">
                            <div class="sidebar-title">Commits Modifying Line</div>
                            <div class="timeline-container">
                                ${timelineHtml}
                            </div>
                        </div>
                        
                        <div class="main-panel">
                            <div class="detail-header">
                                <div class="detail-subject" id="detail-subject"></div>
                                <div class="detail-meta-grid">
                                    <span class="detail-meta-label">Author:</span>
                                    <span id="detail-author"></span>
                                    <span class="detail-meta-label">Date:</span>
                                    <span id="detail-date"></span>
                                    <span class="detail-meta-label">Commit:</span>
                                    <span id="detail-hash" style="font-family: monospace;"></span>
                                </div>
                                <div class="action-bar">
                                    <button class="action-btn" onclick="openCommitDetails()">
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 13a6 6 0 110-12 6 6 0 010 12z"/>
                                            <path d="M7 6h2v6H7zm0-2h2v1.5H7z"/>
                                        </svg>
                                        Show Commit Details
                                    </button>
                                    <button class="action-btn secondary" onclick="copySHA()">
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                            <path d="M4 2h8v2H4V2zm10 4v9H2V6h12zm-1 1H3v7h10V7zM5 11h6v1H5v-1zm0-2h6v1H5V9z"/>
                                        </svg>
                                        Copy SHA
                                    </button>
                                </div>
                            </div>
                            
                            <div class="detail-diff-panel">
                                <div class="detail-diff-title">Line Diff</div>
                                <div class="scrollable">
                                    <div class="diff-container" id="diff-viewport"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <script>
                        const vscode = acquireVsCodeApi();
                        const commits = ${JSON.stringify(commitsData)};
                        let selectedHash = null;

                        function selectCommit(hash) {
                            selectedHash = hash;
                            
                            // Highlight in timeline sidebar
                            document.querySelectorAll('.timeline-item').forEach(item => {
                                if (item.getAttribute('data-hash') === hash) {
                                    item.classList.add('active');
                                } else {
                                    item.classList.remove('active');
                                }
                            });

                            // Retrieve commit data
                            const commit = commits.find(c => c.hash === hash);
                            if (commit) {
                                document.getElementById('detail-subject').textContent = commit.subject;
                                document.getElementById('detail-author').textContent = commit.author + " (" + commit.email + ")";
                                document.getElementById('detail-date').textContent = commit.date;
                                document.getElementById('detail-hash').textContent = commit.hash;
                                
                                const viewport = document.getElementById('diff-viewport');
                                viewport.innerHTML = commit.diffHtml || '<div style="padding: 20px; color: var(--vscode-descriptionForeground);">No diff content.</div>';
                            }
                        }

                        function openCommitDetails() {
                            if (selectedHash) {
                                vscode.postMessage({ command: 'showCommitDetails', hash: selectedHash });
                            }
                        }

                        function copySHA() {
                            if (selectedHash) {
                                vscode.postMessage({ command: 'copySHA', hash: selectedHash });
                            }
                        }

                        // Auto-select first commit on load
                        window.addEventListener('DOMContentLoaded', () => {
                            if (commits.length > 0) {
                                selectCommit(commits[0].hash);
                            }
                        });
                    </script>
                </body>
                </html>
            `;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to retrieve line history: ${error.message}`);
        }
    }));
}

/**
 * Escapes characters for HTML content.
 */
function escapeHtml(unsafe: string): string {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

/**
 * Parses and renders Git patch/diff to syntax-colored HTML.
 */
function renderDiffToHtml(diffText: string): string {
    const lines = diffText.split('\n');
    const filteredLines = lines.filter(line => {
        if (line.startsWith('diff --git')) { return false; }
        if (line.startsWith('index ')) { return false; }
        if (line.startsWith('new file ')) { return false; }
        if (line.startsWith('deleted file ')) { return false; }
        if (line.startsWith('similarity ')) { return false; }
        if (line.startsWith('rename ')) { return false; }
        if (line.startsWith('--- ') || line.startsWith('+++ ')) { return false; }
        if (line.startsWith('old mode ') || line.startsWith('new mode ')) { return false; }
        return true;
    });
    return filteredLines.map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            return `<div class="diff-line diff-add">${escapeHtml(line)}</div>`;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            return `<div class="diff-line diff-del">${escapeHtml(line)}</div>`;
        } else if (line.startsWith('@@')) {
            return `<div class="diff-line diff-hunk">${escapeHtml(line)}</div>`;
        } else {
            return `<div class="diff-line">${escapeHtml(line)}</div>`;
        }
    }).join('');
}

/**
 * Compares the file state at a specific commit with the active workspace file.
 */
async function compareWithWorking(gitRoot: string, commitHash: string, filePath: string) {
    try {
        const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
        const fileContent = await execAsync(`git show ${commitHash}:"${relPath}"`, { cwd: gitRoot });
        const tmpFile = path.join(os.tmpdir(), `${commitHash.substring(0, 7)}_${path.basename(filePath)}`);
        fs.writeFileSync(tmpFile, fileContent);
        await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(tmpFile),
            vscode.Uri.file(filePath),
            `${path.basename(filePath)} (${commitHash.substring(0, 7)} ⟷ Working Tree)`
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to compare with working tree: ${err.message}`);
    }
}

/**
 * Fetches and copies the full commit message to the clipboard.
 */
async function copyCommitMessage(gitRoot: string, commitHash: string) {
    try {
        const message = await execAsync(`git show -s --format="%B" ${commitHash}`, { cwd: gitRoot });
        await vscode.env.clipboard.writeText(message.trim());
        vscode.window.showInformationMessage('Copied Commit Message!');
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to copy commit message: ${err.message}`);
    }
}

/**
 * Prompts user for a name and creates a new branch at the commit.
 */
async function createBranchAtCommit(gitRoot: string, commitHash: string) {
    const branchName = await vscode.window.showInputBox({
        prompt: 'Enter name for the new branch',
        placeHolder: 'feature-branch'
    });
    if (branchName) {
        try {
            await execAsync(`git branch "${branchName}" ${commitHash}`, { cwd: gitRoot });
            vscode.window.showInformationMessage(`Created branch "${branchName}" at ${commitHash.substring(0, 7)}.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create branch: ${err.message}`);
        }
    }
}

/**
 * Prompts user for a name and creates a new tag at the commit.
 */
async function createTagAtCommit(gitRoot: string, commitHash: string) {
    const tagName = await vscode.window.showInputBox({
        prompt: 'Enter name for the new tag',
        placeHolder: 'v1.0.0'
    });
    if (tagName) {
        try {
            await execAsync(`git tag "${tagName}" ${commitHash}`, { cwd: gitRoot });
            vscode.window.showInformationMessage(`Created tag "${tagName}" at ${commitHash.substring(0, 7)}.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create tag: ${err.message}`);
        }
    }
}