//Текст и якоря читалки: plain text из HTML, подсветка совпадений, поиск фрагмента текста и узла-якоря.
//Работает с DOM (TreeWalker, caretPositionFromPoint), но не с состоянием компонента.

function normalizeReaderSearchText(text = '') {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// <template> разбирает HTML без загрузки и декодирования картинок (data: URL до мегабайт)
function parseInertHtml(html = '') {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    return template;
}

function stripHtml(html = '') {
    if (typeof document === 'undefined')
        return String(html || '');

    return String(parseInertHtml(html).content.textContent || '');
}

function highlightHtmlMatches(html = '', query = '') {
    const safeQuery = String(query || '').trim();
    if (!safeQuery || typeof document === 'undefined')
        return html;

    const host = parseInertHtml(html);
    const pattern = new RegExp(escapeRegExp(safeQuery), 'gi');
    const walker = document.createTreeWalker(host.content, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode())
        textNodes.push(walker.currentNode);

    for (const textNode of textNodes) {
        const value = String(textNode.nodeValue || '');
        if (!value.trim() || !pattern.test(value))
            continue;

        pattern.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match = pattern.exec(value);
        while (match) {
            const matchText = match[0];
            const matchIndex = match.index;
            if (matchIndex > lastIndex)
                fragment.appendChild(document.createTextNode(value.slice(lastIndex, matchIndex)));

            const mark = document.createElement('mark');
            mark.className = 'reader-search-hit';
            mark.textContent = matchText;
            fragment.appendChild(mark);
            lastIndex = matchIndex + matchText.length;
            match = pattern.exec(value);
        }

        if (lastIndex < value.length)
            fragment.appendChild(document.createTextNode(value.slice(lastIndex)));

        if (textNode.parentNode)
            textNode.parentNode.replaceChild(fragment, textNode);
    }

    return host.innerHTML;
}

function getReaderRootSearchText(root = null) {
    if (!root || typeof document === 'undefined' || typeof document.createTreeWalker !== 'function')
        return normalizeReaderSearchText(root && root.textContent ? root.textContent : '').toLowerCase();

    const parts = [];
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => (
                normalizeReaderSearchText(node.nodeValue || '').length
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT
            ),
        },
    );
    let current = walker.nextNode();
    while (current) {
        const text = normalizeReaderSearchText(current.nodeValue || '');
        if (text)
            parts.push(text);
        current = walker.nextNode();
    }

    return normalizeReaderSearchText(parts.join(' ')).toLowerCase();
}

function getHtmlReaderSearchText(html = '') {
    if (typeof document === 'undefined')
        return normalizeReaderSearchText(stripHtml(html || '')).toLowerCase();

    const host = document.createElement('div');
    host.innerHTML = String(html || '');
    return getReaderRootSearchText(host);
}

function getReaderTextPositionFromPoint(x = 0, y = 0) {
    if (typeof document === 'undefined')
        return null;

    if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(x, y);
        if (position && position.offsetNode)
            return {
                node: position.offsetNode,
                offset: Math.max(0, Math.round(Number(position.offset || 0) || 0)),
            };
    }

    if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(x, y);
        if (range && range.startContainer)
            return {
                node: range.startContainer,
                offset: Math.max(0, Math.round(Number(range.startOffset || 0) || 0)),
            };
    }

    return null;
}

