# Symbol & Relation Window Specification

## 1. Overview
**Name:** `symbol-relation-window`
**DisplayName:** Symbol & Relation Window
**Goal:** Provide a comprehensive "Source Insight"-like experience in VS Code, featuring a Symbol List for navigation, a Relation Window for call hierarchy analysis, and a Reference Window for global lookup.
**Core Philosophy:** Fast, native look-and-feel, leveraging VS Code APIs to avoid custom parsing overhead where possible.

## 2. Marketplace Optimization
**Keywords:**
- `symbol`
- `outline`
- `navigation`
- `structure`
- `workspace`
- `search`
- `tree`
- `call hierarchy`
- `references`
- `find references`
- `caller`
- `callee`
- `relation`
- `code map`

## 3. Architecture & Modules

### 3.1 Module Structure
The extension follows a modular architecture, separating business logic (Features) from infrastructure (Shared) and presentation (Webview).

```
src/
├── extension.ts                       // Entry point: Activates features, registers commands.
├── features/                          // Feature Modules
│   ├── <feature>/                     // Standard Pattern (e.g., relation, reference)
│   │   ├── *Controller.ts             // Logic: Orchestrates events, updates, and mode switching.
│   │   ├── *Model.ts                  // Data: Fetches information from LSP, Database, or Search.
│   │   └── *WebviewProvider.ts        // UI Backend: Manages the Webview panel and IPC messages.
│   │
│   └── symbol/                        // Symbol Window Specifics
│       ├── indexer/                   // Background Indexer: Scans workspace files into SQLite.
│       └── parsing/                   // Parsing Strategies: Cleans symbol names (e.g., removing C++ params).
│
├── shared/                            // Shared Infrastructure
│   ├── common/                        // Shared Types and Constants.
│   ├── db/                            // Database Layer: SQLite schema and query methods.
│   ├── services/                      // Core Services: Singletons like LspClient and DatabaseManager.
│   ├── ui/                            // Shared UI Logic (e.g. GlobalStatusBar).
│   └── utils/                         // Utilities: Search Engine (Ripgrep), Navigation, etc.
│
└── webview/                           // Frontend Application (React)
    ├── components/                    // Shared React Components (e.g. FilterView).
    ├── features/                      // Feature-specific UI Modules.
    │   └── <feature>/                 // e.g. symbol, relation
    │       ├── index.tsx              // Entry point: Mounts the React app.
    │       ├── *App.tsx               // Main Component: Handles state and messages.
    │       └── *Tree.tsx              // Presentation: Renders the tree/list view.
    ├── global.d.ts                    // TypeScript definitions for Webview context.
    ├── utils.ts                       // Frontend utilities (e.g. message passing).
    └── vscode-api.ts                  // API Wrapper: Typed wrapper for VS Code Webview API.
```

### 3.2 Path Handling Strategy (Cross-Platform)
To ensure consistent behavior across Windows, WSL, and Remote environments, the extension adopts an **"Internal/External Separation"** strategy for path handling:

1.  **Internal Logic (Model/Tools)**: Always use **File System Paths (`fsPath`)**.
    -   Tools like `ripgrep` and `sqlite` (Node.js `fs`) require OS-native paths.
    -   On Windows: `C:\Users\Project\...`
    -   On WSL/Linux: `/mnt/c/Users/Project/...`
2.  **External Communication (Webview/VS Code API)**: Always use **URI Strings** or **Objects**.
    -   Webviews and VS Code APIs expect URIs (`file:///...` or `vscode-remote://...`).
    -   This abstracts away the underlying OS differences.
3.  **Path Joining**: Always use `vscode.Uri.joinPath`.
    -   Never use string concatenation (`root + '/' + file`) or `path.join` for cross-platform logic involving URIs.
    -   `ripgrep` output (relative paths) is split by `/[\\/]/` to handle mixed separators (e.g., `src\utils.ts` on Windows) before joining.

**Key Components:**
*   **Features (`src/features/*`)**: Each folder (symbol, relation, reference) is self-contained, typically consisting of:
    *   `Controller`: Orchestrates events and updates.
    *   `Model`: Fetches data from LSP or Database.
    *   `WebviewProvider`: Manages the UI panel and IPC.
*   **Shared Infrastructure (`src/shared/*`)**:
    *   `services`: Manages expensive resources like `LspClient` and `DatabaseManager`.
    *   `db`: Handles SQLite connection, schema, and queries.
    *   `utils`: Provides utilities like `ripgrep` search and navigation helpers.
*   **Webview (`src/webview`)**: A single React application that renders different "Apps" (`SymbolApp`, `RelationApp`, `ReferenceApp`) based on the view context.

### 3.2 Data Flow
1.  **Init:** Extension activates -> Reads config -> Instantiates enabled Controllers (`SymbolController`, `RelationController`, `ReferenceController`) -> Registers ViewProviders.
2.  **Update (Symbol):** User opens file -> `SymbolController` checks readiness -> fetches symbols -> Sends `updateSymbols` message to Webview.
3.  **Update (Relation):** User moves cursor -> `RelationController` debounces -> checks symbol validity -> fetches hierarchy -> Sends `updateRelation` message to Webview.
4.  **Lookup (Reference):** User triggers "Lookup References" -> `ReferenceController` fetches data (LSP + Deep Search) -> Sends `update` message to Reference Webview.
5.  **Search:** User types in SearchBar -> React filters locally (Current Mode) OR sends `search` message to Extension (Project Mode).
6.  **Navigation:** User double-clicks item -> Sends `jump` message to Extension -> Extension opens file & reveals range.

### 3.3 Resource Management & Layout
- **Container (Side Bar):** The main Activity Bar container is named **"Window"** to serve as a neutral parent for the Symbol and Relation views.
- **Container (Editor Area):** The Reference Window opens as a **Webview Panel** in the editor area (like a standard file tab), allowing for a spacious view and side-by-side comparison.
- **Independent Switches:**
    - `symbolWindow.enable`: Boolean. Controls the Symbol Window.
    - `relationWindow.enable`: Boolean. Controls the Relation Window.
    - `referenceWindow.enable`: Boolean. Controls the Reference Window.
- **Layout Logic (Side Bar):**
    - **Standard Layout (Default):**
        - **Both Enabled:** Vertical Split. Symbol Window (toggles between Current/Project) on Top, Relation Window on Bottom.
        - **Only Symbol Enabled:** Symbol Window takes full height.
        - **Only Relation Enabled:** Relation Window takes full height.
    - **Split View Enabled (`symbolWindow.splitView`):**
        - The Symbol Window functionality is separated into two distinct views.
        - **Order:**
            1. **Symbol Window** (Current Document) - Top
            2. **Project Symbols** (Workspace Search) - Middle
            3. **Relation Window** (if enabled) - Bottom
    - **Both Disabled:** A special "Foolproof" view (`all-disabled-view`) is shown. It displays buttons to "Enable Symbol Window" and "Enable Relation Window" to guide the user back to a working state.
