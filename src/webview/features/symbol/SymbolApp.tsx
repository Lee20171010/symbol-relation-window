import React, { useState, useEffect, useCallback, useRef } from 'react';
import { VSCodeTextField } from '@vscode/webview-ui-toolkit/react';
import { SymbolItem, SymbolMode, WebviewMessage, Message } from '../../../shared/common/types';
import SymbolTree from './SymbolTree';
import FilterView from '../../components/FilterView';
import { vscode } from '../../vscode-api';
import { symbolKindNames } from '../../utils';
import '../../style.css';

const ALL_KINDS = Object.keys(symbolKindNames).map(Number);

const isSameRange = (r1: any, r2: any) => {
    if (!r1 || !r2) return false;
    if (Array.isArray(r1) && Array.isArray(r2)) {
         return r1[0].line === r2[0].line && r1[0].character === r2[0].character &&
                r1[1].line === r2[1].line && r1[1].character === r2[1].character;
    }
    if (r1.start && r2.start) {
         return r1.start.line === r2.start.line && r1.start.character === r2.start.character &&
                r1.end.line === r2.end.line && r1.end.character === r2.end.character;
    }
    return false;
};

const findSymbolByRange = (items: SymbolItem[], targetRange: any): SymbolItem | null => {
    for (const item of items) {
        if (isSameRange(item.range, targetRange)) {
            return item;
        }
        if (item.children) {
            const found = findSymbolByRange(item.children, targetRange);
            if (found) return found;
        }
    }
    return null;
};

