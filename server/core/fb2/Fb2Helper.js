const fs = require('fs-extra');
const iconv = require('iconv-lite');
const {isUtf8} = require('buffer');
const textUtils = require('./textUtils');

const Fb2Parser = require('../fb2/Fb2Parser');
const sax = require('../xml/sax');
const utils = require('../utils');
const {t} = require('../i18n');

class Fb2Helper {
    async decompressIfNeeded(data) {
        if (data && data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b)
            return await utils.gunzipBuffer(data);

        return data;
    }

    checkEncoding(data) {
        if (!Buffer.isBuffer(data) || !data.length)
            return data;

        // A BOM or the XML byte order is reliable even when a language-based
        // detector mistakes UTF-16 for a single-byte encoding.
        let encoding = '';
        if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0x3c && data[1] === 0 && data[3] === 0))
            encoding = 'utf-16le';
        else if ((data[0] === 0xfe && data[1] === 0xff) || (data[0] === 0 && data[1] === 0x3c && data[2] === 0))
            encoding = 'utf-16be';

        if (!encoding) {
            const head = data.subarray(0, 1024).toString('latin1');
            const declaration = head.match(/^\s*<\?xml\b[^?]*\?>/i);
            const declared = declaration && declaration[0].match(/\bencoding\s*=\s*(['"])([^'"]+)\1/i);
            // FLibrary can retain a legacy declaration on UTF-8 bytes. Validate
            // the bytes first; otherwise honour XML instead of guessing by prose.
            if (isUtf8(data)) {
                // Already normalized UTF-8: decoding and encoding again would return the same bytes
                // and costs ~0.3 s on a 14 MB book.
                if (data[0] === 0x3c && (!/^<\?xml\b/i.test(head) || (declaration && (!declared || declared[0] === 'encoding="utf-8"'))))
                    return data;
                encoding = 'utf-8';
            } else if (declared && !/^utf-?8$/i.test(declared[2])) {
                if (!iconv.encodingExists(declared[2]))
                    throw new Error(t('errors.fb2UnsupportedEncoding', {encoding: declared[2]}));
                encoding = declared[2];
            } else {
                encoding = textUtils.getEncoding(data);
            }
        }

        let text = iconv.decode(data, encoding).replace(/^\uFEFF/, '').trimStart();
        text = text.replace(/^<\?xml\b[^?]*\?>/i, declaration =>
            declaration.replace(/\bencoding\s*=\s*(['"])[^'"]+\1/i, 'encoding="utf-8"'));
        return Buffer.from(text, 'utf8');
    }

    async getDescAndCover(bookFile) {
        let data = await fs.readFile(bookFile);
        data = await this.decompressIfNeeded(data);
        const text = this.checkEncoding(data).toString();

        // Дерево всей книги строим только по запросу: для обложки хватает поиска по тексту.
        let fb2 = null;
        return {
            ...this.findCover(text),
            get fb2() {
                if (!fb2) {
                    fb2 = new Fb2Parser();
                    fb2.fromString(text, {lowerCase: true});
                }
                return fb2;
            },
        };
    }

    // То же, что /description/title-info/coverpage/image и последний <binary> с этим id.
    findCover(text) {
        const result = {cover: null, coverExt: ''};
        const image = block(block(block(text, 'description'), 'title-info'), 'coverpage').match(/<image(?=[\s/>])[^>]*>/i);
        if (!image)
            return result;

        const root = text.match(/<fictionbook(?=[\s/>])[^>]*>/i);
        let ns = 'l';
        for (const [key, value] of (root ? tagAttrs(root[0]) : [])) {
            if (value == 'http://www.w3.org/1999/xlink') {
                ns = key.split(':')[1] || ns;
                break;
            }
        }
        const href = tagAttrs(image[0]).get(`${ns}:href`);
        if (!href)
            return result;

        const binaryId = (href[0] == '#' ? href.substring(1) : href);
        let binary = null;
        let binaryAttrs = null;
        const binaries = /<binary(?=[\s/>])[^>]*>/gi;
        for (let match; (match = binaries.exec(text));) {
            const attrs = tagAttrs(match[0]);
            if (attrs.get('id') === binaryId) {
                binary = match;
                binaryAttrs = attrs;
            }
        }
        if (!binary)
            return result;

        let coverType = binaryAttrs.get('content-type');
        coverType = (coverType == 'image/jpg' || coverType == 'application/octet-stream' ? 'image/jpeg' : coverType);
        result.coverExt = (coverType == 'image/png' ? '.png' : '.jpg');

        let base64 = '';
        if (!binary[0].endsWith('/>')) {
            const start = binary.index + binary[0].length;
            const close = /<\/binary\s*>/gi;
            close.lastIndex = start;
            const end = close.exec(text);
            base64 = text.slice(start, end ? end.index : text.length).trim();
        }
        result.cover = (base64 ? Buffer.from(base64, 'base64') : null);
        return result;
    }
}

function block(text, name) {
    const match = text.match(new RegExp(`<${name}(?=[\\s/>])[^>]*>[\\s\\S]*?</${name}\\s*>`, 'i'));
    return match ? match[0] : '';
}

// Атрибуты тега так же, как их читает XmlParser с lowerCase.
function tagAttrs(tag) {
    const tail = tag.replace(/^<[^\s/>]*/, '').replace(/\/?>$/, '');
    return new Map(Array.from(sax.getAttrsSync(tail, true).values(), attr => [attr.fn, attr.value]));
}

module.exports = Fb2Helper;
