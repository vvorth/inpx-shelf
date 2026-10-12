//Преобразование FB2 в HTML читалки: оглавление, картинки (data: URL), примечания.
//Без DOM и состояния компонента, поэтому проверяется тестом в Node (scripts/reader-tests.js).
const he = require('he');
const Fb2Parser = require('../../../server/core/fb2/Fb2Parser');
const readerContent = require('../../../server/core/fb2/ReaderContent');

function normalizeBinaryType(type = '') {
    let result = String(type || '').trim().toLowerCase();
    if (result === 'image/jpg' || result === 'application/octet-stream')
        result = 'image/jpeg';
    return result;
}

function sanitizeContents(list = []) {
    return (Array.isArray(list) ? list : [])
        .map((item, index) => ({
            id: `section-${index + 1}`,
            title: decodeReaderText(item && item.title ? item.title : '').trim(),
        }))
        .filter((item) => item.title);
}

function extractReaderContents(parser) {
    const result = [];
    const getNodeText = (node) => {
        const parts = [];
        node.eachDeepSelf((item) => {
            if (item.type === parser.TEXT || item.type === parser.CDATA)
                parts.push(item.value);
        });

        return parts.join(' ').replace(/\s+/g, ' ').trim();
    };
    const walk = (sections, level = 0) => {
        for (const section of sections) {
            const titleNode = section.$$('/title/');
            const title = (titleNode && titleNode.count) ? getNodeText(titleNode) : '';
            if (title)
                result.push({title, level});

            const childSections = section.$$array('/section');
            if (childSections.length)
                walk(childSections, level + 1);
        }
    };

    for (const body of parser.$$array('/body')) {
        const attrs = body.attrs() || {};
        const bodyName = String(attrs.name || '').trim().toLowerCase();
        if (bodyName === 'notes')
            continue;

        walk(body.$$array('/section'));
    }

    return result;
}

function extractImageMap(parser) {
    const result = new Map();
    for (const node of parser.$$array('/binary')) {
        const attrs = (node.attrs() || {});
        const id = attrs.id;
        const contentType = normalizeBinaryType(attrs['content-type']);
        const src = readerContent.createReaderImageDataUrl(contentType, node.text());
        if (!id || !src)
            continue;

        result.set(String(id), src);
    }
    return result;
}

function decodeReaderText(value = '') {
    const source = String(value || '');
    if (!source)
        return '';

    return he.decode(source, {isAttributeValue: false});
}

