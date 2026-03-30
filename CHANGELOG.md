# Change Log

All notable changes to the "symbol-relation-window" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]


## [1.0.2] - 2026-03-31

### Added
- **Smart Search Focus & Auto-Select**: In Project Mode, using the `Focus Project Search` shortcut (`Ctrl+T`) automatically extracts the word or selection under the cursor and executes an immediate search.

### Changed
- **Optimized File System Watcher**: The background file watcher now rigorously restricts its glob scoping to `shared.includeFiles` and actively skips files caught by `shared.excludeFiles`, reducing unnecessary monitoring overhead.

### Fixed
- **Dynamic Configuration Updates**: The Background Indexer now dynamically recreates file system watchers and reloads cache mapping when `shared.includeFiles` or `shared.excludeFiles` are modified.
- **Filter State on Refresh**: Fixed a bug where refreshing the Symbol Window in Project Mode would drop the user's active symbol kind filters and query all types instead.
- **Webview Synchronization**: Resolved cold-start bug preventing search inputs from focusing or receiving queries upon initial extension load.
  - Implemented a `_messagesQueue` mechanism in `SymbolWebviewProvider` and `RelationWebviewProvider` to buffer incoming messages until the React frontend explicitly signals it is `ready`.
  - Enforced strict execution order by replacing asynchronous `.show()` API calls with standard VS Code `vscode.commands.executeCommand('*.focus')` and explicitly `await`ing their resolution.

## [1.0.1] - 2025-12-24

### Added
- **Cross-Platform Build**: Added build scripts to automatically download and bundle the correct `ripgrep` binary for the target platform (Windows, macOS, Linux) during packaging.

