import * as React from 'react';
import { vscode } from '../../vscode-api';
import ReferenceTree from './ReferenceTree';

interface Range {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface Location {
    uri: { fsPath: string; path: string; scheme: string; [key: string]: any };
    range: Range;
}

interface ReferenceItem {
    loc: Location;
    isDeep: boolean;
}

interface FileGroup {
    fsPath: string;
    filename: string;
    dir: string;
    items: ReferenceItem[];
    fileLines?: string[]; // We might need to fetch this or pass it. 
    // In the previous implementation, we read file content in the webview generation.
    // Now we are in React. We can't read files directly.
    // The controller should pass the preview text or we need to request it.
    // The previous implementation read files in `generateHtmlContent` which ran in the Extension Host (Node.js).
    // So the data passed to the webview MUST include the code preview.
}

// We need to update the Controller to pass code previews!
// Or we can pass the raw locations and let the webview ask for content? No, that's too many round trips.
// The controller should prepare the data: { uri, range, previewText, isDeep }

interface ReferenceData {
    uri: string; // string uri
    fsPath: string;
    relativePath: string;
    range: Range;
    preview: string;
    isDeep: boolean;
}

export type { ReferenceData };

export const App: React.FC = () => {
    const savedState = vscode.getState() || {};
    const [title, setTitle] = React.useState(savedState.title || '');
    const [groups, setGroups] = React.useState<Record<string, ReferenceData[]>>(savedState.groups || {});
    const [selectedRef, setSelectedRef] = React.useState<ReferenceData | null>(null);
    const [isDeepSearching, setIsDeepSearching] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState(savedState.searchQuery || '');
    const [includePattern, setIncludePattern] = React.useState(savedState.includePattern || '');
    const [excludePattern, setExcludePattern] = React.useState(savedState.excludePattern || '');
    const [isLoading, setIsLoading] = React.useState(false);
    const [isToolbarExpanded, setIsToolbarExpanded] = React.useState(savedState.isToolbarExpanded !== false);

    // Refs for event listener access
    const groupsRef = React.useRef(groups);
    const selectedRefRef = React.useRef(selectedRef);

    React.useEffect(() => {
        groupsRef.current = groups;
        selectedRefRef.current = selectedRef;
    }, [groups, selectedRef]);

    // Save state and sync with extension
    React.useEffect(() => {
        vscode.setState({ 
            title, 
            groups, 
            searchQuery, 
            includePattern, 
            excludePattern,
            isToolbarExpanded
        });
        
        // Sync filters to extension for Lookup Reference command
        vscode.postMessage({
            command: 'updateFilters',
            includePattern,
            excludePattern
        });
    }, [title, groups, searchQuery, includePattern, excludePattern, isToolbarExpanded]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            switch (message.command) {
                case 'setLoading':
                    setIsLoading(message.isLoading);
                    break;
                case 'update':
                    setTitle(message.title);
                    setSearchQuery(message.title);
                    processReferences(message.references, message.deepReferences);
                    setIsDeepSearching(false);
                    // Don't stop loading here, wait for explicit setLoading(false)
                    break;
                case 'appendResults':
                    // Merge new results
                    appendReferences(message.references);
                    setIsDeepSearching(false);
                    // Don't stop loading here, wait for explicit setLoading(false)
                    break;
                case 'navigate': {
                    const direction = message.direction;
                    const currentGroups = groupsRef.current;
                    const currentSelected = selectedRefRef.current;
                    
                    const sortedPaths = Object.keys(currentGroups).sort();
                    const allItems: ReferenceData[] = [];
                    sortedPaths.forEach(path => {
                        const groupItems = [...currentGroups[path]];
                        groupItems.sort((a, b) => a.range.start.line - b.range.start.line);
                        allItems.push(...groupItems);
                    });
                    
                    if (allItems.length === 0) {
                        return;
                    }

                    let nextIndex = 0;
                    if (currentSelected) {
                        const idx = allItems.findIndex(r => 
                            r.fsPath === currentSelected.fsPath && 
                            r.range.start.line === currentSelected.range.start.line &&
                            r.range.start.character === currentSelected.range.start.character
                        );
                        
                        if (idx !== -1) {
                            if (direction === 'next') {
                                nextIndex = idx + 1;
                            } else {
                                nextIndex = idx - 1;
                            }
                        }
                    } else {
                        // If nothing selected, only Next works (selects first)
                        if (direction === 'prev') {
                            return;
                        }
                        nextIndex = 0;
                    }

                    // Stop if out of bounds (no ring/loop)
                    if (nextIndex < 0 || nextIndex >= allItems.length) {
                        return;
                    }

                    const nextItem = allItems[nextIndex];
                    setSelectedRef(nextItem);
                    openRef(nextItem);
                    
                    // Scroll to item
                    setTimeout(() => {
                        const domItems = document.querySelectorAll('.reference-item');
                        if (domItems[nextIndex]) {
                            (domItems[nextIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
                        }
                    }, 0);
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);
        // Signal ready
        vscode.postMessage({ command: 'ready' });
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    // Handle keyboard navigation
    React.useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                // If focus is in input, we might want to allow default behavior or not?
                // Usually in VS Code lists, Up/Down navigates the list even if focus is elsewhere, 
                // UNLESS the focus is in an input that needs Up/Down (like a multiline text area, or history).
                // Here inputs are single line.
                
                // Let's allow navigation if we have results
                const allItems = Array.from(document.querySelectorAll('.reference-item'));
                if (allItems.length === 0) return;

                e.preventDefault();
                
                const selectedEl = document.querySelector('.reference-item.selected');
                let nextIndex = 0;

                if (selectedEl) {
                    const currentIndex = allItems.indexOf(selectedEl);
                    if (e.key === 'ArrowDown') {
                        nextIndex = Math.min(currentIndex + 1, allItems.length - 1);
                    } else {
                        nextIndex = Math.max(currentIndex - 1, 0);
                    }
                } else {
                    nextIndex = 0;
                }

                const nextEl = allItems[nextIndex] as HTMLElement;
                if (nextEl) {
                    nextEl.click(); // Trigger selection
                    nextEl.scrollIntoView({ block: 'nearest' });
                }
            } else if (e.key === 'Enter') {
                // If an item is selected and we are NOT in an input
                if (selectedRef && document.activeElement?.tagName !== 'INPUT') {
                    openRef(selectedRef);
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [selectedRef]);

    const processReferences = (refs: ReferenceData[], deepRefs: ReferenceData[]) => {
        const newGroups: Record<string, ReferenceData[]> = {};
        
        const add = (item: ReferenceData) => {
            if (!newGroups[item.fsPath]) {
                newGroups[item.fsPath] = [];
            }
            newGroups[item.fsPath].push(item);
        };

        refs.forEach(r => add(r));
        deepRefs.forEach(r => add(r));
        
        setGroups(newGroups);
    };

    const appendReferences = (newRefs: ReferenceData[]) => {
        setGroups(prev => {
            const next = { ...prev };
            newRefs.forEach(item => {
                if (!next[item.fsPath]) {
                    next[item.fsPath] = [];
                }
                // Check duplicates? Controller handles it, but safe to check
                // Simple check
                const exists = next[item.fsPath].some(r => 
                    r.range.start.line === item.range.start.line && 
                    r.range.start.character === item.range.start.character
                );
                if (!exists) {
                    next[item.fsPath].push(item);
                }
            });
            return next;
        });
    };

    const handleSearch = () => {
        if (searchQuery) {
            setIsDeepSearching(true);
            vscode.postMessage({ 
                command: 'search', 
                query: searchQuery,
                includePattern,
                excludePattern
            });
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSearch();
        }
    };

    const openRef = (ref: ReferenceData) => {
        vscode.postMessage({
            command: 'open',
            uri: ref.uri,
            range: [ref.range.start, ref.range.end]
        });
    };

    const sortedPaths = Object.keys(groups).sort();
    const totalCount = Object.values(groups).flat().length;

    return (
        <div className="reference-container">
            <div 
                className={`reference-header ${isToolbarExpanded ? 'expanded' : ''}`} 
                onClick={() => setIsToolbarExpanded(!isToolbarExpanded)}
            >
                <span 
                    className={`codicon codicon-chevron-${isToolbarExpanded ? 'down' : 'right'}`}
                ></span>
                <span>References: {title} ({totalCount})</span>
            </div>

            {isToolbarExpanded && (
                <div className="toolbar">
                    <div className="search-box-container">
                        <div className="filters-row">
                            <div className="filter-box search-main">
                                <span className="label">search references</span>
                                <div className="search-input-wrapper">
                                    <input 
                                        type="text" 
                                        className="search-input" 
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder="Search references..."
                                        onClick={e => e.stopPropagation()}
                                    />
                                    <button className="btn search-btn" onClick={(e) => { e.stopPropagation(); handleSearch(); }} title="Search">
                                        <span className="codicon codicon-search"></span>
                                    </button>
                                </div>
                            </div>
                            <div className="filter-box">
                                <span className="label">files to include</span>
                                <input 
                                    type="text" 
                                    className="search-input" 
                                    value={includePattern}
                                    onChange={e => setIncludePattern(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="e.g. *.ts, src/**/include"
                                    title="Comma-separated patterns to include (e.g. src/**/*.ts)"
                                    onClick={e => e.stopPropagation()}
                                />
                            </div>
                            <div className="filter-box">
                                <span className="label">files to exclude</span>
                                <input 
                                    type="text" 
                                    className="search-input" 
                                    value={excludePattern}
                                    onChange={e => setExcludePattern(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="e.g. *.ts, src/**/exclude"
                                    title="Comma-separated patterns to exclude (e.g. **/*.test.ts)"
                                    onClick={e => e.stopPropagation()}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            )}
            
            {isLoading && (
                <div className="progress-bar-container">
                    <div className="progress-bar"></div>
                </div>
            )}

            <ReferenceTree 
                groups={groups}
                selectedRef={selectedRef}
                onSelect={(ref) => {
                    setSelectedRef(ref);
                    vscode.postMessage({ 
                        command: 'preview', 
                        uri: ref.uri, 
                        range: ref.range 
                    });
                }}
                onOpen={openRef}
                searchQuery={searchQuery}
            />
        </div>
    );
};
