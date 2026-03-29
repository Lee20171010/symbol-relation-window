import * as vscode from 'vscode';
import { RelationModel, DeepCall } from './RelationModel';
import { RelationWebviewProvider } from './RelationWebviewProvider';
import { RelationItem, HistoryEntry, RelationMessage, RelationSettings } from '../../shared/common/types';
import { ReferenceController } from '../reference/ReferenceController';
import { parserRegistry } from '../symbol/parsing/ParserRegistry';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { previewLocation } from '../../shared/utils/navigation';

import { DatabaseManager } from '../../shared/services/DatabaseManager';
import { symbolKindNames } from '../../shared/common/symbolKinds';

export class RelationController {
    private model: RelationModel;
    private webviewProvider: RelationWebviewProvider;
    private referenceController: ReferenceController | undefined;
    private context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];

    // State
    private currentRoot: vscode.CallHierarchyItem | string | undefined;
    private direction: 'incoming' | 'outgoing' = 'incoming'; // Default per spec
    private isLocked: boolean = false;
    private history: HistoryEntry[] = [];
    private historyIndex: number = -1;
    private itemCache: Map<string, vscode.CallHierarchyItem> = new Map();
    
    // Internal history with full objects
    private internalHistory: { 
        root: vscode.CallHierarchyItem | string; 
        label: string;
        // For string fallback, we need context to re-fetch references
        context?: { uri: vscode.Uri; range: vscode.Range };
    }[] = [];

    // Auto-Sync Logic
    private debounceTimer: NodeJS.Timeout | undefined;
    private isJumping: boolean = false;
    private jumpTimeout: NodeJS.Timeout | undefined;
    private nextRequestId = 0;
    private cancellationTokenSource: vscode.CancellationTokenSource | undefined;
    // Map to track cancellation tokens for individual node expansions
    private nodeExpansionTokens: Map<string, vscode.CancellationTokenSource> = new Map();

    // Pagination for References
    private cachedReferences: vscode.Location[] = [];
    private loadedReferencesCount: number = 0;
    private currentRelationRoot: RelationItem | undefined;
    private currentFilter: number[] = [];
    private incomingFilter: number[] = [];
    private outgoingFilter: number[] = [];
    private currentSettings: RelationSettings;

    constructor(
        context: vscode.ExtensionContext, 
        webviewProvider: RelationWebviewProvider, 
        referenceController: ReferenceController | undefined,
        dbManager: DatabaseManager
    ) {
        this.context = context;
        this.model = new RelationModel(dbManager);
        this.webviewProvider = webviewProvider;
        this.referenceController = referenceController;

        // Initialize filter
        const defaultFilter = [
            vscode.SymbolKind.Function,
            vscode.SymbolKind.Method,
            vscode.SymbolKind.Constructor,
            vscode.SymbolKind.Constant
        ];
        this.currentFilter = this.context.workspaceState.get<number[]>('relationWindow.filter', defaultFilter);
        this.incomingFilter = this.context.workspaceState.get<number[]>('relationWindow.incomingFilter', defaultFilter);
        this.outgoingFilter = this.context.workspaceState.get<number[]>('relationWindow.outgoingFilter', defaultFilter);
        
        this.currentSettings = this.context.workspaceState.get<RelationSettings>('relationWindow.settings', { removeDuplicate: true, showDefinitionPath: false });

        // Listen to webview messages
        this.webviewProvider.onMessage(this.handleMessage.bind(this));

        // Listen to cursor moves
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(this.onCursorMove.bind(this)),
            vscode.window.onDidChangeActiveTextEditor(this.onEditorChange.bind(this))
        );

        // Listen to config changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('relationWindow.defaultDirection')) {
                    // Only apply if we haven't set a direction yet (though we init with 'incoming')
                }
                if (e.affectsConfiguration('relationWindow.showBothDirections')) {
                    this.refresh();
                }
            })
        );
        
        // Initialize direction from config or state
        const savedDirection = this.context.workspaceState.get<'incoming' | 'outgoing'>('relationWindow.direction');
        if (savedDirection) {
            this.direction = savedDirection;
        } else {
            const config = vscode.workspace.getConfiguration('relationWindow');
            const defaultDir = config.get<string>('relationWindow.defaultDirection');
            if (defaultDir === 'outgoing') {
                this.direction = 'outgoing';
            }
        }
    }

    public setReferenceController(controller: ReferenceController | undefined) {
        this.referenceController = controller;
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }

    private async handleMessage(message: any) {
        switch (message.command) {
            case 'resolveHierarchy':
                await this.resolveHierarchy(message.itemId, message.direction);
                break;
            case 'setDirection':
                this.direction = message.direction;
                this.context.workspaceState.update('relationWindow.direction', this.direction);
                // Re-fetch for current root if exists
                if (this.currentRoot) {
                    await this.refresh();
                }
                break;
            case 'refreshRelation':
                await this.refresh();
                break;
            case 'toggleLock':
                this.isLocked = message.locked;
                break;
            case 'navigateHistory':
                await this.navigateHistory(message.action, message.index);
                break;
            case 'jump':
                await this.handleJump(message.uri, message.range, false);
                break;
            case 'preview':
                if (message.uri && message.range) {
                    previewLocation(message.uri, message.range);
                }
                break;
            case 'saveFilter':
                if (message.scope === 'incoming') {
                    this.incomingFilter = message.filter;
                    this.context.workspaceState.update('relationWindow.incomingFilter', this.incomingFilter);
                    // If current direction is incoming, update currentFilter too
                    if (this.direction === 'incoming') {
                        this.currentFilter = message.filter;
                        this.context.workspaceState.update('relationWindow.filter', this.currentFilter);
                    }
                } else if (message.scope === 'outgoing') {
                    this.outgoingFilter = message.filter;
                    this.context.workspaceState.update('relationWindow.outgoingFilter', this.outgoingFilter);
                    // If current direction is outgoing, update currentFilter too
                    if (this.direction === 'outgoing') {
                        this.currentFilter = message.filter;
                        this.context.workspaceState.update('relationWindow.filter', this.currentFilter);
                    }
                } else {
                    // Legacy/Single mode save
                    this.currentFilter = message.filter;
                    this.context.workspaceState.update('relationWindow.filter', this.currentFilter);
                    
                    // Sync back to specific filters
                    if (this.direction === 'incoming') {
                        this.incomingFilter = message.filter;
                        this.context.workspaceState.update('relationWindow.incomingFilter', this.incomingFilter);
                    } else {
                        this.outgoingFilter = message.filter;
                        this.context.workspaceState.update('relationWindow.outgoingFilter', this.outgoingFilter);
                    }
                }
                
                // Refresh if we have a root
                if (this.currentRoot) {
                    this.refresh();
                }
                break;
            case 'saveSettings':
                if (message.settings) {
                    this.currentSettings = message.settings;
                    this.context.workspaceState.update('relationWindow.settings', this.currentSettings);
                    if (this.currentRoot) {
                        this.refresh();
                    }
                }
                break;
            case 'ready':
                // Restore state if available
                this.webviewProvider.postMessage({ 
                    command: 'setFilters', 
                    filter: this.currentFilter,
                    incomingFilter: this.incomingFilter,
                    outgoingFilter: this.outgoingFilter
                });
                this.webviewProvider.postMessage({ command: 'setSettings', settings: this.currentSettings });
                
                if (this.currentRoot) {
                    // If we have data in memory, resend it
                    this.webviewProvider.postMessage({ command: 'setDirection', direction: this.direction });
                    
                    // If we have a valid root, try to refresh view
                    if (this.currentRelationRoot) {
                         this.refresh();
                    }
                } else {
                    // Try to restore from workspaceState
                    const savedRoot = this.context.workspaceState.get<any>('relationWindow.lastRoot');
                    if (savedRoot) {
                        try {
                            const uri = vscode.Uri.parse(savedRoot.uri);
                            
                            const parseRange = (r: any) => {
                                if (Array.isArray(r)) {
                                    return new vscode.Range(r[0].line, r[0].character, r[1].line, r[1].character);
                                } else if (r && r.start && r.end) {
                                    return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                                } else if (r && typeof r.line === 'number') {
                                     // Handle single position? No, Range is two positions.
                                     // Maybe it's just {line, character} repeated? No.
                                     return new vscode.Range(r.line, r.character, r.line, r.character);
                                }
                                return new vscode.Range(0, 0, 0, 0);
                            };

                            const range = parseRange(savedRoot.range);
                            const selectionRange = parseRange(savedRoot.selectionRange);
                            
                            this.currentRoot = new vscode.CallHierarchyItem(savedRoot.kind, savedRoot.name, savedRoot.detail, uri, range, selectionRange);
                            
                            this.webviewProvider.postMessage({ command: 'setDirection', direction: this.direction });
                            this.refresh();
                        } catch (e) {
                            console.warn('[Source Window] Failed to restore last root', e);
                            this.webviewProvider.postMessage({ command: 'setDirection', direction: this.direction });
                        }
                    } else {
                        this.webviewProvider.postMessage({ command: 'setDirection', direction: this.direction });
                    }
                }
                break;
            case 'preview':
                await this.handleJump(message.uri, message.range, true);
                break;
            case 'loadMoreRelation':
                this.loadMoreReferences();
                break;
            case 'lookupReference':
                if (this.referenceController) {
                    // If we have a valid item, use it. Otherwise use current root.
                    // The message should contain the item to lookup.
                    // If message.item is provided, use it.
                    // If not, use currentRoot.
                    
                    let target: vscode.CallHierarchyItem | undefined;
                    
                    if (message.item) {
                        // Reconstruct CallHierarchyItem from message.item
                        // We need to find it in cache or reconstruct
                        // RelationItem has uri and range.
                        const item = message.item as RelationItem;
                        // We need to find the original CallHierarchyItem or create one.
                        // Since we don't have the full CallHierarchyItem easily available for children without cache,
                        // we might need to rely on cache.
                        
                        const cached = this.itemCache.get(item.id);
                        if (cached) {
                            target = cached;
                        } else {
                            // Try to reconstruct
                            // We need detail, kind, etc.
                            // But ReferenceController.findReferences takes uri and position.
                            // So we don't strictly need CallHierarchyItem.
                            // ReferenceController.findReferences(uri, position)
                        }
                        
                        if (target) {
                            this.referenceController.findReferences(target.uri, target.selectionRange.start);
                        } else if (item.uri && item.selectionRange) {
                             this.referenceController.findReferences(vscode.Uri.parse(item.uri), new vscode.Position(item.selectionRange.start.line, item.selectionRange.start.character));
                        }
                    } else if (this.currentRoot && typeof this.currentRoot !== 'string') {
                        this.referenceController.findReferences(this.currentRoot.uri, this.currentRoot.selectionRange.start);
                    }
                } else {
                    vscode.window.showInformationMessage('Reference Window is disabled.');
                }
                break;
        }
    }



    public async jumpToDefinition(item: { targetUri: string; targetRange?: any; targetSelectionRange?: any }) {
        if (!item.targetUri) {
            return;
        }
        
        // Use targetSelectionRange if available, otherwise targetRange
        const rangeToUse = item.targetSelectionRange || item.targetRange;
        if (!rangeToUse) {
            return;
        }

        await this.handleJump(item.targetUri, rangeToUse, false);
    }

    private async handleJump(uriStr: string, range: any, preserveFocus: boolean) {
        // Set jump flag to suppress next auto-sync
        this.isJumping = true;
        if (this.jumpTimeout) {
            clearTimeout(this.jumpTimeout);
        }
        this.jumpTimeout = setTimeout(() => {
            this.isJumping = false;
        }, 1000); // 1s safety timeout

        if (uriStr && range) {
            const uri = vscode.Uri.parse(uriStr);
            let start: vscode.Position;
            let end: vscode.Position;

            if (Array.isArray(range)) {
                start = new vscode.Position(range[0].line, range[0].character);
                end = new vscode.Position(range[1].line, range[1].character);
            } else {
                // Assume object with start/end or line/character properties
                // vscode.Range serialization might be {start: {line, character}, end: {line, character}}
                // or {line, character} (if it's a Position?) - no, range is Range.
                if (range.start && range.end) {
                    start = new vscode.Position(range.start.line, range.start.character);
                    end = new vscode.Position(range.end.line, range.end.character);
                } else if (range[0]) {
                     // Fallback for array-like object
                    start = new vscode.Position(range[0].line, range[0].character);
                    end = new vscode.Position(range[1].line, range[1].character);
                } else {
                    // Fallback or error
                    console.error('[Source Window] Invalid range format', range);
                    return;
                }
            }
            
            const vscodeRange = new vscode.Range(start, end);

            // Use selectionRange if available for better highlighting?
            // But range passed here is usually the target range.
            // User wants: "無論 root node 還是 children，選取的都是 selection_range"
            // But handleJump receives 'range'. We need to ensure 'range' passed from UI IS the selectionRange.
            // Or we can pass both and prefer selectionRange.
            // Currently UI passes item.range (or item.selectionRange?).
            // Let's check UI code or just assume we should use selectionRange if passed.
            // But wait, handleJump signature is (uriStr, range).
            // If we want to force selectionRange, we should ensure the caller passes selectionRange.
            
            // However, for Root Node double click behavior:
            // The Root Node in UI has 'range' and 'selectionRange'.
            // If user double clicks, UI sends 'jump' command with 'range'.
            // We should change UI to send 'selectionRange' if available.
            
            // But if we can't change UI easily right now, we can try to find the item in cache?
            // No, jump might come from history or anywhere.
            
            // Let's look at toRelationItem. It sets range=item.range, selectionRange=item.selectionRange.
            // In UI (RelationTree.tsx/RelationItemView.tsx), what is sent?
            // Usually it sends item.range.
            
            // If we want to fix this in Controller:
            // We can't easily know if 'range' is full range or selection range just by looking at it.
            // But we can change toRelationItem to SWAP them? No that's dangerous.
            
            // Best fix: Ensure UI sends selectionRange for jump.
            // But wait, user said "root node 的選取範圍會用 symbol 的 range 而非 selection_range".
            // This implies when we showTextDocument, we are selecting the whole function body (range) instead of just the name (selectionRange).
            
            // If we want to fix this here:
            // We can try to use selectionRange if we have the item in cache?
            // But handleJump is generic.
            
            // Let's assume we fix it by ensuring the range passed to showTextDocument IS the selectionRange.
            // If the caller passed the full range, we can't "shrink" it to selectionRange without parsing.
            
            // So we must ensure the caller (UI or internal logic) passes the correct range.
            // In 'resolveHierarchy', we set currentRoot.
            // When we render, we send RelationItem.
            
            // Let's look at 'onCursorMove' -> 'sync'.
            // sync calls 'updateView'.
            // updateView sends 'relationRoot'.
            // relationRoot has 'range' and 'selectionRange'.
            
            // If the user double clicks the root node in the tree:
            // The tree view sends a command.
            // If the tree view uses 'item.range' for the command payload, that's the issue.
            
            // But wait, the user also said: "有時候剛開啟或者跳轉去別的 activity bar工具再回來，游标点击 symbol 后，relation window 會沒去抓游标位置的内容并作动"
            // This sounds like onDidChangeTextEditorSelection is not firing or we are ignoring it.
            // We have 'if (this.isLocked) return;' and 'if (this.isJumping) return;'.
            // Maybe isJumping gets stuck? We have a timeout.
            // Or maybe the event doesn't fire when switching focus back?
            // When switching back to editor, onDidChangeTextEditorSelection might not fire if selection didn't change.
            // We should also listen to onDidChangeActiveTextEditor.
            
            await vscode.window.showTextDocument(uri, {
                selection: vscodeRange,
                preserveFocus: preserveFocus,
                preview: true
            });
        }
    }

    private onEditorChange(editor: vscode.TextEditor | undefined) {
        if (!this.webviewProvider.isVisible()) {
            return;
        }

        if (editor && !this.isLocked && !this.isJumping) {
            const config = vscode.workspace.getConfiguration('relationWindow');
            if (config.get<boolean>('autoSearch', false)) {
                // Use the same debounce logic as onCursorMove
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                }

                // Cancel previous operation
                if (this.cancellationTokenSource) {
                    this.cancellationTokenSource.cancel();
                    this.cancellationTokenSource.dispose();
                    this.cancellationTokenSource = undefined;
                }

                this.debounceTimer = setTimeout(() => {
                    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor === editor) {
                        this.sync(editor.document.uri, editor.selection.active);
                    }
                }, 1000);
            }
        }
    }

    private onCursorMove(event: vscode.TextEditorSelectionChangeEvent) {
        if (!this.webviewProvider.isVisible()) {
            return;
        }

        if (this.isLocked) {
            return;
        }

        if (this.isJumping) {
            return;
        }

        const config = vscode.workspace.getConfiguration('relationWindow');
        if (!config.get<boolean>('autoSearch', false)) {
            return;
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Cancel previous operation
        if (this.cancellationTokenSource) {
            this.cancellationTokenSource.cancel();
            this.cancellationTokenSource.dispose();
            this.cancellationTokenSource = undefined;
        }

        this.debounceTimer = setTimeout(() => {
            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor === event.textEditor) {
                this.sync(event.textEditor.document.uri, event.textEditor.selection.active);
            }
        }, 1000);
    }

    public async refresh() {
        await vscode.commands.executeCommand('relation-window-view.focus');
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await this.sync(editor.document.uri, editor.selection.active, true);
        } else if (this.currentRoot) {
            const requestId = ++this.nextRequestId;
            // Clear deep search on refresh
            
            if (typeof this.currentRoot !== 'string') {
                // Re-fetch children for current root
                const rootId = uuidv4();
                this.itemCache.clear();
                this.itemCache.set(rootId, this.currentRoot);
                const relationRoot = this.toRelationItem(this.currentRoot, rootId);
                
                // Use parallel
                if (this.cancellationTokenSource) {
                    this.cancellationTokenSource.cancel();
                    this.cancellationTokenSource.dispose();
                }
                this.cancellationTokenSource = new vscode.CancellationTokenSource();
                const token = this.cancellationTokenSource.token;
                
                this.webviewProvider.postMessage({ command: 'setLoading', isLoading: true });
                
                // Clear view initially to ensure UI updates even if no results found
                this.updateView(relationRoot, [], requestId);

                const config = vscode.workspace.getConfiguration('relationWindow');
                const showBoth = config.get<boolean>('showBothDirections', false);

                if (showBoth) {
                    const incomingNode: RelationItem = {
                        id: uuidv4(),
                        name: 'INCOMING CALLS (CALLERS)',
                        detail: '',
                        kind: vscode.SymbolKind.Interface,
                        uri: '',
                        range: new vscode.Range(0, 0, 0, 0),
                        selectionRange: new vscode.Range(0, 0, 0, 0),
                        hasChildren: true,
                        children: [],
                        isCategory: true,
                        direction: 'incoming'
                    };
                    const outgoingNode: RelationItem = {
                        id: uuidv4(),
                        name: 'OUTGOING CALLS (CALLEES)',
                        detail: '',
                        kind: vscode.SymbolKind.Interface,
                        uri: '',
                        range: new vscode.Range(0, 0, 0, 0),
                        selectionRange: new vscode.Range(0, 0, 0, 0),
                        hasChildren: true,
                        children: [],
                        isCategory: true,
                        direction: 'outgoing'
                    };

                    const fetchAndPopulate = async (dir: 'incoming' | 'outgoing', node: RelationItem) => {
                        await this.fetchChildrenParallel(this.currentRoot as vscode.CallHierarchyItem, dir, token, (children) => {
                            node.children = children;
                            node.hasChildren = children.length > 0;
                            this.updateView(relationRoot, [incomingNode, outgoingNode], requestId);
                        }, true);
                    };

                    const t1 = fetchAndPopulate('incoming', incomingNode);
                    const t2 = fetchAndPopulate('outgoing', outgoingNode);
                    
                    await Promise.all([t1, t2]);
                    this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });
                    // Ensure view is updated with categories even if empty
                    this.updateView(relationRoot, [incomingNode, outgoingNode], requestId);
                } else {
                    await this.fetchChildrenParallel(this.currentRoot, this.direction, token, (children) => {
                        this.updateView(relationRoot, children, requestId);
                    });
                }
            } else {
                // String fallback refresh
                const entry = this.internalHistory[this.historyIndex];
                if (entry && entry.context) {
                    const refs = await this.model.getReferences(entry.context.uri, entry.context.range.start);
                    
                    // Pagination init
                    this.cachedReferences = refs;
                    this.loadedReferencesCount = 100;
                    const children = this.locationsToRelationItems(refs.slice(0, 100));
                    if (refs.length > 100) {
                        children.push(this.createLoadMoreItem());
                    }

                    const relationRoot: RelationItem = {
                        id: 'root',
                        name: entry.root as string,
                        detail: 'References',
                        kind: vscode.SymbolKind.String,
                        uri: entry.context.uri.toString(),
                        range: entry.context.range,
                        selectionRange: entry.context.range,
                        children: [],
                        hasChildren: children.length > 0
                    };
                    this.currentRelationRoot = relationRoot;
                    this.updateView(relationRoot, children, requestId);
                }
            }
        }
    }

    private async sync(uri: vscode.Uri, position: vscode.Position, isManual: boolean = false) {
        const requestId = ++this.nextRequestId;
        
        // Cancel previous
        if (this.cancellationTokenSource) {
            this.cancellationTokenSource.cancel();
            this.cancellationTokenSource.dispose();
        }
        this.cancellationTokenSource = new vscode.CancellationTokenSource();
        const token = this.cancellationTokenSource.token;

        this.webviewProvider.postMessage({ command: 'setLoading', isLoading: true });

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Fetching Relation Hierarchy...'
        }, async (progress) => {
            try {
                // 1. Try Call Hierarchy
                let rootItem = await this.model.prepareCallHierarchy(uri, position);

                // Check if LSP returned the container instead of the target (Caller vs Callee fix)
                const doc = await vscode.workspace.openTextDocument(uri);
                const wordRange = doc.getWordRangeAtPosition(position);
                const word = wordRange ? doc.getText(wordRange) : '';
                
                if (rootItem && word && rootItem.name !== word) {
                     // A. Try to find definition of the word to get the REAL Call Hierarchy item (LSP compatible)
                     const defLoc = await this.model.getDefinition(uri, position);
                     if (defLoc) {
                         const defItem = await this.model.prepareCallHierarchy(defLoc.uri, defLoc.range.start);
                         if (defItem && (defItem.name === word || defItem.name.includes(word))) {
                             rootItem = defItem;
                         }
                     }

                     // B. If still no match (or no definition found), try DB/Deep search lookup
                     if (!rootItem || (rootItem.name !== word && !rootItem.name.includes(word))) {
                        const dbItem = await this.model.findSymbolAtLocation(uri, position);
                        if (dbItem && dbItem.name === word) {
                            rootItem = dbItem;
                        }
                     }
                }

                // 2. Fallback: Try DB lookup if Call Hierarchy failed
                if (!rootItem) {
                    rootItem = await this.model.findSymbolAtLocation(uri, position);
                }

                if (token.isCancellationRequested) {return;}

                if (rootItem) {
                    // Stability Check
                    if (!isManual && this.isSameRoot(rootItem)) {
                        this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });
                        return;
                    }

                    // New valid symbol
                    this.currentRoot = rootItem;
                    this.itemCache.clear();
                    
                    // Cache root
                    const rootId = uuidv4();
                    this.itemCache.set(rootId, rootItem);

                    const relationRoot = this.toRelationItem(rootItem, rootId);
                    
                    // Push to history
                    this.pushHistory(rootItem, rootItem.name);

                    // Initial fetch of children (Parallel)
                    let hasCommitted = false;
                    if (isManual) {
                        hasCommitted = true;
                        this.updateView(relationRoot, [], requestId);
                    }

                    const config = vscode.workspace.getConfiguration('relationWindow');
                    const showBoth = config.get<boolean>('showBothDirections', false);

                    if (showBoth) {
                        // Create category nodes
                        const incomingNode: RelationItem = {
                            id: uuidv4(),
                            name: 'INCOMING CALLS (CALLERS)',
                            detail: '',
                            kind: vscode.SymbolKind.Interface, // Or any other icon
                            uri: '',
                            range: new vscode.Range(0, 0, 0, 0),
                            selectionRange: new vscode.Range(0, 0, 0, 0),
                            hasChildren: true,
                            children: [],
                            isCategory: true,
                            direction: 'incoming'
                        };
                        const outgoingNode: RelationItem = {
                            id: uuidv4(),
                            name: 'OUTGOING CALLS (CALLEES)',
                            detail: '',
                            kind: vscode.SymbolKind.Interface,
                            uri: '',
                            range: new vscode.Range(0, 0, 0, 0),
                            selectionRange: new vscode.Range(0, 0, 0, 0),
                            hasChildren: true,
                            children: [],
                            isCategory: true,
                            direction: 'outgoing'
                        };

                        // We need to cache these virtual items so resolveHierarchy can find them?
                        // No, resolveHierarchy uses itemCache. If user expands these nodes, we need to handle it.
                        // But here we want to pre-fetch them?
                        // User said "results will be simultaneously on Relation window".
                        // So we should fetch and populate them.
                        
                        // We can't use fetchChildrenParallel directly because it calls updateView with root's children.
                        // We need to manually run fetch logic and update the category nodes.
                        
                        // Let's define a helper
                        const fetchAndPopulate = async (dir: 'incoming' | 'outgoing', node: RelationItem) => {
                            return this.fetchChildrenParallel(rootItem, dir, token, (children) => {
                                node.children = children;
                                node.hasChildren = children.length > 0;
                                // Update view with the two category nodes
                                this.webviewProvider.postMessage({
                                    command: 'updateNode',
                                    itemId: node.id,
                                    children: children
                                });
                            }, true); // Pass true to suppress setLoading(false) inside
                        };

                        relationRoot.children = [incomingNode, outgoingNode];
                        relationRoot.hasChildren = true;
                        this.updateView(relationRoot, relationRoot.children, requestId);

                        const t1 = fetchAndPopulate('incoming', incomingNode);
                        const t2 = fetchAndPopulate('outgoing', outgoingNode);
                        
                        const [incomingResults, outgoingResults] = await Promise.all([t1, t2]);
                        
                        // Filter out empty categories
                        const newChildren: RelationItem[] = [];
                        if (incomingResults.length > 0) {
                            newChildren.push(incomingNode);
                        }
                        if (outgoingResults.length > 0) {
                            newChildren.push(outgoingNode);
                        }
                        
                        relationRoot.children = newChildren;
                        
                        // Update Root Children
                        this.webviewProvider.postMessage({
                            command: 'updateNode',
                            itemId: relationRoot.id,
                            children: newChildren
                        });

                        this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });

                        if (!hasCommitted) {
                            hasCommitted = true;
                            this.currentRoot = rootItem;
                            // Save state...
                            this.context.workspaceState.update('relationWindow.lastRoot', {
                                uri: rootItem.uri.toString(),
                                range: rootItem.range,
                                selectionRange: rootItem.selectionRange,
                                name: rootItem.name,
                                detail: rootItem.detail,
                                kind: rootItem.kind
                            });
                            this.itemCache.clear();
                            this.itemCache.set(rootId, rootItem);
                            // Also cache the category nodes? No, they are virtual.
                            // But if user expands a child of category, it works fine.
                            // If user collapses and expands category node?
                            // The tree view handles expansion if children are provided.
                            // If we provide children, it's fine.
                        }

                    } else {
                        await this.fetchChildrenParallel(rootItem, this.direction, token, (children) => {
                            if (!hasCommitted) {
                                if (children.length > 0) {
                                    hasCommitted = true;
                                    this.currentRoot = rootItem;
                                    
                                    // Save to state
                                    this.context.workspaceState.update('relationWindow.lastRoot', {
                                        uri: rootItem.uri.toString(),
                                        range: rootItem.range,
                                        selectionRange: rootItem.selectionRange,
                                        name: rootItem.name,
                                        detail: rootItem.detail,
                                        kind: rootItem.kind
                                    });

                                    this.itemCache.clear();
                                    this.itemCache.set(rootId, rootItem);
                                    this.updateView(relationRoot, children, requestId);
                                }
                            } else {
                                this.updateView(relationRoot, children, requestId);
                            }
                        });
                        this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });
                    }
                    
                    if (!hasCommitted && isManual) {
                         // If manual trigger and no results found, maybe show message?
                         vscode.window.showInformationMessage('No relations found.');
                    }
                    
                } else {
                    // Call Hierarchy failed
                    if (isManual) {
                        vscode.window.showInformationMessage('No call hierarchy information available for this symbol.');
                    }
                    this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });
                }
            } catch (e) {
                console.error('[Source Window] Sync failed', e);
                this.webviewProvider.postMessage({ command: 'error', message: 'Failed to sync relation' });
                this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });
            }
        });
    }

    private isSameRoot(newItem: vscode.CallHierarchyItem): boolean {
        if (typeof this.currentRoot === 'string' || !this.currentRoot) {
            return false;
        }
        return this.currentRoot.uri.toString() === newItem.uri.toString() &&
               this.currentRoot.range.isEqual(newItem.range);
    }

    private async resolveHierarchy(itemId: string, direction: 'incoming' | 'outgoing') {
        const item = this.itemCache.get(itemId);
        if (item) {
            // Cancel any existing expansion for this node
            if (this.nodeExpansionTokens.has(itemId)) {
                this.nodeExpansionTokens.get(itemId)?.cancel();
                this.nodeExpansionTokens.get(itemId)?.dispose();
            }

            const cts = new vscode.CancellationTokenSource();
            this.nodeExpansionTokens.set(itemId, cts);
            const token = cts.token;

            this.webviewProvider.postMessage({ command: 'setLoading', isLoading: true });

            try {
                const childrenMap = new Map<string, RelationItem>();
                
                const update = (newItems: RelationItem[]) => {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    let changed = false;
                    for (const newItem of newItems) {
                        const uriKey = newItem.targetUri || newItem.uri;
                        const key = `${uriKey}:${newItem.range.start.line}:${newItem.range.start.character}`;
                        const existing = childrenMap.get(key);
                        
                        if (!existing) {
                            childrenMap.set(key, newItem);
                            changed = true;
                        } else if (existing.isDeepSearch && !newItem.isDeepSearch) {
                            // Upgrade to LSP item if available
                            childrenMap.set(key, newItem);
                            changed = true;
                        }
                    }
                    
                    if (changed) {
                        this.webviewProvider.postMessage({
                            command: 'updateNode',
                            itemId: itemId,
                            children: Array.from(childrenMap.values())
                        });
                    }
                };

                // Task A: LSP
                const lspTask = this.fetchChildrenLsp(item, direction, token).then(children => {
                    update(children);
                });

                // Task B: Deep Search
                const deepSearchTask = this.fetchChildrenDeep(item, direction, token).then(children => {
                    update(children);
                });

                await Promise.allSettled([lspTask, deepSearchTask]);
            } finally {
                this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });

                // Cleanup token if it's still the current one
                if (this.nodeExpansionTokens.get(itemId) === cts) {
                    this.nodeExpansionTokens.delete(itemId);
                    cts.dispose();
                }
            }
        }
    }

    private async fetchChildrenParallel(
        item: vscode.CallHierarchyItem, 
        direction: 'incoming' | 'outgoing', 
        token: vscode.CancellationToken,
        onUpdate: (children: RelationItem[]) => void,
        suppressLoading: boolean = false
    ): Promise<RelationItem[]> {
        const childrenMap = new Map<string, RelationItem>();
        
        const update = (newItems: RelationItem[]) => {
            let changed = false;
            for (const newItem of newItems) {
                // Key based on Call Site (Source URI + Range)
                // For incoming: Source is the caller (newItem.uri)
                // For outgoing: Source is the current root (item.uri) but we need to distinguish call sites.
                // newItem.range is the call site range.
                
                let key = '';
                if (direction === 'incoming') {
                    key = `${newItem.uri}:${newItem.range.start.line}:${newItem.range.start.character}`;
                } else {
                    // Outgoing: All items are in the same file (root item's file), but at different ranges
                    // We use the range to distinguish them.
                    // Note: newItem.uri for outgoing is the Call Site URI (which is item.uri)
                    
                    // FIX: Include Target URI/Range to allow multiple definitions for the same call site (Ambiguity)
                    const targetKey = newItem.targetUri ? `${newItem.targetUri}:${newItem.targetRange?.start.line}` : 'unknown';
                    key = `${newItem.uri}:${newItem.range.start.line}:${newItem.range.start.character}|${targetKey}`;
                }

                const existing = childrenMap.get(key);
                
                if (!existing) {
                    childrenMap.set(key, newItem);
                    changed = true;
                } else {
                    // Merge Logic
                    if (newItem.isDeepSearch) {
                        // New item is Deep Search
                        if (!existing.isDeepSearch) {
                            // Existing is LSP -> Use Deep Search Range (more precise) but keep LSP Target
                            existing.range = newItem.range;
                            changed = true;
                        }
                        // If existing is also Deep Search, ignore
                    } else {
                        // New item is LSP
                        if (existing.isDeepSearch) {
                            // Existing is Deep Search -> Verify it!
                            existing.isDeepSearch = false; // Remove special background
                            existing.targetUri = newItem.targetUri; // Update definition target
                            existing.targetRange = newItem.targetRange; // Update definition range
                            existing.targetSelectionRange = newItem.targetSelectionRange; // Update definition selection range
                            // Keep existing.range (Deep Search range)
                            changed = true;
                        }
                        // If existing is also LSP, ignore
                    }
                }
            }
            
            if (changed) {
                onUpdate(Array.from(childrenMap.values()));
            }
        };

        // Task A: LSP
        const lspTask = this.fetchChildrenLsp(item, direction, token).then(children => {
            if (token.isCancellationRequested) {return;}
            update(children);
        });

        // Task B: Deep Search
        const deepSearchTask = this.fetchChildrenDeep(item, direction, token).then(children => {
            if (token.isCancellationRequested) {return;}
            update(children);
        });

        // Wait for both
        await Promise.allSettled([lspTask, deepSearchTask]);

        if (token.isCancellationRequested) {return [];}
        
        if (!suppressLoading) {
            this.webviewProvider.postMessage({ command: 'setLoading', isLoading: false });
        }

        return Array.from(childrenMap.values());
    }

    private getCleanName(name: string): string {
        const match = name.match(/[a-zA-Z0-9_]+/);
        return match ? match[0] : name;
    }

    private async fetchChildrenLsp(item: vscode.CallHierarchyItem, direction: 'incoming' | 'outgoing', token?: vscode.CancellationToken): Promise<RelationItem[]> {
        if (token?.isCancellationRequested) {return [];}
        
        const results: RelationItem[] = [];
        
        // Determine which filter to use
        let activeFilter = this.currentFilter;
        if (this.context.workspaceState.get('relationWindow.showBothDirections')) {
            activeFilter = direction === 'incoming' ? this.incomingFilter : this.outgoingFilter;
        }

        if (direction === 'incoming') {
            const calls = await this.model.getIncomingCalls(item);
            if (token?.isCancellationRequested) {return [];}
            
            // Deduplicate by unique key (uri + range)
            const uniqueItems = new Map<string, RelationItem>();

            let processCount = 0;
            for (const call of calls) {
                // Filter by kind
                if (activeFilter.length > 0 && !activeFilter.includes(call.from.kind)) {
                    continue;
                }

                for (const range of call.fromRanges) {
                    processCount++;
                    if (processCount % 500 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }

                    const key = `${call.from.uri.toString()}:${range.start.line}:${range.start.character}`;
                    if (!uniqueItems.has(key)) {
                        const subId = uuidv4();
                        this.itemCache.set(subId, call.from);
                        const { name, detail, path } = this.formatItemInfo(call.from.name, call.from.detail || '', call.from.kind, call.from.uri, range.start.line);
                        uniqueItems.set(key, {
                            id: subId,
                            name: name,
                            detail: detail,
                            path: path,
                            kind: call.from.kind,
                            uri: call.from.uri.toString(),
                            range: range,
                            selectionRange: call.from.selectionRange,
                            hasChildren: true
                        });
                    }
                }
            }
            
            const results = Array.from(uniqueItems.values());
            
            // Sort: Root name match first
            let rootName = '';
            if (this.currentRoot && typeof this.currentRoot !== 'string') {
                rootName = this.currentRoot.name;
            }

            if (rootName) {
                const matches: RelationItem[] = [];
                const others: RelationItem[] = [];
                
                const cleanRootName = this.getCleanName(rootName);

                for (const item of results) {
                    const cachedItem = this.itemCache.get(item.id);
                    const name = cachedItem ? cachedItem.name : item.name;
                    const cleanName = this.getCleanName(name);
                    
                    if (cleanName === cleanRootName) {
                        matches.push(item);
                    } else {
                        others.push(item);
                    }
                }
                return [...matches, ...others];
            }

            return results;
        } else {
            const calls = await this.model.getOutgoingCalls(item);
            if (token?.isCancellationRequested) {return [];}

            // Group by Name -> Definition (URI+Range) -> Call Sites
            const grouped = new Map<string, Map<string, { call: vscode.CallHierarchyOutgoingCall, range: vscode.Range }[]>>();
            
            for (const call of calls) {
                if (activeFilter.length > 0 && !activeFilter.includes(call.to.kind)) { continue; }
                
                const name = call.to.name;
                if (!grouped.has(name)) { grouped.set(name, new Map()); }
                const defs = grouped.get(name)!;
                
                const defKey = `${call.to.uri.toString()}:${call.to.range.start.line}:${call.to.range.start.character}`;
                if (!defs.has(defKey)) { defs.set(defKey, []); }
                
                for (const range of call.fromRanges) {
                    defs.get(defKey)!.push({ call, range });
                }
            }
            
            for (const [name, defs] of grouped) {
                const defList = Array.from(defs.values());
                const isAmbiguous = defList.length > 1;
                
                defList.forEach((callSites, index) => {
                    const sitesToShow = this.currentSettings.removeDuplicate ? [callSites[0]] : callSites;
                    
                    for (const { call, range } of sitesToShow) {
                        const subId = uuidv4();
                        this.itemCache.set(subId, call.to);
                        
                        let pathUri = item.uri; // Call Site Source
                        let pathLine = range.start.line; // Call Site Line
                        
                        if (this.currentSettings.showDefinitionPath) {
                            pathUri = call.to.uri;
                            pathLine = call.to.range.start.line;
                        }
                        
                        const { name: fmtName, detail, path } = this.formatItemInfo(call.to.name, call.to.detail || '', call.to.kind, pathUri, pathLine, call.to.uri);
                        
                        let displayName = fmtName;
                        if (isAmbiguous) {
                            displayName = `${fmtName} (${index + 1}/${defList.length})`;
                        }
                        
                        results.push({
                            id: subId,
                            name: displayName,
                            detail: detail,
                            path: path,
                            kind: call.to.kind,
                            uri: item.uri.toString(), // Jump to Call Site
                            targetUri: call.to.uri.toString(),
                            targetRange: call.to.range,
                            targetSelectionRange: call.to.selectionRange,
                            range: range,
                            selectionRange: range,
                            hasChildren: true,
                            isDeepSearch: false
                        });
                    }
                });
            }

            // Sort: Root name match first
            let rootName = '';
            if (this.currentRoot && typeof this.currentRoot !== 'string') {
                rootName = this.currentRoot.name;
            }

            if (rootName) {
                const matches: RelationItem[] = [];
                const others: RelationItem[] = [];
                
                const cleanRootName = this.getCleanName(rootName);

                for (const item of results) {
                    const cachedItem = this.itemCache.get(item.id);
                    const name = cachedItem ? cachedItem.name : item.name;
                    const cleanName = this.getCleanName(name);
                    
                    if (cleanName === cleanRootName) {
                        matches.push(item);
                    } else {
                        others.push(item);
                    }
                }
                return [...matches, ...others];
            }
        }
        return results;
    }

    private async fetchChildrenDeep(item: vscode.CallHierarchyItem, direction: 'incoming' | 'outgoing', token?: vscode.CancellationToken): Promise<RelationItem[]> {
        const config = vscode.workspace.getConfiguration('relationWindow');
        if (!config.get<boolean>('enableDeepSearch', true)) {
            return [];
        }

        if (token?.isCancellationRequested) {return [];}
        
        let deepItems: RelationItem[] = [];
        
        // Determine which filter to use
        let activeFilter = this.currentFilter;
        if (this.context.workspaceState.get('relationWindow.showBothDirections')) {
            activeFilter = direction === 'incoming' ? this.incomingFilter : this.outgoingFilter;
        }

        if (direction === 'incoming') {
            const calls = await this.model.getDeepIncomingCalls(item, token, activeFilter);
            if (token?.isCancellationRequested) {return [];}
            deepItems = [];
            const uniqueItems = new Map<string, RelationItem>();

            for (const call of calls) {
                // Filter out self-references (where 'from' is the same as 'root item')
                // This prevents the root node from appearing as its own child
                if (call.from.uri.toString() === item.uri.toString() && 
                    call.from.range.start.line === item.range.start.line) {
                    continue;
                }

                for (const range of call.fromRanges) {
                    const key = `${call.from.uri.toString()}:${range.start.line}:${range.start.character}`;
                    if (uniqueItems.has(key)) {
                        continue;
                    }

                    const subId = uuidv4();
                    // We need to cache the item to support further navigation
                    this.itemCache.set(subId, call.from);
                    const { name, detail, path } = this.formatItemInfo(call.from.name, call.from.detail || '', call.from.kind, call.from.uri, range.start.line);
                    
                    uniqueItems.set(key, {
                        id: subId,
                        name: name,
                        detail: detail,
                        path: path,
                        kind: call.from.kind,
                        uri: call.from.uri.toString(),
                        range: range,
                        selectionRange: call.from.selectionRange,
                        hasChildren: true,
                        isDeepSearch: true
                    });
                }
            }
            deepItems = Array.from(uniqueItems.values());

            // Sort: Root name match first
            let rootName = '';
            if (this.currentRoot && typeof this.currentRoot !== 'string') {
                rootName = this.currentRoot.name;
            }

            if (rootName) {
                const matches: RelationItem[] = [];
                const others: RelationItem[] = [];
                
                const cleanRootName = this.getCleanName(rootName);

                for (const item of deepItems) {
                    const cachedItem = this.itemCache.get(item.id);
                    const name = cachedItem ? cachedItem.name : item.name;
                    const cleanName = this.getCleanName(name);
                    
                    if (cleanName === cleanRootName) {
                        matches.push(item);
                    } else {
                        others.push(item);
                    }
                }
                deepItems = [...matches, ...others];
            }
        } else {
            const calls = await this.model.getDeepOutgoingCalls(item, token, activeFilter);
            if (token?.isCancellationRequested) {return [];}

            // Group by token name to detect ambiguity
            const callsByName = new Map<string, DeepCall[]>();
            for (const call of calls) {
                // Use a unique key for the target definition to group identical definitions
                // (e.g. same file, same range)
                // But here we want to group by "Symbol Name" to show (1/n) for different definitions of same name.
                const name = call.to.name;
                if (!callsByName.has(name)) {
                    callsByName.set(name, []);
                }
                callsByName.get(name)!.push(call);
            }

            deepItems = [];
            
            for (const [name, group] of callsByName) {
                // Deduplicate targets
                const uniqueTargets = new Map<string, DeepCall>();
                for (const call of group) {
                    const key = `${call.to.uri.toString()}:${call.to.range.start.line}:${call.to.range.start.character}`;
                    if (!uniqueTargets.has(key)) {
                        uniqueTargets.set(key, call);
                    }
                }
                
                const distinctCalls = Array.from(uniqueTargets.values());
                const isAmbiguous = distinctCalls.length > 1;
                
                distinctCalls.forEach((call, index) => {
                    const sitesToShow = this.currentSettings.removeDuplicate ? [call.fromRanges[0]] : call.fromRanges;
                    
                    for (const range of sitesToShow) {
                        const subId = uuidv4();
                        this.itemCache.set(subId, call.to);
                        
                        let pathUri = item.uri; // Call Site Source
                        let pathLine = range.start.line; // Call Site Line
                        
                        if (this.currentSettings.showDefinitionPath) {
                            pathUri = call.to.uri;
                            pathLine = call.to.range.start.line;
                        }
                        
                        let { name: fmtName, detail, path } = this.formatItemInfo(call.to.name, call.to.detail || '', call.to.kind, pathUri, pathLine, call.to.uri);
                        
                        if (isAmbiguous) {
                            fmtName = `${fmtName} (${index + 1}/${distinctCalls.length})`;
                        }
                        
                        deepItems.push({
                            id: subId,
                            name: fmtName,
                            detail: detail,
                            path: path,
                            kind: call.to.kind,
                            uri: item.uri.toString(), // Jump to Call Site (Source)
                            targetUri: call.to.uri.toString(), // Definition Target
                            targetRange: call.to.range, // Definition Range
                            targetSelectionRange: call.to.selectionRange, // Definition Selection Range
                            range: range, // Call Site Range (Regex Token Range)
                            selectionRange: range, // Call Site Selection Range
                            hasChildren: true,
                            isDeepSearch: true // Unverified
                        });
                    }
                });
            }

            // Sort: Root name match first
            let rootName = '';
            if (this.currentRoot && typeof this.currentRoot !== 'string') {
                rootName = this.currentRoot.name;
            }

            if (rootName) {
                const matches: RelationItem[] = [];
                const others: RelationItem[] = [];
                
                const cleanRootName = this.getCleanName(rootName);

                for (const item of deepItems) {
                    const cachedItem = this.itemCache.get(item.id);
                    const name = cachedItem ? cachedItem.name : item.name;
                    const cleanName = this.getCleanName(name);
                    
                    if (cleanName === cleanRootName) {
                        matches.push(item);
                    } else {
                        others.push(item);
                    }
                }
                deepItems = [...matches, ...others];
            }
        }
        
        return deepItems;
    }

    private toRelationItem(item: vscode.CallHierarchyItem, id: string): RelationItem {
        const { name, detail, path } = this.formatItemInfo(item.name, item.detail || '', item.kind, item.uri, item.range.start.line);
        return {
            id: id,
            name: name,
            detail: detail,
            path: path,
            kind: item.kind,
            uri: item.uri.toString(),
            range: item.selectionRange, // Use selectionRange for navigation/highlighting
            selectionRange: item.selectionRange,
            hasChildren: true
        };
    }

    private locationsToRelationItems(locations: vscode.Location[]): RelationItem[] {
        return locations.map(loc => {
            const relativePath = vscode.workspace.asRelativePath(loc.uri);
            const filename = path.basename(loc.uri.fsPath);
            let location = '';
            if (relativePath === filename) {
                location = `${filename}:${loc.range.start.line + 1}`;
            } else {
                const dir = relativePath.substring(0, relativePath.length - filename.length - 1);
                location = `${filename} (${dir}):${loc.range.start.line + 1}`;
            }

            return {
                id: uuidv4(),
                name: filename,
                detail: '',
                path: location,
                kind: vscode.SymbolKind.File,
                uri: loc.uri.toString(),
                range: loc.range,
                selectionRange: loc.range,
                hasChildren: false,
                isRef: true
            };
        });
    }

    private updateView(root: RelationItem, children: RelationItem[], requestId?: number) {
        const config = vscode.workspace.getConfiguration('relationWindow');
        const showBoth = config.get<boolean>('showBothDirections', false);
        const autoExpandBoth = config.get<boolean>('autoExpandBothDirections', false);

        this.webviewProvider.postMessage({
            command: 'updateRelation',
            root: root,
            children: children,
            direction: this.direction,
            history: this.history,
            historyIndex: this.historyIndex,
            isLocked: this.isLocked,
            requestId: requestId,
            showBothDirections: showBoth,
            autoExpandBothDirections: autoExpandBoth
        });
    }

    private pushHistory(root: vscode.CallHierarchyItem | string, label: string, context?: { uri: vscode.Uri; range: vscode.Range }) {
        // If same as current top, don't push
        if (this.historyIndex >= 0 && this.historyIndex < this.internalHistory.length) {
            const current = this.internalHistory[this.historyIndex];
            
            let isSame = false;
            if (typeof root === 'string' && typeof current.root === 'string') {
                isSame = root === current.root;
            } else if (typeof root !== 'string' && typeof current.root !== 'string') {
                isSame = root.uri.toString() === current.root.uri.toString() && 
                         root.range.isEqual(current.root.range);
            }

            if (isSame) {
                return;
            }
        }

        // Truncate future
        if (this.historyIndex < this.internalHistory.length - 1) {
            this.internalHistory = this.internalHistory.slice(0, this.historyIndex + 1);
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        this.internalHistory.push({ root, label, context });
        this.history.push({ label, timestamp: Date.now() });

        // Limit to 20
        if (this.internalHistory.length > 20) {
            this.internalHistory.shift();
            this.history.shift();
        }
        this.historyIndex = this.internalHistory.length - 1;
    }

    public async navigateHistory(action: 'back' | 'forward' | 'pick', index?: number) {
        let targetIndex = this.historyIndex;
        if (action === 'back') {
            targetIndex--;
        } else if (action === 'forward') {
            targetIndex++;
        } else if (action === 'pick' && index !== undefined) {
            targetIndex = index;
        }

        if (targetIndex >= 0 && targetIndex < this.internalHistory.length) {
            const requestId = ++this.nextRequestId;
            this.historyIndex = targetIndex;
            const entry = this.internalHistory[targetIndex];
            
            if (typeof entry.root === 'string') {
                // Restore word fallback
                this.currentRoot = entry.root;
                this.itemCache.clear();

                if (entry.context) {
                    // Re-fetch references
                    const refs = await this.model.getReferences(entry.context.uri, entry.context.range.start);
                    
                    // Pagination init
                    this.cachedReferences = refs;
                    this.loadedReferencesCount = 100;
                    const children = this.locationsToRelationItems(refs.slice(0, 100));
                    if (refs.length > 100) {
                        children.push(this.createLoadMoreItem());
                    }
                    
                    const relationRoot: RelationItem = {
                        id: 'root',
                        name: entry.root,
                        detail: 'References',
                        kind: vscode.SymbolKind.String,
                        uri: entry.context.uri.toString(),
                        range: entry.context.range,
                        selectionRange: entry.context.range,
                        children: [],
                        hasChildren: children.length > 0
                    };
                    this.currentRelationRoot = relationRoot;
                    this.updateView(relationRoot, children, requestId);
                }
            } else {
                // Restore CallHierarchyItem
                this.currentRoot = entry.root;
                this.itemCache.clear();
                
                const rootId = uuidv4();
                this.itemCache.set(rootId, entry.root);
                
                const relationRoot = this.toRelationItem(entry.root, rootId);
                
                // Use parallel
                if (this.cancellationTokenSource) {
                    this.cancellationTokenSource.cancel();
                    this.cancellationTokenSource.dispose();
                }
                this.cancellationTokenSource = new vscode.CancellationTokenSource();
                const token = this.cancellationTokenSource.token;
                
                this.webviewProvider.postMessage({ command: 'setLoading', isLoading: true });
                await this.fetchChildrenParallel(entry.root, this.direction, token, (children) => {
                    this.updateView(relationRoot, children, requestId);
                });
            }
        }
    }

    public async toggleDirection() {
        this.direction = this.direction === 'incoming' ? 'outgoing' : 'incoming';
        this.context.workspaceState.update('relationWindow.direction', this.direction);
        this.webviewProvider.postMessage({ command: 'setDirection', direction: this.direction });
        if (this.currentRoot) {
            await this.refresh();
        }
    }

    public toggleLock() {
        this.isLocked = !this.isLocked;
        vscode.commands.executeCommand('setContext', 'relationWindow.isLocked', this.isLocked);
        // Optionally notify webview if it needs to show status
        this.webviewProvider.postMessage({ command: 'toggleLock', locked: this.isLocked });
    }



    private createLoadMoreItem(): RelationItem {
        return {
            id: 'load-more',
            name: 'Loading...',
            detail: '',
            kind: -1,
            uri: '',
            range: new vscode.Range(0, 0, 0, 0),
            selectionRange: new vscode.Range(0, 0, 0, 0),
            hasChildren: false,
            isLoadMore: true
        };
    }

    private loadMoreReferences() {
        if (this.cachedReferences.length > this.loadedReferencesCount && this.currentRelationRoot) {
            const requestId = ++this.nextRequestId;
            this.loadedReferencesCount += 100;
            const currentItems = this.locationsToRelationItems(this.cachedReferences.slice(0, this.loadedReferencesCount));
            
            if (this.cachedReferences.length > this.loadedReferencesCount) {
                currentItems.push(this.createLoadMoreItem());
            }
            
            this.updateView(this.currentRelationRoot, currentItems, requestId);
        }
    }

    private formatItemInfo(name: string, originalDetail: string, kind: vscode.SymbolKind, uri: vscode.Uri, line: number, symbolUri?: vscode.Uri): { name: string, detail: string, path: string } {
        const config = vscode.workspace.getConfiguration('symbolWindow');
        const mode = config.get<string>('symbolParsing.mode', 'auto');

        // Guess language from file extension
        const ext = uri.path.split('.').pop()?.toLowerCase() || '';
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

        // Filter out originalDetail if it looks like a file path
        // Use symbolUri if provided (the actual location of the symbol), otherwise use display uri
        const filterUri = symbolUri || uri;
        const filename = path.basename(filterUri.fsPath);
        const relativePath = vscode.workspace.asRelativePath(filterUri);
        const isPathInfo = originalDetail && (
            originalDetail.includes(filename) || 
            originalDetail.includes(relativePath) ||
            originalDetail.trim() === filename
        );

        const detailToParse = isPathInfo ? '' : originalDetail;

        const parser = parserRegistry.getParser(languageId, mode);
        const parsed = parser.parse(name, detailToParse, kind);
        
        let finalName = parsed.name;
        let finalDetail = parsed.detail;
        
        // Project Mode: filename (path):line
        // If relativePath is just filename, don't show (path)
        
        // Use display uri for location string
        const displayFilename = path.basename(uri.fsPath);
        const displayRelativePath = vscode.workspace.asRelativePath(uri);

        let location = '';
        if (displayRelativePath === displayFilename) {
            location = `${displayFilename}:${line + 1}`;
        } else {
            // Remove filename from relativePath to get dir
            const dir = displayRelativePath.substring(0, displayRelativePath.length - displayFilename.length - 1); // -1 for separator
            location = `${displayFilename} (${dir}):${line + 1}`;
        }

        return {
            name: finalName,
            detail: finalDetail,
            path: location
        };
    }
}
