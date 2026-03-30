import * as vscode from 'vscode';
import { SymbolDatabase, SymbolRecord } from '../../../shared/db/database';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class SymbolIndexer {
    private queue: vscode.Uri[] = [];
    private queueSet = new Set<string>();
    private isProcessing = false;
    private isPaused = true; // Default to paused (wait for LSP ready)
    private processedCount = 0;
    private totalToProcess = 0;

    private rootIgnored = new Set<string>(['.git', '.DS_Store', '.vscode']);
    private anywhereIgnored = new Set<string>([]);

    private excludeIgnored = new Set<string>();
    private excludeRegexes: RegExp[] = [];
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    private debounceTimer: NodeJS.Timeout | undefined;
    private readonly DEBOUNCE_DELAY = 2000; // 2 seconds

    // Retry mechanism
    private retryCounts = new Map<string, number>();
    private readonly MAX_RETRIES = 3;

    constructor(
        private context: vscode.ExtensionContext, 
        private db: SymbolDatabase,
        private onProgress?: (percent: number) => void,
        private onIndexingComplete?: () => void,
        private onRebuildFullStart?: () => void
    ) {
    }

    public async rebuildIndexFull() {
        console.log('[Source Window] Rebuilding index (Full)...');
        
        // Notify start of full rebuild (set ready=false)
        if (this.onRebuildFullStart) {
            this.onRebuildFullStart();
        }

        this.isPaused = true; // Pause current processing
        this.queue = []; // Clear queue
        this.queueSet.clear();
        this.retryCounts.clear();
        this.processedCount = 0;
        this.totalToProcess = 0;
        
        // Clear DB
        this.db.clear();
        
        // Re-scan all files
        const files = await this.findAllFiles();
        this.totalToProcess = files.length;
        this.queue = files;
        this.queueSet = new Set(files.map(u => u.toString()));
        
        this.isPaused = false;
        this.processQueue();
    }

    public async rebuildIndexIncremental() {
        console.log('[Source Window] Rebuilding index (Incremental)...');
        // Just trigger syncIndex, which does the diffing
        await this.syncIndex();
    }

    private async findAllFiles(): Promise<vscode.Uri[]> {
        const sharedConfig = vscode.workspace.getConfiguration('shared');
        const includeFiles = sharedConfig.get<string>('includeFiles', '');
        const excludeFiles = sharedConfig.get<string>('excludeFiles', '');

        // Use vscode.workspace.findFiles which is faster and handles .gitignore automatically
        // It also works on remote workspaces (SSH, WSL, etc.)
        
        let include: vscode.GlobPattern | undefined = undefined;
        if (includeFiles) {
            const patterns = includeFiles.split(',').map(p => p.trim()).filter(p => p.length > 0);
            if (patterns.length > 1) {
                include = `{${patterns.join(',')}}`;
            } else if (patterns.length === 1) {
                include = patterns[0];
            }
        }

        let exclude: vscode.GlobPattern | undefined = undefined;
        if (excludeFiles) {
            const patterns = excludeFiles.split(',').map(p => p.trim()).filter(p => p.length > 0);
            if (patterns.length > 1) {
                exclude = `{${patterns.join(',')}}`;
            } else if (patterns.length === 1) {
                exclude = patterns[0];
            }
        }

        return await vscode.workspace.findFiles(include || '**/*', exclude);
    }



    public addToQueue(uri: vscode.Uri) {
        // Avoid duplicates
        const key = uri.toString();
        if (!this.queueSet.has(key)) {
            this.queueSet.add(key);
            this.queue.push(uri);
            this.totalToProcess++;
            this.updateStatusBar();
            this.scheduleDebounce();
        }
    }

    public startWatching() {
        this.loadGitignore();
        this.loadExclude();

        // Watch .gitignore changes to update fast path filters
        const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
        gitignoreWatcher.onDidChange(() => this.loadGitignore());
        gitignoreWatcher.onDidCreate(() => this.loadGitignore());
        gitignoreWatcher.onDidDelete(() => this.loadGitignore());
        this.context.subscriptions.push(gitignoreWatcher);

        this.setupFileWatcher();

        // Watch for configuration changes to update the watcher & exclude caches organically
        const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('shared.excludeFiles')) {
                // console.log('[Source Window] Configuration shared.excludeFiles changed, reloading caches.');
                this.loadExclude();
            }
            if (e.affectsConfiguration('shared.includeFiles')) {
                // console.log('[Source Window] Configuration shared.includeFiles changed, recreating OS watcher.');
                this.setupFileWatcher();
            }
        });
        this.context.subscriptions.push(configWatcher);
    }

    private setupFileWatcher() {
        // Dispose of the previous watcher to prevent memory leaks / duplicate events
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }

        const sharedConfig = vscode.workspace.getConfiguration('shared');
        const includeFiles = sharedConfig.get<string>('includeFiles', '');
        
        let watcherGlob = '**/*';
        if (includeFiles) {
            const patterns = includeFiles.split(',').map(p => p.trim()).filter(p => p.length > 0);
            if (patterns.length > 1) {
                watcherGlob = `{${patterns.join(',')}}`;
            } else if (patterns.length === 1) {
                watcherGlob = patterns[0];
            }
        }

        // 1. Handle File Creation, Deletion, and Changes
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(watcherGlob);
        this.context.subscriptions.push(this.fileWatcher);
        
        const handleFileChange = (uri: vscode.Uri) => {
            if (this.shouldIgnore(uri)) { return; }
            // console.log(`[Source Window] File change detected:`, uri.fsPath);
            this.addToQueue(uri);
        };

        this.fileWatcher.onDidCreate(handleFileChange);
        this.fileWatcher.onDidChange(handleFileChange);
        this.fileWatcher.onDidDelete(uri => {
            if (this.shouldIgnore(uri)) { return; }
            this.db.deleteFile(uri.fsPath);
        });
    }

    private scheduleDebounce() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.processQueue();
        }, this.DEBOUNCE_DELAY);
    }

    private async processQueue() {
        if (this.isPaused) { return; }
        if (this.isProcessing) { return; }
        this.isProcessing = true;

        while (this.queue.length > 0) {
            // Check if paused
            if (this.isPaused) {
                break;
            }

            // Get batch size from settings
            const sharedConfig = vscode.workspace.getConfiguration('shared');
            let batchSize = sharedConfig.get<number>('indexingBatchSize', 15);

            // Limit batch size to avoid LSP crash
            const MAX_BATCH_SIZE = 200;
            if (batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
                batchSize = MAX_BATCH_SIZE;
            }

            const batch = this.queue.splice(0, batchSize);
            // Remove from set
            for (const u of batch) {
                this.queueSet.delete(u.toString());
            }

            // Filter out files that are ignored by .gitignore (using rg)
            const validBatch = await this.filterExcludedFiles(batch);

            if (validBatch.length > 0) {
                await Promise.all(validBatch.map(uri => this.indexFile(uri)));
                // Note: indexFile might re-queue items on failure.
                // We count them as processed for this batch to keep progress moving forward visually,
                // even if they are re-added to the end of the queue.
                // If we don't count them, the progress bar might stall.
                // But if we re-queue, totalToProcess should ideally increase? 
                // No, totalToProcess is fixed based on initial scan.
                // If we re-queue, we are just delaying completion.
                this.processedCount += validBatch.length; 
            }
            
            // We also count ignored ones as "processed" for the progress bar
            const ignoredCount = batch.length - validBatch.length;
            if (ignoredCount > 0) {
                this.processedCount += ignoredCount;
            }

            this.updateStatusBar();

            // Small delay to yield to UI
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.isProcessing = false;
        if (this.queue.length === 0) {
            console.log(`[Source Window] Indexing complete. Processed ${this.processedCount} files.`);
            // Notify completion
            if (this.onIndexingComplete) {
                this.onIndexingComplete();
            }
            // Also notify progress 100% to clear UI
            if (this.onProgress) {
                this.onProgress(100);
            }
            
            // Reset counters for the next incremental batch
            this.processedCount = 0;
            this.totalToProcess = 0;
        } else {
            console.log('[Source Window] Indexing paused.');
        }
    }

    private async indexFile(uri: vscode.Uri) {
        try {
            // 0. Check existence and get mtime first
            // This prevents ENOENT errors if the file was deleted before we could process it
            let stat: vscode.FileStat;
            try {
                stat = await vscode.workspace.fs.stat(uri);
            } catch (error) {
                // File likely deleted or not accessible, skip silently
                return;
            }

            // Check DB mtime to avoid unnecessary LSP calls
            const dbMtime = this.db.getFileMtime(uri.fsPath);
            // Allow small time difference (e.g. 100ms) or exact match?
            // Usually exact match is fine for integers.
            // But let's be safe: if dbMtime >= stat.mtime, we skip.
            // Note: stat.mtime is usually in milliseconds.
            if (dbMtime !== undefined && dbMtime >= stat.mtime) {
                // console.log(`[Source Window] Skipping ${uri.fsPath} (mtime match)`);
                return;
            }

            // 1. Get Symbols
            // We use executeDocumentSymbolProvider. 
            // Note: This might open the document in the background.
            // Add timeout to prevent hanging
            const symbolsPromise = vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );

            const timeoutPromise = new Promise<vscode.DocumentSymbol[]>((_, reject) => {
                setTimeout(() => reject(new Error('Timeout')), 5000); // 5s timeout
            });

            let symbols: vscode.DocumentSymbol[] | undefined;
            try {
                symbols = await Promise.race([symbolsPromise, timeoutPromise]);
            } catch (e) {
                // Timeout or error
                const key = uri.toString();
                const retries = this.retryCounts.get(key) || 0;
                
                if (retries < this.MAX_RETRIES) {
                    // Re-queue
                    this.retryCounts.set(key, retries + 1);
                    this.queue.push(uri);
                    this.queueSet.add(key);
                    // Don't increment totalToProcess as it's already counted
                    // But we need to ensure processedCount isn't incremented for this failure
                    // The caller (processQueue) increments processedCount based on validBatch.
                    // We need to signal failure here so caller doesn't count it?
                    // Actually processQueue calls indexFile inside Promise.all.
                    // If indexFile returns, it's considered "done".
                    // So we should probably NOT re-queue here, but return a status?
                    // Or just re-queue and let it be processed again later.
                    // If we re-queue, queue.length increases.
                    // processQueue loop continues until queue is empty.
                    // So eventually it will be picked up again.
                    // console.log(`[Source Window] Retry ${retries + 1} for ${uri.fsPath}`);
                } else {
                    console.warn(`[Source Window] Failed to index ${uri.fsPath} after ${this.MAX_RETRIES} retries.`);
                }
                return;
            }

            // Success - clear retry count
            this.retryCounts.delete(uri.toString());

            // Even if symbols is empty, we should record the file in DB to track mtime
            // and avoid re-indexing it on every sync.
            const flatSymbols = (symbols && symbols.length > 0) ? this.flattenSymbols(symbols) : [];

            // 3. Insert into DB
            const mtime = stat.mtime;

            // Use transaction for atomic update
            this.db.insertFileAndSymbols(uri.fsPath, mtime, flatSymbols);

        } catch (error) {
            console.error(`[Source Window] Failed to index ${uri.fsPath}:`, error);
        }
    }

    private flattenSymbols(symbols: vscode.DocumentSymbol[], parentName: string = ''): Omit<SymbolRecord, 'id' | 'file_id'>[] {
        let result: Omit<SymbolRecord, 'id' | 'file_id'>[] = [];
        
        for (const sym of symbols) {
            const containerName = parentName;
            const fullName = parentName ? `${parentName}.${sym.name}` : sym.name;
            
            result.push({
                name: sym.name,
                detail: sym.detail,
                kind: sym.kind,
                range_start_line: sym.range.start.line,
                range_start_char: sym.range.start.character,
                range_end_line: sym.range.end.line,
                range_end_char: sym.range.end.character,
                selection_range_start_line: sym.selectionRange.start.line,
                selection_range_start_char: sym.selectionRange.start.character,
                selection_range_end_line: sym.selectionRange.end.line,
                selection_range_end_char: sym.selectionRange.end.character,
                container_name: containerName
            });

            if (sym.children && sym.children.length > 0) {
                result = result.concat(this.flattenSymbols(sym.children, fullName));
            }
        }
        return result;
    }

    private updateStatusBar() {
        const percent = Math.floor((this.processedCount / this.totalToProcess) * 100);
        if (this.onProgress) {
            this.onProgress(percent);
        }
    }

    public async syncIndex() {
        console.log('[Source Window] Starting Warm Start Sync...');
        
        // 1. Get all files in workspace using Ripgrep
        const workspaceFiles = await this.findAllFiles();
        const workspaceFileMap = new Map(workspaceFiles.map(f => [f.fsPath, f]));

        // 2. Get all files in DB
        const dbFiles = this.db.getFiles();

        // 3. Compare
        const toIndex: vscode.Uri[] = [];
        
        // Check for new or modified files
        const filesToCheck: { path: string, uri: vscode.Uri, dbMtime: number }[] = [];

        for (const [path, uri] of workspaceFileMap) {
            const dbRecord = dbFiles.get(path);
            if (!dbRecord) {
                // New file
                toIndex.push(uri);
            } else {
                filesToCheck.push({ path, uri, dbMtime: dbRecord.mtime });
            }
        }

        // Process filesToCheck in batches to check mtime
        const BATCH_SIZE = 100;
        for (let i = 0; i < filesToCheck.length; i += BATCH_SIZE) {
            const batch = filesToCheck.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (item) => {
                try {
                    const stat = await vscode.workspace.fs.stat(item.uri);
                    // Allow 1s difference due to precision
                    if (stat.mtime > item.dbMtime + 1000) {
                        toIndex.push(item.uri);
                    }
                } catch (e) {
                    // File might be gone or inaccessible
                }
            }));
        }

        // Check for deleted files
        for (const [path, record] of dbFiles) {
            if (!workspaceFileMap.has(path)) {
                this.db.deleteFile(path);
            }
        }

        if (toIndex.length > 0) {
            console.log(`[Source Window] Found ${toIndex.length} files to update.`);
            
            // If idle, reset counters for a fresh progress view
            if (this.queue.length === 0 && !this.isProcessing) {
                this.processedCount = 0;
                this.totalToProcess = 0;
            }

            this.totalToProcess += toIndex.length;
            
            for (const uri of toIndex) {
                const key = uri.toString();
                if (!this.queueSet.has(key)) {
                    this.queueSet.add(key);
                    this.queue.push(uri);
                }
            }

            this.updateStatusBar();
            this.processQueue();
        } else {
            console.log('[Source Window] Index is up to date.');
            if (this.onIndexingComplete) {
                this.onIndexingComplete();
            }
            // Also notify progress 100% to clear UI
            if (this.onProgress) {
                this.onProgress(100);
            }
        }
    }

    public pause() {
        this.isPaused = true;
        this.isProcessing = false;
        console.log('[Source Window] Paused.');
    }

    public resume() {
        if (this.isPaused) {
            console.log('[Source Window] Resumed.');
            this.isPaused = false;
            this.processQueue();
        }
    }

    private shouldIgnore(uri: vscode.Uri): boolean {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) { return false; }

        const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
        const segments = relativePath.split(path.sep);
        
        // Check root ignored (e.g. /dist)
        if (segments.length > 0 && this.rootIgnored.has(segments[0])) {
            return true;
        }

        // Check anywhere ignored (e.g. node_modules)
        if (segments.some(s => this.anywhereIgnored.has(s))) {
            return true;
        }

        // Check user configured plain text excludes (extremely fast O(1) Set lookup)
        if (segments.some(s => this.excludeIgnored.has(s))) {
            return true;
        }

        const normalizedPath = relativePath.replace(/\\/g, '/');

        // Check user configured excludeFiles using pre-compiled regex for globs
        if (this.excludeRegexes.length > 0) {
            if (this.excludeRegexes.some(r => r.test(normalizedPath))) {
                return true;
            }
        }

        return false;
    }

    private async filterExcludedFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
        if (uris.length === 0) { return []; }

        // 1. Check files.exclude using findFiles
        // We check each file individually to respect files.exclude settings
        const notExcludedBySettings = await Promise.all(uris.map(async uri => {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) { 
                return uri; // File outside workspace, assume valid
            }

            const relative = vscode.workspace.asRelativePath(uri, false);
            if (relative === uri.fsPath) { return uri; } 

            // findFiles respects files.exclude (but NOT .gitignore by default)
            // We pass the relative path as include pattern. If it returns the file, it's NOT excluded.
            const found = await vscode.workspace.findFiles(relative, null, 1);
            return found.length > 0 ? uri : null;
        }));
        
        const candidates = notExcludedBySettings.filter(u => u !== null) as vscode.Uri[];
        if (candidates.length === 0) { return []; }

        // 2. Check .gitignore using git check-ignore
        // This is the most robust way to handle complex .gitignore rules (negations, nested, etc.)
        return this.checkGitIgnore(candidates);
    }

    private async checkGitIgnore(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return uris; }

        try {
            // Convert to relative paths for git check-ignore
            const relativePaths = uris.map(u => vscode.workspace.asRelativePath(u, false));
            
            return new Promise((resolve) => {
                // git check-ignore -v -n <paths>
                // We use --stdin is safer for many files, but here we have small batch (10).
                // We use simple `git check-ignore <paths>` which outputs the paths that ARE ignored.
                
                const args = ['check-ignore', ...relativePaths];
                const child = cp.spawn('git', args, { cwd: rootPath });
                
                let output = '';
                child.stdout.on('data', (d: any) => output += d.toString());
                
                child.on('close', (code: number) => {
                    // If code is 0, some files were ignored.
                    // If code is 1, none were ignored.
                    // Output contains the list of ignored files (one per line).
                    
                    const ignoredFiles = new Set(output.split('\n').map(l => l.trim()).filter(l => l.length > 0));
                    
                    // Filter out ignored files
                    const valid = uris.filter(u => {
                        const rel = vscode.workspace.asRelativePath(u, false);
                        // git check-ignore output might use different separators on Windows?
                        // Usually it matches input format.
                        // Let's normalize to be safe.
                        return !ignoredFiles.has(rel) && !ignoredFiles.has(rel.replace(/\\/g, '/'));
                    });
                    resolve(valid);
                });
                
                child.on('error', () => {
                    // git not found or error, assume all valid (fail open)
                    resolve(uris);
                });
            });
        } catch (e) {
            return uris;
        }
    }

    private loadExclude() {
        const sharedConfig = vscode.workspace.getConfiguration('shared');
        const excludeFiles = sharedConfig.get<string>('excludeFiles', '');
        
        this.excludeIgnored.clear();
        this.excludeRegexes = [];

        if (!excludeFiles) { return; }

        const patterns = excludeFiles.split(',').map(p => p.trim()).filter(p => p.length > 0);
        for (let p of patterns) {
            // If the pattern contains wildcards (*, ?, []), convert it to a regular expression
            if (/[*?\[\]]/.test(p)) {
                try {
                    // We must escape *, ? as well before replacing them, otherwise they break the RegExp
                    const escaped = p.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
                    const regexStr = escaped.replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '.');
                    this.excludeRegexes.push(new RegExp(`(^|/)${regexStr}(/|$)`, 'i'));
                } catch (e) {
                    console.warn(`[Source Window] Ignored invalid exclude configuration pattern: "${p}"`, e);
                }
            } else {
                // If it is a simple folder or file name (e.g., node_modules, dist), store it in the Set directly
                if (p.startsWith('/')) { p = p.substring(1); }
                if (p.endsWith('/')) { p = p.substring(0, p.length - 1); }
                this.excludeIgnored.add(p);
            }
        }
    }

    private loadGitignore() {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return; }
        
        // Always reset to defaults first. 
        // This ensures that if .gitignore is deleted, we revert to the safe defaults.
        this.rootIgnored = new Set(['.git', '.DS_Store', '.vscode']);
        this.anywhereIgnored = new Set([]);

        const gitignorePath = path.join(rootPath, '.gitignore');
        if (!fs.existsSync(gitignorePath)) { return; }

        try {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            const lines = content.split('\n');
            
            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#')) { continue; }
                
                // Handle simple cases for fast path
                // Skip globs (*, ?, []) as they are too complex for simple string matching
                // We let the robust filterExcludedFiles (using vscode.findFiles) handle those.
                if (/[*?\[\]]/.test(line)) { continue; }

                const isRoot = line.startsWith('/');
                if (isRoot) { line = line.substring(1); }
                
                if (line.endsWith('/')) { line = line.substring(0, line.length - 1); }

                // If it still contains slash, it's a nested path e.g. "foo/bar"
                // We skip these for fast path optimization to keep it simple
                if (line.includes('/')) { continue; }

                if (isRoot) {
                    this.rootIgnored.add(line);
                } else {
                    this.anywhereIgnored.add(line);
                }
            }
            console.log('[Source Window] Loaded .gitignore patterns for fast path filtering.');
        } catch (e) {
            console.error('[Source Window] Failed to load .gitignore:', e);
        }
    }
}