function findTopLeftReaderTextPosition(root = null) {
    if (!root || typeof document === 'undefined' || typeof window === 'undefined' || typeof document.createTreeWalker !== 'function')
        return null;

    const rootRect = (typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null);
    if (!rootRect || rootRect.width <= 0 || rootRect.height <= 0)
        return null;

    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => (
                normalizeReaderSearchText(node.nodeValue || '').length
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT
            ),
        },
    );
    let bestRect = null;
    let current = walker.nextNode();

    while (current) {
        const range = document.createRange();
        range.selectNodeContents(current);
        const rects = Array.from(range.getClientRects());
        if (typeof range.detach === 'function')
            range.detach();

        for (const rect of rects) {
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;
            if (rect.bottom < rootRect.top || rect.top > rootRect.bottom)
                continue;
            if (rect.right < rootRect.left || rect.left > rootRect.right)
                continue;

            if (!bestRect || rect.top < bestRect.top || (Math.round(rect.top) === Math.round(bestRect.top) && rect.left < bestRect.left))
                bestRect = rect;
        }

        current = walker.nextNode();
    }

    if (!bestRect)
        return null;

    const points = [
        {x: bestRect.left + 1, y: bestRect.top + (bestRect.height / 2)},
        {x: bestRect.left + Math.min(12, Math.max(2, bestRect.width / 4)), y: bestRect.top + (bestRect.height / 2)},
        {x: rootRect.left + 2, y: bestRect.top + (bestRect.height / 2)},
    ];

    for (const point of points) {
        const position = getReaderTextPositionFromPoint(point.x, point.y);
        if (position && position.node && root.contains(position.node))
            return position;
    }

    return null;
}

//все текстовые узлы по порядку: смещения в тексте ленты считаются по ним
function getReaderTextNodes(root = null) {
    if (!root || typeof document === 'undefined' || typeof document.createTreeWalker !== 'function')
        return [];

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode())
        nodes.push(walker.currentNode);
    return nodes;
}

//прямоугольник символа; свёрнутые пробелы пропускаем
function getReaderTextRect(node = null, offset = 0) {
    if (!node || node.nodeType !== Node.TEXT_NODE || typeof document === 'undefined')
        return null;

    const length = String(node.nodeValue || '').length;
    const range = document.createRange();
    for (let index = Math.max(0, offset); index < Math.min(length, offset + 8); index++) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];
        if (rect && rect.height > 0)
            return rect;
    }
    return null;
}

//Первая строка текста ниже top: точка у левого края колонки даёт начало строки. Строку, видную меньше чем
//наполовину, пропускаем
function findReaderTextPositionBelow(root = null, left = 0, top = 0, bottom = 0) {
    if (!root || typeof root.contains !== 'function')
        return null;

    for (let y = top + 1; y < bottom; y += 4) {
        const position = getReaderTextPositionFromPoint(left, y);
        if (!position || !position.node || position.node.nodeType !== Node.TEXT_NODE || !root.contains(position.node))
            continue;

        const rect = getReaderTextRect(position.node, position.offset);
        if (!rect)
            continue;
        if (rect.top + (rect.height / 2) < top) {
            y = Math.max(y, rect.bottom - 3);
            continue;
        }
        return Object.assign(position, {top: rect.top});
    }
    return null;
}

function getReaderTextSnippetFromPosition(root = null, node = null, offset = 0) {
    if (!root || !node || node.nodeType !== Node.TEXT_NODE || typeof document === 'undefined' || typeof document.createTreeWalker !== 'function')
        return '';

    let text = String(node.nodeValue || '').slice(Math.max(0, Math.min(String(node.nodeValue || '').length, Math.round(Number(offset || 0) || 0))));
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (candidate) => (
                normalizeReaderSearchText(candidate.nodeValue || '').length
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT
            ),
        },
    );

    let found = false;
    let current = walker.nextNode();
    while (current && text.length < 260) {
        if (current === node) {
            found = true;
        } else if (found) {
            text += ` ${String(current.nodeValue || '')}`;
        }
        current = walker.nextNode();
    }

    const normalized = normalizeReaderSearchText(text);
    return normalized.length >= 12 ? normalized.slice(0, 180) : '';
}

function getReaderNodeAnchorId(node = null) {
    if (!node || typeof node.getAttribute !== 'function')
        return '';

    return String(node.getAttribute('id') || node.getAttribute('name') || '').trim();
}

function getReaderNodeTextSnippet(node = null) {
    if (!node)
        return '';

    const text = normalizeReaderSearchText(node.textContent || '');
    if (!text)
        return '';

    return text.slice(0, 180);
}

function normalizeReaderImageAnchor(src = '') {
    const safeSrc = String(src || '').trim();
    if (!safeSrc)
        return '';

    let normalized;
    try {
        const url = new URL(safeSrc, window.location.href);
        normalized = `${url.pathname}${url.search || ''}`;
    } catch(e) {
        normalized = safeSrc;
    }

    return `image:${normalized}`.slice(0, 220);
}