- **Lifecycle:**
    - **Side Bar Views:** When a module is disabled via settings, its ViewProvider must be disposed, and all associated event listeners (e.g., `onDidChangeTextEditorSelection`, `FileSystemWatcher`) must be removed to free up resources.
    - **Reference Window:**
        - **On Close:** When the user closes the editor tab, the Webview is disposed (`panel.onDidDispose`). The extension clears the `referenceWindow.exists` context key.
        - **On Disable:** If `referenceWindow.enable` is set to false, the command to open the window is disabled. If the window is currently open, it is not forcibly closed, but subsequent attempts to open it will be blocked.

### 3.4 Global Status Bar (Shared)
Since the Database is a shared resource, its status and controls are hosted in the VS Code Status Bar to avoid UI clutter in the side bar.
- **Location:** VS Code Status Bar (Bottom Left, Priority 100).
- **States:**
    -   **Standby/Ready:** `$(database) Symbols: Ready`
    -   **Indexing:** `$(sync~spin) Symbol: Indexing (45%)`
    -   **LSP Wait:** `$(sync~spin) Symbol: Waiting for LSP...`
    -   **Error/Timeout:** `$(warning) Symbol: LSP Timeout`
- **Interaction:**
    -   **Click:** Opens a Quick Pick menu with shared commands:
        -   `Rebuild Index (Incremental)`: (Default) Triggers an incremental update based on file changes.
        -   `Rebuild Index (Full)`: Drops and recreates the database from scratch.
    -   **Note:** There is no manual "Switch Mode" in the menu. The extension automatically uses Database Mode if available. Users cannot manually revert to Normal Mode unless they disable `shared.enableDatabaseMode` in settings.

## 4. Shared Feature: Database Indexing

### 4.1 Core Logic
1.  **Configuration:**
    -   `shared.enableDatabaseMode`: Master switch (Default: `true`).
    -   **If True:**
        -   Start indexing in the background.
        -   Use "Hybrid Transition Strategy": Use LSP + Manual Deep Search (via button) until indexing is complete, then switch to Database Mode.
    -   **If False:**
        -   Do not start indexing.
        -   Permanently use LSP + Manual Deep Search (via button).
    -   **Shared Resource:** This database is used by both the **Symbol Window** (for fast project-wide searching) and the **Relation Window** (for validating symbol existence before hierarchy lookups).
2.  **Data Source:** `vscode.executeDocumentSymbolProvider` (for every file).
3.  **Storage:** `node:sqlite` (Built-in Node.js module).
    -   **Feature Detection:** On extension activation, attempt to dynamically import `node:sqlite`.
    -   **Fallback:** If the import fails (e.g., older VS Code versions), **completely disable** the Indexing feature and revert to the standard "Project Mode" (LSP + Deep Search).
    -   **Versioning:** Store a schema version (e.g., `PRAGMA user_version`). On startup, check if the DB version matches the extension's expected version. If mismatch, **drop and rebuild** the entire database to ensure schema compatibility.
    -   **Self-Healing:** Wrap database operations in try-catch blocks. If a critical error (e.g., `SQLITE_CORRUPT`) is detected, automatically delete the database file and trigger a full rebuild.
    -   **Optimization:** Enable WAL mode (`PRAGMA journal_mode = WAL;`) and `PRAGMA synchronous = NORMAL;` for better concurrency.
    -   **Lifecycle:** Explicitly close the database connection (`db.close()`) in the extension's `deactivate` method to ensure WAL files are merged and resources are released.
4.  **Indexing Strategy:**
    -   **LSP Dependency:** The indexer **MUST** wait for the `SymbolController` to report `ready` state before processing the queue. If the LSP becomes unavailable, indexing pauses.
    -   **Initial Scan (Cold Start):**
        -   Iterate over all workspace folders (`vscode.workspace.workspaceFolders`).
        -   Run `vscode.workspace.findFiles` for each folder to build the initial file list.
    -   **Startup Sync (Warm Start):**
        -   Load the list of indexed files from SQLite.
        -   Compare with the current workspace state (using `vscode.workspace.findFiles` per folder).
        -   **Deleted Files:** Remove from DB.
        -   **New Files:** Add to the indexing queue.
        -   **Modified Files:** Check `mtime` (modification time). If changed, add to the indexing queue.
    -   **Queue System:**
        -   Process files in small batches to avoid blocking the UI.
        -   **Deduplication:** Use a `Set` or `Map` to track pending files. If a file is already in the queue, update its status but do not add a duplicate entry.
        -   **Fault Isolation:** Wrap individual file processing in try-catch blocks. If parsing or indexing fails for a specific file, log the error and **continue** to the next file in the queue.
    -   **Persistence:** Store the index in `workspaceStorage` (`context.storageUri`) which is managed by VS Code per workspace.
    -   **Tree Flattening & Bulk Insert:**
        -   **Strategy:** Perform a Depth-First Search (DFS) traversal to collect all symbols in memory first.
        -   **Container Name:** Pass the **accumulated ancestor path** (e.g., "Namespace.Class") down during DFS. This allows searching for a method using its namespace or any ancestor name (e.g., "Namespace Method").
        -   **Bulk Insert:** Once all symbols for a file are collected, insert them into the database using a **single transaction**.
            -   **Chunking:** Split the symbols into smaller batches (e.g., 100 symbols per INSERT) to avoid SQLite's parameter limit (SQLITE_MAX_VARIABLE_NUMBER). This prevents "too many terms in compound SELECT" errors for large files.
    -   **Incremental Updates:**
        -   **Watcher:** Use `vscode.workspace.createFileSystemWatcher` to detect external changes (e.g., `git pull`).
            -   *Optimization:* Since VS Code's watcher API does not support complex exclude patterns (like `node_modules`), we use a global watcher (`**/*`) combined with a **Fast Path Filter** (`shouldIgnore`) that checks against `.gitignore` rules in memory to quickly discard irrelevant events.
        -   **Events:**
            -   `onDidChange` / `onDidCreate`: Add file to indexing queue.
            -   `onDidDelete`: Remove from DB immediately.
        -   **Transactions:** Use SQLite transactions (`BEGIN`...`COMMIT`) when updating a file. This ensures that "Delete old symbols", "Insert new symbols", and "Update file metadata (mtime)" happen atomically.

### 4.2 Database Schema
The database schema is normalized to reduce storage size and improve query performance.

**Table: `files`** (Stores file metadata)
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT
    - *Purpose:* Unique identifier for the file, used as a foreign key in the `symbols` table.
- `path`: TEXT UNIQUE
    - *Purpose:* The absolute file path.
    - *Normalization:* Paths must be normalized (e.g., using `vscode.Uri.file(path).fsPath`) before storage to handle Windows drive letter inconsistencies (e.g., `c:` vs `C:`).
- `mtime`: INTEGER
    - *Purpose:* Last modification timestamp. Used to detect if a file has changed since the last index.
- `indexed_at`: INTEGER
    - *Purpose:* Timestamp of when the file was last successfully indexed.

**Table: `symbols`** (Stores symbol data)
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT
    - *Purpose:* Unique identifier for the symbol.
- `file_id`: INTEGER
    - *Purpose:* Foreign Key referencing `files.id`. Links the symbol to its source file.
    - *Constraint:* `ON DELETE CASCADE` (Automatically delete symbols when the file is deleted).
