import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { rgPath } from '@vscode/ripgrep';

export interface DeepSearchOptions {
    query: string;
    cwd: string;
    isCaseSensitive?: boolean;
    isWordMatch?: boolean;
    includePattern?: string;
    excludePattern?: string;
}

export async function performDeepSearch(options: DeepSearchOptions): Promise<vscode.Location[]> {
    const { query, cwd, isCaseSensitive = false, isWordMatch = false, includePattern, excludePattern } = options;

    if (!query || !cwd) {
        return [];
    }

    const args = [
        '--vimgrep',
        '--fixed-strings', // Treat pattern as literal string
        '--glob', '!**/.git/**',
        '--glob', '!**/node_modules/**'
    ];

    if (includePattern) {
        const patterns = includePattern.split(',').map(p => p.trim()).filter(p => p.length > 0);
        patterns.forEach(p => args.push('--glob', p));
    }

    if (excludePattern) {
        const patterns = excludePattern.split(',').map(p => p.trim()).filter(p => p.length > 0);
        patterns.forEach(p => args.push('--glob', `!${p}`));
    }

    args.push(query, '.');

    if (!isCaseSensitive) {
        args.unshift('--ignore-case');
    }
    
    if (isWordMatch) {
        args.unshift('--word-regexp');
    }

    return new Promise((resolve) => {
        const child = cp.spawn(rgPath, args, { cwd });
        let output = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.on('close', (code) => {
            const lines = output.split('\n').filter(l => l.trim().length > 0);
            const locations: vscode.Location[] = [];

            for (const line of lines) {
                // Parse vimgrep output: file:line:col:content
                const parts = line.split(':');
                if (parts.length < 4) { continue; }

                const file = parts[0];
                const lineNum = parseInt(parts[1]) - 1; // 0-based
                const colNum = parseInt(parts[2]) - 1;
                
                // Use Uri.joinPath for safe cross-platform path joining
                let uri: vscode.Uri;
                if (path.isAbsolute(file)) {
                    uri = vscode.Uri.file(file);
                } else {
                    const rootUri = vscode.Uri.file(cwd);
                    const segments = file.split(/[\\/]/);
                    uri = vscode.Uri.joinPath(rootUri, ...segments);
                }
                
                // We don't know the length of the match easily without re-checking query length or content
                // But for fixed string search, it's query.length
                const range = new vscode.Range(lineNum, colNum, lineNum, colNum + query.length);

                locations.push(new vscode.Location(uri, range));
            }
            resolve(locations);
        });

        child.on('error', (err) => {
            console.error('[Source Window] Deep Search failed:', err);
            resolve([]);
        });
    });
}
