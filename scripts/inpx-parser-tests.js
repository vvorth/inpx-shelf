const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const InpxParser = require('../server/core/InpxParser');

function writeZip(file, entries) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        for (const [name, data] of Object.entries(entries))
            zip.addBuffer(Buffer.from(data), name);
        zip.end();
        zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

//_uid — инвариант: на него ссылаются списки, прогресс, Kobo и бэкапы. Хэши не менять никогда.
async function testInpxParserUidIsStable() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-parser-'));
    try {
        const file = path.join(dir, 'lib.inpx');
        const row1 = ['Булгаков,Михаил,Афанасьевич:', 'prose_classic:', 'Мастер и Маргарита', 'Классика', '3', '1001', '123456', '1001', '0', 'fb2', '2020-01-01', 'ru', '5', ''].join('\x04');
        const row2 = ['Le Guin,Ursula,:', 'sf_fantasy:', 'A Wizard of Earthsea', '', '', '1002', '2000', '1002', '1', 'epub', '2021-02-03', 'en', '', 'magic'].join('\x04');
        await writeZip(file, {
            'collection.info': 'Test',
            'fb2-001.inp': `${row1}\r\n${row2}\n`,
        });

        const books = [];
        await new InpxParser().parse(file, null, async chunk => books.push(...chunk));

        assert.deepStrictEqual(books.map(b => b._uid), [
            '4xwZGsGG0A5IwTfueWXH7cMo3vXKCs0yoFA3vByf56w=',
            '+yxTpV0XGP7woy/ZSs70t25rUpWfUyEapREuL+n/0RQ=',
        ]);
        assert.strictEqual(books[0].author, 'Булгаков Михаил Афанасьевич');
        assert.strictEqual(books[0].genre, 'prose_classic');
        assert.strictEqual(books[0].serno, 3);
        assert.strictEqual(books[0].folder, 'fb2-001.zip');
        assert.strictEqual(books[1].author, 'Le Guin Ursula');
        assert.strictEqual(books[1].del, 1);
        assert.strictEqual(books[1].keywords, 'magic');
    } finally {
        await fs.remove(dir);
    }
}

module.exports = [testInpxParserUidIsStable];
