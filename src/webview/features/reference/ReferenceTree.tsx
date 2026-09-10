import React from 'react';
import { ReferenceData } from './ReferenceApp';

interface ReferenceTreeProps {
    groups: Record<string, ReferenceData[]>;
    selectedRef: ReferenceData | null;
    onSelect: (ref: ReferenceData) => void;
    onOpen: (ref: ReferenceData) => void;
    searchQuery: string;
}

const ReferenceTree: React.FC<ReferenceTreeProps> = ({ groups, selectedRef, onSelect, onOpen, searchQuery }) => {
    const sortedPaths = Object.keys(groups).sort();
    const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(new Set());

    const toggleCollapse = (path: string) => {
        const newCollapsed = new Set(collapsedPaths);
        if (newCollapsed.has(path)) {
            newCollapsed.delete(path);
        } else {
            newCollapsed.add(path);
        }
        setCollapsedPaths(newCollapsed);
    };

    const highlightText = (text: string, query: string) => {
        if (!query) return text;
        
        // Escape regex characters
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Split by whitespace to get keywords
        const keywords = escapedQuery.split(/\s+/).filter(k => k.length > 0);
        if (keywords.length === 0) return text;

        const parts = text.split(new RegExp(`(${keywords.join('|')})`, 'gi'));
        
        return parts.map((part, i) => {
            const isMatch = keywords.some(k => part.toLowerCase() === k.toLowerCase());
            return isMatch ? <span key={i} className="highlight">{part}</span> : part;
        });
    };

    return (
        <div id="content">
            {sortedPaths.map(path => {
                const items = groups[path];
                // Sort items by line
                items.sort((a, b) => a.range.start.line - b.range.start.line);
                
                const filename = path.split(/[/\\]/).pop() || '';
                
                // Calculate display path
                let displayPath = filename;
                if (items.length > 0) {
                    const relativePath = items[0].relativePath;
                    if (relativePath && relativePath !== filename) {
                        // Extract directory
                        const dir = relativePath.substring(0, relativePath.length - filename.length - 1);
                        if (dir) {
                            displayPath = `${filename} (${dir})`;
                        }
                    }
                }

                const isCollapsed = collapsedPaths.has(path);
                
                return (
                    <div key={path} className="file-group" data-file={path}>
                        <div 
                            className="file-header" 
                            title={items[0]?.relativePath || path}
                            onClick={() => toggleCollapse(path)}
                        >
                            <span className={`codicon codicon-chevron-${isCollapsed ? 'right' : 'down'}`}></span>
                            <span className="codicon codicon-file"></span>
                            <span className="filename">{displayPath}</span>
                            <span className="badge">{items.length}</span>
                        </div>
                        {!isCollapsed && (
                            <div className="references">
                                {items.map((item, idx) => (
                                    <div 
                                        key={idx}
                                        className={`reference-item ${item.isDeep ? 'deep-search-result' : ''} ${selectedRef === item ? 'selected' : ''}`}
                                        onClick={() => onSelect(item)}
                                        onDoubleClick={() => onOpen(item)}
                                    >
                                        {item.isDeep ? (
                                            <span className="codicon codicon-zap deep-search-icon" title="Deep Search Result"></span>
                                        ) : (
                                            <span className="codicon codicon-zap deep-search-icon placeholder"></span>
                                        )}
                                        <span className="line-number">Line {item.range.start.line + 1}:</span>
                                        <span className="code-preview">{highlightText(item.preview, searchQuery)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ReferenceTree;
