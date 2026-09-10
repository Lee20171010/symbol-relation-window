import * as vscode from 'vscode';
import * as path from 'path';

export class ReferenceWebviewProvider {
    public static readonly viewType = 'reference-window';
    private _panel?: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _onMessage = new vscode.EventEmitter<any>();
    public readonly onMessage = this._onMessage.event;

    // Cache last data to send on ready
    private _lastData: { references: any[], deepReferences: any[], title: string } | undefined;

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    public setPanel(panel: vscode.WebviewPanel) {
        this._panel = panel;

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };

        panel.webview.html = this.getHtmlForWebview(panel.webview);

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'ready') {
                if (this._lastData) {
                    this._panel?.webview.postMessage({
                        command: 'update',
                        ...this._lastData
                    });
                }
            } else {
                this._onMessage.fire(message);
            }
        });

        panel.onDidDispose(() => {
            this._panel = undefined;
        });
    }

    public dispose() {
        this._panel?.dispose();
        this._panel = undefined;
        this._lastData = undefined;
    }

    public postMessage(message: any) {
        this._panel?.webview.postMessage(message);
    }

    public async show(references: vscode.Location[], deepReferences: vscode.Location[], title: string) {
        // Prepare data
        const preparedRefs = await this.prepareData(references, false);
        const preparedDeepRefs = await this.prepareData(deepReferences, true);

        this._lastData = {
            references: preparedRefs,
            deepReferences: preparedDeepRefs,
            title
        };

        if (this._panel) {
            this._panel.reveal(undefined, true); // Preserve focus? No, we want to see it.
            this._panel.webview.postMessage({
                command: 'update',
                ...this._lastData
            });
        }
    }

    private async prepareData(locations: vscode.Location[], isDeep: boolean): Promise<any[]> {
        // Group by file to minimize file reads
        const grouped: Record<string, vscode.Location[]> = {};
        locations.forEach(loc => {
            const fsPath = loc.uri.fsPath;
            if (!grouped[fsPath]) {
                grouped[fsPath] = [];
            }
            grouped[fsPath].push(loc);
        });

        const result: any[] = [];
        for (const fsPath of Object.keys(grouped)) {
            let lines: string[] = [];
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
                lines = doc.getText().split('\n');
            } catch (e) { }

            grouped[fsPath].forEach(loc => {
                const line = loc.range.start.line;
                const preview = lines[line] ? lines[line].trim() : '';
                result.push({
                    uri: loc.uri.toString(),
                    fsPath: loc.uri.fsPath,
                    relativePath: vscode.workspace.asRelativePath(loc.uri),
                    range: {
                        start: { line: loc.range.start.line, character: loc.range.start.character },
                        end: { line: loc.range.end.line, character: loc.range.end.character }
                    },
                    preview: preview,
                    isDeep: isDeep
                });
            });
        }
        return result;
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-reference.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'style.css'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'codicon.css'));

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet" />
                <link href="${codiconsUri}" rel="stylesheet" />
                <title>References</title>
            </head>
            <body class="reference-window">
                <div id="root"></div>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