const App: React.FC = () => {
    const savedState = vscode.getState() || {};
    const [mode, setMode] = useState<SymbolMode>(savedState.mode || 'current');
    const [query, setQuery] = useState(savedState.query || '');
    const [symbols, setSymbols] = useState<SymbolItem[]>([]);
    const [totalCount, setTotalCount] = useState<number>(0);
    const [selectedSymbol, setSelectedSymbol] = useState<SymbolItem | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [backendStatus, setBackendStatus] = useState<'ready' | 'loading' | 'timeout'>(
        (savedState.mode || 'current') === 'project' ? 'loading' : 'ready'
    );
    const [enableHighlighting, setEnableHighlighting] = useState(true);
    const [scopePath, setScopePath] = useState<string | undefined>(undefined);
    const [includePattern, setIncludePattern] = useState(savedState.includePattern || '');
    const [excludePattern, setExcludePattern] = useState(savedState.excludePattern || '');
    const [showDetails, setShowDetails] = useState(savedState.showDetails || false);
    const [indexingProgress, setIndexingProgress] = useState<number | null>(null);
    const [isDatabaseMode, setIsDatabaseMode] = useState(savedState.isDatabaseMode || false);
    const [currentFilter, setCurrentFilter] = useState<number[]>(savedState.currentFilter || ALL_KINDS);
    const [projectFilter, setProjectFilter] = useState<number[]>(savedState.projectFilter || ALL_KINDS);
    const [showFilterView, setShowFilterView] = useState(false);
    
    const searchInputRef = useRef<any>(null);

    // Refs for accessing state in event listener
    const modeRef = useRef(mode);
    const queryRef = useRef(query);
    const includePatternRef = useRef(includePattern);
    const excludePatternRef = useRef(excludePattern);
    const symbolsRef = useRef(symbols);
    const projectFilterRef = useRef(projectFilter);

    useEffect(() => { modeRef.current = mode; }, [mode]);
    useEffect(() => { queryRef.current = query; }, [query]);
    useEffect(() => { includePatternRef.current = includePattern; }, [includePattern]);
    useEffect(() => { excludePatternRef.current = excludePattern; }, [excludePattern]);
    useEffect(() => { symbolsRef.current = symbols; }, [symbols]);
    useEffect(() => { projectFilterRef.current = projectFilter; }, [projectFilter]);

    // Save state
    useEffect(() => {
        vscode.setState({ mode, query, showDetails, includePattern, excludePattern, isDatabaseMode, currentFilter, projectFilter });
    }, [mode, query, showDetails, includePattern, excludePattern, isDatabaseMode, currentFilter, projectFilter]);

    // Handle messages from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data as Message;
            switch (message.command) {
                case 'updateSymbols':
                    setSymbols(message.symbols);
                    if (message.totalCount !== undefined) {
                        setTotalCount(message.totalCount);
                    }
                    setIsSearching(false);
                    break;
                case 'searchStart':
                    setIsSearching(true);
                    break;
                case 'setMode':
                    // Only clear if mode actually changes
                    if (modeRef.current !== message.mode) {
                        setMode(message.mode);
                        setQuery(''); // Clear query on mode toggle
                        setSymbols([]);
                        // Don't auto-set status here, rely on backend 'status' message
                    }
                    // If lockedMode is provided, we might want to store it or use it to hide UI elements
                    // But currently we rely on 'mode' being correct.
                    break;
                case 'status':
                    setBackendStatus(message.status);
                    break;
                case 'setQuery':
                    setQuery(message.query);
                    break;
                case 'setFilters':
                    // If backend sends filters (e.g. from workspaceState), update state
                    // But only if we don't have local changes? 
                    // Actually, backend is the source of truth for workspace persistence.
                    // If savedState is empty (first load), we might rely on this.
                    if (message.currentFilter) {
                        setCurrentFilter(message.currentFilter);
                    }
                    if (message.projectFilter) {
                        setProjectFilter(message.projectFilter);
                    }
                    break;
                case 'setSettings':
                    if (message.settings?.enableHighlighting !== undefined) {
                        setEnableHighlighting(message.settings.enableHighlighting);
                    }
                    break;
                case 'refresh':
                    if (modeRef.current === 'project') {
                        // Re-trigger search with current query
                        vscode.postMessage({ 
                            command: 'search', 
                            query: queryRef.current, 
                            includePattern: includePatternRef.current,
                            excludePattern: excludePatternRef.current,
                            kinds: projectFilterRef.current
                        });
                    }
                    break;
                case 'highlight':
                    // TODO: Implement highlight logic (expand tree and select)
                    break;
                case 'setScope':
                    setScopePath(message.scopePath);
                    break;
                case 'progress':
                    // @ts-ignore
                    setIndexingProgress(message.percent);
                    // @ts-ignore
                    if (message.percent >= 100) {
                        setIndexingProgress(null);
                    }
                    break;
                case 'setDatabaseMode':
                    // @ts-ignore
                    setIsDatabaseMode(message.enabled);
                    // If database mode is enabled, ensure we are in project mode if not already?
                    // No, user might be in current mode. But if in project mode, UI should update label.
                    if (message.enabled && modeRef.current === 'project') {
                        // Force re-render of title if needed, but React handles state change.
                    }
                    break;
                case 'appendSymbols':
                    // @ts-ignore
                    setSymbols(prev => [...prev, ...message.symbols]);
                    if (message.totalCount !== undefined) {
                        setTotalCount(message.totalCount);
                    }
                    setIsSearching(false);
                    break;
                case 'selectSymbol':
                    // @ts-ignore
                    const targetRange = message.range;
                    const found = findSymbolByRange(symbolsRef.current, targetRange);
                    if (found) {
                        setSelectedSymbol(found);
                    }
                    break;
                case 'focusInput':
                    // Use setTimeout to ensure the DOM is ready or to break the call stack
                    setTimeout(() => {
                        if (message.query) {
                            setQuery(message.query);
                            
                            // Emit search immediately
                            vscode.postMessage({ 
                                command: 'search', 
                                query: message.query, 
                                includePattern: includePatternRef.current,
                                excludePattern: excludePatternRef.current,
                                kinds: modeRef.current === 'project' ? projectFilterRef.current : undefined
                            });
                        }
                        
                        // Wait slightly for React to render the new value if any, then focus to select
                        setTimeout(() => {
                            if (searchInputRef.current) {
                                searchInputRef.current.focus();
                                
                                // To easily allow users to replace the query, we should select all of the text
                                const inputEl = searchInputRef.current.shadowRoot?.querySelector('input');
                                if (inputEl) {
                                    inputEl.select();
                                }
                            }
                        }, 50);
                    }, 0);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        
        // Notify extension that we are ready
        vscode.postMessage({ command: 'ready' });

        return () => window.removeEventListener('message', handleMessage);
    }, []);

    // Handle search input
    const handleSearch = (e: any) => {
        const newQuery = e.target.value;
        setQuery(newQuery);
        
        if (mode === 'project') {
            // Debounce is handled in backend or here? 
            // Spec says "Triggered only when the user types".
            // Let's send every keystroke and let backend debounce.
            vscode.postMessage({ 
                command: 'search', 
                query: newQuery, 
                includePattern: includePatternRef.current,
                excludePattern: excludePatternRef.current,
                kinds: projectFilterRef.current
            });
        }
    };

    const handleIncludePatternChange = (e: any) => {
        const newPattern = e.target.value;
        setIncludePattern(newPattern);
        
        if (mode === 'project' && query) {
            vscode.postMessage({ 
                command: 'search', 
                query: query, 
                includePattern: newPattern,
                excludePattern: excludePatternRef.current,
                kinds: projectFilterRef.current
            });
        }
    };

    const handleExcludePatternChange = (e: any) => {
        const newPattern = e.target.value;
        setExcludePattern(newPattern);
        
        if (mode === 'project' && query) {
            vscode.postMessage({ 
                command: 'search', 
                query: query, 
                includePattern: includePatternRef.current,
                excludePattern: newPattern,
                kinds: projectFilterRef.current
            });
        }
    };

    const handleIncludePatternKeyDown = (e: any) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIncludePattern('');
            if (mode === 'project' && query) {
                vscode.postMessage({ 
                    command: 'search', 
                    query: query, 
                    includePattern: '',
                    excludePattern: excludePatternRef.current,
                    kinds: projectFilterRef.current
                });
            }
        }
    };

    const handleExcludePatternKeyDown = (e: any) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setExcludePattern('');
            if (mode === 'project' && query) {
                vscode.postMessage({ 
                    command: 'search', 
                    query: query, 
                    includePattern: includePatternRef.current,
                    excludePattern: '',
                    kinds: projectFilterRef.current
                });
            }
        }
    };

    const handleFilterApply = (newSelection: number[]) => {
        setShowFilterView(false);
        
        // Save to workspace state via extension
        // We send both filters to keep them in sync
        const nextCurrent = mode === 'current' ? newSelection : currentFilter;
        const nextProject = mode === 'project' ? newSelection : projectFilter;
        
        vscode.postMessage({ 
            command: 'saveFilters', 
            currentFilter: nextCurrent,
            projectFilter: nextProject
        });

        if (mode === 'current') {
            setCurrentFilter(newSelection);
        } else {
            setProjectFilter(newSelection);
            // Trigger search immediately for project mode
            if (query) {
                vscode.postMessage({ 
                    command: 'search', 
                    query: query, 
                    includePattern: includePattern,
                    excludePattern: excludePattern,
                    kinds: newSelection
                });
            }
        }
    };

    // Handle jump
    const handleJump = (symbol: SymbolItem) => {
        // For current mode, double click selects the full range (start to end)
        // For project mode, double click jumps to selectionRange (the name)
        const range = mode === 'current' ? symbol.range : symbol.selectionRange;
        
        vscode.postMessage({ 
            command: 'jump', 
            uri: symbol.uri, 
            range: range 
        });
    };

    // Handle selection
    const handleSelect = (symbol: SymbolItem) => {
        setSelectedSymbol(symbol);
        
        // Send preview command for Context Window
        if (symbol.uri && symbol.selectionRange) {
            vscode.postMessage({ 
                command: 'preview', 
                uri: symbol.uri, 
                range: symbol.selectionRange 
            });
        }

        if (mode === 'current') {
            // Single click in current mode: jump to selectionRange (name)
            vscode.postMessage({ 
                command: 'jump', 
                uri: symbol.uri, 
                range: symbol.selectionRange 
            });
        }
    };

    // Handle keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Only handle navigation if not typing in an input (unless it's the search box and we want to support arrow keys there too)
            // Actually, usually we want arrow keys to work even if focused on search box to navigate the list.
            // But if the user is typing, ArrowLeft/Right should work in input. ArrowUp/Down usually navigate list.
            
            if (e.key === 'Escape') {
                // Clear search query if focused on search bar or generally if query exists
                if (queryRef.current.length > 0) {
                    e.preventDefault();
                    setQuery('');
                    vscode.postMessage({ command: 'search', query: '', includePattern: includePatternRef.current });
                }
                return;
            }

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const selectedEl = document.querySelector('.symbol-item.selected');
                const allItems = Array.from(document.querySelectorAll('.symbol-item'));
                
                if (allItems.length === 0) return;

                let nextIndex = 0;
                if (selectedEl) {
                    const currentIndex = allItems.indexOf(selectedEl);
                    if (e.key === 'ArrowDown') {
                        nextIndex = Math.min(currentIndex + 1, allItems.length - 1);
                    } else {
                        nextIndex = Math.max(currentIndex - 1, 0);
                    }
                } else {
                    // If nothing selected, select first
                    nextIndex = 0;
                }

                const nextEl = allItems[nextIndex] as HTMLElement;
                if (nextEl) {
                    nextEl.click();
                    nextEl.scrollIntoView({ block: 'nearest' });
                }
            } else if (e.key === 'Enter') {
                if (selectedSymbol) {
                    handleJump(selectedSymbol);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedSymbol]);

    // Filter symbols for Current Mode (Client-side)
    const displaySymbols = React.useMemo(() => {
        if (mode === 'project') {
            return symbols; // Backend handles filtering
        }
        
        // Filter by Kind first (if any filter is set)
        let filteredSymbols = symbols;
        
        // If filter is empty, show NOTHING (Scheme B)
        if (currentFilter.length === 0) {
            return [];
        }

        // If filter is NOT full (some unchecked), apply filter
        if (currentFilter.length < ALL_KINDS.length) {
            const filterByKind = (items: SymbolItem[]): SymbolItem[] => {
                const result: SymbolItem[] = [];
                for (const item of items) {
                    // Check if item matches kind
                    const match = currentFilter.includes(item.kind);
                    
                    // Process children
                    const filteredChildren = item.children ? filterByKind(item.children) : [];
                    
                    if (match) {
                        result.push({
                            ...item,
                            children: filteredChildren
                        });
                    } else if (filteredChildren.length > 0) {
                        // If parent doesn't match but child does, keep parent to show child
                        result.push({
                            ...item,
                            children: filteredChildren
                        });
                    }
                }
                return result;
            };
            filteredSymbols = filterByKind(symbols);
        }

        if (!query) return filteredSymbols;

        const lowerQuery = query.toLowerCase();
        const keywords = lowerQuery.split(/\s+/).filter((k: string) => k.length > 0);

        const filterTree = (items: SymbolItem[]): SymbolItem[] => {
            const result: SymbolItem[] = [];
            for (const item of items) {
                const match = keywords.every((k: string) => item.name.toLowerCase().includes(k));
                
                if (match) {
                    // If parent matches, include it and ALL its original children (no filtering on children)
                    // This allows users to expand the result and see members
                    // We don't force expand here, so user sees the match but not necessarily all children immediately
                    result.push({
                        ...item,
                        autoExpand: false
                    });
                } else {
                    // If parent doesn't match, check children
                    const filteredChildren = item.children ? filterTree(item.children) : [];
                    
                    if (filteredChildren.length > 0) {
                        result.push({
                            ...item,
                            children: filteredChildren,
                            autoExpand: true // Force expand because a child matched
                        });
                    }
                }
            }
            return result;
        };

        return filterTree(filteredSymbols);
    }, [symbols, query, mode, currentFilter]);

    // Auto-load more if content doesn't fill container
    useEffect(() => {
        if (mode === 'project' && symbols.length > 0 && symbols.length < totalCount) {
            const container = document.querySelector('.tree-container');
            if (container && container.scrollHeight <= container.clientHeight) {
                vscode.postMessage({ command: 'loadMore' });
            }
        }
    }, [symbols, mode, totalCount]);

    // Handle scroll for infinite loading
    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        if (mode === 'project') {
            const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
            // If scrolled to bottom (within 20px)
            if (scrollTop + clientHeight >= scrollHeight - 20) {
                vscode.postMessage({ command: 'loadMore' });
            }
        }
    };

    return (
        <div className={`container mode-${mode}`}>
            <div className={`indexing-progress-container ${indexingProgress !== null ? 'visible' : ''}`}>
                <div className="indexing-label">
                    <span className="codicon codicon-sync codicon-modifier-spin"></span>
                    <span>Indexing Symbols... {indexingProgress || 0}%</span>
                </div>
                <div className="indexing-progress">
                    {/* eslint-disable-next-line react/forbid-dom-props */}
                    <div className="indexing-progress-bar" style={{ width: `${indexingProgress || 0}%` }} />
                </div>
            </div>
            
            {isSearching && (
                <div className="progress-bar-container">
                    <div className="progress-bar"></div>
                </div>
            )}

            <div className="search-container">
                <div className="mode-indicator">
                    {mode === 'current' ? 'Current Document' : (isDatabaseMode ? 'Project Workspace (Database)' : 'Project Workspace')}
                </div>
                {backendStatus === 'loading' && (
                    <div className="status-warning">
                        <span className="codicon codicon-loading codicon-modifier-spin"></span>
                        {mode === 'project' && query ? 'Searching...' : 'Waiting for symbol provider...'}
                        {mode === 'project' && query && (
                            <span 
                                className="codicon codicon-close cancel-button" 
                                title="Cancel Search"
                                onClick={() => vscode.postMessage({ command: 'cancel' })}
                            ></span>
                        )}
                    </div>
                )}
                {backendStatus === 'timeout' && (
                    <div className="status-error">
                        <span className="codicon codicon-warning"></span>
                        Symbol provider not ready. Open a file to retry.
                    </div>
                )}
                <VSCodeTextField 
                    ref={searchInputRef}
                    placeholder={mode === 'current' ? "Filter symbols..." : "Search workspace..."}
                    value={query}
                    onInput={handleSearch}
                    style={{ width: '100%' }}
                    disabled={backendStatus === 'loading' || backendStatus === 'timeout'}
                >
                    <span slot="start" className="codicon codicon-search"></span>
                    <span 
                        slot="end" 
                        className={`codicon codicon-filter ${((mode === 'current' && currentFilter.length < ALL_KINDS.length) || (mode === 'project' && projectFilter.length < ALL_KINDS.length)) ? 'active' : ''}`}
                        onClick={() => setShowFilterView(true)}
                        title="Filter by Kind"
                        style={{ marginRight: '4px', cursor: 'pointer' }}
                    ></span>
                    {mode === 'project' && !isDatabaseMode && (
                        <span 
                            slot="end" 
                            className={`codicon codicon-kebab-vertical ${showDetails ? 'active' : ''}`}
                            onClick={() => setShowDetails(!showDetails)}
                            title="Toggle Search Details(DeepSearch)"
                        ></span>
                    )}
                </VSCodeTextField>
                
                {mode === 'project' && !isDatabaseMode && showDetails && (
                    <div className="search-details">
                        <div className="scope-control">
                            <span className="label">Scope:</span>
                            <span className="scope-path" title={scopePath || 'Workspace Root'}>
                                {scopePath ? scopePath.split(/[\\/]/).pop() : 'Workspace Root'}
                            </span>
                            <span 
                                className="codicon codicon-folder-opened action-icon" 
                                title="Select Folder"
                                onClick={() => vscode.postMessage({ command: 'selectScope' })}
                            ></span>
                            {scopePath && (
                                <span 
                                    className="codicon codicon-clear-all action-icon" 
                                    title="Clear Scope"
                                    onClick={() => vscode.postMessage({ command: 'clearScope' })}
                                ></span>
                            )}
                        </div>
                        <div className="include-pattern-container">
                            <span className="label">files to include</span>
                            <VSCodeTextField 
                                placeholder="e.g. *.ts, src/**/include"
                                value={includePattern}
                                onInput={handleIncludePatternChange}
                                onKeyDown={handleIncludePatternKeyDown}
                                className="include-pattern-input"
                            >
                                <span slot="start" className="codicon codicon-files"></span>
                            </VSCodeTextField>
                        </div>
                        <div className="include-pattern-container">
                            <span className="label">files to exclude</span>
                            <VSCodeTextField 
                                placeholder="e.g. *.ts, src/**/exclude"
                                value={excludePattern}
                                onInput={handleExcludePatternChange}
                                onKeyDown={handleExcludePatternKeyDown}
                                className="include-pattern-input"
                            >
                                <span slot="start" className="codicon codicon-files"></span>
                            </VSCodeTextField>
                        </div>
                    </div>
                )}
            </div>
            <div className="tree-container" onScroll={handleScroll}>
                {!isSearching && displaySymbols.length === 0 && query.length > 0 && (
                    <div className="no-results">No results found</div>
                )}
                <SymbolTree 
                    symbols={displaySymbols} 
                    onJump={handleJump}
                    onSelect={handleSelect}
                    selectedSymbol={selectedSymbol}
                    defaultExpanded={mode === 'current' ? !!query : false}
                    query={enableHighlighting ? query : undefined}
                />
            </div>
            
            {showFilterView && (
                <FilterView 
                    initialSelection={mode === 'current' ? currentFilter : projectFilter}
                    onApply={handleFilterApply}
                    onCancel={() => setShowFilterView(false)}
                />
            )}
        </div>
    );
};

export default App;