- `name`: TEXT
    - *Purpose:* The name of the symbol (e.g., "MyClass", "init").
- `detail`: TEXT
    - *Purpose:* Additional details (e.g., function signature "(int a, int b)", class inheritance).
- `kind`: INTEGER
    - *Purpose:* The `vscode.SymbolKind` enum value (e.g., 5 for Method, 11 for Function). Used to render the correct icon.
- `range_start_line`: INTEGER
- `range_start_char`: INTEGER
- `range_end_line`: INTEGER
- `range_end_char`: INTEGER
    - *Purpose:* The full range of the symbol (including body). Used for highlighting.
- `selection_range_start_line`: INTEGER
- `selection_range_start_char`: INTEGER
- `selection_range_end_line`: INTEGER
- `selection_range_end_char`: INTEGER
    - *Purpose:* The range of the symbol's name (identifier). Used for "Jump to Definition" to position the cursor exactly on the name.
- `container_name`: TEXT
    - *Purpose:* The name of the parent symbol (e.g., class name for a method). Used to reconstruct the hierarchy or display context in flat lists.

### 4.3 Benefits
-   **Precision:** Eliminates fuzzy/regex matching errors.
-   **Completeness:** Bypasses the result limit of standard LSP calls.
-   **Performance:** SQL queries are extremely fast once indexed.

### 4.4 Challenges & Solutions
1.  **Initialization Time (The 'Cold Start' Problem):**
    -   *Challenge:* Indexing thousands of files takes time.
    -   *Solution:* **Hybrid Transition Strategy**.
        -   While indexing is in progress, the extension continues to use the existing "LSP + Deep Search" mechanism.
        -   Show a non-intrusive progress indicator (Status Bar) during indexing.
2.  **LSP Bottleneck:**
    -   *Challenge:* Flooding the LSP with `getDocumentSymbol` requests can cause high CPU usage or crashes.
    -   *Solution:* **Smart Scheduler**.
        -   **Batching:** Process files in configurable batches (Default: 15 files) with delays (100ms) between batches.
            -   **Configuration:** `shared.indexingBatchSize` allows users to tune this.
        -   **User Preemption:** If the user triggers a search or interacts with the editor, pause the background indexing to prevent UI lag.
3.  **File Filtering:**
    -   *Challenge:* Indexing irrelevant files (minified JS, logs, node_modules) wastes resources.
    -   *Solution:* **Leverage Ripgrep & Configuration**.
        -   Use `rg --files` to discover files for indexing. This automatically respects `.gitignore` and handles binary/large file exclusion.
        -   **Configuration:**
            -   `shared.includeFiles`: Whitelist specific patterns (e.g., `**/*.c, **/*.h`). If set, only matching files are indexed.
            -   `shared.excludeFiles`: Blacklist specific patterns (e.g., `**/*.md, **/*.txt`). These are excluded even if they pass `.gitignore`.
        -   Explicitly exclude `node_modules` unless configured otherwise.
4.  **Path Consistency (Windows):**
    -   *Challenge:* Windows file paths are case-insensitive but inconsistent (e.g., `c:\Project` vs `C:\Project`). `ripgrep` and VS Code APIs may return different casing, leading to duplicate indexing or lookup failures.
    -   *Solution:* **Canonicalization**. Always normalize paths (e.g., `vscode.Uri.file(path).fsPath`) before storing in the database or querying.
5.  **Atomic Saves & Race Conditions:**
    -   *Challenge:* Many editors perform "atomic saves" (write new file -> delete old -> rename new). `FileSystemWatcher` events can trigger for the "delete" phase, causing `ENOENT` errors if the indexer tries to read the file immediately.
    -   *Solution:* **Robust Event Handling**.
        -   Use `FileSystemWatcher` for all events (`create`, `change`, `delete`) to ensure external changes (e.g., git pull) are captured.
        -   Implement existence checks (`fs.stat`) before processing any file in the queue to gracefully handle files that disappear during processing (e.g., during atomic saves).

## 5. Part I: Symbol Window

### 5.1 UI/UX Design

#### 5.1.1 Entry Point
- **Activity Bar:** A dedicated icon opens the "Symbol Window" in the Primary Sidebar.
- **View Container:** A custom view container in the sidebar.

#### 5.1.2 Layout
- **Technology:** **Webview View** (using React). This is necessary to implement the "Always-visible Search Bar" and custom filtering logic that standard VS Code TreeViews cannot support.
- **Indexing Progress:** A progress bar displayed at the top of the view when background indexing is active (shows percentage).
- **Status Feedback:** Visual indicators for "Loading" (Spinner) and "Timeout" (Error) states displayed below the mode header.
- **Search Bar:** Fixed at the top of the view.
    - **Filter Icon:** A funnel icon on the right side allows filtering symbols by Kind (Class, Method, etc.).
    - **Project Mode:** Includes a "Toggle Search Details" (kebab menu) button when Deep Search is enabled.
- **Search Details Panel:** (Project Mode and DeepSearch only)
    - **Scope Control:** Display current scope path, button to select folder, button to clear scope.
    - **Files to Include:** Input field for glob patterns.
- **Symbol Tree:** The main area displaying the list/tree of symbols below the search bar.
- **Split View Layout:** (When `symbolWindow.splitView` is enabled)
    - **Current Document View:**
        -   Dedicated view for the active editor's symbols.
        -   Always visible at the top.
        -   Search bar filters the current document tree.
    -   **Project Symbols View:**
        -   Dedicated view for workspace-wide search.
        -   Located below the Current Document View.
        -   Search bar triggers project-wide search (Database or LSP).
- **Toolbar Actions (View Title):**
    - **Mode Switching:** (Only in Standard Layout). Icons/Buttons in the View Title area (top right of the panel).
        - **Modes:**
            1.  **Current Editor (Document Symbols)**
            2.  **Project (Workspace Symbols)**
    - **Deep Search:** (Visible only in **Project Mode** when Database is NOT ready). Triggers text-based search fallback. Hidden when Database Mode is active.

#### 5.1.3 Interaction
- **Click:**
    - **Single Click:**
        - **Current Mode:** Selects the item and **jumps** to the symbol location (syncs editor).
        - **Project Mode:** Selects the item and triggers a preview in the **Context Window** (if available), but does **not** change the active editor focus/location.
    - **Double Click:** Jumps to the symbol location in the editor and reveals it (transfers focus).
- **Filter:** Clicking the Filter icon in the search bar opens a checklist to toggle visibility of specific symbol kinds.
- **Cursor Sync (Current Editor Mode):** Moving the cursor in the editor automatically highlights/selects the corresponding symbol in the tree and scrolls it into view.
- **Keyboard Shortcuts:**
    - The extension provides commands (`symbol-window.refresh`, `symbol-window.toggleMode`, `symbol-window.rebuildIndex`, `symbol-window.rebuildIndexFull`) that users can bind to custom shortcuts.
- **Keyboard Navigation (Webview):**
    - `Arrow Up/Down`: Move focus from Search Bar to the List, or navigate within the List.
    - `Arrow Left/Right`: Move cursor within the Search Bar (when focused).
    - `Enter`: Jump to the selected symbol (same as Double Click).
