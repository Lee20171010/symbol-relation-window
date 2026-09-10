import * as vscode from 'vscode';
import { ReferenceModel } from './ReferenceModel';
import { ReferenceWebviewProvider } from './ReferenceWebview';
import { previewLocation } from '../../shared/utils/navigation';

export class ReferenceController {
    private model: ReferenceModel;
    private view: ReferenceWebviewProvider;
    private context: vscode.ExtensionContext;

    // State
    private currentTitle: string = '';
    private currentReferences: vscode.Location[] = [];
    private deepSearchReferences: vscode.Location[] = [];
    private searchCts: vscode.CancellationTokenSource | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(context: vscode.ExtensionContext, viewProvider: ReferenceWebviewProvider) {
        this.context = context;
        this.model = new ReferenceModel();
        this.view = viewProvider;
        
        this.disposables.push(this.view.onMessage(this.handleMessage.bind(this)));

        // Register navigation commands
        this.disposables.push(
            vscode.commands.registerCommand('reference-window.next', () => {
                this.view.postMessage({ command: 'navigate', direction: 'next' });
            }),
            vscode.commands.registerCommand('reference-window.prev', () => {
                this.view.postMessage({ command: 'navigate', direction: 'prev' });
            })
        );
    }

    public findReferences(uri: vscode.Uri, position: vscode.Position) {
        // Helper to trigger lookup from other controllers
        // We need to get the word at position to set the title
        vscode.workspace.openTextDocument(uri).then(doc => {
            const range = doc.getWordRangeAtPosition(position);
            const word = range ? doc.getText(range) : 'Reference';
            this.lookupReference(uri, position, word);
        });
    }

    public async lookupReference(uri: vscode.Uri, position: vscode.Position, word: string) {
        // Ensure panel exists
        this.createOrShow();

        // Cancel previous search
        if (this.searchCts) {
            this.searchCts.cancel();
            this.searchCts.dispose();
        }
        this.searchCts = new vscode.CancellationTokenSource();
        const token = this.searchCts.token;

        this.currentTitle = word;
        this.deepSearchReferences = [];
        this.currentReferences = [];
        
        // Show loading state
        this.view.postMessage({ command: 'setLoading', isLoading: true });
        this.view.show([], [], this.currentTitle);

        // Get current filter state from webview if possible, or use saved state
        // Since we can't easily get state from webview synchronously, we rely on the webview to send us the state
        // But here we are triggered by extension command.
        // We should probably fetch the state from workspaceState or ask webview?
        // Asking webview is async and might be slow.
        // Let's try to read from workspaceState directly if we saved it there?
        // In ReferenceApp.tsx we do: vscode.setState(...) which saves to webview state, not workspaceState.
        // We need to persist these filters in workspaceState or globalState to access them here.
        
        // For now, let's just trigger the search without filters, and let the user refine it?
        // OR, we can update the App to send the current filters back when 'ready' or 'search' happens.
        // Actually, the best way is to store these filters in the extension context workspaceState as well.
        
        // Let's read from workspaceState
        const includePattern = this.context.workspaceState.get<string>('referenceWindow.includePattern') || '';
        const excludePattern = this.context.workspaceState.get<string>('referenceWindow.excludePattern') || '';

        // Run in parallel
        const lspPromise = this.fetchLspReferences(uri, position, token);
        const deepPromise = this.fetchDeepSearchReferences(includePattern, excludePattern, token);

        await Promise.allSettled([lspPromise, deepPromise]);
        
        if (token.isCancellationRequested) {
            return;
        }

        // Stop loading
        this.view.postMessage({ command: 'setLoading', isLoading: false });
    }

