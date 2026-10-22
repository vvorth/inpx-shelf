const fs = require('fs-extra');
const iconv = require('iconv-lite');
const {isUtf8} = require('buffer');
const textUtils = require('./textUtils');

const Fb2Parser = require('../fb2/Fb2Parser');
const sax = require('../xml/sax');
const utils = require('../utils');
const {t} = require('../i18n');

const {NODE, TEXT, CDATA, COMMENT} = new Fb2Parser();

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

    async readText(bookFile) {
        return this.checkEncoding(await this.decompressIfNeeded(await fs.readFile(bookFile))).toString();
    }

    async getDescAndCover(bookFile) {
        return this.findCover(await this.readText(bookFile));
    }

    // Странице книги: обложка, <description>, картинки, оглавление и статистика текста
    async getBookPageInfo(bookFile) {
        const text = await this.readText(bookFile);
        return {...this.findCover(text), ...this.pageInfo(text)};
    }

    // Один проход sax без дерева всей книги: дерево XmlParser.fromString (lowerCase) строится
    // только вне <body> и для картинок вкладки «Картинки» (до 18, без обложки); <body> первого
    // корневого узла даёт оглавление (кроме body name="notes"), эпиграф и счёт букв и слов.
    // Вложенность повторяет fromString: закрывающий тег снимает узел, только если совпал с верхним.
    pageInfo(text) {
        const parsed = [];
        const stack = [];
        const sections = [];
        const lines = [];
        const authors = [];
        const stats = {letters: 0, words: 0, pages: 0, images: 0};
        let firstBody = true;
        let coverId = null;
        let binaries = 0;

        const append = node => {
            const parent = stack[stack.length - 1];
            if (!parent)
                parsed.push(node);
            else if (parent.raw)
                (parent.raw[3] || (parent.raw[3] = [])).push(node);
        };
        const onText = (value, type) => {
            const top = stack[stack.length - 1];
            if (top && top.count) {
                countText(value, stats);
                if (top.collect)
                    top.collect.push(value);
            }
            append([type, value]);
        };

        sax.parseSync(text, {
            lowerCase: true,
            onStartNode: (tag, tail) => {
                if (tag == '?xml')
                    return;

                const parent = stack[stack.length - 1];
                const frame = {tag, raw: null, count: false, collect: null, kind: ''};
                let attrs = null;
                let build = !parent || !!parent.raw;
                if (parent) {
                    frame.count = parent.count;
                    frame.collect = parent.collect;
                }

                const inFirst = stack.length == 1 && parent.raw === parsed[0];
                if (stack.length == 1 && tag == 'body') {
                    build = false;
                    if (inFirst) {
                        frame.count = true;
                        frame.kind = 'body';
                        attrs = tailAttrs(tail);
                        frame.notes = String(attrs.get('name') || '').trim().toLowerCase() == 'notes';
                        frame.first = firstBody;
                        firstBody = false;
                    }
                } else if (stack.length == 1 && tag == 'binary') {
                    attrs = tailAttrs(tail);
                    if (inFirst && String(attrs.get('content-type') || '').toLowerCase().startsWith('image/'))
                        stats.images++;
                    // Обложка и картинки сверх 18 не нужны; пока первый <description> не пройден, id обложки неизвестен
                    if (coverId === null && (!inFirst || hasChild(parsed[0], 'description')))
                        coverId = findCoverId(parsed);
                    if (coverId !== null) {
                        if (attrs.get('id') === coverId || binaries >= 18)
                            build = false;
                        else
                            binaries++;
                    }
                } else if (parent && parent.kind) {
                    if (tag == 'section' && (parent.kind == 'section' || (parent.kind == 'body' && !parent.notes))) {
                        frame.kind = 'section';
                        frame.slot = {level: (parent.kind == 'section' ? parent.slot.level + 1 : 0), parts: null};
                        sections.push(frame.slot);
                    } else if (tag == 'title' && parent.kind == 'section' && !parent.slot.parts) {
                        frame.collect = parent.slot.parts = [];
                    } else if (tag == 'epigraph' && parent.kind == 'body' && parent.first) {
                        frame.kind = 'epigraph';
                    } else if (tag == 'p' && parent.kind == 'epigraph') {
                        lines.push(frame.collect = []);
                    } else if (tag == 'text-author' && parent.kind == 'epigraph' && !parent.author) {
                        authors.push(parent.author = frame.collect = []);
                    }
                }

                if (build) {
                    frame.raw = [NODE, tag, null, null];
                    if (!attrs && tail && tail.trim() !== '')
                        attrs = tailAttrs(tail);
                    if (attrs && attrs.size)
                        frame.raw[2] = Array.from(attrs);
                    append(frame.raw);
                } else if (parent.raw && !parent.raw[3]) {
                    // как в полном дереве: у родителя есть список детей, даже если всё из него отброшено
                    parent.raw[3] = [];
                }
                stack.push(frame);
            },
            onEndNode: tag => {
                if (stack.length && stack[stack.length - 1].tag === tag)
                    stack.pop();
            },
            onTextNode: value => {
                if (/\S/.test(value))
                    onText(value, TEXT);
            },
            onCdata: value => onText(value, CDATA),
            onComment: value => append([COMMENT, value]),
        });

        if (coverId === null)
            coverId = findCoverId(parsed);
        let images = 0;
        const keep = node => node[0] !== NODE || (node[1] === 'binary'
            ? new Map(node[2] || []).get('id') !== coverId && images++ < 18
            : node[1] !== 'body');
        const fb2 = parsed.map(node => (node[0] === NODE && Array.isArray(node[3])
            ? [node[0], node[1], node[2], node[3].filter(keep)] : node));

        stats.pages = (stats.words ? Math.max(1, Math.round((stats.words / 250) * 10) / 10) : 0);
        return {
            fb2,
            contents: sections.map(({parts, level}) => ({title: joinText(parts), level})).filter(item => item.title).slice(0, 200),
            annotationMeta: {
                epigraph: lines.map(joinText).filter(Boolean).slice(0, 12),
                epigraphAuthor: authors.map(joinText).find(Boolean) || '',
                stats,
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

// id обложки так же, как /description/title-info/coverpage/image в первом корневом узле
function findCoverId(rawNodes) {
    const parser = new Fb2Parser(rawNodes);
    const image = parser.$$('/description/title-info/coverpage/image');
    const root = rawNodes[0];
    let ns = 'l';
    for (const [key, value] of (root && root[0] === NODE && root[2]) || []) {
        if (value == 'http://www.w3.org/1999/xlink') {
            ns = key.split(':')[1] || ns;
            break;
        }
    }
    const href = String((image.count && (image.attrs() || {})[`${ns}:href`]) || '');
    return (href[0] == '#' ? href.substring(1) : href);
}

function hasChild(node, name) {
    return !!node && node[0] === NODE && Array.isArray(node[3]) && node[3].some(child => child[0] === NODE && child[1] === name);
}

// Текст узла, как его собирала страница книги: куски через пробел, пробелы схлопнуты
function joinText(parts) {
    return (parts ? parts.join(' ').replace(/\s+/g, ' ').trim() : '');
}

// Буквы и слова как у fullText.replace(/\s+/g, '') и split(/\s+/), но без копии всего текста книги
function countText(value, stats) {
    let inWord = false;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        // \s в JS
        const space = (c <= 0x20 ? (c == 0x20 || (c >= 0x09 && c <= 0x0d)) : (c >= 0xa0 && (c < 0x1680 ? c == 0xa0 : (c == 0x1680
            || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff))));
        if (space) {
            inWord = false;
        } else {
            stats.letters++;
            if (!inWord) {
                stats.words++;
                inWord = true;
            }
        }
    }
}

function block(text, name) {
    const match = text.match(new RegExp(`<${name}(?=[\\s/>])[^>]*>[\\s\\S]*?</${name}\\s*>`, 'i'));
    return match ? match[0] : '';
}

// Атрибуты тега так же, как их читает XmlParser с lowerCase.
function tagAttrs(tag) {
    return tailAttrs(tag.replace(/^<[^\s/>]*/, '').replace(/\/?>$/, ''));
}

function tailAttrs(tail) {
    return new Map(Array.from(sax.getAttrsSync(tail, true).values(), attr => [attr.fn, attr.value]));
}

module.exports = Fb2Helper;
