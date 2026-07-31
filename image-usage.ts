import { normalizeImageUrl } from "./image-utils";

export interface ImageUsageSummary {
    referenceCount: number;
    noteCount: number;
    notePaths: string[];
}

function blankRange(text: string): string {
    return text.replace(/[^\r\n]/g, " ");
}

function maskNonRenderedCode(markdown: string): string {
    let masked = markdown.replace(/<!--[\s\S]*?-->/g, blankRange);
    const lines = masked.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
    let fenceChar = "";
    let fenceLength = 0;
    masked = lines.map((line) => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/i)?.[1] ?? "";
        if (!fenceChar && marker) {
            fenceChar = marker[0];
            fenceLength = marker.length;
            return blankRange(line);
        }
        if (fenceChar) {
            const closesFence = new RegExp(
                `^ {0,3}\\${fenceChar}{${fenceLength},}\\s*$`
            ).test(line.trimEnd());
            if (closesFence) {
                fenceChar = "";
                fenceLength = 0;
            }
            return blankRange(line);
        }
        return line;
    }).join("");

    const characters = masked.split("");
    for (let index = 0; index < characters.length;) {
        if (characters[index] !== "`" || isEscaped(masked, index)) {
            index++;
            continue;
        }
        let runLength = 1;
        while (characters[index + runLength] === "`") runLength++;
        const delimiter = "`".repeat(runLength);
        const end = masked.indexOf(delimiter, index + runLength);
        if (end < 0) {
            index += runLength;
            continue;
        }
        for (let cursor = index; cursor < end + runLength; cursor++) {
            if (characters[cursor] !== "\r" && characters[cursor] !== "\n") {
                characters[cursor] = " ";
            }
        }
        index = end + runLength;
    }
    return characters.join("");
}

function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function markdownImageDestination(text: string, openParen: number): string | null {
    let cursor = openParen + 1;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] === "<") {
        const start = ++cursor;
        while (cursor < text.length && (text[cursor] !== ">" || isEscaped(text, cursor))) {
            cursor++;
        }
        return cursor < text.length ? text.slice(start, cursor) : null;
    }

    const start = cursor;
    let nestedParentheses = 0;
    while (cursor < text.length) {
        const character = text[cursor];
        if (isEscaped(text, cursor)) {
            cursor++;
        } else if (character === "(") {
            nestedParentheses++;
        } else if (character === ")") {
            if (nestedParentheses === 0) break;
            nestedParentheses--;
        } else if (/\s/.test(character) && nestedParentheses === 0) {
            break;
        }
        cursor++;
    }
    if (cursor === start) return null;
    return text.slice(start, cursor).replace(/\\([\\()[\]<> ])/g, "$1");
}

/** Extract rendered external image sources, excluding ordinary links and code. */
export function extractImageUrls(markdown: string): string[] {
    const text = maskNonRenderedCode(markdown);
    const urls: string[] = [];

    for (let index = 0; index < text.length - 3; index++) {
        if (text[index] !== "!" || text[index + 1] !== "[" || isEscaped(text, index)) {
            continue;
        }
        let bracketDepth = 1;
        let cursor = index + 2;
        while (cursor < text.length && bracketDepth > 0) {
            if (!isEscaped(text, cursor)) {
                if (text[cursor] === "[") bracketDepth++;
                else if (text[cursor] === "]") bracketDepth--;
            }
            cursor++;
        }
        if (bracketDepth !== 0) continue;
        while (/\s/.test(text[cursor] ?? "")) cursor++;
        if (text[cursor] !== "(") continue;
        const destination = markdownImageDestination(text, cursor);
        if (destination) urls.push(destination);
        index = cursor;
    }

    const htmlImage = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    let match: RegExpExecArray | null;
    while ((match = htmlImage.exec(text)) !== null) {
        const source = match[1] ?? match[2] ?? match[3];
        if (source) urls.push(source);
    }
    return urls;
}

export class ImageUsageStore {
    private readonly fileCounts = new Map<string, Map<string, number>>();
    private readonly urlFiles = new Map<string, Map<string, number>>();

    clear(): void {
        this.fileCounts.clear();
        this.urlFiles.clear();
    }

    updateFile(filePath: string, links: string[]): Set<string> {
        const changed = this.removeFile(filePath);
        const counts = new Map<string, number>();

        for (const link of links) {
            const normalized = normalizeImageUrl(link);
            if (!normalized) continue;
            counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
        }

        if (counts.size === 0) return changed;
        this.fileCounts.set(filePath, counts);
        for (const [url, count] of counts) {
            let files = this.urlFiles.get(url);
            if (!files) {
                files = new Map<string, number>();
                this.urlFiles.set(url, files);
            }
            files.set(filePath, count);
            changed.add(url);
        }
        return changed;
    }

    removeFile(filePath: string): Set<string> {
        const changed = new Set<string>();
        const previous = this.fileCounts.get(filePath);
        if (!previous) return changed;

        this.fileCounts.delete(filePath);
        for (const url of previous.keys()) {
            const files = this.urlFiles.get(url);
            files?.delete(filePath);
            if (files?.size === 0) this.urlFiles.delete(url);
            changed.add(url);
        }
        return changed;
    }

    renameFile(oldPath: string, newPath: string): Set<string> {
        const previous = this.fileCounts.get(oldPath);
        if (!previous || oldPath === newPath) return new Set<string>();

        this.fileCounts.delete(oldPath);
        this.fileCounts.set(newPath, previous);
        const changed = new Set<string>();
        for (const url of previous.keys()) {
            const files = this.urlFiles.get(url);
            const count = files?.get(oldPath);
            if (files && count !== undefined) {
                files.delete(oldPath);
                files.set(newPath, count);
            }
            changed.add(url);
        }
        return changed;
    }

    getUsage(rawUrl: string): ImageUsageSummary {
        const normalized = normalizeImageUrl(rawUrl);
        const files = normalized ? this.urlFiles.get(normalized) : undefined;
        if (!files) {
            return { referenceCount: 0, noteCount: 0, notePaths: [] };
        }

        let referenceCount = 0;
        for (const count of files.values()) referenceCount += count;
        return {
            referenceCount,
            noteCount: files.size,
            notePaths: Array.from(files.keys()).sort((a, b) => a.localeCompare(b)),
        };
    }
}