- **State Persistence:**
    - The extension remembers the last active mode (Current vs. Project), search query, details panel visibility (`showDetails`), include pattern (`includePattern`), and filters when the view is hidden or VS Code is restarted (using Webview State and Workspace State).

### 5.2 Functional Requirements

#### 5.2.1 Mode: Current Editor Symbols
- **Data Source:** `vscode.executeDocumentSymbolProvider`.
- **Default State:** Shows all symbols in the active document (Tree structure).
- **Search/Filter:**
    - Typing in the search bar filters the existing tree.
    - **Result Display:** Show all matching symbols within the document hierarchy. Expand parent nodes to reveal matching children.
    - Empty search bar restores the full tree.
- **Context Switching:**
    - Updates automatically when the active editor changes.
    - **Readiness Check:** If the language server is not ready (e.g., C/C++ extension indexing), the view waits and retries until symbols are available.
- **Display Details:**
    - Show Symbol Name.
    - Show Symbol Detail/Signature (e.g., function parameters) in a subtle color.
    - **Icons:** Use VS Code Codicons mapped to `vscode.SymbolKind`.
    - **Symbol Parsing (C-Style Optimization):**
        - **Configuration:** `symbolWindow.symbolParsing.mode` (Default: `auto`).
        - **Auto Mode:** Automatically detects language ID. For C/C++/Java/C#, it applies specialized parsing to extract function signatures and type suffixes (e.g., `(struct)`) from the name and move them to the detail view for cleaner display.
        - **Fallback:** For other languages, or if configured to `none`, symbols are displayed exactly as returned by the LSP.
        - **Extensibility:** Designed with a Strategy Pattern (`SymbolParser` interface) to easily add support for other languages in the future.

#### 5.2.2 Mode: Project Symbols
- **Data Source:** `vscode.executeWorkspaceSymbolProvider` (Standard) + `ripgrep` (Deep Search) OR **SQLite Database** (Database Mode).
- **Default State:** Empty (to save resources and reduce noise).
- **Search:**
    - Triggered only when the user types.
    - **Debounce:** 300ms delay to prevent API flooding.
    - **Cancellation:** If user continues typing, cancel the previous pending API request.
    - **Scope (Deep Search only):** User can select a specific folder to limit the search context.
    - **Files to Include (Deep Search only):** User can provide glob patterns to filter files.
    - **Result Display:** Show all matching symbols from the workspace.
        - **Pagination:** Infinite scroll mechanism loads more results (batches of 100) as the user scrolls to the bottom.
        - **Expansion:** Results are collapsed by default to show more items.
- **Display:** Flat list (grouped by file).

