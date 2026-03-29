import * as vscode from 'vscode';
import { getNonce } from '../../shared/utils/general';

export class RelationWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'relation-window-view';

    private _view?: vscode.WebviewView;
    private _onMessage = new vscode.EventEmitter<any>();
    public readonly onMessage = this._onMessage.event;
    private _isReady: boolean = false;
    private _messagesQueue: any[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._isReady = false;
        this._messagesQueue = [];

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            if (data.command === 'ready') {
                this._isReady = true;
                while (this._messagesQueue.length > 0) {
                    const msg = this._messagesQueue.shift();
                    this.postMessage(msg);
                }
            }
            this._onMessage.fire(data);
        });
    }

    public postMessage(message: any) {
        if (!this._isReady) {
            this._messagesQueue.push(message);
            return;
        }
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public isVisible(): boolean {
        return this._view ? this._view.visible : false;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-relation.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'style.css'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'codicon.css'));

        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <!--
                    Use a content security policy to only allow loading images from https or from our extension directory,
                    and only allow scripts that have a specific nonce.
                -->
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <link href="${codiconsUri}" rel="stylesheet">
                <title>Relation Window</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
