import * as vscode from 'vscode';

export async function previewLocation(uri: string | vscode.Uri, range: any) {
    try {
        let uriString = typeof uri === 'string' ? uri : uri.toString();

        // Handle remote URI format (WSL, SSH, Containers, etc.)
        // When running in a remote environment, vscode-context-window expects a vscode-remote:// URI
        if (vscode.env.remoteName) {
            const parsedUri = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
            if (parsedUri.scheme === 'file') {
                // Strategy 1: Try to get authority from current workspace
                // This works for SSH, Dev Containers, Codespaces, etc.
                const remoteFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'vscode-remote');
                
                if (remoteFolder) {
                    uriString = parsedUri.with({
                        scheme: 'vscode-remote',
                        authority: remoteFolder.uri.authority
                    }).toString();
                } 
                // Strategy 2: Fallback for WSL if no workspace or specific env var is present
                else if (vscode.env.remoteName === 'wsl') {
                    const distro = process.env.WSL_DISTRO_NAME;
                    if (distro) {
                        uriString = `vscode-remote://wsl+${distro}${parsedUri.path}`;
                    }
                }
            }
        }

        // Ensure range is in the correct format if it's an array or VS Code Range
        let targetRange = range;
        
        // Handle [start, end] array format if necessary (though usually it's an object with start/end)
        if (Array.isArray(range)) {
            targetRange = { start: range[0], end: range[1] };
        }

        // Convert 0-based range (VS Code standard) to 1-based range (expected by vscode-context-window)
        const oneBasedRange = {
            start: { 
                line: targetRange.start.line + 1, 
                character: targetRange.start.character + 1 
            },
            end: { 
                line: targetRange.end.line + 1, 
                character: targetRange.end.character + 1 
            }
        };

        await vscode.commands.executeCommand('vscode-context-window.navigateUri', uriString, oneBasedRange);
    } catch (e) {
        // Command might not be available
        console.debug('Preview command failed', e);
    }
}