#### 5.2.3 Search Logic
- **Debouncing:** 300ms delay.
- **Multi-keyword Support:**
    - **Goal:** Order-independent matching (e.g., "User Controller" and "Controller User" should both find "UserController").
    - **Current Mode (Client-side):**
        - Split query by spaces into keywords.
        - Filter tree nodes: A node matches if it contains **ALL** keywords (AND logic).
        - Preserve hierarchy: If a child matches, show its parents.
    - **Project Mode (Hybrid):**
        - **Strategy:** "Fetch Missing + Cache + Client Filter".
        - Step 1: Split query into keywords.
        - Step 2: Identify keywords not present in the cache.
        - Step 3: Fetch results for missing keywords using `vscode.executeWorkspaceSymbolProvider`.
        - Step 4: Cache the results for each keyword.
        - Step 5: Collect all cached results for the current keywords.
        - Step 6: Filter the collected results in memory to ensure each symbol matches **ALL** keywords.
    - **Database Mode (SQLite):**
        - **Trigger:** Active when `shared.enableDatabaseMode` is true and indexing is complete.
        - **Strategy:** Direct SQL Query.
        - **Details:** See [Section 5.4.2](#542-search--pagination) for full SQL logic, ordering rules, and pagination details.
    - **Deep Search (Text Scan Fallback):**
        - **Trigger:**
            - Manual button click in Project Mode (Vertical Ellipsis menu).
            - Fallback if standard search yields insufficient results (implementation detail).
        - **Optimization:**
            - **Regex Permutations:** Generates regex for all permutations of keywords (up to 5) to allow order-independent matching directly in `ripgrep` (e.g., `A.*B|B.*A`).
            - **Ripgrep Options:** Uses standard line-based search (no `--multiline`) for maximum performance.
        - **Purpose:** Overcome LSP result truncation (e.g., searching "User" returns only first 100 results).
        - **Strategy:**
            1.  Generate regex permutations for the top 5 keywords (e.g., `A.*B|B.*A`).
            2.  Use **Ripgrep (`rg`)** to scan the workspace for files containing matching lines.
            3.  For each matching file, invoke `vscode.executeDocumentSymbolProvider` to parse symbols.
            4.  Filter symbols in memory to ensure they match **ALL** keywords.
            5.  **If Forced:** Return these results directly.
            6.  **If Manual:** Deduplicate against existing results (using `SelectionRange`) and prepend to the list.

#### 5.2.4 Visuals
- **Icons:** Use VS Code native `ThemeIcon` mapped to `vscode.SymbolKind` (e.g., `SymbolKind.Method` -> `$(symbol-method)`). This ensures it looks exactly like the native outline/search.

### 5.3 Architecture (Symbol Window Specific)

#### 5.3.1 Components
1.  **SymbolWebviewProvider:** Implements `vscode.WebviewViewProvider`. Hosts the React app.
2.  **React App (Frontend):**
    - **Library:** Use `@vscode/webview-ui-toolkit` for native VS Code UI components.
    - `App`: Main container, handles state (Mode, SearchQuery, TreeData).
    - `SearchBar`: Input component.
    - `SymbolTree`: Renders the tree/list. Handles expansion and selection.
    - `SymbolItem`: Renders individual rows (Icon + Name + Detail).
3.  **SymbolController (Backend):** Handles business logic, message passing, caching, and readiness checks.
4.  **SymbolModel:** Wraps VS Code APIs (`executeDocumentSymbolProvider`, `executeWorkspaceSymbolProvider`).
5.  **Database Module (`src/shared/db`):** Manages the SQLite connection and schema.
6.  **Indexer Module (`src/features/symbol/indexer`):** Handles workspace crawling, symbol extraction, and incremental updates.

#### 5.3.2 Readiness State Machine
The `LspClient` (shared service) maintains a state machine to handle the availability of the Language Server Protocol (LSP). The `SymbolController` consumes this state to update the UI.

- **States:**
    - `standby`: Initial state. The extension is waiting for a trigger (e.g., opening a file) to check availability.
    - `loading`: The extension is actively polling `getWorkspaceSymbols` to check if the LSP is ready.
    - `ready`: The LSP has successfully returned symbols.
    - `timeout`: Polling exceeded the maximum retries (60s) without success.
- **Transitions:**
    - `standby` -> `loading`: Triggered by `startPolling()` (e.g., on activation, file open, or manual retry).
    - `loading` -> `ready`: Polling succeeds (symbols returned or empty result with no error).
    - `loading` -> `timeout`: Polling times out (MAX_RETRIES exceeded).
    - `timeout` -> `loading`: Triggered by manual retry (Refresh button).
- **Mode-Specific Behavior:**
    - **Project Mode:** Strictly respects the state. If `timeout`, it shows an error. If `loading`, it shows a spinner.
    - **Current Mode:** Also respects the global readiness state. It will fetch and display symbols if available, but the UI will remain in a "Loading" state until the global polling confirms the LSP is fully ready.
        - **Exception:** If no editor is active, the state automatically transitions to `ready` to avoid a perpetual spinner.

### 5.4 Database Mode Integration

#### 5.4.1 Hybrid Transition Strategy
-   **Behavior:**
    -   While indexing is in progress, the extension continues to use the existing "LSP + Deep Search" mechanism.
    -   Once indexing is complete, the UI seamlessly switches to "Database Mode" (labeled as **PROJECT WORKSPACE (DATABASE)**).
    -   **UI Changes:** The "Deep Search" controls (kebab menu) are hidden when Database Mode is active.
    -   **Toolbar:** The "Rebuild Index" icon in the Symbol Window toolbar is removed (moved to Status Bar).

#### 5.4.2 Search & Pagination
-   **Performance:** Since `node:sqlite` is synchronous, queries **MUST** use `LIMIT` and `OFFSET` (e.g., `LIMIT 100`) to prevent blocking the Extension Host when the result set is large.
-   **Pagination State:** The frontend (React) maintains the current page index. When the user scrolls to the bottom (Infinite Scroll), it sends a new search request with an incremented `OFFSET` (e.g., `OFFSET 100`, `OFFSET 200`).
-   **Multi-keyword Logic:**
    -   **Debounce:** Apply the same 300ms debounce as standard search to prevent excessive synchronous queries during rapid typing.
    -   **Case Insensitivity:** SQL `LIKE` queries should be case-insensitive (default behavior for ASCII in SQLite, but explicit `COLLATE NOCASE` can be used if needed).
    -   **Strategy:** Split the search query by spaces into tokens (e.g., "User Controller" -> `["User", "Controller"]`).
    -   **Sanitization:** Escape SQL wildcards (`%`, `_`) and backslashes in user input to prevent injection or incorrect matching (e.g., searching for "100%" should not match "1000"). Use `ESCAPE '\'` in the SQL query.
    -   **SQL Construction:** Use `AND` operators to ensure the result matches **ALL** tokens.
    -   **Scope:** Search across both `name` and `container_name` columns. This allows finding a method by combining its class name and method name (e.g., "MyClass init").
    -   **Filtering:** Apply `kind` filter if active (using `kind IN (...)`).
    -   **Ordering:**
        1.  **Exact Match:** Symbols whose name exactly matches the query string.
        2.  **Name Match:** Symbols whose name contains the first keyword (prioritized over matches only in `container_name`).
        3.  **Length:** Shorter names first.
        4.  **Alphabetical:** A-Z.
        5.  **File Path:** Consistent tie-breaker.
    -   **Example SQL:**
        ```sql
        SELECT * FROM symbols 
        WHERE (name LIKE '%User%' OR container_name LIKE '%User%') 
        AND (name LIKE '%Controller%' OR container_name LIKE '%Controller%')
        AND kind IN (5, 11) -- Optional Filter
        ORDER BY 
            CASE WHEN name LIKE 'User Controller' THEN 0 ELSE 1 END, -- Exact Match
            CASE WHEN name LIKE '%User%' THEN 0 ELSE 1 END,          -- Name Match
            LENGTH(name) ASC,
            name ASC, 
            path ASC
        LIMIT 100 OFFSET ?
        ```
-   **Precise Matching:** Use SQL `LIKE` with `%` wildcards (e.g., `%keyword%`) for substring matching.
-   **No Fuzzy Matching:** We explicitly avoid fuzzy subsequence matching (e.g., "SC" finding "SymbolController") to ensure high precision.
-   **Frontend Highlighting:** The Webview is responsible for highlighting the matching keywords in the result list.
    -   *Performance:* Since results are paginated (100 items), simple substring highlighting is performant and does not cause rendering lag.
    -   *Consistency:* Frontend highlighting logic must match the backend's `AND` logic (highlight all occurrences of all keywords).

## 6. Part II: Relation Window

### 6.1 UI/UX Design
- **Location:**
    - Same View Container as Symbol Window (`symbol-relation-window-container`).
    - Appears **below** the Symbol Window by default.
    - **Resizable:** Users can drag the split line between Symbol and Relation windows.
- **View ID:** `relation-window-view`.
- **Interaction:**
    -   **Cursor Sync:** As the user moves the cursor in the editor, the Relation Window updates to show the hierarchy of the symbol under the cursor (if `relationWindow.autoSearch` is enabled).
    -   **Click:** Single click selects the item.
        -   **Preview:** If the **Context Window** extension is installed, it triggers a preview in that window.(if available).
    -   **Double Click / Enter:** Jumps to the code location and **transfers focus** to the editor.
    -   **Context Menu:**
        -   **Jump to Definition:** (Right-click) Jumps to the definition of the target symbol (instead of the call site). Only available if the item has a resolved definition target.
    -   **Keyboard:** Arrow keys to navigate, Enter to jump.
    - **Toolbar Actions (View Title):**
        - **Toggle Direction:** Switch between "Calls" (Outgoing) and "Called By" (Incoming).
            -   **Visibility:** Hidden if `relationWindow.showBothDirections` is enabled.
        - **Refresh / Search:**
            -   If `autoSearch` is **ON**: Shows a "Refresh" button to force sync to the current cursor.
            -   If `autoSearch` is **OFF**: Shows a "Search" button to manually trigger a search for the symbol under the cursor.
        - **Lookup References:** Triggers the Reference Window to search for references of the selected symbol (only visible when Reference Window is active).
        - **Previous/Next Reference:** Buttons to navigate through the reference list (only visible when Reference Window is active).
        - **Filter:** Toggle button to show/hide the Filter View.
            -   **Standard Mode:** Toggles the filter view for the current direction.
            -   **Both Directions Mode:** Opens a dropdown menu to select "Incoming Filter" or "Outgoing Filter", allowing independent configuration for each direction.
        - **Settings:** Gear icon to open the Settings View (in the Webview content).
            -   **Visibility:** Only visible when direction is "Outgoing" or in "Both Directions" mode (since settings like "Remove Duplicates" apply to outgoing calls).
    - **Settings (Webview):**
        -   **Remove Duplicates:** Option to merge multiple calls from the same function into a single node.
        -   **Show Definition Path:** Option to show the definition path instead of the call site path in the details.

### 6.2 Functional Requirements

#### 6.2.1 Cursor-Sync Logic
- **Prerequisite:** `relationWindow.autoSearch` is enabled.
- **Trigger:** `vscode.window.onDidChangeTextEditorSelection`.
- **Debounce:** **1000ms**.
    - If the user moves the cursor or types within 1000ms, the timer resets.
    - Only triggers after the cursor has been stationary for 1000ms.
- **Jump Suppression (Context Preservation):**
    - **Problem:** When the user double-clicks a node in the Relation Window to jump to its definition, the cursor moves, which would normally trigger Auto-Sync and reset the view to the *target* symbol, causing the user to lose their current browsing context (the *caller*).
    -   **Solution:** When a jump is initiated by the Relation Window, set a temporary flag `isJumping = true`. The `onDidChangeTextEditorSelection` listener checks this flag; if true, it ignores the event and resets the flag. This keeps the Relation Window focused on the original symbol while the editor shows the target.
    -   **Suppression Window:** Instead of resetting the flag on the *first* event, the flag should remain active for a short duration (e.g., 100ms) after the jump command is issued. This handles cases where VS Code fires multiple selection events (e.g., focus change + cursor move + scroll) in rapid succession during a single jump operation.
    - **Flag Lifecycle:**
        1.  **Set:** `isJumping = true` immediately before executing the jump command (`vscode.window.showTextDocument` / `revealRange`).
        2.  **Safety Timeout:** Set a timeout (e.g., 1000ms) to automatically reset `isJumping = false`. This ensures the flag doesn't get stuck if the editor event fails to fire (e.g., jumping to the exact same location).
        3.  **Check & Reset:** Inside the `onDidChangeTextEditorSelection` handler:
            ```typescript
            if (this.isJumping) {
                // Do NOT reset immediately. Wait for the suppression window or timeout.
                return; // Suppress this specific update
            }
            ```

#### 6.2.2 Symbol Resolution & Validation
-   **Goal:** The Relation Window should **only** update when the user clicks on a valid symbol. Clicking on whitespace, comments, or non-symbols should **NOT** clear the view; it should retain the last valid hierarchy.
-   **Step 1:** Call `vscode.prepareCallHierarchy` at the new cursor position.
    -   **Multiple Results:** If the API returns an array of items, use the **first item** as the candidate.
-   **Step 2 (Stability Check):** If a valid `CallHierarchyItem` is returned, compare it with the **Current Root Symbol**.
    -   If `New Root` is identical to `Current Root` (same `uri`, same `name`, and `range` overlaps), **ignore the update**. This prevents the tree from redrawing/collapsing while the user navigates within the same function.
-   **Step 3 (Update):** If it is a *new* valid symbol, update the Relation Window.
    -   **Empty Results:** The view updates even if the symbol has no incoming/outgoing calls (it will display the Root with no children).
-   **Step 4 (Failure/No Symbol):** If `undefined` or empty is returned, **abort the update** (maintain the last valid state).
    -   **Exception (Manual Refresh):** If the update was triggered manually (Refresh button), proceed to **Data Fetching Strategy** (Section 6.2.3) to attempt a Reference lookup using the word under the cursor.

#### 6.2.3 Data Fetching Strategy (Parallel & Hybrid)
The Relation Window employs a **Parallel Execution Strategy** to combine the precision of LSP with the breadth of Deep Search.

1.  **Parallel Execution:**
    -   Upon triggering a search, the extension launches two asynchronous tasks simultaneously:
        -   **Task A: LSP Hierarchy** (`vscode.provideIncomingCalls` / `vscode.provideOutgoingCalls`).
        -   **Task B: Deep Search** (Database + Ripgrep).
    -   **UI Feedback:**
        -   **Window Progress:** Show an indeterminate blue progress bar (`vscode.window.withProgress` with `location: Window`) immediately.
        -   **Webview:** Show a "Loading..." state or skeleton loader.

2.  **Result Merging (First-Paint & Append):**
    -   **First Response (Usually LSP):**
        -   As soon as the first task (usually LSP) completes, **immediately** render its results in the Webview.
        -   Do **not** wait for the second task.
    -   **Second Response (Usually Deep Search):**
        -   When the second task completes, perform **Hybrid Merge**:
            -   Compare new items against the already displayed items (matching by File Path and Range).
            -   **Merge Logic:**
                -   **LSP + Deep Search:** If an item exists from LSP and a matching Deep Search result arrives, **update the Range** to use the Deep Search's precise location (often more accurate than LSP's block range), but keep the LSP's semantic definition info.
                -   **Deep Search + LSP:** If an item exists from Deep Search and a matching LSP result arrives, **upgrade the item** with LSP's definition info (`targetUri`, `targetRange`) and remove the "Deep Search" visual marker.
        -   **Append:** Add any completely new items to the list.
        -   **Visual Distinction:** Mark pure Deep Search results (e.g., different icon color) to indicate they are text-based matches.
    -   **Completion:** Once both tasks are done (or failed), hide the progress bar.