function getReaderNodeImageAnchor(node = null) {
    if (!node || typeof node.querySelector !== 'function')
        return '';

    const image = (String(node.tagName || '').toLowerCase() === 'img')
        ? node
        : node.querySelector('img');
    if (!image)
        return '';

    return normalizeReaderImageAnchor(image.getAttribute('src') || image.currentSrc || image.src || '');
}

function findReaderNodeByImageAnchor(root = null, imageAnchor = '') {
    if (!root || typeof root.querySelectorAll !== 'function')
        return null;

    const safeAnchor = String(imageAnchor || '').trim();
    if (!safeAnchor)
        return null;

    const images = Array.from(root.querySelectorAll('img'));
    const image = images.find((node) => normalizeReaderImageAnchor(node.getAttribute('src') || node.currentSrc || node.src || '') === safeAnchor);
    if (!image)
        return null;

    return image.closest('.reader-image-block, .reader-page-content, p, div') || image;
}

function isReaderHighlightContainerNode(node = null) {
    if (!node || !node.classList)
        return false;

    return [
        'reader-html',
        'reader-page-content',
        'reader-page-sheet',
        'reader-page-column-sheet',
    ].some(className => node.classList.contains(className));
}

function findReaderNodeByTextSnippet(root = null, textSnippet = '') {
    if (!root || typeof root.querySelectorAll !== 'function')
        return null;

    const safeSnippet = normalizeReaderSearchText(textSnippet).toLowerCase();
    if (!safeSnippet)
        return null;

    const needles = [
        safeSnippet.slice(0, 180),
        safeSnippet.slice(0, 120),
        safeSnippet.slice(0, 80),
        safeSnippet.slice(0, 48),
    ].filter((value) => value.length >= 24);
    if (!needles.length)
        return null;

    const nodes = Array.from(root.querySelectorAll('*')).reverse();
    for (const node of nodes) {
        if (node === root || isReaderHighlightContainerNode(node))
            continue;

        const text = normalizeReaderSearchText(node.textContent || '').toLowerCase();
        if (text && needles.some((needle) => text.includes(needle)))
            return node;
    }

    return null;
}

//Нижний край видимого содержимого: самый низкий прямоугольник непустых текстовых узлов и элементов.
//Одна мерка для разбивки страниц и для подстройки нижнего края, иначе они разойдутся. -Infinity, если мерить нечего
function getReaderContentBottom(root) {
    let maxBottom = -Infinity;
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {acceptNode: node => (node.nodeType !== Node.TEXT_NODE || String(node.nodeValue || '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)},
    );
    //один Range на все текстовые узлы: каждый живой Range браузер обновляет при правке документа
    const range = document.createRange();
    for (let current = walker.currentNode; current; current = walker.nextNode()) {
        let rects = [];
        if (current.nodeType === Node.TEXT_NODE) {
            range.selectNodeContents(current);
            rects = range.getClientRects();
        } else if (typeof current.getClientRects === 'function') {
            rects = current.getClientRects();
        }
        for (const rect of rects) {
            if (rect && rect.height > 0)
                maxBottom = Math.max(maxBottom, rect.bottom);
        }
    }
    if (typeof range.detach === 'function')
        range.detach();
    return maxBottom;
}

module.exports = {
    getReaderContentBottom,
    normalizeReaderSearchText,
    escapeRegExp,
    parseInertHtml,
    stripHtml,
    highlightHtmlMatches,
    getReaderRootSearchText,
    getHtmlReaderSearchText,
    getReaderTextPositionFromPoint,
    findTopLeftReaderTextPosition,
    getReaderTextNodes,
    getReaderTextRect,
    findReaderTextPositionBelow,
    getReaderTextSnippetFromPosition,
    getReaderNodeAnchorId,
    getReaderNodeTextSnippet,
    normalizeReaderImageAnchor,
    getReaderNodeImageAnchor,
    findReaderNodeByImageAnchor,
    isReaderHighlightContainerNode,
    findReaderNodeByTextSnippet,
};
