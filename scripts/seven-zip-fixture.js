// Test archives in formats yazl cannot write (7z, PPMd zip), made with the same 7-Zip WebAssembly build the server reads them with.
const fs = require('fs-extra');
const path = require('path');
const SevenZip = require('7z-wasm/7zz.umd.js');

// entries: {name: string|Buffer}; args: 7-Zip switches such as ['-t7z'] or ['-tzip', '-mm=PPMd'].
async function sevenZipArchive(file, entries, args = ['-t7z']) {
    await fs.ensureDir(path.dirname(file));
    const input = await fs.mkdtemp(path.join(path.dirname(file), 'archive-input-'));
    try {
        for (const [name, value] of Object.entries(entries))
            await fs.outputFile(path.join(input, name), value);
        const output = [];
        const sz = await SevenZip({print: line => output.push(line), printErr: line => output.push(line)});
        sz.FS.mkdir('/in');
        sz.FS.mount(sz.NODEFS, {root: input}, '/in');
        sz.FS.mkdir('/out');
        sz.FS.mount(sz.NODEFS, {root: path.dirname(path.resolve(file))}, '/out');
        sz.FS.chdir('/in');
        const temp = `${path.basename(file)}.tmp`;
        let code;
        try {
            code = sz.callMain(['a', '-y', '-bd', ...args, `/out/${temp}`, '.']);
        } catch (e) {
            code = (e && Number.isInteger(e.status) ? e.status : 2);
        }
        if (code !== 0)
            throw new Error(`7-Zip fixture failed: ${output.join('\n')}`);
        await fs.move(path.join(path.dirname(file), temp), file, {overwrite: true});
    } finally {
        await fs.remove(input);
    }
}

module.exports = {sevenZipArchive};