3.  **Deep Search Logic:**
    -   **Pre-check:**
        -   Check if the **Symbol Database** is available. If not, skip Deep Search.
    -   **Incoming Calls (Callers):**
        1.  **Ripgrep:** Search workspace for `Symbol Name`.
        2.  **Map:** For each match `(File, Line)`, query DB to find the "Enclosing Symbol" (the function containing that line).
    -   **Outgoing Calls (Callees):**
        1.  **Read Body:** Read source code of the current function.
        2.  **Tokenize:** Extract words/tokens.
        3.  **DB Query:** Find symbols in the DB that match these tokens.

4.  **Error Handling & Cancellation:**
    -   **Cancellation:** If the user moves the cursor again (triggering a new Debounce) or manually cancels, **abort** both running tasks immediately.
    -   **Database Error:** If the DB is busy or corrupt, catch the error silently and return empty results for Deep Search. Do **not** block LSP results.

#### 6.2.4 View Content & Data Protocol
- **Tree Structure:**
    -   **Lazy Loading:** Initial fetch retrieves only the first level of children. Subsequent levels are fetched dynamically when the user expands a node.
    -   **Root:** The symbol under cursor.
    -   **Children:** The callers (or callees).
    -   **Aggregation & Display Logic:**
        -   **Incoming Calls (Callers):**
            -   **One Node Per Call Site:** Displays every location where the root symbol is called. If `Function B` calls `Function A` twice, `Function B` appears twice (pointing to different lines).
            -   **Sorting:**
                -   **Root Name Match First:** Callers whose name matches the Root Symbol's name (e.g., recursive calls or same-named functions) are listed first.
                -   **Matching Logic:** Uses regex `/[a-zA-Z0-9_]+/` to extract the core name for comparison.
                -   **Others:** Remaining callers follow.
            -   **Filtering:**
                -   **Deduplication:** Identical call sites (same URI + Range) are merged.
                -   **Self-Reference:** Callers that are identical to the Root Node (same URI + Range) are filtered out (to prevent immediate infinite recursion in the view).
        -   **Outgoing Calls (Callees):**
            -   **Display Logic:** Displays symbols called by the root.
            -   **Ambiguity Handling (Multiple Definitions):**
                -   **Scenario:** A called symbol (e.g., `func()`) might resolve to multiple definitions (overloads, dynamic dispatch).
                -   **Display:** The view groups these by definition.
                -   **Suffix:** Appends `(1/n)`, `(2/n)` to the name to distinguish different definitions of the same symbol.
            -   **Jump to Definition:**
                -   Items contain the `targetUri` of the definition.
                -   Users can right-click and select "Jump to Definition" to navigate to the *callee's definition* instead of the *call site*.

    -   **Configurable Behaviors (Outgoing Only):**
        -   **Remove Duplicates:**
            -   **Enabled (Default):** If the root calls the same function multiple times (e.g., `print()` called at line 10 and 20), the view merges them into a **single node** (pointing to the first call site).
            -   **Disabled:** The view displays **multiple nodes**, one for each call site.
        -   **Show Definition Path:**
            -   **Disabled (Default):** The detail text (grayed out) shows the **Call Site** location (file/line where the function is called).
            -   **Enabled:** The detail text shows the **Definition** location (file/line where the function is defined).

