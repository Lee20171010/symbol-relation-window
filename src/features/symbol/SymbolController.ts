import * as vscode from 'vscode';
import * as path from 'path';
import { SymbolModel } from './SymbolModel';
import { parserRegistry } from './parsing/ParserRegistry';
import { SymbolWebviewProvider } from './SymbolWebviewProvider';
import { SymbolMode, SymbolItem } from '../../shared/common/types';
import { SymbolDatabase, SymbolRecord } from '../../shared/db/database';
import { SymbolIndexer } from './indexer/indexer';
import { LspClient, LspStatus } from '../../shared/services/LspClient';
import { DatabaseManager } from '../../shared/services/DatabaseManager';
import { symbolKindNames } from '../../shared/common/symbolKinds';

export class SymbolController {
    private model: SymbolModel;
    private provider?: SymbolWebviewProvider;
    private context: vscode.ExtensionContext;
    public currentMode: SymbolMode = 'current';
    private debounceTimer: NodeJS.Timeout | undefined;
    private currentSearchId: number = 0;
    private searchCts: vscode.CancellationTokenSource | undefined;
    
    private currentQuery: string = '';
    private currentScopePath: string | undefined;
    private currentIncludePattern: string | undefined;
    private currentExcludePattern: string | undefined;
    private currentDocumentSymbols: SymbolItem[] = [];
    private currentFilter: number[] = [];
    private projectFilter: number[] = [];

    // Caching
    private searchCache: Map<string, SymbolItem[]> = new Map();
    private cacheTimeout: NodeJS.Timeout | undefined;
    private readonly CACHE_DURATION = 120000; // 2 minutes

    // Pagination
    private allSearchResults: SymbolItem[] = [];
    private loadedCount: number = 0;
    private readonly BATCH_SIZE = 100;
    
    private readiness: 'standby' | 'loading' | 'ready' = 'standby';
    private retryCount: number = 0;
    private readonly MAX_RETRIES = 20; // 20 * 3s = 60s
    private probeIndex: number = 0;
    private readonly PROBE_CHARS = ['', 'e', 'a', 'i', 'o', 'u', 's', 't', 'r', 'n']; // Common letters
    private isDatabaseReady = false;
    private lastProgress: number | null = null;
    private disposables: vscode.Disposable[] = [];

