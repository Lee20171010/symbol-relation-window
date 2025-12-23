import * as vscode from 'vscode';
import { SymbolItem } from '../../shared/common/types';
import * as cp from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { parserRegistry } from './parsing/ParserRegistry';

export class SymbolModel {
    
    public async getDocumentSymbols(uri: vscode.Uri): Promise<SymbolItem[]> {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider', 
            uri
        );
        
        if (!symbols) {
            return [];
        }

        return this.mapDocumentSymbols(symbols, uri);
    }

    public async getWorkspaceSymbols(query: string, token?: vscode.CancellationToken): Promise<SymbolItem[]> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider', 
                query,
                token
            );

            if (!symbols) {
                return [];
            }

            return this.mapWorkspaceSymbols(symbols);
        } catch (e) {
            console.error(`[Source Window] Error fetching symbols:`, e);
            // If we fail to map symbols, we should probably return the raw symbols or empty?
            // If we return empty, checkReadiness loops forever.
            // Let's try to return empty but log it.
            return [];
        }
    }

    public async findSymbolsByTextSearch(
        query: string, 
        keywords: string[], 
        token?: vscode.CancellationToken,
        scopePath?: string,
        includePattern?: string,
        excludePattern?: string
    ): Promise<SymbolItem[]> {
        // Strategy: Use ripgrep with regex permutations to find files containing ALL keywords.
        // Since rg doesn't support lookahead, we use alternation of permutations:
        // e.g. for "A B", we search "A.*B|B.*A"
        // We limit this to the top 5 keywords for regex generation to keep it performant
        
        const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
        // Limit to top 5 keywords for regex generation to keep it performant
        const regexKeywords = sortedKeywords.slice(0, 5);
        const remainingKeywords = sortedKeywords.slice(5); // These will be checked in JS if any
        
        // Use provided scopePath or fallback to workspace root
        const rootPath = scopePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) {
            return [];
        }

        const matchedUris = new Set<string>();

        try {
            // Generate permutations
            const permutations = this.permute(regexKeywords);
            // Join with .* and then join permutations with |
            // Escape special regex characters in keywords
            const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            const patterns = permutations.map(p => p.map(escapeRegex).join('.*'));
            const regexPattern = patterns.join('|');

            // rg arguments:
            // --files-with-matches (-l)
            // --ignore-case (-i)
            // --glob: Follow .gitignore
            // --max-columns: Ignore lines longer than 1000 chars (avoids minified files)
            
            const args = [
                '-i', '-l', '--max-columns', '1000',
                '--glob', '!**/*.{txt,log,lock,map,pdf,doc,docx,xls,xlsx,ppt,pptx,png,jpg,jpeg,gif,bmp,ico,svg,mp3,mp4,wav,zip,tar,gz,7z,rar,bin,exe,dll,so,dylib,pdb,obj,o,a,min.js,min.css}', 
                regexPattern, 
                '.'
            ];

            // Add user defined include patterns
            if (includePattern) {
                // Split by comma and trim
                const patterns = includePattern.split(',').map(p => p.trim()).filter(p => p.length > 0);
                patterns.forEach(p => {
                    args.push('--glob', p);
                });
            }

            // Add user defined exclude patterns
            if (excludePattern) {
                // Split by comma and trim
                const patterns = excludePattern.split(',').map(p => p.trim()).filter(p => p.length > 0);
                patterns.forEach(p => {
                    args.push('--glob', `!${p}`);
                });
            }
            
            const output = await new Promise<string>((resolve, reject) => {
                const child = cp.execFile(rgPath, args, { 
                    cwd: rootPath,
                    maxBuffer: 1024 * 1024 * 10 // 10MB buffer
                }, (err, stdout, stderr) => {
                    if (err && (err as any).code !== 1) { 
                        reject(err);
                    } else {
                        resolve(stdout);
                    }
                });
                
                token?.onCancellationRequested(() => {
                    child.kill();
                });
            });

            const files = output.split('\n').filter(f => f.trim().length > 0);

            for (const file of files) {
                // Use Uri.joinPath to handle cross-platform path joining safely
                // Split by both / and \ to handle potential mixed separators from rg output
                const segments = file.split(/[\\/]/);
                const rootUri = vscode.Uri.file(rootPath);
                const fullUri = vscode.Uri.joinPath(rootUri, ...segments);
                matchedUris.add(fullUri.toString());
            }

        } catch (e) {
            console.error('[Source Window] Ripgrep failed', e);
            return [];
        }

        if (matchedUris.size === 0) {
            return [];
        }

        const uris = Array.from(matchedUris);
        const results: SymbolItem[] = [];
        
        // Get batch size from settings
        const sharedConfig = vscode.workspace.getConfiguration('shared');
        let batchSize = sharedConfig.get<number>('indexingBatchSize', 15);
        // Limit batch size to avoid LSP crash
        const MAX_BATCH_SIZE = 200;
        if (batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
            batchSize = MAX_BATCH_SIZE;
        }

        for (let i = 0; i < uris.length; i += batchSize) {
            if (token?.isCancellationRequested) {
                break;
            }

            const batch = uris.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (uriStr) => {
                if (token?.isCancellationRequested) {
                    return [];
                }

                const uri = vscode.Uri.parse(uriStr);

                // If we had more than 3 keywords, we still need to check the remaining ones
                // But since we already filtered by the top 3, this set should be small enough to check in JS
                // Actually, we can just let filterSymbols handle it, or do a quick text check.
                // Let's do a quick text check if there are remaining keywords.
                if (remainingKeywords.length > 0) {
                        try {
                        const fileData = await vscode.workspace.fs.readFile(uri);
                        const text = new TextDecoder().decode(fileData).toLowerCase();
                        const allFound = remainingKeywords.every(k => text.includes(k.toLowerCase()));
                        if (!allFound) {
                            return [];
                        }
                    } catch (e) {
                        // ignore read error
                    }
                }

                try {
                    const symbols = await this.getDocumentSymbols(uri);
                    const filtered = this.filterSymbols(symbols, keywords);
                    
                    // Add path info for Deep Search results
                    return filtered.map(item => {
                        const relativePath = vscode.workspace.asRelativePath(uri);
                        const filename = relativePath.split(/[/\\]/).pop() || '';
                        let location = '';
                        if (relativePath === filename) {
                            location = `${filename}:${item.range.start.line + 1}`;
                        } else {
                            const dir = relativePath.substring(0, relativePath.length - filename.length - 1);
                            location = `${filename} (${dir}):${item.range.start.line + 1}`;
                        }
                        return { ...item, path: location, isDeepSearch: true };
                    });
                } catch (e) {
                    console.error(`[Source Window] Error getting symbols for ${uriStr}`, e);
                    return [];
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults.flat());

            // Yield to UI
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        return results;
    }

    private permute(permutation: string[]): string[][] {
        const length = permutation.length;
        const result = [permutation.slice()];
        const c = new Array(length).fill(0);
        let i = 1;
        let k;
        let p;
      
        while (i < length) {
            if (c[i] < i) {
                k = i % 2 && c[i];
                p = permutation[i];
                permutation[i] = permutation[k];
                permutation[k] = p;
                ++c[i];
                i = 1;
                result.push(permutation.slice());
            } else {
                c[i] = 0;
                ++i;
            }
        }
        return result;
    }

    private filterSymbols(symbols: SymbolItem[], keywords: string[]): SymbolItem[] {
        const lowerKeywords = keywords.map(k => k.toLowerCase());
        const matches: SymbolItem[] = [];

        const traverse = (items: SymbolItem[]) => {
            for (const item of items) {
                const name = item.name.toLowerCase();
                const detail = (item.detail || '').toLowerCase();
                
                const isMatch = lowerKeywords.every(k => name.includes(k) || detail.includes(k));
                
                if (isMatch) {
                    matches.push(item);
                }
                
                if (item.children && item.children.length > 0) {
                    traverse(item.children);
                }
            }
        };

        traverse(symbols);
        return matches;
    }
    
    // Fix recursion bug in previous block and apply same logic
    private mapDocumentSymbolsRecursive(symbols: vscode.DocumentSymbol[], parser: any, uri: vscode.Uri): SymbolItem[] {
        return symbols.map(s => {
            const { name, detail } = parser.parse(s.name, s.detail || '', s.kind);

            // Current Mode: No path info needed
            return {
                name: name,
                detail: detail,
                // path: undefined, // Explicitly undefined
                kind: s.kind,
                range: s.range,
                selectionRange: s.selectionRange,
                children: this.mapDocumentSymbolsRecursive(s.children, parser, uri),
                uri: uri.toString()
            };

        });
    }

    private mapDocumentSymbols(symbols: vscode.DocumentSymbol[], uri: vscode.Uri): SymbolItem[] {
        const config = vscode.workspace.getConfiguration('symbolWindow');
        const mode = config.get<string>('symbolParsing.mode', 'auto');
        
        // Get language ID from document if possible, but we only have URI here.
        // We can try to find the document in open editors or use file extension mapping.
        // Better: SymbolController should pass the document or languageId.
        // For now, let's try to get it from the URI extension or active editor.
        
        // Actually, getDocumentSymbols is called for a specific URI.
        // We can try to find the text document.
        let languageId = '';
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) {
            languageId = doc.languageId;
        } else {
            // Fallback: guess from extension
            const ext = uri.path.split('.').pop()?.toLowerCase();
            if (ext === 'c' || ext === 'h') {
                languageId = 'c';
            } else if (ext === 'cpp' || ext === 'hpp' || ext === 'cc') {
                languageId = 'cpp';
            } else if (ext === 'java') {
                languageId = 'java';
            } else if (ext === 'cs') {
                languageId = 'csharp';
            }
        }

        const parser = parserRegistry.getParser(languageId, mode);
        return this.mapDocumentSymbolsRecursive(symbols, parser, uri);
    }

    private mapWorkspaceSymbols(symbols: vscode.SymbolInformation[]): SymbolItem[] {
        const config = vscode.workspace.getConfiguration('symbolWindow');
        const mode = config.get<string>('symbolParsing.mode', 'auto');

        return symbols.map(s => {
            // Guess language from file extension
            const ext = s.location.uri.path.split('.').pop()?.toLowerCase() || '';
            let languageId = '';
            if (ext === 'c' || ext === 'h') {
                languageId = 'c';
            } else if (ext === 'cpp' || ext === 'hpp' || ext === 'cc') {
                languageId = 'cpp';
            } else if (ext === 'java') {
                languageId = 'java';
            } else if (ext === 'cs') {
                languageId = 'csharp';
            }
            
            const parser = parserRegistry.getParser(languageId, mode);
            const { name, detail } = parser.parse(s.name, s.containerName || '', s.kind);

            // Project Mode: filename (path):line
            const relativePath = vscode.workspace.asRelativePath(s.location.uri);
            const filename = relativePath.split(/[/\\]/).pop() || '';
            // If relativePath is just filename, don't show (path)
            // Format: filename (dir/path):line
            
            let location = '';
            if (relativePath === filename) {
                location = `${filename}:${s.location.range.start.line + 1}`;
            } else {
                // Remove filename from relativePath to get dir
                const dir = relativePath.substring(0, relativePath.length - filename.length - 1); // -1 for separator
                location = `${filename} (${dir}):${s.location.range.start.line + 1}`;
            }

            return {
                name: name,
                detail: detail,
                path: location,
                kind: s.kind,
                range: s.location.range,
                selectionRange: s.location.range, // WorkspaceSymbol doesn't have selectionRange
                children: [],
                uri: s.location.uri.toString(),
                containerName: s.containerName
            };
        });
    }

}