- **Communication Protocol:**
    -   **Frontend Request (Client -> Extension):**
        -   `resolveHierarchy`: `{ command: 'resolveHierarchy', itemId: string, direction: 'incoming'|'outgoing' }` - Request children for a node.
        -   `setDirection`: `{ command: 'setDirection', direction: 'incoming'|'outgoing' }` - Switch view direction.
        -   `refreshRelation`: `{ command: 'refreshRelation' }` - Trigger manual refresh.
        -   `navigateHistory`: `{ command: 'navigateHistory', action: 'back'|'forward', index: number }` - History navigation.
        -   `jump`: `{ command: 'jump', uri: string, range: Range }` - Open file at location.
        -   `saveSettings`: `{ command: 'saveSettings', settings: RelationSettings }` - Update view settings.
        -   `toggleLock`: `{ command: 'toggleLock', locked: boolean }` - Toggle auto-sync lock.
    -   **Backend Response (Extension -> Client):**
        -   `updateRelation`: `{ command: 'updateRelation', root: RelationItem, children: RelationItem[], ... }` - Full view update (Root change).
        -   `updateNode`: `{ command: 'updateNode', itemId: string, children: RelationItem[] }` - Partial update (Node expansion).
        -   `setLoading`: `{ command: 'setLoading', isLoading: boolean }` - Toggle loading spinner.
        -   `setSettings`: `{ command: 'setSettings', settings: RelationSettings }` - Sync settings state.
    -   **Cache:** The Backend must maintain a `Map<string, CallHierarchyItem>` to map the `itemId` back to the actual VS Code object needed for API calls.
        -   **Cache Clearing:** The cache MUST be cleared whenever the **Root Symbol** changes (i.e., when `updateRelation` is sent). This prevents memory leaks from accumulated items.
        -   **Unique IDs:** `itemId` MUST be a unique identifier (e.g., UUID or incrementing counter) to ensure that even if the same function appears multiple times in the tree (recursion), each node is treated as a distinct entity by the React frontend.
- **Display Info:**
    -   **Icon:** Symbol Kind icon.
    -   **Name:** Function name.
    -   **Detail:** File path or line number (grayed out).
    -   **Deep Search Indicator:** A lightning bolt icon (`$(zap)`) is displayed next to the symbol icon if the result was found via Deep Search (text scanning) rather than LSP.
-   **Stale Data Handling:**
    -   Since the view persists after file closure, the cached `CallHierarchyItem` (specifically its `Range`) may become outdated if the underlying file is modified.
    -   **Strategy:** When `resolveHierarchy` is called, wrap the API call in a try-catch block. If VS Code throws an error (e.g., "Invalid Range"), the extension currently:
        1.  Logs the error (Warning level).
        2.  Returns empty results (Silent Failure).
        3.  The frontend stops the loading spinner but displays no new children.

#### 6.2.5 Concurrency & Lifecycle
-   **Race Condition Handling:**
    -   Assign a unique `requestId` (incrementing integer) to each hierarchy fetch request.
    -   The Frontend stores the `lastRequestId` of the most recently processed update.
    -   When the Backend responds, it includes the `requestId`.
    -   The Frontend discards any response where `response.requestId < lastRequestId`. This prevents "stale" results (from older requests that finished late) from overwriting newer ones.

#### 6.2.6 Both Directions Mode
-   **Trigger:** Enabled via `relationWindow.showBothDirections` setting.
-   **Structure:**
    -   The Root Symbol remains the top-level node.
    -   Immediate children are two **Virtual Category Nodes**:
        -   `INCOMING CALLS (CALLERS)`
        -   `OUTGOING CALLS (CALLEES)`
    -   These nodes are purely organizational (`isCategory: true`) and do not represent actual symbols.
-   **Data Fetching:**
    -   Fetches both Incoming and Outgoing hierarchies in parallel (`Promise.all`).
    -   Populates the respective Category Node with the results.
-   **Auto-Expansion:**
    -   If `relationWindow.autoExpandBothDirections` is enabled, the two Category Nodes are automatically expanded to show their children upon loading.

## 7. Part III: Reference Window (Lookup References)

### 7.1 UI/UX Design
- **Location:**
    -   **Editor Area**: The view opens as a standard editor tab (`vscode.WebviewPanel`).
    -   **Goal:** Provide a dedicated, spacious workspace for reviewing references without cramping the sidebar or panel.
- **Layout:**
    -   **Header:** Collapsible section displaying the Title (e.g., "References: MySymbol") and Total Count. Clicking toggles the visibility of the Toolbar.
    -   **Toolbar:** Contains three input fields (visible when Header is expanded):
        1.  **Search References:** Main input for Manual Search text.
        2.  **Files to Include:** Glob patterns to whitelist files (e.g., `src/**/*.ts`).
        3.  **Files to Exclude:** Glob patterns to blacklist files (e.g., `**/*.test.ts`).
    -   **Result List:** Grouped by file path.
- **Trigger:**
    -   **Method 1:** Click "Lookup References" button in the Relation Window toolbar.
    -   **Method 2:** Right-click in the editor and select "Lookup References".
    -   **Method 3:** Click the "Search" button in the Reference Window (uses input box content).
    -   **Note:** The Reference Window does **NOT** update automatically on cursor movement. It only updates when explicitly triggered via one of the above methods.
    -   **Behavior:** When triggered, the Reference Window automatically opens (if not already open) and reveals itself in the active editor group.
- **Interaction:**
    -   **Click:** Selects the reference item and shows a **Code Preview** in the list item.
    -   **Double Click / Enter:** Jumps to the location in the editor.
    -   **Keyboard Navigation:**
        -   `Arrow Up/Down`: Navigate through the reference list.
        -   `Enter`: Open the selected reference in the editor.
    -   **Close/Hide:** Standard editor tab closing behavior (`Ctrl+W` or click 'x').

### 7.2 Functional Requirements

#### 7.2.1 Data Fetching Strategy
The strategy depends on how the search is triggered, but **both** methods respect the "Files to Include" and "Files to Exclude" filters set in the UI.

1.  **Contextual Lookup (Triggered by Cursor/Menu):**
    -   **Parallel Execution:** Executes **LSP Reference Provider** (using cursor position) and **Deep Search** (using symbol name) simultaneously.
    -   **Filter Application:** The Deep Search component explicitly applies the current Include/Exclude patterns from the Reference Window's state.
    -   **Merging:** Results are merged, with LSP taking precedence for definitions.

2.  **Manual Search (Triggered by Input Box):**
    -   **Deep Search Only:** Since there is no reference cursor position, **only Deep Search** is performed.
    -   **Scope:** Searches for the text string across the workspace, strictly applying the Include/Exclude patterns.
    -   **LSP Skipped:** LSP Reference Provider is **NOT** called.