    constructor(
        context: vscode.ExtensionContext,
        private lspClient: LspClient,
        private dbManager: DatabaseManager,
        private lockedMode?: SymbolMode
    ) {
        this.context = context;
        this.model = new SymbolModel();
        
        // Restore state
        if (this.lockedMode) {
            this.currentMode = this.lockedMode;
        } else {
            this.currentMode = this.context.workspaceState.get<SymbolMode>('symbolWindow.mode', 'current');
        }
        this.currentScopePath = this.context.workspaceState.get<string>('symbolWindow.scopePath');
        
        const allKinds = Object.keys(symbolKindNames).map(Number);
        this.currentFilter = this.context.workspaceState.get<number[]>('symbolWindow.currentFilter', allKinds);
        this.projectFilter = this.context.workspaceState.get<number[]>('symbolWindow.projectFilter', allKinds);
        
        if (!this.lockedMode) {
            vscode.commands.executeCommand('setContext', 'symbolWindow.mode', this.currentMode);
        }

        // Listen to LSP status
        this.disposables.push(this.lspClient.onStatusChange(status => {
            this.provider?.postMessage({ command: 'status', status: status });
            if (status === 'ready') {
                this.dbManager.resumeIndexing();
                // If we just became ready, refresh to show symbols
                this.refresh();
            } else if (status === 'loading') {
                this.dbManager.pauseIndexing();
            }
        }));

        // Listen to DB status
        this.disposables.push(this.dbManager.onReadyChange(ready => {
            this.setDatabaseReady(ready);
        }));
        
        this.disposables.push(this.dbManager.onProgress(percent => {
            this.updateProgress(percent);
        }));

        // Listen to active editor changes
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            // Current Mode: Always try to update immediately
            if (this.currentMode === 'current') {
                if (editor) {
                    this.updateCurrentSymbols(editor.document.uri).catch(e => {
                        console.error('[Source Window] updateCurrentSymbols failed', e);
                    });
                } else {
                    this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                }
            }
        }));

        // Listen to document changes (re-parse symbols)
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            // 1. Clear Project Cache (Always)
            this.searchCache.clear();

            // 2. Current Mode: Update immediately
            if (this.currentMode === 'current') {
                this.updateCurrentSymbols(doc.uri);
            }
        }, null, context.subscriptions);
        
        // Listen to selection changes for sync
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (this.currentMode === 'current' && this.provider && this.provider.isVisible) {
                const cursor = e.selections[0].active;
                const symbol = this.findSymbolAtPosition(this.currentDocumentSymbols, cursor);
                if (symbol) {
                    this.provider.postMessage({ command: 'selectSymbol', range: symbol.range });
                }
            }
        }, null, context.subscriptions);

        // Listen to configuration changes
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('symbolWindow.enableHighlighting') || 
                e.affectsConfiguration('shared.enableDatabaseMode')) {
                this.refresh();
            }
        }));
    }

    private findSymbolAtPosition(symbols: SymbolItem[], position: vscode.Position): SymbolItem | undefined {
        for (const symbol of symbols) {
            if (symbol.range.contains(position)) {
                // Check children first for more specific match
                if (symbol.children && symbol.children.length > 0) {
                    const child = this.findSymbolAtPosition(symbol.children, position);
                    if (child) {
                        return child;
                    }
                }
                return symbol;
            }
        }
        return undefined;
    }

    public setProvider(provider: SymbolWebviewProvider) {
        this.provider = provider;
        // When provider is set (webview becomes visible or reloaded), refresh immediately
        // This is crucial when controller is recreated but webview was already there
        this.refresh();
    }

    public setDatabaseReady(ready: boolean) {
        // Always notify UI, even if state hasn't changed (for re-renders)
        this.isDatabaseReady = ready;
        if (ready) {
            this.lastProgress = null; // Clear progress when ready
        }
        
        const dbEnabled = vscode.workspace.getConfiguration('shared').get<boolean>('enableDatabaseMode', true);
        const effectiveReady = ready && dbEnabled;

        vscode.commands.executeCommand('setContext', 'symbolWindow.databaseReady', effectiveReady);
        // Notify webview to update UI (hide deep search, show rebuild)
        this.provider?.postMessage({ command: 'setDatabaseMode', enabled: effectiveReady });
        
        if (ready) {
            console.log('[Source Window] Indexing complete. Switching to Database Mode.');
        }
    }

    public async refresh() {
        // Clear cache on explicit refresh
        this.searchCache.clear();

        // Sync mode to webview to ensure consistency
        this.provider?.postMessage({ command: 'setMode', mode: this.currentMode, lockedMode: this.lockedMode });
        
        // Sync database mode state
        // We need to check both the config AND the readiness
        const dbEnabled = vscode.workspace.getConfiguration('shared').get<boolean>('enableDatabaseMode', true);
        const effectiveReady = dbEnabled && this.isDatabaseReady;
        
        vscode.commands.executeCommand('setContext', 'symbolWindow.databaseReady', effectiveReady);
        this.provider?.postMessage({ command: 'setDatabaseMode', enabled: effectiveReady });

        // Sync progress if active
        if (this.lastProgress !== null) {
            this.provider?.postMessage({ command: 'progress', percent: this.lastProgress });
        }

        // Sync settings
        const config = vscode.workspace.getConfiguration('symbolWindow');
        this.provider?.postMessage({ 
            command: 'setSettings', 
            settings: {
                enableHighlighting: config.get<boolean>('enableHighlighting', true)
            }
        });
        
        // Sync mode
        this.provider?.postMessage({ command: 'setMode', mode: this.currentMode });

        // Sync scope
        this.provider?.postMessage({ command: 'setScope', scopePath: this.currentScopePath });

        // Sync filters
        this.provider?.postMessage({ 
            command: 'setFilters', 
            currentFilter: this.currentFilter, 
            projectFilter: this.projectFilter 
        });

        // If standby, try polling again (Manual Retry)
        if (this.lspClient.status === 'standby') {
            this.lspClient.startPolling();
        } else {
             this.provider?.postMessage({ command: 'status', status: this.lspClient.status });
        }

        if (this.currentMode === 'current') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await this.updateCurrentSymbols(editor.document.uri);
            } else {
                // No active editor, clear symbols
                this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                this.provider?.postMessage({ command: 'status', status: 'ready' });
            }
            return;
        }

        // Project Mode Logic
        if (this.lspClient.status === 'loading') {
            return;
        }
        
        // Project mode refresh: Ask webview to re-send search query
        this.provider?.postMessage({ command: 'refresh' });
    }

    public toggleMode() {
        if (this.lockedMode) { return; }
        this.setMode(this.currentMode === 'current' ? 'project' : 'current');
    }

    public setMode(mode: SymbolMode) {
        if (this.lockedMode) { return; }
        if (this.currentMode === mode) { return; }
        
        this.currentMode = mode;
        this.context.workspaceState.update('symbolWindow.mode', this.currentMode);
        vscode.commands.executeCommand('setContext', 'symbolWindow.mode', this.currentMode);
        if (this.provider) {
            // Force update mode in webview
            this.provider.postMessage({ command: 'setMode', mode: this.currentMode });
            
            // Sync settings on mode toggle too
            const config = vscode.workspace.getConfiguration('symbolWindow');
            this.provider.postMessage({ 
                command: 'setSettings', 
                settings: {
                    enableHighlighting: config.get<boolean>('enableHighlighting', true)
                }
            });
        }
        
        // If ready, refresh. If standby, maybe poll?
        if (this.lspClient.status === 'ready') {
            this.refresh();
        } else if (this.lspClient.status === 'standby') {
            this.lspClient.startPolling();
        }
    }

    public async startPolling() {
        this.lspClient.startPolling();
    }

    public cancelSearch() {
        if (this.searchCts) {
            this.searchCts.cancel();
            this.searchCts.dispose();
            this.searchCts = undefined;
        }
        this.provider?.postMessage({ command: 'status', status: 'ready' });
        this.provider?.postMessage({ command: 'updateSymbols', symbols: this.allSearchResults });
    }

    // Removed checkReadiness method as it is replaced by startPolling/poll
    public async handleSearch(query: string, includePattern?: string, excludePattern?: string, kinds?: number[]) {
        if (this.currentMode === 'project') {
            // Update patterns
            this.currentIncludePattern = includePattern;
            this.currentExcludePattern = excludePattern;
            if (kinds) {
                this.projectFilter = kinds;
            }

            // If not ready, don't search, just ensure UI is in loading state
            if (this.lspClient.status !== 'ready') {
                this.provider?.postMessage({ command: 'status', status: 'loading' });
                return;
            }

            // Cancel any ongoing search immediately when user types
            if (this.searchCts) {
                this.searchCts.cancel();
                this.searchCts.dispose();
                this.searchCts = undefined;
            }

            // Debounce
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            
            const searchId = ++this.currentSearchId;
            const config = vscode.workspace.getConfiguration('shared');
            const enableDatabaseMode = config.get<boolean>('enableDatabaseMode', false);

            // Hybrid Transition: Use DB only if indexing is complete (isDatabaseReady)
            if (enableDatabaseMode && this.dbManager.getDb() && this.isDatabaseReady) {
                this.debounceTimer = setTimeout(async () => {
                    if (searchId !== this.currentSearchId) { return; }
                    
                    this.currentQuery = query;
                    this.provider?.postMessage({ command: 'searchStart' });
                    
                    if (!query) {
                        this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                        return;
                    }

                    try {
                        // If kinds is empty, it means "select none", so return empty immediately (Scheme B)
                        if (kinds && kinds.length === 0) {
                            this.allSearchResults = [];
                            this.loadedCount = 0;
                            this.provider?.postMessage({ 
                                command: 'updateSymbols', 
                                symbols: []
                            });
                            return;
                        }

                        // Optimization: If kinds contains ALL kinds, pass undefined to DB to skip "IN (...)" check
                        const totalKinds = Object.keys(symbolKindNames).length;
                        const effectiveKinds = (kinds && kinds.length >= totalKinds) ? undefined : kinds;

                        const records = this.dbManager.getDb()!.search(query, this.BATCH_SIZE, 0, effectiveKinds);
                        const items = records.map((r: SymbolRecord) => this.mapRecordToItem(r));
                        
                        this.allSearchResults = items;
                        this.loadedCount = items.length;
                        
                        this.provider?.postMessage({ 
                            command: 'updateSymbols', 
                            symbols: items
                        });
                    } catch (e) {
                        console.error('[Source Window] DB Search failed:', e);
                    }
                }, 300);
                return;
            }

            const debounceTime = 300;

            this.debounceTimer = setTimeout(async () => {
                if (searchId !== this.currentSearchId) { return; }

                if (!query) {
                    this.currentQuery = '';
                    this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                    return;
                }
                
                this.currentQuery = query;
                const keywords = query.trim().split(/\s+/).filter(k => k.length > 0);
                
                this.provider?.postMessage({ command: 'searchStart' });

                if (keywords.length === 0) {
                     this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                     return;
                }

                // --- Caching Logic Start ---
                
                // 1. Prune cache: Remove keys not in current query
                for (const key of this.searchCache.keys()) {
                    if (!keywords.includes(key)) {
                        this.searchCache.delete(key);
                    }
                }

                // 2. Reset Timeout
                if (this.cacheTimeout) { clearTimeout(this.cacheTimeout); }
                this.cacheTimeout = setTimeout(() => {
                    this.searchCache.clear();
                }, this.CACHE_DURATION);

                // 3. Identify missing keywords
                const missingKeywords = keywords.filter(k => !this.searchCache.has(k));

                // --- Caching Logic End ---

                this.searchCts = new vscode.CancellationTokenSource();
                const token = this.searchCts.token;

                let allSymbols: SymbolItem[] = [];

                try {
                    // Standard Search Logic (LSP)
                    // Fetch missing keywords
                    if (missingKeywords.length > 0) {
                        const searchPromises = missingKeywords.map(async (keyword) => {
                            const results = await this.model.getWorkspaceSymbols(keyword, token);
                            return { keyword, results };
                        });

                        const newResults = await Promise.all(searchPromises);

                        if (searchId !== this.currentSearchId || token.isCancellationRequested) { 
                            return; 
                        }

                        // Update cache
                        newResults.forEach(({ keyword, results }) => {
                            this.searchCache.set(keyword, results);
                        });
                    }

                    // Collect results from cache for ALL keywords
                    const symbolMap = new Map<string, SymbolItem>();
                    
                    keywords.forEach(k => {
                        const cached = this.searchCache.get(k);
                        if (cached) {
                            cached.forEach(symbol => {
                                const key = `${symbol.name}|${symbol.detail}|${symbol.range.start.line}:${symbol.range.start.character}`;
                                if (!symbolMap.has(key)) {
                                    symbolMap.set(key, symbol);
                                }
                            });
                        }
                    });

                    allSymbols = Array.from(symbolMap.values());

                    // Client-side Filtering: Ensure result matches ALL keywords
                    if (keywords.length > 1) {
                        const lowerKeywords = keywords.map(k => k.toLowerCase());
                        allSymbols = allSymbols.filter(s => {
                            const name = s.name.toLowerCase();
                            const container = (s.detail || '').toLowerCase(); 
                            return lowerKeywords.every(k => name.includes(k) || container.includes(k));
                        });
                    }

                    allSymbols = this.sortSymbols(allSymbols, query);

                    this.allSearchResults = allSymbols;
                    this.loadedCount = this.BATCH_SIZE;

                    // Send first batch
                    const initialBatch = this.allSearchResults.slice(0, this.loadedCount);
                    this.provider?.postMessage({ 
                        command: 'updateSymbols', 
                        symbols: initialBatch,
                        totalCount: this.allSearchResults.length 
                    });

                } catch (error) {
                    if (error instanceof vscode.CancellationError) {
                        // ignore
                    } else {
                        console.error(`[Source Window] SearchId ${searchId} failed`, error);
                        
                        // LSP Crash / Error Recovery
                        // If the search fails (e.g. LSP crash), revert to standby and try to recover
                        this.provider?.postMessage({ command: 'status', status: 'loading' }); // Show loading in UI
                        this.lspClient.startPolling();

                        // Stop the search progress bar
                        this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                    }
                    return;
                }
            }, debounceTime);
        }
    }

    private async updateCurrentSymbols(uri: vscode.Uri) {
        const symbols = await this.model.getDocumentSymbols(uri);
        this.currentDocumentSymbols = symbols;
        
        // Note: We do NOT force status to 'ready' here anymore.
        // We rely on the global readiness state (determined by workspace polling)
        // to tell the UI when to stop loading. This prevents "False Ready" states
        // where we get empty symbols because the LSP is initializing.
        
        this.provider?.postMessage({ command: 'updateSymbols', symbols });
    }

    public jumpTo(uriStr: string | undefined, range: any) {
        if (uriStr) {
            const uri = vscode.Uri.parse(uriStr);
            vscode.window.showTextDocument(uri, { selection: new vscode.Range(range[0].line, range[0].character, range[1].line, range[1].character) });
        } else {
            // Current document
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.revealRange(new vscode.Range(range[0].line, range[0].character, range[1].line, range[1].character));
                editor.selection = new vscode.Selection(range[0].line, range[0].character, range[1].line, range[1].character);
            }
        }
    }

    public loadMore() {
        if (this.currentMode === 'project') {
            const config = vscode.workspace.getConfiguration('shared');
            if (config.get('enableDatabaseMode') && this.dbManager.getDb() && this.isDatabaseReady) {
                const nextBatch = this.dbManager.getDb()!.search(this.currentQuery, this.BATCH_SIZE, this.loadedCount);
                if (nextBatch.length > 0) {
                    const items = nextBatch.map((r: SymbolRecord) => this.mapRecordToItem(r));
                    this.allSearchResults.push(...items);
                    this.loadedCount += items.length;
                    this.provider?.postMessage({ 
                        command: 'appendSymbols', 
                        symbols: items
                    });
                }
                return;
            }

            if (this.loadedCount < this.allSearchResults.length) {
                const start = this.loadedCount;
                this.loadedCount += this.BATCH_SIZE;
                const nextBatch = this.allSearchResults.slice(start, this.loadedCount);
                this.provider?.postMessage({ 
                    command: 'appendSymbols', 
                    symbols: nextBatch,
                    totalCount: this.allSearchResults.length
                });
            }
        }
    }

    public async deepSearch(isAuto: boolean = false) {
        // Deep Search is only available in Project Mode when Database is NOT ready
        if (this.currentMode !== 'project' || !this.currentQuery) {
            return;
        }

        const keywords = this.currentQuery.trim().split(/\s+/).filter(k => k.length > 0);
        if (keywords.length === 0) {
            return;
        }

        // If auto-triggered, we don't want to set status to loading if it's already loading?
        // Actually, handleSearch sets 'searchStart' which might set loading.
        // But deepSearch is async.
        this.provider?.postMessage({ command: 'status', status: 'loading' });

        try {
            const textSearchResults = await this.model.findSymbolsByTextSearch(
                this.currentQuery, 
                keywords, 
                this.searchCts?.token,
                this.currentScopePath,
                this.currentIncludePattern
            );
            
            // Check cancellation
            if (this.searchCts?.token.isCancellationRequested) {
                return;
            }

            // Deduplicate against existing results
            const existingKeys = new Set<string>();
            this.allSearchResults.forEach(s => {
                // Use selectionRange for better matching between DocumentSymbol and WorkspaceSymbol
                // WorkspaceSymbol range usually points to the name, which matches DocumentSymbol.selectionRange
                const key = `${s.uri}|${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
                existingKeys.add(key);
            });

            const newItems: SymbolItem[] = [];
            textSearchResults.forEach(s => {
                const key = `${s.uri}|${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
                if (!existingKeys.has(key)) {
                    s.isDeepSearch = true;
                    newItems.push(s);
                    existingKeys.add(key); // Avoid duplicates within new items too
                }
            });

            if (newItems.length > 0) {
                // Prepend new items
                this.allSearchResults = [...newItems, ...this.allSearchResults];
                
                this.allSearchResults = this.sortSymbols(this.allSearchResults, this.currentQuery);

                // Refresh UI
                this.loadedCount = Math.max(this.loadedCount + newItems.length, this.BATCH_SIZE);
                const batch = this.allSearchResults.slice(0, this.loadedCount);
                
                this.provider?.postMessage({ 
                    command: 'updateSymbols', 
                    symbols: batch,
                    totalCount: this.allSearchResults.length 
                });
            }
        } catch (e) {
            console.error('[Source Window] Deep search failed', e);
        } finally {
            this.provider?.postMessage({ command: 'status', status: 'ready' });
        }
    }

    public setScope(scope: string) {
        // Sanitize input: Ensure we have a valid fsPath for internal use
        try {
            // If it looks like a URI, parse it
            if (scope.startsWith('file://') || scope.startsWith('vscode-remote://')) {
                this.currentScopePath = vscode.Uri.parse(scope).fsPath;
            } else {
                // Otherwise treat as path (but normalize it via Uri.file to be safe)
                this.currentScopePath = vscode.Uri.file(scope).fsPath;
            }
        } catch (e) {
            console.warn('[Source Window] Invalid scope path:', scope);
            this.currentScopePath = scope; // Fallback
        }

        this.context.workspaceState.update('symbolWindow.scopePath', this.currentScopePath);
        
        // Switch to project mode if not already
        if (this.currentMode !== 'project') {
            this.toggleMode();
        }
        
        // Send back to Webview as URI string (External Communication)
        const scopeUri = vscode.Uri.file(this.currentScopePath).toString();
        this.provider?.postMessage({ command: 'setScope', scopePath: scopeUri });
        
        // Trigger search if query exists
        if (this.currentQuery) {
            this.handleSearch(this.currentQuery, this.currentIncludePattern, this.currentExcludePattern, this.projectFilter);
        }
    }

    public clearScope() {
        this.currentScopePath = undefined;
        this.context.workspaceState.update('symbolWindow.scopePath', undefined);
        this.provider?.postMessage({ command: 'setScope', scopePath: undefined });
        
        // Trigger search if query exists
        if (this.currentQuery) {
            this.handleSearch(this.currentQuery, this.currentIncludePattern, this.currentExcludePattern, this.projectFilter);
        }
    }

    public async selectScope() {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Search Scope'
        });

        if (uris && uris.length > 0) {
            // Internal: Use fsPath
            this.setScope(uris[0].fsPath);
        }
    }

    private mapRecordToItem(record: any): SymbolItem {
        const config = vscode.workspace.getConfiguration('symbolWindow');
        const mode = config.get<string>('symbolParsing.mode', 'auto');

        const ext = record.file_path ? record.file_path.split('.').pop()?.toLowerCase() || '' : '';
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
        const { name, detail } = parser.parse(record.name, record.detail || '', record.kind);

        let finalDetail = detail;
        // In Project Mode, it's helpful to see the container name (e.g. Class)
        if (record.container_name && record.container_name !== finalDetail) {
            finalDetail = finalDetail ? `${finalDetail}  ${record.container_name}` : record.container_name;
        }

        const relativePath = vscode.workspace.asRelativePath(vscode.Uri.file(record.file_path));
        const filename = path.basename(record.file_path);
        let location = '';
        if (relativePath === filename) {
            location = `${filename}:${record.range_start_line + 1}`;
        } else {
            const dir = relativePath.substring(0, relativePath.length - filename.length - 1);
            location = `${filename} (${dir}):${record.range_start_line + 1}`;
        }

        return {
            name: name,
            detail: finalDetail,
            path: location,
            kind: record.kind,
            range: new vscode.Range(
                record.range_start_line, record.range_start_char,
                record.range_end_line, record.range_end_char
            ),
            selectionRange: new vscode.Range(
                record.selection_range_start_line, record.selection_range_start_char,
                record.selection_range_end_line, record.selection_range_end_char
            ),
            children: [],
            uri: vscode.Uri.file(record.file_path).toString(),
            containerName: record.container_name
        };
    }

    private sortSymbols(symbols: SymbolItem[], query: string): SymbolItem[] {
        const queryLower = query.toLowerCase();
        return symbols.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();

            // 1. Exact Match
            const aExact = aName === queryLower;
            const bExact = bName === queryLower;
            if (aExact && !bExact) { return -1; }
            if (!aExact && bExact) { return 1; }

            // 2. Length (Shortest First)
            const lenDiff = aName.length - bName.length;
            if (lenDiff !== 0) { return lenDiff; }

            // 3. Alphabetical
            return aName.localeCompare(bName);
        });
    }

    public updateProgress(percent: number) {
        this.lastProgress = percent;
        if (percent >= 100) {
            this.lastProgress = null;
        }
        this.provider?.postMessage({ command: 'progress', percent });
    }

    public saveFilters(currentFilter: number[], projectFilter: number[]) {
        this.currentFilter = currentFilter;
        this.projectFilter = projectFilter;
        this.context.workspaceState.update('symbolWindow.currentFilter', currentFilter);
        this.context.workspaceState.update('symbolWindow.projectFilter', projectFilter);
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}