function escapeHtml(value = '') {
    return decodeReaderText(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function resolveImageSrc(attrs = {}, imageMap) {
    const href = attrs.href || attrs['l:href'] || attrs['xlink:href'] || '';
    const id = String(href || '').replace(/^#/, '').trim();
    if (!id)
        return '';

    return imageMap.get(id) || '';
}

function resolveInternalReaderTarget(attrs = {}) {
    const href = String(attrs.href || attrs['l:href'] || attrs['xlink:href'] || '').trim();
    if (!href.startsWith('#'))
        return '';

    return href.replace(/^#/, '').trim();
}

function resolveReaderNodeId(attrs = {}) {
    return String(attrs.id || attrs['xml:id'] || attrs['l:id'] || attrs.name || '').trim();
}

function readerNodeIdAttribute(attrs = {}) {
    const nodeId = resolveReaderNodeId(attrs);
    return nodeId ? ` id="${escapeHtml(nodeId)}"` : '';
}

function renderInlineNodes(nodes = [], imageMap) {
    const parts = [];

    for (const raw of nodes) {
        const type = raw && raw[0];
        if (type === 2 || type === 3) {
            parts.push(escapeHtml(raw[1] || ''));
            continue;
        }

        if (type !== 1)
            continue;

        const name = String(raw[1] || '').toLowerCase();
        const attrs = Object.fromEntries(raw[2] || []);
        const children = raw[3] || [];

        if (name === 'strong') {
            parts.push(`<strong>${renderInlineNodes(children, imageMap)}</strong>`);
        } else if (name === 'emphasis') {
            parts.push(`<em>${renderInlineNodes(children, imageMap)}</em>`);
        } else if (name === 'style') {
            parts.push(`<span>${renderInlineNodes(children, imageMap)}</span>`);
        } else if (name === 'a') {
            const targetId = resolveInternalReaderTarget(attrs);
            const html = renderInlineNodes(children, imageMap);
            const idAttr = readerNodeIdAttribute(attrs);
            if (targetId) {
                const safeTarget = escapeHtml(targetId);
                parts.push(`<a${idAttr} class="reader-inline-link reader-note-link" href="#${safeTarget}" data-reader-target="${safeTarget}">${html}</a>`);
            } else {
                parts.push(`<span${idAttr} class="reader-inline-link">${html}</span>`);
            }
        } else if (name === 'image') {
            const src = resolveImageSrc(attrs, imageMap);
            if (src)
                parts.push(`<img src="${escapeHtml(src)}" class="reader-inline-image" alt="fb2-image">`);
        } else if (name === 'empty-line') {
            parts.push('<br>');
        } else {
            parts.push(renderInlineNodes(children, imageMap));
        }
    }

    return parts.join('');
}

function renderTitleNode(raw, imageMap, context = {}) {
    const children = raw[3] || [];
    const lines = [];

    for (const child of children) {
        if (child && child[0] === 1 && String(child[1] || '').toLowerCase() === 'p') {
            const html = renderInlineNodes(child[3] || [], imageMap).trim();
            if (html)
                lines.push(html);
        } else {
            const html = renderInlineNodes([child], imageMap).trim();
            if (html)
                lines.push(html);
        }
    }

    const titleHtml = lines.join('<br>');
    if (!titleHtml)
        return '';

    if (context.sectionTitle) {
        const state = (context.state || {sectionIndex: 0});
        let item = null;
        if (context.contentsAnchor !== false) {
            item = (context.contents || [])[state.sectionIndex] || null;
            if (item)
                state.sectionIndex++;
        }

        const idAttr = (item ? ` id="${item.id}"` : '');
        const level = Math.min(4, 2 + Math.max(0, context.depth || 0));
        return `<h${level}${idAttr} class="reader-anchored-heading reader-section-heading">${titleHtml}</h${level}>`;
    }

    return `<div class="reader-opening-title">${titleHtml}</div>`;
}

function renderBlockNodes(nodes = [], imageMap, context = {}) {
    const parts = [];

    for (const raw of nodes) {
        const type = raw && raw[0];
        if (type === 2 || type === 3) {
            const text = escapeHtml(raw[1] || '').trim();
            if (text)
                parts.push(`<p class="reader-paragraph">${text}</p>`);
            continue;
        }

        if (type !== 1)
            continue;

        const name = String(raw[1] || '').toLowerCase();
        const attrs = Object.fromEntries(raw[2] || []);
        const children = raw[3] || [];

        if (name === 'section') {
            const idAttr = readerNodeIdAttribute(attrs);
            parts.push(`<section${idAttr} class="reader-section-block">${renderBlockNodes(children, imageMap, {
                state: context.state,
                contents: context.contents,
                depth: (context.depth || 0) + 1,
                inSection: true,
                contentsAnchor: context.contentsAnchor !== false,
            })}</section>`);
        } else if (name === 'title') {
            parts.push(renderTitleNode(raw, imageMap, {
                state: context.state,
                contents: context.contents,
                depth: Math.max(0, (context.depth || 0) - 1),
                sectionTitle: !!context.inSection,
                contentsAnchor: context.contentsAnchor !== false,
            }));
        } else if (name === 'p') {
            parts.push(`<p${readerNodeIdAttribute(attrs)} class="reader-paragraph">${renderInlineNodes(children, imageMap)}</p>`);
        } else if (name === 'subtitle') {
            parts.push(`<h4${readerNodeIdAttribute(attrs)} class="reader-subtitle">${renderInlineNodes(children, imageMap)}</h4>`);
        } else if (name === 'epigraph') {
            parts.push(`<blockquote${readerNodeIdAttribute(attrs)} class="reader-epigraph">${renderBlockNodes(children, imageMap, {
                state: context.state,
                contents: context.contents,
                depth: context.depth || 0,
                inSection: false,
                contentsAnchor: context.contentsAnchor !== false,
            })}</blockquote>`);
        } else if (name === 'text-author') {
            parts.push(`<div${readerNodeIdAttribute(attrs)} class="reader-epigraph-author">${renderInlineNodes(children, imageMap)}</div>`);
        } else if (name === 'poem') {
            parts.push(`<div${readerNodeIdAttribute(attrs)} class="reader-poem">${renderBlockNodes(children, imageMap, context)}</div>`);
        } else if (name === 'stanza') {
            parts.push(`<div${readerNodeIdAttribute(attrs)} class="reader-stanza">${renderBlockNodes(children, imageMap, context)}</div>`);
        } else if (name === 'cite') {
            parts.push(`<blockquote${readerNodeIdAttribute(attrs)} class="reader-cite">${renderBlockNodes(children, imageMap, context)}</blockquote>`);
        } else if (name === 'image') {
            const src = resolveImageSrc(attrs, imageMap);
            if (src)
                parts.push(`<div class="reader-image-block"><img src="${escapeHtml(src)}" class="reader-inline-image" alt="fb2-image"></div>`);
        } else if (name === 'empty-line') {
            parts.push('<div class="reader-empty-line"></div>');
        } else {
            const fallback = renderBlockNodes(children, imageMap, context);
            if (fallback)
                parts.push(fallback);
        }
    }

    return parts.join('');
}

function buildReaderAnnotationHtml(parser, annotationNodes = []) {
    if (!Array.isArray(annotationNodes) || !annotationNodes.length)
        return '';

    return renderBlockNodes(annotationNodes, extractImageMap(parser), {
        state: {sectionIndex: 0},
        depth: 0,
        inSection: false,
        contentsAnchor: false,
    }).trim();
}

function createReaderNotesAnchorId(parser) {
    const baseId = 'reader-book-notes';
    const usedIds = new Set();
    parser.eachDeepSelf((node) => {
        if (node.type !== 1)
            return;

        const attrs = node.attrs();
        const nodeId = attrs && (attrs.get('id') || attrs.get('xml:id') || attrs.get('l:id') || attrs.get('name'));
        if (nodeId)
            usedIds.add(String(nodeId).trim());
    });

    let anchorId = baseId;
    let suffix = 2;
    while (usedIds.has(anchorId)) {
        anchorId = `${baseId}-${suffix}`;
        suffix += 1;
    }
    return anchorId;
}

//Возвращает HTML и id якоря «Примечания» ('' если примечаний нет)
function buildReaderHtml(parser, {contents = [], notesTitle = ''} = {}) {
    const parts = [];
    const imageMap = extractImageMap(parser);
    const state = {sectionIndex: 0};
    const notesAnchorId = createReaderNotesAnchorId(parser);
    let notesAnchorAdded = false;

    for (const body of parser.$$array('/body')) {
        const attrs = (body.attrs() || {});
        const bodyName = String(attrs.name || '').trim().toLowerCase();
        const bodyNode = body.rawNodes[0] || null;
        const html = renderBlockNodes((bodyNode && bodyNode[3]) || [], imageMap, {
            state,
            contents,
            depth: 0,
            inSection: false,
            contentsAnchor: bodyName !== 'notes',
        });

        if (bodyName === 'notes') {
            if (!String(html || '').trim())
                continue;

            const anchorAttribute = notesAnchorAdded ? '' : ` id="${escapeHtml(notesAnchorId)}"`;
            parts.push(`<section class="reader-notes"><h2${anchorAttribute}>${escapeHtml(notesTitle)}</h2>${html}</section>`);
            notesAnchorAdded = true;
        } else {
            parts.push(`<section class="reader-section">${html}</section>`);
        }
    }

    return {
        html: parts.join('\n'),
        notesAnchorId: notesAnchorAdded ? notesAnchorId : '',
    };
}

function createFb2Parser(source = '') {
    if (source instanceof Fb2Parser)
        return source;

    if (Array.isArray(source))
        return new Fb2Parser(source);

    if (source && typeof source === 'object') {
        if (Array.isArray(source.rawNodes))
            return new Fb2Parser(source.rawNodes);

        // Some API responses already send parsed FictionBook root nodes.
        if (source[0] && Array.isArray(source[0]))
            return new Fb2Parser(source);
    }

    const parser = new Fb2Parser();
    parser.fromString(String(source || ''), {
        lowerCase: true,
    });
    return parser;
}

module.exports = {
    normalizeBinaryType,
    sanitizeContents,
    extractReaderContents,
    extractImageMap,
    decodeReaderText,
    escapeHtml,
    buildReaderAnnotationHtml,
    createReaderNotesAnchorId,
    buildReaderHtml,
    createFb2Parser,
};