3.  **State Persistence:**
    -   The Include/Exclude patterns are persisted in `workspaceState`. This means a Contextual Lookup triggered from the editor will use the filters last set by the user in the Reference Window UI.

4.  **Deduplication & Merging:**
    -   **LSP Results:** Displayed with standard styling.
    -   **Deep Search Results:** Displayed with a distinct background color (e.g., light yellow/blue) to indicate they are text matches.
    -   **Intersection:** If a result appears in *both* LSP and Deep Search:
        -   It is treated as a confirmed reference.
        -   The "Deep Search" background color is **removed**.
        -   Duplicates are merged into a single entry.


#### 7.2.2 Code Preview
-   **Mechanism:**
    -   When a reference is found, the extension reads the file content (using `vscode.workspace.openTextDocument` or `fs.readFile`).
    -   Extracts the line of code containing the reference.
    -   Displays this line in the Reference Window list item, allowing the user to see context without opening the file.

## 8. Configuration Settings

### 8.1 Window Enablement
- `symbolWindow.enable`: (Default: `true`) Enable the Symbol Window.
- `relationWindow.enable`: (Default: `true`) Enable the Relation Window.
- `referenceWindow.enable`: (Default: `true`) Enable the Reference Window.

### 8.2 Shared Settings
- `shared.enableDatabaseMode`: (Default: `true`) Enable Database Mode (SQLite) for instant project-wide search.
- `shared.database.cacheSizeMB`: (Default: `64`) SQLite cache size in MB.
- `shared.indexingBatchSize`: (Default: `15`) Number of files to process in each indexing batch.
- `shared.includeFiles`: (Default: `""`) Glob patterns to include in indexing.
- `shared.excludeFiles`: (Default: `**/*.md, ...`) Glob patterns to exclude from indexing.

### 8.3 Symbol Window
- `symbolWindow.symbolParsing.mode`: (Default: `auto`) Controls how symbol names are parsed (`auto`, `c-style`, `default`).
- `symbolWindow.splitView`: (Default: `false`) Split Symbol Window into "Current Document" and "Project Symbols" views.
- `symbolWindow.enableHighlighting`: (Default: `true`) Enable keyword highlighting in search results.

### 8.4 Relation Window
- `relationWindow.autoSearch`: (Default: `false`) Automatically search for relations when the cursor moves.
- `relationWindow.showBothDirections`: (Default: `false`) Show both incoming and outgoing calls.
- `relationWindow.autoExpandBothDirections`: (Default: `false`) Automatically expand nodes when showing both directions.
- `relationWindow.enableDeepSearch`: (Default: `true`) Enable Deep Search (text scanning) fallback.

## 9. Commands

### 9.1 Symbol Window
- `symbol-window.refresh`: Refresh the current view.
- `symbol-window.toggleMode`: Toggle between Current and Project modes.
- `symbol-window.focusProjectSearch`: Focus the Project search bar.
- `symbol-window.focusCurrentSearch`: Focus the Current Document search bar.
- `symbol-window.deepSearch`: Trigger Deep Search.
- `symbol-window.rebuildIndex`: Incremental index rebuild.
- `symbol-window.rebuildIndexFull`: Full index rebuild.

### 9.2 Relation Window
- `relation-window.refresh`: Refresh the relation tree.
- `relation-window.manualSearch`: Manually trigger search.
- `relation-window.toggleDirection`: Toggle between Callers/Callees.
- `relation-window.lookupReference`: Trigger "Lookup References".
- `relation-window.jumpToDefinition`: Jump to definition.

### 9.3 Reference Window
- `reference-window.next`: Go to next reference.
- `reference-window.prev`: Go to previous reference.

## 10. Default Keyboard Shortcuts

| Command | Keybinding | Condition |
| :--- | :--- | :--- |
| **Symbol Window** | | |
| `symbol-window.focusProjectSearch` | `Ctrl+T` | `config.symbolWindow.enable` |
| `symbol-window.focusCurrentSearch` | `Ctrl+Shift+O` | `config.symbolWindow.enable` |
| **Relation Window** | | |
| `relation-window.manualSearch` | `Shift+Alt+H` | `config.relationWindow.enable` |
| `relation-window.lookupReference` | `Shift+Alt+F12` | `config.referenceWindow.enable` |
| **Reference Window** | | |
| `reference-window.prev` | `F1` | `reference-window.hasResults` |
| `reference-window.next` | `F2` | `reference-window.hasResults` |

## 11. Future Work & Known Issues

### 11.1 Code Residue (To Be Cleaned)
-   **Relation Window History:** The internal logic for history navigation (`history`, `navigateHistory`) remains in `RelationController.ts` but the UI buttons have been removed.
-   **Relation Window Lock:** The `isLocked` state variable remains in `RelationController.ts` but is no longer toggled via UI (replaced by `autoSearch` setting).

### 11.2 Planned Features
-   **Native Search API Integration:** Currently, this extension bundles `ripgrep` binaries for different platforms to support Deep Search features. This requires platform-specific builds. In the future, once VS Code's native `findTextInFiles` API stabilizes (moves out of proposal stage), we plan to:
    - Remove the bundled `ripgrep` binaries and dependencies.
    - Remove platform-specific build scripts.
    - Fully migrate to `vscode.workspace.findTextInFiles` for a lighter, more robust cross-platform experience.
-   **Deep Search Timeout:** Consider adding a timeout (e.g., 5s) for Deep Search tasks. Currently not implemented as it seems unnecessary (users prefer complete results).
-   **History Navigation UI:** Restore the Back/Forward buttons in the Relation Window toolbar to allow users to navigate through their browsing history (logic already exists in backend).
-   **Lock View UI:** Restore the "Lock" button to allow users to temporarily freeze the Relation Window on a specific symbol without disabling Auto-Sync globally.
-   **Stale Data Notification:** Implement a user-friendly notification (Toast) when `resolveHierarchy` fails due to stale data (e.g., "Invalid Range"), instead of failing silently.

### 11.3 History Management
-   **Concept:** The history records the **Root Symbol** (the subject of the view), not the entire tree state. Navigating history simply changes the "Current Subject" and re-fetches the hierarchy for it.
-   **Capacity:** Store up to **20** history entries.
-   **Entry Data:**
    -   **Internal State:** `{ root: CallHierarchyItem | string, label: string, context?: { uri, range } }`.
    -   **UI State:** `{ label: string, timestamp: number }`.
-   **Behavior:**
    -   **Push:** When the Root Symbol changes (via Auto-Sync or Manual Refresh), push the new state to the history stack.
    -   **Back/Forward:**
        1.  Retrieve the target entry from the stack.
        2.  **Validation:** Attempt to resolve the `rootSymbol`. If the file no longer exists or the symbol is invalid:
            -   **Abort:** Do not perform the jump.
            -   **Cleanup:** Remove the invalid entry from the history stack silently (no error toast).
            -   **Stay:** Remain on the current view.
        3.  Set the view's Root Symbol to the stored `rootSymbol`.
        4.  Trigger a hierarchy fetch (resolve children) for this root using the **current** direction.
        5.  **Note:** This action does **NOT** trigger a new "Push" to history.
    -   **Duplicate Check:** If the new Root is identical to the current one (same file, same range), do not push to history.