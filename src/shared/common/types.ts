export interface SymbolItem {
    name: string;
    detail: string;
    kind: number; // vscode.SymbolKind
    range: any; // vscode.Range
    selectionRange: any; // vscode.Range
    children: SymbolItem[];
    uri?: string; // For workspace symbols
    containerName?: string;
    autoExpand?: boolean;
    isDeepSearch?: boolean;
    path?: string;
}

export type SymbolMode = 'current' | 'project';

export interface WebviewState {
    mode: SymbolMode;
    query: string;
    showDetails?: boolean;
    includePattern?: string;
    excludePattern?: string;
    currentFilter?: number[];
    projectFilter?: number[];
    isDatabaseMode?: boolean;
}

export type Message = 
    | { command: 'updateSymbols'; symbols: SymbolItem[]; totalCount?: number }
    | { command: 'highlight'; uri: string; range: any }
    | { command: 'setMode'; mode: SymbolMode; lockedMode?: SymbolMode }
    | { command: 'status'; status: 'ready' | 'loading' | 'timeout' }
    | { command: 'setQuery'; query: string }
    | { command: 'refresh' }
    | { command: 'searchStart' }
    | { command: 'setSettings'; settings: { enableHighlighting?: boolean } }
    | { command: 'setFilters'; currentFilter: number[]; projectFilter: number[] }
    | { command: 'setScope'; scopePath?: string }
    | { command: 'progress'; percent: number }
    | { command: 'setDatabaseMode'; enabled: boolean }
    | { command: 'appendSymbols'; symbols: SymbolItem[]; totalCount?: number }
    | { command: 'selectSymbol'; range: any }
    | { command: 'focusInput'; query?: string };

export type WebviewMessage =
    | { command: 'search'; query: string; includePattern?: string; excludePattern?: string; kinds?: number[] }
    | { command: 'jump'; uri?: string; range: any }
    | { command: 'ready' }
    | { command: 'loadMore' }
    | { command: 'deepSearch' }
    | { command: 'cancel' }
    | { command: 'selectScope' }
    | { command: 'clearScope' }
    | { command: 'resolveHierarchy'; itemId: string; direction: 'incoming' | 'outgoing' }
    | { command: 'setDirection'; direction: 'incoming' | 'outgoing' }
    | { command: 'refreshRelation' }
    | { command: 'saveFilters'; currentFilter: number[]; projectFilter: number[] }
    | { command: 'saveFilter'; filter: number[] }
    | { command: 'saveSettings'; settings: RelationSettings }
    | { command: 'toggleLock'; locked: boolean }
    | { command: 'navigateHistory'; action: 'back' | 'forward' | 'pick'; index?: number }
    | { command: 'loadMoreRelation' }
    | { command: 'preview'; uri?: string; range: any };

export interface RelationSettings {
    removeDuplicate: boolean;
    showDefinitionPath: boolean;
}

export interface RelationItem {
    id: string;
    name: string;
    detail: string;
    kind: number;
    uri: string;
    range: any;
    selectionRange: any;
    children?: RelationItem[];
    hasChildren?: boolean; // To show expander before fetching
    isRef?: boolean; // Is a reference (leaf node)
    isLoadMore?: boolean;
    isDeepSearch?: boolean;
    isCategory?: boolean;
    direction?: 'incoming' | 'outgoing';
    path?: string; // Display path for alignment
    targetUri?: string; // For deduplication of outgoing calls and Jump to Definition
    targetRange?: any; // For Jump to Definition
    targetSelectionRange?: any; // For Jump to Definition
}

export interface HistoryEntry {
    label: string;
    timestamp: number;
    // We don't pass the full VS Code object to webview, just enough to display
}

export type RelationMessage = 
    | { command: 'updateRelation'; root: RelationItem; children: RelationItem[]; direction: 'incoming' | 'outgoing'; history: HistoryEntry[]; historyIndex: number; isLocked: boolean; requestId?: number; showBothDirections?: boolean; autoExpandBothDirections?: boolean }
    | { command: 'updateNode'; itemId: string; children: RelationItem[] }
    | { command: 'setLoading'; isLoading: boolean }
    | { command: 'error'; message: string }
    | { command: 'setDirection'; direction: 'incoming' | 'outgoing' }
    | { command: 'setFilter'; filter: number[] }
    | { command: 'setFilters'; filter?: number[]; incomingFilter?: number[]; outgoingFilter?: number[] }
    | { command: 'setSettings'; settings: RelationSettings }
    | { command: 'refreshRelation' }
    | { command: 'toggleLock'; locked: boolean }
    | { command: 'navigateHistory'; action: 'back' | 'forward' | 'pick'; index?: number };
