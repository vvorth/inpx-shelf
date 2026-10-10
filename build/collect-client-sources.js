// Copies every source file the client build can read into <outDir>, keeping
// repo-relative paths. Used by the Dockerfile so the webpack layer is keyed
// only on these files: server-only changes keep it cached, while a client
// import of any server module is picked up automatically.
//
// Starts from client/, shared/, build/ and root configs, then follows every
// quoted relative path ('./x', '../x') found in those files, transitively.
// Over-including is harmless (just less caching); built-ins only, since this
// runs before node_modules exist.
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2])
    throw new Error('Usage: node build/collect-client-sources.js <outDir>');

const rootEntries = ['client', 'shared', 'build', 'package.json', 'package-lock.json', '.babelrc'];
const scanExts = new Set(['.js', '.mjs', '.cjs', '.vue', '.json', '.css', '.html', '.template']);
const resolveSuffixes = ['', '.js', '.vue', '.json', '.mjs', '.cjs', '/index.js', '/index.vue'];
const relSpecRe = /['"`](\.{1,2}\/[^'"`\s]*)['"`]/g;

const collected = new Set();
const queue = [];

function add(file) {
    const rel = path.relative(rootDir, file);
    if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules') || collected.has(rel))
        return;
    collected.add(rel);
    queue.push(file);
}

function walk(entry) {
    if (!fs.existsSync(entry))
        return;
    if (fs.statSync(entry).isDirectory()) {
        for (const name of fs.readdirSync(entry))
            walk(path.join(entry, name));
    } else {
        add(entry);
    }
}

function resolveSpec(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec.split(/[?#]/)[0]);
    for (const suffix of resolveSuffixes) {
        const candidate = base + suffix;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
            return candidate;
    }
    return null;
}

for (const entry of rootEntries)
    walk(path.join(rootDir, entry));

while (queue.length) {
    const file = queue.pop();
    if (!scanExts.has(path.extname(file)))
        continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(relSpecRe)) {
        const resolved = resolveSpec(file, spec);
        if (resolved)
            add(resolved);
    }
}

for (const rel of collected) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.copyFileSync(path.join(rootDir, rel), dest);
    fs.chmodSync(dest, fs.statSync(path.join(rootDir, rel)).mode);
}

const outside = [...collected].filter(rel => !rootEntries.some(e => rel === e || rel.startsWith(e + path.sep)));
console.log(`collected ${collected.size} client build files; from outside client/shared/build: ${outside.sort().join(', ') || 'none'}`);
