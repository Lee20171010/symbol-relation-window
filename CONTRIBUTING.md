# Contributing to Symbol Window

Thank you for your interest in contributing to Symbol Window! We welcome bug reports, feature requests, and pull requests.

## Development Setup

1.  **Prerequisites**:
    - Node.js (v16 or higher)
    - npm
    - Visual Studio Code

2.  **Clone the repository**:
    ```bash
    git clone https://github.com/Lee20171010/symbol-relation-window.git
    cd symbol-relation-window
    ```

3.  **Install dependencies**:
    ```bash
    npm install
    ```

4.  **Run the extension**:
    - Open the project in VS Code.
    - Press `F5` to start debugging. This will open a new "Extension Development Host" window with the extension loaded.

## Project Structure

The codebase follows a modular MVC-like pattern. Here is the breakdown of the folder structure and the responsibilities of key components:

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

## Build & Packaging

### Compilation
To compile the project manually:

```bash
npm run compile
```

To watch for changes:

```bash
npm run watch
```

### Cross-Platform Packaging
This extension uses a custom build script to handle cross-platform packaging of `ripgrep` binaries.

**Standard Development:**
For local development, simply run:
```bash
npm install
```
This will automatically download the `ripgrep` binary for your current platform via the standard `@vscode/ripgrep` post-install script.

**Packaging for Release:**
To package the extension for a specific platform (or all platforms), use the provided script. This script dynamically downloads the correct `ripgrep` binary from GitHub Releases and bundles it into the VSIX, allowing you to build for Linux/macOS even from a Windows machine.

```bash
# Package for current platform
npm run package:target

# Package for a specific target
node scripts/platform-publish.js package linux-x64
node scripts/platform-publish.js package darwin-arm64
```

### Publishing
To publish the extension to the VS Code Marketplace, you can use the same script with the `publish` action. This will package the extension for the specified target and immediately publish it.

```bash
# Publish for current platform
npm run publish:target -- -p <YOUR_TOKEN>

# Publish for a specific target
node scripts/platform-publish.js publish linux-x64 -p <YOUR_TOKEN>
node scripts/platform-publish.js publish darwin-arm64 -p <YOUR_TOKEN>
```

## Testing

We use `@vscode/test-electron` for integration tests.

```bash
npm test
```

See `TEST.md` for the manual test plan.

## Code Style

- We use **ESLint** for linting. Please ensure your code passes linting before submitting a PR.
- Keep code comments and documentation in **English**.

## License

By contributing, you agree that your contributions will be licensed under its MIT License.
