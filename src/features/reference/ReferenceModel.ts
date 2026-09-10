import * as vscode from 'vscode';
import { performDeepSearch } from '../../shared/utils/search';

export class ReferenceModel {
    public async getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        try {
            const refs = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                uri,
                position
            );
            return refs || [];
        } catch (e) {
            console.error('[Source Window] getReferences failed', e);
            return [];
        }
    }

    public async deepSearch(query: string, rootPath: string, includePattern?: string, excludePattern?: string): Promise<vscode.Location[]> {
        // Extract the first continuous sequence of word characters, allowing for:
        // - Namespaces (::) e.g. std::vector
        // - Member access (.) e.g. obj.member
        // - Pointer access (->) e.g. ptr->member
        const match = query.match(/[a-zA-Z0-9_]+(?:(?:\.|->|::)[a-zA-Z0-9_]+)*/);
        const cleanQuery = match ? match[0] : query;
        
        if (!cleanQuery) {
            return [];
        }

        return performDeepSearch({
            query: cleanQuery,
            cwd: rootPath,
            isCaseSensitive: true,
            isWordMatch: true,
            includePattern,
            excludePattern
        });
    }
}
