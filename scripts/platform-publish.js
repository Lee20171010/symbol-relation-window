const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const RIPGREP_VERSION = 'v13.0.0-10'; // Version used by @vscode/ripgrep 1.15.0+
const BASE_URL = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RIPGREP_VERSION}`;

// Map VS Code target to Ripgrep asset name
function getRipgrepAsset(target) {
    const map = {
        'win32-x64': 'ripgrep-v13.0.0-10-x86_64-pc-windows-msvc.zip',
        'win32-arm64': 'ripgrep-v13.0.0-10-aarch64-pc-windows-msvc.zip',
        'linux-x64': 'ripgrep-v13.0.0-10-x86_64-unknown-linux-musl.tar.gz',
        'linux-arm64': 'ripgrep-v13.0.0-10-aarch64-unknown-linux-gnu.tar.gz',
        'darwin-x64': 'ripgrep-v13.0.0-10-x86_64-apple-darwin.tar.gz',
        'darwin-arm64': 'ripgrep-v13.0.0-10-aarch64-apple-darwin.tar.gz'
    };
    return map[target];
}

// Map Node.js platform/arch to VS Code target
function getLocalTarget() {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'win32') {
        if (arch === 'x64') return 'win32-x64';
        if (arch === 'arm64') return 'win32-arm64';
    } else if (platform === 'linux') {
        if (arch === 'x64') return 'linux-x64';
        if (arch === 'arm64') return 'linux-arm64';
    } else if (platform === 'darwin') {
        if (arch === 'x64') return 'darwin-x64';
        if (arch === 'arm64') return 'darwin-arm64';
    }
    return null;
}

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            file.close();
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function prepareRipgrep(target) {
    const assetName = getRipgrepAsset(target);
    if (!assetName) {
        throw new Error(`No ripgrep asset found for target: ${target}`);
    }

    const downloadUrl = `${BASE_URL}/${assetName}`;
    const tempDir = path.join(os.tmpdir(), 'vscode-ripgrep-build');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    const archivePath = path.join(tempDir, assetName);
    const extractDir = path.join(tempDir, 'extracted');
    
    console.log(`[Build] Downloading ${assetName}...`);
    await downloadFile(downloadUrl, archivePath);

    console.log(`[Build] Extracting...`);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir);

    if (assetName.endsWith('.zip')) {
        // Use powershell to unzip on windows, or unzip command on linux/mac
        if (process.platform === 'win32') {
            execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}'"`);
        } else {
            execSync(`unzip '${archivePath}' -d '${extractDir}'`);
        }
    } else {
        // tar.gz
        execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`);
    }

    // Find the binary
    // Structure is usually: ripgrep-x.y.z-target/rg(.exe)
    const findBinary = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                const res = findBinary(fullPath);
                if (res) return res;
            } else if (file === 'rg' || file === 'rg.exe') {
                return fullPath;
            }
        }
        return null;
    };

    const binaryPath = findBinary(extractDir);
    if (!binaryPath) throw new Error('Could not find rg binary in extracted archive');

    // Target path in node_modules
    // We place it where @vscode/ripgrep expects it
    const targetDir = path.join(__dirname, '..', 'node_modules', '@vscode', 'ripgrep', 'bin');
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    } else {
        // Clean up existing binaries to prevent bloating (e.g. having both rg and rg.exe)
        const existingFiles = fs.readdirSync(targetDir);
        for (const file of existingFiles) {
            if (file === 'rg' || file === 'rg.exe') {
                fs.unlinkSync(path.join(targetDir, file));
            }
        }
    }
    
    const targetBinaryName = target.startsWith('win32') ? 'rg.exe' : 'rg';
    const targetPath = path.join(targetDir, targetBinaryName);

    console.log(`[Build] Placing binary at ${targetPath}`);
    fs.copyFileSync(binaryPath, targetPath);
    
    if (!target.startsWith('win32')) {
        fs.chmodSync(targetPath, 0o755);
    }
}

const ALL_TARGETS = [
    'win32-x64',
    'win32-arm64',
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64'
];

async function runTask(action, target, extraArgs) {
    console.log(`[Platform Build] Action: ${action}`);
    console.log(`[Platform Build] Target: ${target}`);

    // 1. Prepare Ripgrep for the target platform
    await prepareRipgrep(target);

    // 2. Run vsce
    const cmd = `npx vsce ${action} --target ${target} ${extraArgs}`;
    console.log(`[Platform Build] Executing: ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });

    console.log(`[Platform Build] Success for ${target}!`);
}

async function main() {
    // Usage: node platform-publish.js [action] [target] [extraArgs...]
    // action: package | publish
    // target: auto | all | win32-x64 | linux-x64 | ...
    
    const action = process.argv[2] || 'package';
    let target = process.argv[3] || 'auto';
    const extraArgs = process.argv.slice(4).join(' ');

    if (target === 'all') {
        console.log(`[Platform Build] Running ${action} for ALL targets...`);
        for (const t of ALL_TARGETS) {
            try {
                await runTask(action, t, extraArgs);
            } catch (error) {
                console.error(`[Platform Build] Failed for ${t}:`, error.message);
                process.exit(1);
            }
        }
        console.log(`[Platform Build] All targets processed successfully!`);
        return;
    }

    if (target === 'auto') {
        target = getLocalTarget();
        if (!target) {
            console.error(`Unsupported local platform: ${os.platform()}-${os.arch()}`);
            process.exit(1);
        }
    }

    try {
        await runTask(action, target, extraArgs);
    } catch (error) {
        console.error(`[Platform Build] Failed:`, error.message);
        process.exit(1);
    }
}

main();