    public createOrShow() {
        if (this.currentPanel) {
            this.currentPanel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ReferenceWebviewProvider.viewType,
            'References',
            vscode.ViewColumn.Active, // Open in active group
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                    vscode.Uri.joinPath(this.context.extensionUri, 'dist')
                ]
            }
        );

        this.currentPanel = panel;
        this.view.setPanel(panel);
        
        vscode.commands.executeCommand('setContext', 'referenceWindow.exists', true);

        panel.onDidDispose(() => {
            this.currentPanel = undefined;
            vscode.commands.executeCommand('setContext', 'referenceWindow.exists', false);
        }, null, this.disposables);
    }

    private currentPanel: vscode.WebviewPanel | undefined;

    private async fetchLspReferences(uri: vscode.Uri, position: vscode.Position, token?: vscode.CancellationToken) {
        const refs = await this.model.getReferences(uri, position);
        if (token?.isCancellationRequested) {
            return;
        }
        this.currentReferences = refs || [];
        this.updateView();
    }

    private async fetchDeepSearchReferences(includePattern?: string, excludePattern?: string, token?: vscode.CancellationToken) {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath || !this.currentTitle) {
            return;
        }
        const results = await this.model.deepSearch(this.currentTitle, rootPath, includePattern, excludePattern);
        if (token?.isCancellationRequested) {
            return;
        }
        this.deepSearchReferences = results || [];
        this.updateView();
    }

    private updateView() {
        const lspKeys = new Set(this.currentReferences.map(r => this.getKey(r)));
        
        // Filter out deep search results that are already in LSP results
        const uniqueDeepRefs = this.deepSearchReferences.filter(r => !lspKeys.has(this.getKey(r)));
        
        const hasResults = this.currentReferences.length > 0 || uniqueDeepRefs.length > 0;
        vscode.commands.executeCommand('setContext', 'reference-window.hasResults', hasResults);

        this.view.show(this.currentReferences, uniqueDeepRefs, this.currentTitle);
    }

    private getKey(r: vscode.Location): string {
        return `${r.uri.fsPath}:${r.range.start.line}`;
    }
    
    private async handleMessage(message: any) {
        switch (message.command) {
            case 'deepSearch':
                // Deprecated manual trigger, but if called, use defaults
                await this.fetchDeepSearchReferences();
                break;
            case 'search':
                // Manual search from input box
                // Cancel previous search
                if (this.searchCts) {
                    this.searchCts.cancel();
                    this.searchCts.dispose();
                }
                this.searchCts = new vscode.CancellationTokenSource();
                const token = this.searchCts.token;

                this.currentTitle = message.query;
                this.currentReferences = []; 
                this.deepSearchReferences = [];
                
                this.view.postMessage({ command: 'setLoading', isLoading: true });
                this.view.show([], [], this.currentTitle);
                
                await this.fetchDeepSearchReferences(message.includePattern, message.excludePattern, token);
                
                if (token.isCancellationRequested) {
                    return;
                }

                this.view.postMessage({ command: 'setLoading', isLoading: false });
                break;
            case 'open':
                this.openFile(message.uri, message.range);
                break;
            case 'preview':
                if (message.uri && message.range) {
                    previewLocation(message.uri, message.range);
                }
                break;
            case 'updateFilters':
                // Save filters to workspace state so they persist across sessions and can be used by lookupReference
                this.context.workspaceState.update('referenceWindow.includePattern', message.includePattern);
                this.context.workspaceState.update('referenceWindow.excludePattern', message.excludePattern);
                break;
        }
    }

    private async runDeepSearch() {
        // Deprecated in favor of fetchDeepSearchReferences
        await this.fetchDeepSearchReferences();
    }

    private openFile(uriStr: string, range: any) {
        const uri = vscode.Uri.parse(uriStr);
        const start = new vscode.Position(range[0].line, range[0].character);
        const end = new vscode.Position(range[1].line, range[1].character);
        
        // Open in the active editor group (or beside if configured, but standard is active)
        // This might hide the reference window if it's in the same group, which is expected behavior for editor tabs.
        vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(start, end),
            preview: true
        });
    }
    
    public dispose() {
        this.currentPanel?.dispose();
        if (this.searchCts) {
            this.searchCts.cancel();
            this.searchCts.dispose();
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