### Fixed
- **Permissions**: Fixed `ripgrep` permission issues on macOS/Linux by adding a runtime check to ensure the binary is executable (`chmod 755`).
- **Indexing**: Improved file discovery for the Symbol Database. Switched from spawning `ripgrep --files` to using the native `vscode.workspace.findFiles` API. This fixes issues with path resolution in WSL/Remote environments and ensures `.gitignore` is respected consistently.
- **Cross-Platform Paths**: Fixed "File not found" errors in WSL/Remote environments by implementing a robust path handling strategy.
    - Correctly handles `ripgrep` output with mixed separators (Windows `\` vs Linux `/`).
    - Ensures Webview communication uses standard URIs while internal tools use file system paths.
    - Added support for `vscode-context-window` navigation in Remote environments (WSL, SSH, Dev Containers, Codespaces).
    - *Note: While we've implemented support for generic remote environments, we have primarily tested on Windows and WSL. If you encounter issues on other remote platforms (SSH, Containers), please file an issue.*

## [1.0.0] - 2025-12-21

### Added
- **Relation Window**: Fully implemented the Relation Window for exploring Call Hierarchy.
    - **Incoming/Outgoing Calls**: View callers and callees for the selected symbol.
    - **Both Directions**: Added `relationWindow.showBothDirections` setting to display both incoming and outgoing calls simultaneously.
    - **Deep Search**: Integrated `ripgrep`-based Deep Search for relations to find calls even when LSP is incomplete (e.g., in C/C++ projects).
    - **Filtering**: Filter relation results by symbol kind (e.g., show only Functions or Methods).
    - **Settings**: Added options to "Remove Duplicates" and "Show Definition Path".
- **Reference Window**: Added a dedicated window for looking up references.
    - **Code Preview**: View code context for each reference directly in the list.
    - **Navigation**: Quick jump to reference locations.
- **Symbol Window**:
    - **Split View**: Added `symbolWindow.splitView` setting to separate "Current Document" and "Project Workspace" into two distinct views for simultaneous access.
    - **Kind Filtering**: Added a new filter button to the search bar allowing users to filter symbols by type (Class, Method, Variable, etc.).
    - **Keyword Highlighting**: Search results now highlight the matching query terms for better visibility.
- **Symbol Parsing**: Implemented an extensible `SymbolParser` interface.
    - **C/C++ Support**: Added a specialized parser for C/C++ to strip function signatures and type suffixes for cleaner display.
    - **Auto Detection**: Default `auto` mode selects the appropriate parser based on language ID.
- **New Commands**:
    - **Relation**: `Toggle Direction`, `Manual Search` (Shift+Alt+H), `Lookup References` (Shift+Alt+F12), `Jump to Definition`.
    - **Reference**: `Next Reference` (F2), `Previous Reference` (F1).
    - **Symbol**: `Toggle Mode`, `Focus Project Search` (Ctrl+T), `Focus Current Search` (Ctrl+Shift+O).
- **New Configurations**:
    - `symbolWindow.symbolParsing.mode`: Configure parsing strategy (`auto`, `c-style`, `default`).
    - `symbolWindow.enableHighlighting`: Toggle search result highlighting.
    - `relationWindow.autoSearch`: Automatically search relations on cursor move.
    - `relationWindow.autoExpandBothDirections`: Auto-expand nodes when showing both directions.
    - `relationWindow.enableDeepSearch`: Enable/disable Deep Search for relations.

### Changed
- **Configuration Scope**: Moved several settings to the `shared` scope to reflect their usage across multiple windows (Symbol, Relation, Reference).
    - `symbolWindow.enableDatabaseMode` -> `shared.enableDatabaseMode`
    - `symbolWindow.indexingBatchSize` -> `shared.indexingBatchSize`
    - `symbolWindow.includeFiles` -> `shared.includeFiles`
    - `symbolWindow.excludeFiles` -> `shared.excludeFiles`
    - `shared.database.cacheSizeMB` (New shared setting)

### Refactor
- **Architecture**: Adopted a **Feature-based Architecture**. Source code is now organized into `src/features/{symbol, relation, reference}` for better modularity and maintainability.
- **Shared Core**: Extracted `LspClient` and `DatabaseManager` to `src/shared/core`. This centralizes the LSP connection and SQLite database management.
- **Global Status Bar**: Refactored status bar logic into a shared component (`GlobalStatusBar`).

### Fixed
- **Indexing Stability**: Improved robustness of the background indexer.
    - **Retry Mechanism**: Added automatic retries for files that fail to index (e.g., due to file locks).
    - **Error Handling**: Enhanced handling of file system errors (e.g., `ENOENT`) during indexing to prevent crashes.

### UI/UX
- **Container**: Renamed the main Activity Bar container from "Symbol Window" to **"Window"**. This provides a neutral parent container for both the Symbol and Relation views.
- **Foolproof View**: Introduced a "Foolproof" view (`all-disabled-view`) that activates when both `symbolWindow.enable` and `relationWindow.enable` are set to `false`. It displays a clean interface with buttons to easily re-enable either window.
- **Zap Indicator**: Added `$(zap)` icon to indicate results found via Deep Search (Text Search) vs LSP.

## [0.1.2] - 2025-11-27

### Fixed
- **Incremental Indexing**: Fixed a critical bug where files with 0 symbols were ignored by the indexer, causing them to be re-scanned infinitely during incremental updates.
- **Race Condition Handling**: Added robust existence checks (`fs.stat`) before processing files in the indexing queue. This prevents `ENOENT` errors caused by atomic save operations (delete-then-rename) when using `FileSystemWatcher`.

### Changed
- **Performance Tuning**: 
    - Reduced default `symbolWindow.indexingBatchSize` from 30 to **15** to further reduce LSP load.
    - Increased batch processing delay from 50ms to **100ms** to give the CPU more breathing room between batches.
    - **Data Transfer**: Optimized `loadMore` to use incremental data transfer, reducing IPC overhead when scrolling through large result lists.
- **Configuration**: 
    - `symbolWindow.indexingBatchSize`: Added a hard limit of 200 files/batch to prevent LSP crashes.
    - `symbolWindow.excludeFiles`: Added new setting to control which files are excluded from indexing. Default value now covers a comprehensive list of binary files, images, archives, and documentation (e.g., `.md`, `.txt`, `.pdf`, `.zip`, `.exe`) to prevent them from being indexed.
    - `symbolWindow.includeFiles`: Added new setting to whitelist specific file patterns for indexing.

### Removed
- **Deep Search**: Removed `symbolWindow.enableDeepSearch` configuration. Deep Search is now an integrated fallback feature in Project Mode (when Database Mode is not ready) and Relation Window, rather than a globally toggled setting.

## [0.1.1] - 2025-11-26

### Added
- **Configuration**: 
    - `symbolWindow.indexingBatchSize`: Configure indexing performance (Default: 30 files/batch). Set to `0` for unlimited speed.
- **Commands**:
    - `Rebuild Symbol Index (Incremental)`: Safely updates the index for changed files.
    - `Rebuild Symbol Index (Full)`: Completely clears and rebuilds the database.

### Fixed
- **State Persistence**: Fixed an issue where the "Database Mode" UI state and Indexing Progress bar would be lost when switching views or reloading the window.
- **Progress Tracking**: Indexing progress is now robustly synced between the backend and the webview.

### Removed
- **Dev Commands**: Removed `symbol-window.testSqlite` and `symbol-window.focus` as they are no longer needed.

## [0.1.0] - 2025-11-26

### Added
- **Database Mode**: A new high-performance mode backed by SQLite for instant symbol search in large workspaces.
    - **Persistent Index**: Symbols are indexed once and persisted to disk, eliminating wait times on startup.
    - **Incremental Updates**: The index is automatically updated in the background as you edit files.
    - **Hybrid Search**: Combines database speed with LSP accuracy.
- **Configuration**: 
    - `symbolWindow.enableDatabaseMode`: Enable the new SQLite-based mode.
- **UI**: Added a distinct **PROJECT WORKSPACE (DATABASE)** label when Database Mode is active.

### Changed
- **Performance**: Significantly reduced memory usage and improved search responsiveness in large projects when using Database Mode.
- **Documentation**: Updated README and SPEC to reflect the new architecture.

## [0.0.4] - 2025-11-25

### Changed
- **Deep Search Graduation**: Deep Search is no longer experimental and is now enabled by default (`symbolWindow.enableDeepSearch` defaults to `true`).
- **Deep Search Optimization**: Implemented Regex Permutations for multi-keyword matching to significantly improve search speed with `ripgrep`.
- **UI Polish**: Updated the Search Details UI to match VS Code's native design (transparent backgrounds, better spacing).
- **UX Improvements**:
    - Deep Search results are now collapsed by default to reduce clutter.
    - Added `Esc` key support to clear the "Files to Include" input.
    - The "Search Details" toggle is now only visible when Deep Search is enabled.

### Added
- **Advanced Deep Search Filtering**:
    - **Search Scope**: Users can now limit Deep Search to specific folders.
    - **Files to Include**: Added support for glob patterns (e.g., `*.ts`, `src/**`) to filter search results.
- **Search Details Panel**: A new toggleable panel in the search bar (Project Mode) to access advanced filtering options.
- **State Persistence**: The extension now remembers the Search Scope, Include Patterns, and Details Panel visibility across sessions.

## [0.0.2] - 2025-11-24

### Added
- **Deep Search**: A new hybrid search mechanism combining Ripgrep (text scan) and LSP (symbol parsing) to find symbols in large projects where standard LSP results are truncated.
- **Deep Search UI**: Added a "Deep Search" button in Project Mode that appears when results might be incomplete.
- **Result Highlighting**: Deep Search results are highlighted to distinguish them from standard search results.

### Changed
- **Search Logic**: Improved deduplication logic using `selectionRange` to better merge Document and Workspace symbols.
- **UI Feedback**: Enhanced loading state indicators during search operations.

## [0.0.1] - 2025-11-23

### Features
- **Current Document Mode**: Tree view of symbols in the active file with real-time filtering.
- **Project Workspace Mode**: Global symbol search with multi-keyword support.
- **Readiness State Machine**: Robust handling of Language Server initialization and timeouts.
- **LSP Crash Recovery**: Automatic detection and recovery from Language Server failures.
- **Native UI**: Built with VS Code Webview UI Toolkit for a seamless look and feel.
- **Performance**: Implemented caching and debouncing for search queries.