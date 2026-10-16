//Пагинация режима страниц: замеры и разбивка текста на страницы, кэш разбивки, переход по страницам,
//поиск страницы по якорю или тексту. Своего состояния нет: поля живут в Reader, который наследует этот класс
//вместе с другими слоями (readerLayers в Reader.vue; vueComponent собирает методы и геттеры по цепочке прототипов).
//Массив страниц (pagedPages) - markRaw: реактивно только само поле, оно заменяется целиком,
//а циклы по тысячам страниц идут без прокси.
import {markRaw} from 'vue';
const readerTextAnchors = require('./readerTextAnchors');
const readerProgress = require('../../share/readerProgress');
const readerPaging = require('../../share/readerPaging');

const pagedPageTextCache = new WeakMap();

export default class ReaderPaginator {
    get activePagedPage() {
        if (!this.isPagedMode || !this.pagedPages.length)
            return null;

        return this.pagedPages[Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex))] || null;
    }

    get isDualPagedSpread() {
        const pageLeafWidth = Math.floor((this.pageFrameWidth - this.dualPageGap) / 2);
        return !!(
            this.isPagedMode
            && !this.isCompactLayout
            && this.activePreferences.pagedSpreadMode === 'dual'
            && this.availableReaderFrameWidth >= 760
            && pageLeafWidth >= 280
        );
    }

    get activePagedSpread() {
        if (!this.isDualPagedSpread)
            return [];

        const firstIndex = Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex));
        const pages = [0, 1].map((offset) => {
            const index = firstIndex + offset;
            const page = this.pagedPages[index] || null;
            return {
                index,
                empty: !page,
                html: page ? this.renderPagedPageHtml(page, index) : '',
                sectionId: page ? page.sectionId || '' : '',
            };
        });

        return pages;
    }

    get activePagedPageRenderedHtml() {
        const page = this.activePagedPage;
        if (!page)
            return '';

        return this.renderPagedPageHtml(page, this.currentPageIndex);
    }

    get pagedStep() {
        return this.isDualPagedSpread ? 2 : 1;
    }

    get pagedMetrics() {
        const pageOffsets = this.pageOffsets;
        const totalPages = Math.max(1, Math.ceil((this.pagedPages.length || pageOffsets.length) / this.pagedStep));
        const pageSize = 1;
        const maxScroll = Math.max(0, totalPages - 1);

        return {pageSize, maxScroll, totalPages, pageOffsets};
    }

    get pageOffsets() {
        if (!this.isPagedMode)
            return [0];

        const step = this.pagedStep;
        return (this.pagedPages.length
            ? this.pagedPages.filter((_, index) => index % step === 0).map((_, index) => index * step)
            : [0]);
    }

    get currentPagedPageIndex() {
        if (!this.isPagedMode)
            return 0;

        return Math.max(0, Math.min(this.totalPagedLogicalPages - 1, this.currentPageIndex));
    }

    get totalPagedLogicalPages() {
        return Math.max(1, this.pagedPages.length);
    }

    // Число страниц для доли прочитанного: пока остальные страницы размечаются в фоне - оценка
    get pagedProgressTotalPages() {
        if (!this.pagedPagesPartial)
            return this.totalPagedLogicalPages;
        return Math.max(this.totalPagedLogicalPages, Math.round(Number(this.pagedPagesEstimatedTotal || 0) || 0));
    }

    getPagedLayoutSignature() {
        if (!this.isPagedMode)
            return '';

        return [
            Math.round(Number(this.pageFrameWidth || 0) || 0),
            Math.round(Number(this.pageMeasureFrameWidth || 0) || 0),
            Math.round(Number(this.pageMinHeight || 0) || 0),
            Math.round(Number(this.currentDynamicBottomClipCompensation || 0) || 0),
            this.layoutSignatureForPreferences(this.activePreferences),
            this.readerSourceKey,
        ].join('|');
    }

    getPagedGeometrySignature() {
        if (!this.isPagedMode)
            return '';

        return [
            Math.round(Number(this.scrollerViewportWidth || 0) || 0),
            Math.round(Number(this.scrollerViewportHeight || 0) || 0),
            Math.round(Number(this.pageMeasureFrameWidth || 0) || 0),
            Math.round(Number(this.pageMinHeight || 0) || 0),
            Math.round(Number(this.currentDynamicBottomClipCompensation || 0) || 0),
        ].join('|');
    }

    getPagedLayoutCacheKey(layoutSignature = '', calibrationKey = '', geometrySignature = '') {
        const layout = String(layoutSignature || '').trim();
        const calibration = String(calibrationKey || '').trim();
        const geometry = String(geometrySignature || '').trim();
        if (!layout || !calibration || !geometry)
            return '';
        return `${layout}::${calibration}::${geometry}`;
    }

    takePagedLayoutCacheEntry(cacheKey = '') {
        const key = String(cacheKey || '').trim();
        if (!key || !this.pagedLayoutCache.has(key))
            return null;

        const entry = this.pagedLayoutCache.get(key) || null;
        this.pagedLayoutCache.delete(key);
        return entry;
    }

    storePagedLayoutCacheEntry(cacheKey = '', entry = null) {
        const key = String(cacheKey || '').trim();
        if (!key || !entry)
            return;

        this.pagedLayoutCache.delete(key);
        this.pagedLayoutCache.set(key, entry);
        while (this.pagedLayoutCache.size > this.pagedLayoutCacheLimit) {
            let leastUsefulKey = '';
            let leastUsefulScore = Infinity;
            for (const [candidateKey, candidate] of this.pagedLayoutCache.entries()) {
                const score = (candidate && candidate.type === 'complete')
                    ? 100
                    : Math.max(0, Number(candidate && candidate.buildProgressPercent) || 0);
                if (score >= leastUsefulScore)
                    continue;
                leastUsefulKey = candidateKey;
                leastUsefulScore = score;
            }
            if (!leastUsefulKey)
                break;
            this.pagedLayoutCache.delete(leastUsefulKey);
        }
    }

    // Текст страницы считается один раз на страницу текущей разбивки
    getPagedPageText(page = null) {
        const html = String((page && page.html) || '');
        if (!page)
            return '';
        const cached = pagedPageTextCache.get(page);
        if (cached && cached.html === html)
            return cached.text;
        const text = readerTextAnchors.stripHtml(html);
        pagedPageTextCache.set(page, {html, text});
        return text;
    }

    isBlankPagedPageUnits(units = []) {
        const html = (Array.isArray(units) ? units : []).join('');
        if (!String(html || '').trim())
            return true;

        if (/<img\b/i.test(html))
            return false;

        return !readerTextAnchors.stripHtml(html).replace(/\s+/g, '').trim();
    }

    getDeepestLastElement(root) {
        if (!root || !root.lastElementChild)
            return null;

        let node = root.lastElementChild;
        while (node && node.lastElementChild)
            node = node.lastElementChild;
        return node || null;
    }

    getPagedMeasureAvailableHeight(measureHost) {
        if (!measureHost || typeof window === 'undefined' || !window.getComputedStyle)
            return 0;

        const measureHtml = measureHost.querySelector('.reader-html');
        const htmlRect = (measureHtml && typeof measureHtml.getBoundingClientRect === 'function'
            ? measureHtml.getBoundingClientRect()
            : {height: 0});
        const hostStyle = window.getComputedStyle(measureHost);
        const htmlStyle = (measureHtml ? window.getComputedStyle(measureHtml) : null);
        const syncedStageRect = this.syncMeasureHostToStage();
        const hostRect = (typeof measureHost.getBoundingClientRect === 'function'
            ? measureHost.getBoundingClientRect()
            : {height: 0});
        const hostPaddingTop = parseFloat(hostStyle.paddingTop || '0') || 0;
        const hostPaddingBottom = parseFloat(hostStyle.paddingBottom || '0') || 0;
        const htmlPaddingTop = parseFloat((htmlStyle && htmlStyle.paddingTop) || '0') || 0;
        const htmlPaddingBottom = parseFloat((htmlStyle && htmlStyle.paddingBottom) || '0') || 0;
        const directHtmlHeight = Math.max(
            0,
            Math.round(Math.max(
                (measureHtml && measureHtml.clientHeight) || 0,
                htmlRect.height || 0,
            )),
        );
        const pageOuterHeight = Math.max(
            0,
            Math.round(Math.max(
                syncedStageRect.height || 0,
                hostRect.height || 0,
                this.pageMinHeight || 0,
                measureHost.clientHeight || 0,
            )),
        );
        const fallbackHeight = Math.max(0, Math.round(
            pageOuterHeight
            - hostPaddingTop
            - hostPaddingBottom
            - htmlPaddingTop
            - htmlPaddingBottom
        ));
        const rawAvailableHeight = (directHtmlHeight || fallbackHeight);
        const dynamicCompensation = Math.max(0, Math.round(Number(this.currentDynamicBottomClipCompensation || 0) || 0));
        const appliedDynamicCompensation = Math.min(
            dynamicCompensation,
            Math.max(0, rawAvailableHeight - 1),
        );
        const availableHeight = Math.max(0, rawAvailableHeight - appliedDynamicCompensation);

        this.pagedMeasureAvailableHeight = Math.round(availableHeight);
        this.pagedAppliedBottomClipCompensation = appliedDynamicCompensation;
        if (this.readerDebugEnabled) {
            this.readerDebug = Object.assign({}, this.readerDebug, {
                measureAvailableHeight: Math.round(availableHeight),
                baseBottomClipCompensation: 0,
                totalBottomClipCompensation: appliedDynamicCompensation,
                pagedContentSafetyInset: 0,
            });
        }
        return availableHeight;
    }

    get pagedContentSafetyInset() {
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.15, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const reserveLines = (this.isCompactLayout ? 1.9 : 1.25);
        const reserve = Math.ceil(fontSize * lineHeight * reserveLines);
        return Math.max((this.isCompactLayout ? 34 : 28), reserve);
    }

    measureElementContentInnerHeight(contentNode) {
        if (!contentNode || typeof window === 'undefined' || !window.getComputedStyle)
            return 0;

        const rootRect = contentNode.getBoundingClientRect();
        let maxBottom = Math.max(
            rootRect.top,
            rootRect.top + (contentNode.scrollHeight || 0),
            rootRect.top + (contentNode.offsetHeight || 0),
            rootRect.top + (contentNode.clientHeight || 0),
        );

        for (const node of Array.from(contentNode.querySelectorAll('*'))) {
            if (!node || typeof node.getBoundingClientRect !== 'function')
                continue;

            const rect = node.getBoundingClientRect();
            if (!rect || rect.height <= 0)
                continue;

            maxBottom = Math.max(maxBottom, rect.bottom);
        }

        const lastElement = this.getDeepestLastElement(contentNode);
        if (lastElement && typeof lastElement.getBoundingClientRect === 'function') {
            const lastRect = lastElement.getBoundingClientRect();
            if (lastRect && lastRect.height > 0) {
                const lastStyle = window.getComputedStyle(lastElement);
                const marginBottom = parseFloat(lastStyle.marginBottom || '0') || 0;
                maxBottom = Math.max(maxBottom, lastRect.bottom + Math.max(0, marginBottom));
            }
        }

        return Math.max(0, Math.ceil(maxBottom - rootRect.top));
    }

    measureContentInnerHeight(contentNode) {
        if (!contentNode || typeof window === 'undefined' || !window.getComputedStyle || typeof document.createRange !== 'function')
            return 0;

        const isMeasureNode = !!(contentNode.closest && contentNode.closest('.reader-page-sheet--measure'));
        if (isMeasureNode)
            return this.measureElementContentInnerHeight(contentNode);

        const rootRect = contentNode.getBoundingClientRect();
        let maxBottom = Math.max(rootRect.top, readerTextAnchors.getReaderContentBottom(contentNode));

        const lastElement = this.getDeepestLastElement(contentNode);
        if (lastElement && typeof lastElement.getBoundingClientRect === 'function') {
            const lastRect = lastElement.getBoundingClientRect();
            if (lastRect && lastRect.height > 0) {
                const lastStyle = window.getComputedStyle(lastElement);
                const marginBottom = parseFloat(lastStyle.marginBottom || '0') || 0;
                maxBottom = Math.max(maxBottom, lastRect.bottom + Math.max(0, marginBottom));
            }
        }

        return Math.max(0, Math.ceil(maxBottom - rootRect.top));
    }

    doesPagedMeasureOverflow(measureHost, measureHtml = null) {
        const measure = this.measurePagedOverflow(measureHost, measureHtml);
        return !!(measure && measure.overflow > 0);
    }

    // Насколько содержимое измерительного листа выше допустимого (overflow > 0 - не помещается)
    measurePagedOverflow(measureHost, measureHtml = null) {
        if (!measureHost)
            return null;

        const availableHeight = this.getPagedMeasureAvailableHeight(measureHost);
        if (!availableHeight)
            return null;

        const htmlNode = (measureHtml || measureHost.querySelector('.reader-html') || null);
        const contentNode = (
            (htmlNode && htmlNode.querySelector('.reader-page-content'))
            || htmlNode
            || measureHost
        );
        const measuredHeight = Math.max(
            contentNode.scrollHeight || 0,
            contentNode.offsetHeight || 0,
            contentNode.clientHeight || 0,
            this.measureContentInnerHeight(contentNode),
        );

        if (this.readerDebugEnabled) {
            this.readerDebug = Object.assign({}, this.readerDebug, {
                measureContentHeight: Math.round(measuredHeight),
                measureOverflowPx: Math.round(measuredHeight - availableHeight),
            });
        }

        return {overflow: measuredHeight - Math.max(0, availableHeight - 12)};
    }

    syncPagedProgress(save = false) {
        if (!this.isPagedMode)
            return;
        if (!this.pagedPages.length)
            return;
        if (!save && this.restorePending)
            return;

        const safeIndex = Math.max(0, Math.min(this.totalPagedLogicalPages - 1, this.currentPageIndex));
        const currentPage = this.pagedPages[safeIndex] || null;
        const sectionId = String((currentPage && currentPage.sectionId) || '').trim()
            || (this.contents[0] ? this.contents[0].id : '');
        const totalPages = this.pagedProgressTotalPages;
        const percent = (totalPages > 1 ? safeIndex / (totalPages - 1) : 0);
        const anchor = this.capturePagedReflowAnchor() || {};
        this.rememberStableReaderReflowAnchor(anchor);
        const textSnippet = String(anchor.textSnippet || '').trim();
        const textOffset = Number(anchor.textOffset);

        this.currentPageIndex = safeIndex;
        this.currentSectionId = sectionId;
        this.progress = Object.assign({}, this.progress, {
            // Отметка «прочитано» снимается, только когда читатель сам листает (save), а не при перестройке страниц
            percent: ((!save && readerProgress.isRead(this.progress)) ? 1 : percent),
            sectionId,
            pageIndex: safeIndex,
            textOffset: Number.isFinite(textOffset) ? textOffset : -1,
            textSnippet,
            updatedAt: new Date().toISOString(),
        });

        if (save) {
            this.writeStoredReaderProgress();
            this.queuePersistProgress();
        }
    }

    setCurrentPagedPage(index = 0, save = false) {
        if (!this.isPagedMode)
            return;
        if (save)
            this.clearPendingReaderNavigationRestore();

        const rawIndex = Math.max(0, Math.min(this.totalPagedLogicalPages - 1, Math.round(index)));
        const nextIndex = this.isDualPagedSpread ? rawIndex - (rawIndex % this.pagedStep) : rawIndex;
        const previousIndex = this.currentPageIndex;
        if (this.reflowPageStartOverride && Number(this.reflowPageStartOverride.pageIndex) !== nextIndex)
            this.reflowPageStartOverride = null;
        this.pageTurnDirection = (nextIndex < this.currentPageIndex ? -1 : 1);
        this.currentPageIndex = nextIndex;
        if (nextIndex !== previousIndex) {
            this.bottomClipPageActivityAt = Date.now();
            this.resetBottomClipCalibrationSample();
        }
        if (save) {
            this.$nextTick(() => {
                requestAnimationFrame(() => {
                    if (!this.isPagedMode || this.currentPageIndex !== nextIndex)
                        return;
                    this.syncPagedProgress(true);
                });
            });
        } else {
            this.syncPagedProgress(false);
        }
    }

    getPageIndexForSection(sectionId = '') {
        const safeId = String(sectionId || '').trim();
        if (!safeId)
            return -1;

        const directIndex = this.pagedPages.findIndex((page) => String(page.sectionId || '').trim() === safeId);
        if (directIndex >= 0)
            return directIndex;

        const sectionIndex = this.contents.findIndex((item) => item.id === safeId);
        if (sectionIndex < 0)
            return -1;

        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const pageSectionId = String((this.pagedPages[index] || {}).sectionId || '').trim();
            const pageSectionIndex = this.contents.findIndex((item) => item.id === pageSectionId);
            if (pageSectionIndex >= sectionIndex)
                return index;
        }

        return -1;
    }

    setPagedScroll(value = 0) {
        this.setCurrentPagedPage(value, false);
    }

    wrapPagedMeasureHtml(parts = []) {
        return `
            <div class="reader-page-content">
                ${parts.join('')}
                <div class="reader-page-spacer" aria-hidden="true"></div>
            </div>
        `;
    }

    // Блоки страницы в измерительном листе. Кандидат почти всегда отличается от прошлого замера только
    // хвостом (ещё один блок, другой кусок абзаца), поэтому заменяем только хвост: браузер перекладывает
    // один блок, а не всю страницу. Дерево то же, что даёт innerHTML = wrapPagedMeasureHtml(units)
    renderPagedMeasureUnits(measureHtml, units = []) {
        let state = this.pagedMeasureDom;
        if (!state || state.html !== measureHtml || !state.content || state.content.parentNode !== measureHtml) {
            measureHtml.innerHTML = this.wrapPagedMeasureHtml([]);
            const content = measureHtml.querySelector('.reader-page-content');
            state = this.pagedMeasureDom = {
                html: measureHtml,
                content,
                spacer: content.querySelector('.reader-page-spacer'),
                parser: document.createElement('div'),
                // Один Range на все замеры: каждый живой Range браузер обновляет при любой правке документа,
                // а новые копились бы до сборки мусора и делали дорогими remove/insertBefore
                range: document.createRange(),
                units: [],
                nodes: [],
            };
        }

        const list = (Array.isArray(units) ? units : []);
        let same = 0;
        while (same < list.length && same < state.units.length && state.units[same] === list[same])
            same += 1;
        for (let index = state.nodes.length - 1; index >= same; index -= 1) {
            for (const node of state.nodes[index])
                node.remove();
        }
        state.units.length = same;
        state.nodes.length = same;
        for (let index = same; index < list.length; index += 1) {
            state.parser.innerHTML = list[index];
            const nodes = Array.from(state.parser.childNodes);
            for (const node of nodes)
                state.content.insertBefore(node, state.spacer);
            state.units.push(list[index]);
            state.nodes.push(nodes);
        }
    }

    extractPagedContentUnits(html = '') {
        if (typeof(document) === 'undefined')
            return [];

        const host = document.createElement('div');
        host.innerHTML = String(html || '');
        const content = host.querySelector('.reader-page-content') || host;
        return Array.from(content.children || [])
            .filter((child) => !child.classList || !child.classList.contains('reader-page-spacer'))
            .map((child) => child.outerHTML || '')
            .filter((item) => String(item || '').trim());
    }

    // Уплотнение страниц телефона: в страницу index перетягиваются первые блоки следующей, пока помещаются.
    // Страница становится окончательной сразу после своего шага, поэтому шаги идут вслед за разбивкой
    // и готовые страницы можно показать, не дожидаясь конца книги
    compactPagedPagePair(page, next, measureHost, measureHtml) {
        if (!page || !next || !Array.isArray(page.units) || !Array.isArray(next.units))
            return;

        while (next.units.length) {
            const candidateUnits = page.units.concat(next.units[0]);
            this.renderPagedMeasureUnits(measureHtml, candidateUnits);
            if (this.doesPagedMeasureOverflow(measureHost, measureHtml)) {
                const splitUnits = this.splitUnitToFitCurrentPage({html: next.units[0]}, page.units);
                if (splitUnits.length > 1) {
                    const firstSplitUnit = splitUnits[0];
                    const remainingSplitUnits = splitUnits.slice(1).map((unit) => unit.html).filter(Boolean);
                    const splitCandidateUnits = page.units.concat(firstSplitUnit.html);
                    this.renderPagedMeasureUnits(measureHtml, splitCandidateUnits);
                    if (firstSplitUnit.html && remainingSplitUnits.length && !this.doesPagedMeasureOverflow(measureHost, measureHtml)) {
                        page.units.push(firstSplitUnit.html);
                        next.units.splice(0, 1, ...remainingSplitUnits);
                    }
                }
                break;
            }

            page.units.push(next.units.shift());
        }
    }

    finalizeCompactedPagedPage(page) {
        if (!page || !page.units || !page.units.length || this.isBlankPagedPageUnits(page.units))
            return null;

        return {
            html: this.wrapPagedMeasureHtml(page.units),
            sectionId: page.sectionId || '',
            anchorIds: this.collectPagedAnchorIdsFromUnits(page.units, page.sectionId || ''),
        };
    }

    collectPagedAnchorIdsFromUnits(units = [], sectionId = '') {
        const ids = new Set();
        const addId = (value = '') => {
            const id = String(value || '').trim();
            if (id)
                ids.add(id);
        };

        addId(sectionId);

        if (typeof document === 'undefined')
            return Array.from(ids);

        const host = document.createElement('div');
        host.innerHTML = (Array.isArray(units) ? units : []).join('');
        for (const node of Array.from(host.querySelectorAll('[id], a[name]'))) {
            addId(node.getAttribute('id'));
            addId(node.getAttribute('name'));
        }
        for (const image of Array.from(host.querySelectorAll('img')))
            addId(readerTextAnchors.normalizeReaderImageAnchor(image.getAttribute('src') || ''));

        return Array.from(ids);
    }


    splitOversizedTextElement(root, unit = {}, options = {}) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return [];

        const tagName = String(root.tagName || '').toLowerCase();
        const className = String(root.className || '');
        const canSplitText = (
            tagName === 'p'
            || tagName === 'blockquote'
            || className.includes('reader-paragraph')
            || className.includes('reader-epigraph')
            || className.includes('reader-cite')
        );
        if (!canSplitText)
            return [];

        const sourceText = String(root.textContent || '').replace(/\s+/g, ' ').trim();
        if (!sourceText)
            return [];

        const measureHost = (this.$refs ? this.$refs.pageMeasure : null);
        const measureHtml = (measureHost ? measureHost.querySelector('.reader-html') : null);
        const baseHtml = (Array.isArray(options.baseHtml) ? options.baseHtml : []).filter(Boolean);
        const allowOverflowFallback = (options.allowOverflowFallback !== false);
        const words = sourceText.split(/\s+/).filter(Boolean);
        if (words.length <= 1)
            return [];

        const fallbackChunks = readerPaging.splitTextIntoReadableChunks(sourceText, (this.isCompactLayout ? 220 : 420), (this.isCompactLayout ? 90 : 140));
        const fastBudget = this.getFastPagedLineBudget(measureHost);
        if (!baseHtml.length) {
            const fastSplit = this.splitFastRootByLineBudget(root, unit, fastBudget);
            if (fastSplit.length > 1)
                return fastSplit;
        } else if (measureHost && !this.isCompactLayout) {
            const usedLines = baseHtml.reduce((acc, item) => {
                const info = this.getFastPagedUnitInfo({html: item});
                return acc + (info ? info.lines : fastBudget);
            }, 0);
            const remainingLines = Math.max(1, fastBudget - usedLines);
            const fastSplit = this.splitFastRootByLineBudget(root, unit, remainingLines);
            if (fastSplit.length > 1)
                return fastSplit;
        }

        if (!measureHost || !measureHtml)
            return this.wrapSplitTextChunks(root, unit, fallbackChunks);

        const chunks = [];
        let start = 0;

        let fitsByEnd = new Map();
        const render = (end) => {
            const clone = root.cloneNode(false);
            clone.textContent = words.slice(start, end).join(' ');
            this.renderPagedMeasureUnits(measureHtml, baseHtml.concat(clone.outerHTML));
            return this.measurePagedOverflow(measureHost, measureHtml);
        };
        const fits = (end) => {
            if (!fitsByEnd.has(end)) {
                const measure = render(end);
                fitsByEnd.set(end, !(measure && measure.overflow > 0));
            }
            return fitsByEnd.get(end);
        };
        // Догадка для поиска: весь остаток абзаца одним замером, по строкам видно, на каком слове
        // текст дойдёт до низа листа. Поиск проверяет догадку и соседа, так что итог тот же, что у
        // двоичного поиска по словам, но замеров обычно три, а не десяток
        const guessEnd = () => {
            const measure = render(words.length);
            const fitsAll = !(measure && measure.overflow > 0);
            fitsByEnd.set(words.length, fitsAll);
            if (!measure || fitsAll)
                return words.length;
            const nodes = this.pagedMeasureDom.nodes[this.pagedMeasureDom.nodes.length - 1] || [];
            const textNode = (nodes[0] && nodes[0].firstChild) || null;
            if (!textNode || textNode.nodeType !== Node.TEXT_NODE)
                return NaN;
            const ends = [];
            let offset = 0;
            for (let index = start; index < words.length; index += 1) {
                offset += words[index].length;
                ends.push(offset);
                offset += 1;
            }
            const range = this.pagedMeasureDom.range;
            const wordBottom = (count) => {
                range.setStart(textNode, ends[count - 1] - words[start + count - 1].length);
                range.setEnd(textNode, ends[count - 1]);
                const rects = range.getClientRects();
                return rects.length ? rects[rects.length - 1].bottom : NaN;
            };
            const limit = wordBottom(ends.length) - measure.overflow;
            let low = 1;
            let high = ends.length;
            let count = 0;
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                if (wordBottom(mid) <= limit) {
                    count = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            return start + count;
        };

        while (start < words.length) {
            fitsByEnd = new Map();
            let best = readerPaging.findLastFit(fits, start + 1, words.length, guessEnd());

            if (best <= start) {
                if (!allowOverflowFallback)
                    break;
                best = Math.min(words.length, start + 1);
            }

            const chunk = words.slice(start, best).join(' ').trim();
            if (!chunk)
                break;

            chunks.push(chunk);
            start = best;
        }

        this.renderPagedMeasureUnits(measureHtml, []);
        if (chunks.length <= 1)
            return (allowOverflowFallback ? this.wrapSplitTextChunks(root, unit, fallbackChunks) : []);

        return this.wrapSplitTextChunks(root, unit, chunks);
    }

    wrapSplitTextChunks(root, unit = {}, chunks = []) {
        const safeChunks = (Array.isArray(chunks) ? chunks : []).map((item) => String(item || '').trim()).filter(Boolean);
        if (safeChunks.length <= 1)
            return [];

        let first = true;
        return safeChunks.map((chunk) => {
            const clone = root.cloneNode(false);
            clone.textContent = chunk;
            const result = {
                html: clone.outerHTML,
                breakBefore: (first ? !!unit.breakBefore : false),
                sectionId: (first ? String(unit.sectionId || root.id || '').trim() : ''),
            };
            first = false;
            return result;
        }).filter((item) => String(item.html || '').trim());
    }

    wrapSplitHtmlChunks(root, unit = {}, chunks = []) {
        const safeChunks = (Array.isArray(chunks) ? chunks : []).map((item) => String(item || '').trim()).filter(Boolean);
        if (safeChunks.length <= 1)
            return [];

        let first = true;
        return safeChunks.map((chunk) => {
            const clone = root.cloneNode(false);
            clone.innerHTML = chunk;
            const result = {
                html: clone.outerHTML,
                breakBefore: (first ? !!unit.breakBefore : false),
                sectionId: (first ? String(unit.sectionId || root.id || '').trim() : ''),
            };
            first = false;
            return result;
        }).filter((item) => String(item.html || '').trim());
    }

    getPagedTextMeasureContext() {
        if (typeof document === 'undefined')
            return null;

        if (!this.pagedTextMeasureCanvas)
            this.pagedTextMeasureCanvas = document.createElement('canvas');

        if (!this.pagedTextMeasureContext)
            this.pagedTextMeasureContext = this.pagedTextMeasureCanvas.getContext('2d');

        return this.pagedTextMeasureContext || null;
    }

    getPagedMeasureTextFont(root = null) {
        const fontSize = Math.max(12, Number(this.activePreferences.fontSize || 18) || 18);
        const family = this.readerFontFamilyCss || 'serif';
        const tagName = String((root && root.tagName) || '').toLowerCase();
        const className = String((root && root.className) || '');
        const isHeading = /^h[1-6]$/.test(tagName) || className.includes('reader-section-heading') || className.includes('reader-subtitle');
        const isTitle = tagName === 'h1';
        const weight = (isHeading || isTitle ? '700' : '400');
        const size = isTitle
            ? Math.max(fontSize * 2.3, fontSize + 18)
            : (isHeading ? Math.max(fontSize * 1.75, fontSize + 8) : fontSize);
        return `${weight} ${Math.round(size)}px ${family}`;
    }

    getPagedInlineTextFont(root = null, token = {}) {
        const baseFont = this.getPagedMeasureTextFont(root);
        const parts = baseFont.split(/\s+/);
        const familyStart = Math.max(0, parts.findIndex((item) => /px$/.test(item)));
        const sizeAndFamily = familyStart >= 0 ? parts.slice(familyStart).join(' ') : baseFont;
        const style = token.italic ? 'italic' : 'normal';
        const weight = token.bold ? '700' : (/^700\s/.test(baseFont) ? '700' : '400');
        return `${style} ${weight} ${sizeAndFamily}`;
    }

    getFastPagedLineBudget(measureHost = null) {
        const availableHeight = this.getPagedMeasureAvailableHeight(measureHost || (this.$refs ? this.$refs.pageMeasure : null));
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.15, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const linePx = Math.max(18, Math.round(fontSize * lineHeight));
        const reserveLines = this.isCompactLayout ? 0.05 : 0.35;
        return Math.max(2, Math.floor((availableHeight / linePx) - reserveLines));
    }

    getFastPagedColumnWidth() {
        const paddingX = Math.max(0, Number(this.pagePaddingLeft || 0) + Number(this.pagePaddingRight || 0));
        return Math.max(120, this.pageMeasureFrameWidth - paddingX - 2);
    }

    getFastPagedRootMarginLines(root = null) {
        const tagName = String((root && root.tagName) || '').toLowerCase();
        const className = String((root && root.className) || '');
        if (/^h[1-6]$/.test(tagName) || className.includes('reader-section-heading') || className.includes('reader-subtitle'))
            return 1.3;
        if (className.includes('reader-epigraph') || className.includes('reader-cite') || tagName === 'blockquote')
            return 0.8;
        if (className.includes('reader-poem') || className.includes('reader-stanza') || className.includes('reader-image-block'))
            return 0.65;
        if (className.includes('reader-epigraph-author'))
            return 0.35;
        return (this.isPagedMode ? 0.45 : 1);
    }

    canFastMeasurePagedRoot(root = null) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return false;

        const tagName = String(root.tagName || '').toLowerCase();
        const className = String(root.className || '');
        if (className.includes('reader-image-block') || className.includes('reader-empty-line'))
            return true;

        if (root.querySelector && root.querySelector('table, pre, code, svg, video, audio'))
            return false;

        if (root.querySelector && root.querySelector('img'))
            return className.includes('reader-image-block');

        return (
            tagName === 'p'
            || tagName === 'blockquote'
            || tagName === 'div'
            || /^h[1-6]$/.test(tagName)
            || className.includes('reader-paragraph')
            || className.includes('reader-epigraph')
            || className.includes('reader-cite')
            || className.includes('reader-section-heading')
            || className.includes('reader-subtitle')
            || className.includes('reader-epigraph-author')
            || className.includes('reader-poem')
            || className.includes('reader-stanza')
            || className.includes('reader-opening-title')
        );
    }

    isFastPagedContainerRoot(root = null) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return false;

        const className = String(root.className || '');
        return (
            className.includes('reader-poem')
            || className.includes('reader-stanza')
            || className.includes('reader-epigraph')
            || className.includes('reader-cite')
        );
    }

    getFastPagedChildElements(root = null) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return [];

        return Array.from(root.childNodes || [])
            .map((child) => {
                if (child.nodeType === Node.ELEMENT_NODE)
                    return child;
                if (child.nodeType === Node.TEXT_NODE && String(child.textContent || '').trim()) {
                    const p = document.createElement('p');
                    p.className = 'reader-paragraph';
                    p.textContent = String(child.textContent || '').trim();
                    return p;
                }
                return null;
            })
            .filter(Boolean);
    }

    inlineWrapperForElement(element = null) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE)
            return null;

        const tagName = String(element.tagName || '').toLowerCase();
        const className = String(element.className || '').trim();
        if (tagName === 'strong' || tagName === 'b')
            return {open: '<strong>', close: '</strong>', bold: true};
        if (tagName === 'em' || tagName === 'i')
            return {open: '<em>', close: '</em>', italic: true};
        if (tagName === 'a' && element.classList.contains('reader-inline-link')) {
            const href = element.getAttribute('href') || '#';
            const target = element.getAttribute('data-reader-target') || '';
            const targetAttr = target ? ` data-reader-target="${this.escapeHtml(target)}"` : '';
            const className = String(element.className || 'reader-inline-link').trim();
            return {
                open: `<a class="${this.escapeHtml(className)}" href="${this.escapeHtml(href)}"${targetAttr}>`,
                close: '</a>',
            };
        }
        if (tagName === 'span' && className === 'reader-inline-link')
            return {open: '<span class="reader-inline-link">', close: '</span>'};
        if (tagName === 'span')
            return {open: '<span>', close: '</span>'};

        return null;
    }

    buildPagedInlineTokens(root = null) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return [];

        const tokens = [];
        //был ли пробел перед следующим словом: граница тега (<em>он</em>.) пробелом не считается
        let gap = false;
        const walk = (node, state = {}) => {
            if (!node)
                return;

            if (node.nodeType === Node.TEXT_NODE) {
                const parts = String(node.textContent || '').split(/(\s+)/).filter((item) => item.length);
                for (const part of parts) {
                    if (!part.trim()) {
                        gap = true;
                        continue;
                    }
                    tokens.push({
                        text: part,
                        html: `${state.open || ''}${this.escapeHtml(part)}${state.close || ''}`,
                        bold: !!state.bold,
                        italic: !!state.italic,
                        breakLine: false,
                        gap,
                    });
                    gap = false;
                }
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE)
                return;

            const tagName = String(node.tagName || '').toLowerCase();
            if (tagName === 'br') {
                tokens.push({text: '', html: '<br>', breakLine: true});
                gap = false;
                return;
            }

            const wrapper = this.inlineWrapperForElement(node);
            const nextState = wrapper
                ? {
                    open: `${state.open || ''}${wrapper.open}`,
                    close: `${wrapper.close}${state.close || ''}`,
                    bold: !!(state.bold || wrapper.bold),
                    italic: !!(state.italic || wrapper.italic),
                }
                : state;

            for (const child of Array.from(node.childNodes || []))
                walk(child, nextState);
        };

        for (const child of Array.from(root.childNodes || []))
            walk(child, {});

        return tokens;
    }

    estimatePagedTextLinesForRoot(root = null) {
        if (!this.canFastMeasurePagedRoot(root))
            return 0;

        const className = String(root.className || '');
        if (className.includes('reader-empty-line'))
            return 1;

        if (className.includes('reader-image-block'))
            return Math.max(6, Math.round(this.getFastPagedLineBudget() * (this.isCompactLayout ? 0.42 : 0.52)));

        if (this.isFastPagedContainerRoot(root)) {
            const childLines = this.getFastPagedChildElements(root)
                .reduce((acc, child) => acc + Math.max(1, this.estimatePagedTextLinesForRoot(child) || 1), 0);
            const frameLines = className.includes('reader-epigraph') || className.includes('reader-cite') ? 1 : 0;
            return Math.max(1, childLines + frameLines);
        }

        const text = String(root.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text)
            return 1;

        const context = this.getPagedTextMeasureContext();
        const width = this.getFastPagedColumnWidth();
        if (!context || !width)
            return Math.max(1, Math.ceil(text.length / (this.isCompactLayout ? 28 : 72)));

        const inlineTokens = this.buildPagedInlineTokens(root);
        const words = inlineTokens.length ? inlineTokens : text.split(/\s+/).filter(Boolean).map((word) => ({text: word}));
        let lines = 1;
        let currentWidth = 0;
        const spaceWidth = Math.max(3, context.measureText(' ').width || 4);

        for (const word of words) {
            if (word.breakLine) {
                lines += 1;
                currentWidth = 0;
                continue;
            }

            context.font = this.getPagedInlineTextFont(root, word);
            const wordWidth = Math.max(1, context.measureText(word.text || '').width || 1);
            if (currentWidth > 0 && currentWidth + spaceWidth + wordWidth > width) {
                lines += 1;
                currentWidth = wordWidth;
            } else {
                currentWidth += (currentWidth > 0 ? spaceWidth : 0) + wordWidth;
            }
        }

        const marginLines = this.getFastPagedRootMarginLines(root);
        return Math.max(1, lines + marginLines);
    }

    getPagedUnitRoot(unit = {}) {
        if (!unit || typeof document === 'undefined')
            return null;

        const html = String(unit.html || '').trim();
        if (!html)
            return null;

        const host = document.createElement('div');
        host.innerHTML = html;
        if (host.childNodes.length !== 1 || !host.firstChild || host.firstChild.nodeType !== Node.ELEMENT_NODE)
            return null;

        return host.firstChild;
    }

    describePagedUnitRoot(root = null) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return 'unknown';

        const tagName = String(root.tagName || 'node').toLowerCase();
        const classNames = String(root.className || '')
            .split(/\s+/)
            .filter((name) => /^reader-/.test(name))
            .slice(0, 2);
        return [tagName].concat(classNames).join('.');
    }

    getFastPagedUnitInfo(unit = {}) {
        const root = this.getPagedUnitRoot(unit);
        if (!root)
            return null;

        if (!this.canFastMeasurePagedRoot(root))
            return null;

        return {
            root,
            lines: this.estimatePagedTextLinesForRoot(root),
        };
    }

    splitTextRootByLineBudget(root = null, unit = {}, maxLines = 1) {
        if (!root || maxLines <= 1)
            return [];

        const context = this.getPagedTextMeasureContext();
        const width = this.getFastPagedColumnWidth();
        const text = String(root.textContent || '').replace(/\s+/g, ' ').trim();
        if (!context || !width || !text)
            return [];

        const inlineTokens = this.buildPagedInlineTokens(root);
        const words = inlineTokens.length
            ? inlineTokens
            : text.split(/\s+/).filter(Boolean).map((word) => ({text: word, html: this.escapeHtml(word)}));
        const chunks = [];
        const marginLines = this.getFastPagedRootMarginLines(root);
        const usableLines = Math.max(1, maxLines - marginLines);
        let current = [];
        let currentWidth = 0;
        let currentLines = 1;
        const spaceWidth = Math.max(3, context.measureText(' ').width || 4);

        const pushCurrent = () => {
            const value = readerPaging.joinInlineTokens(current);
            if (value)
                chunks.push(value);
            current = [];
            currentWidth = 0;
            currentLines = 1;
        };

        for (const word of words) {
            if (word.breakLine) {
                pushCurrent();
                continue;
            }

            context.font = this.getPagedInlineTextFont(root, word);
            const wordWidth = Math.max(1, context.measureText(word.text || '').width || 1);
            const wraps = currentWidth > 0 && currentWidth + spaceWidth + wordWidth > width;
            if (wraps && currentLines >= usableLines && current.length)
                pushCurrent();

            if (currentWidth > 0 && currentWidth + spaceWidth + wordWidth > width) {
                currentLines += 1;
                currentWidth = wordWidth;
            } else {
                currentWidth += (currentWidth > 0 ? spaceWidth : 0) + wordWidth;
            }

            current.push(word);
        }

        pushCurrent();
        return this.wrapSplitHtmlChunks(root, unit, chunks);
    }

    splitFastRootByLineBudget(root = null, unit = {}, maxLines = 1) {
        if (!root || maxLines <= 1)
            return [];

        if (this.isFastPagedContainerRoot(root))
            return this.splitContainerRootByLineBudget(root, unit, maxLines);

        return this.splitTextRootByLineBudget(root, unit, maxLines);
    }

    splitContainerRootByLineBudget(root = null, unit = {}, maxLines = 1) {
        if (!root || maxLines <= 1)
            return [];

        const children = this.getFastPagedChildElements(root);
        if (children.length <= 1)
            return this.splitTextRootByLineBudget(root, unit, maxLines);

        const chunks = [];
        let currentHtml = [];
        let currentLines = 0;
        const frameLines = String(root.className || '').includes('reader-epigraph') || String(root.className || '').includes('reader-cite') ? 1 : 0;
        const usableLines = Math.max(1, maxLines - frameLines);

        const pushCurrent = () => {
            if (currentHtml.length)
                chunks.push(currentHtml.join(''));
            currentHtml = [];
            currentLines = 0;
        };

        for (const child of children) {
            const childLines = Math.max(1, this.estimatePagedTextLinesForRoot(child) || 1);
            if (currentHtml.length && currentLines + childLines > usableLines)
                pushCurrent();

            if (childLines > usableLines) {
                const splitChild = this.splitFastRootByLineBudget(child, {
                    html: child.outerHTML,
                    breakBefore: false,
                    sectionId: '',
                }, usableLines);
                if (splitChild.length) {
                    for (const part of splitChild) {
                        if (currentHtml.length)
                            pushCurrent();
                        chunks.push(part.html);
                    }
                    continue;
                }
            }

            currentHtml.push(child.outerHTML);
            currentLines += childLines;
        }

        pushCurrent();
        return this.wrapSplitHtmlChunks(root, unit, chunks);
    }

    //Дети элемента - отдельными блоками разбивки: текст между ними становится абзацем, id ребёнка - его разделом
    splitChildUnits(childNodes = [], unit = {}) {
        let first = true;
        return childNodes.map((child) => {
            let childHtml = '';
            if (child.nodeType === Node.TEXT_NODE) {
                childHtml = `<p class="reader-paragraph">${this.escapeHtml(String(child.textContent || '').trim())}</p>`;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                childHtml = child.outerHTML;
            }

            const childSectionId = (child.nodeType === Node.ELEMENT_NODE
                ? (child.id || ((child.querySelector && child.querySelector('[id]')) || {}).id || '')
                : '');

            const result = {
                html: childHtml,
                breakBefore: (first ? !!unit.breakBefore : false),
                sectionId: (childSectionId || (first ? String(unit.sectionId || '').trim() : '')),
            };
            first = false;
            return result;
        }).filter((item) => String(item.html || '').trim());
    }

    splitOversizedUnit(unit = {}) {
        const html = String(unit.html || '').trim();
        if (!html || typeof(document) === 'undefined')
            return [];

        const host = document.createElement('div');
        host.innerHTML = html;

        if (host.childNodes.length !== 1 || !host.firstChild || host.firstChild.nodeType !== Node.ELEMENT_NODE)
            return [];

        const root = host.firstChild;
        const childNodes = Array.from(root.childNodes || []).filter((child) => (
            child.nodeType !== Node.TEXT_NODE || String(child.textContent || '').trim()
        ));

        if (childNodes.length <= 1)
            return this.splitOversizedTextElement(root, unit);

        const childSplit = this.splitChildUnits(childNodes, unit);

        return (childSplit.length ? childSplit : this.splitOversizedTextElement(root, unit));
    }

    splitUnitToFitCurrentPage(unit = {}, currentUnits = []) {
        const html = String(unit.html || '').trim();
        if (!html || typeof(document) === 'undefined' || !Array.isArray(currentUnits) || !currentUnits.length)
            return [];

        const host = document.createElement('div');
        host.innerHTML = html;

        if (host.childNodes.length !== 1 || !host.firstChild || host.firstChild.nodeType !== Node.ELEMENT_NODE)
            return [];

        const root = host.firstChild;
        const childNodes = Array.from(root.childNodes || []).filter((child) => (
            child.nodeType !== Node.TEXT_NODE || String(child.textContent || '').trim()
        ));

        if (childNodes.length <= 1) {
            return this.splitOversizedTextElement(root, unit, {
                baseHtml: currentUnits,
                allowOverflowFallback: false,
            });
        }

        const childSplit = this.splitChildUnits(childNodes, unit);

        return childSplit;
    }

    buildPagedUnits() {
        const units = [];
        const pushUnit = (html = '', opts = {}) => {
            if (!String(html || '').trim())
                return;
            units.push({
                html,
                breakBefore: !!opts.breakBefore,
                sectionId: String(opts.sectionId || '').trim(),
            });
        };

        if (this.coverSrc) {
            const dimensions = (this.coverIntrinsicWidth > 0 && this.coverIntrinsicHeight > 0)
                ? ` width="${this.coverIntrinsicWidth}" height="${this.coverIntrinsicHeight}"`
                : '';
            const aspectStyle = (this.coverIntrinsicWidth > 0 && this.coverIntrinsicHeight > 0)
                ? ` style="--reader-cover-aspect: ${this.coverIntrinsicWidth} / ${this.coverIntrinsicHeight}"`
                : '';
            pushUnit(`<div class="reader-cover-box"><img src="${this.escapeHtml(this.coverSrc)}" class="reader-cover"${dimensions}${aspectStyle} alt="${this.escapeHtml(this.title)}"></div>`);
        }
        if (this.seriesLine)
            pushUnit(`<div class="reader-series">${this.escapeHtml(this.seriesLine)}</div>`);
        if (this.title)
            pushUnit(`<h1 class="reader-heading">${this.escapeHtml(this.title)}</h1>`);
        if (this.authorLine)
            pushUnit(`<div class="reader-subheading">${this.escapeHtml(this.authorLine)}</div>`);

        const root = document.createElement('div');
        root.innerHTML = this.readerHtml || '';

        const flattenNode = (node, sectionBreak = false) => {
            if (!node)
                return;

            if (node.nodeType === Node.TEXT_NODE) {
                const text = String(node.textContent || '').trim();
                if (text)
                    pushUnit(`<p class="reader-paragraph">${this.escapeHtml(text)}</p>`, {breakBefore: sectionBreak});
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE)
                return;

            const element = node;
            if (
                element.classList.contains('reader-section')
                || element.classList.contains('reader-section-block')
                || element.classList.contains('reader-notes')
            ) {
                const containerSectionId = String(element.id || '').trim();
                const children = Array.from(element.childNodes).filter((child) => (
                    child.nodeType !== Node.TEXT_NODE || String(child.textContent || '').trim()
                ));
                if (!children.length) {
                    pushUnit(element.outerHTML, {
                        breakBefore: sectionBreak,
                        sectionId: containerSectionId || (element.querySelector('[id]') || {}).id || '',
                    });
                    return;
                }

                let first = true;
                for (const child of children) {
                    const sectionId = (child.nodeType === Node.ELEMENT_NODE
                        ? (child.id || ((child.querySelector && child.querySelector('[id]')) || {}).id || (first ? containerSectionId : '') || '')
                        : '');
                    const firstGeneratedUnitIndex = units.length;
                    flattenNode(child, (sectionBreak && first));
                    if (sectionId && units.length > firstGeneratedUnitIndex) {
                        //id заголовка из оглавления (section-N), найденный внутри, важнее собственного id секции fb2
                        units[firstGeneratedUnitIndex].sectionId = units[firstGeneratedUnitIndex].sectionId || sectionId;
                        units[firstGeneratedUnitIndex].breakBefore = units[firstGeneratedUnitIndex].breakBefore || (sectionBreak && first);
                    }
                    first = false;
                }
                return;
            }

            const sectionId = element.id || ((element.querySelector && element.querySelector('[id]')) || {}).id || '';
            const breakBefore = sectionBreak;
            pushUnit(element.outerHTML, {breakBefore, sectionId});
        };

        for (const node of Array.from(root.childNodes)) {
            const isSection = (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('reader-section-block'));
            flattenNode(node, isSection);
        }

        return units;
    }

    // options.onFirstPages: разбивку не ждать целиком - как только готова страница, на которой откроется книга,
    // готовые страницы показываются (pagedPagesPartial), колбэк вызывается, остальное размечается в фоне
    async buildPagedPagesChunked(jobId = 0, options = {}) {
        const onFirstPages = (typeof options.onFirstPages === 'function' ? options.onFirstPages : null);
        if (!this.isPagedMode) {
            this.pagedPages = [];
            return false;
        }

        if (jobId && jobId !== this.pagedBuildJobId)
            return false;
        if (this.pagedBuildInProgress) {
            this.pagedBuildNeedsRefresh = true;
            return false;
        }

        const measureHost = this.$refs ? this.$refs.pageMeasure : null;
        if (!measureHost)
            return false;

        const measureHtml = measureHost.querySelector('.reader-html');
        if (!measureHtml)
            return false;

        this.syncBottomClipCompensationGeometry();
        const buildOwnerJobId = jobId || this.pagedBuildJobId;
        const buildCalibrationKey = this.getBottomClipCompensationGeometryKey();
        const buildLayoutSignature = this.getPagedLayoutSignature();
        const buildGeometrySignature = this.getPagedGeometrySignature();
        const buildSourceKey = this.readerSourceKey;
        const layoutCacheKey = this.getPagedLayoutCacheKey(
            buildLayoutSignature,
            buildCalibrationKey,
            buildGeometrySignature,
        );
        const cachedLayout = this.takePagedLayoutCacheEntry(layoutCacheKey);
        if (cachedLayout && cachedLayout.type === 'complete' && Array.isArray(cachedLayout.pages) && cachedLayout.pages.length) {
            this.pagedPages = markRaw(cachedLayout.pages);
            this.currentPageIndex = Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex));
            this.pagedPagesPartial = false;
            this.pagedLayoutSignature = buildLayoutSignature;
            this.pagedCommittedCalibrationKey = buildCalibrationKey;
            this.pagedCommittedCalibrationGeneration = buildOwnerJobId;
            this.pagedCommittedCalibrationAt = Date.now();
            this.resetBottomClipCalibrationSample();
            this.noteCompactChromeTotalPages();
            this.rebuildSearchResults(false);
            this.storePagedLayoutCacheEntry(layoutCacheKey, cachedLayout);
            if (this.readerDebugEnabled) {
                this.readerDebug = Object.assign({}, this.readerDebug, {
                    paginationStats: Object.assign({}, cachedLayout.stats || {}, {status: 'cached'}),
                });
            }
            return true;
        }

        // Лист ещё не перерисован под высоту из подписи: замер по нему лёг бы в кэш под чужой подписью
        // и держался бы до смены размера. Вызывающий повторит разбивку после кадра
        if (!readerPaging.isPagedStageCurrent(this.getPagedStageRect().height, this.pageMinHeight)) {
            if (cachedLayout)
                this.storePagedLayoutCacheEntry(layoutCacheKey, cachedLayout);
            return false;
        }

        const checkpoint = (cachedLayout && cachedLayout.type === 'partial') ? cachedLayout : null;
        const queue = checkpoint ? checkpoint.queue : this.buildPagedUnits().slice();
        const totalUnits = Math.max(1, (checkpoint && checkpoint.totalUnits) || queue.length || 1);
        const pages = checkpoint ? checkpoint.pages : [];
        // Телефон: страницы разбивки уплотняются по парам, страница index готова после своего шага
        const compactPages = this.isCompactLayout;
        const compacted = (checkpoint && checkpoint.compacted) || [];
        let compactIndex = (checkpoint && checkpoint.compactIndex) || 0;
        const compactedPages = (checkpoint && checkpoint.compactedPages) || [];
        let currentUnits = checkpoint ? checkpoint.currentUnits : [];
        let activeSectionId = checkpoint ? checkpoint.activeSectionId : '';
        let currentPageSectionId = checkpoint ? checkpoint.currentPageSectionId : '';
        let currentEstimatedLines = checkpoint ? checkpoint.currentEstimatedLines : 0;
        let buildProgressPercent = Math.max(1, (checkpoint && checkpoint.buildProgressPercent) || 1);
        const startIndex = Math.max(0, Math.min(queue.length, (checkpoint && checkpoint.nextIndex) || 0));
        const fastLineBudget = this.getFastPagedLineBudget(measureHost);
        const buildStartedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const fallbackRoots = new Map((checkpoint && checkpoint.fallbackRoots) || []);
        const stats = Object.assign({
            status: 'building',
            totalUnits: queue.length,
            fastUnits: 0,
            domUnits: 0,
            fastSplits: 0,
            domSplits: 0,
            generatedFastSplitUnits: 0,
            generatedDomSplitUnits: 0,
            pages: 0,
            durationMs: 0,
            fallbackRoots: [],
        }, (checkpoint && checkpoint.stats) || {});

        const applyUnits = (list) => {
            this.renderPagedMeasureUnits(measureHtml, list);
        };
        const publishStats = (status = stats.status) => {
            stats.status = status;
            if (!this.readerDebugEnabled)
                return;
            stats.durationMs = Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - buildStartedAt));
            stats.fallbackRoots = Array.from(fallbackRoots.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([label, count]) => `${label}:${count}`);
            this.readerDebug = Object.assign({}, this.readerDebug, {
                paginationStats: Object.assign({}, stats),
            });
        };
        const recordFallbackRoot = (unit) => {
            if (!this.readerDebugEnabled)
                return;
            const label = this.describePagedUnitRoot(this.getPagedUnitRoot(unit));
            fallbackRoots.set(label, (fallbackRoots.get(label) || 0) + 1);
        };
        const finalizePage = () => {
            if (!currentUnits.length)
                return;
            if (!this.isBlankPagedPageUnits(currentUnits)) {
                pages.push({
                    html: this.wrapPagedMeasureHtml(currentUnits),
                    sectionId: currentPageSectionId || activeSectionId || '',
                    anchorIds: this.collectPagedAnchorIdsFromUnits(currentUnits, currentPageSectionId || activeSectionId || ''),
                });
            }
            stats.pages = pages.length;
            currentUnits = [];
            currentPageSectionId = activeSectionId || '';
            currentEstimatedLines = 0;
            advanceCompactedPages(false);
            applyUnits([]);
        };
        const advanceCompactedPages = (done = false) => {
            if (!compactPages)
                return;
            while (compacted.length < pages.length) {
                const page = pages[compacted.length];
                compacted.push(Object.assign({}, page, {units: this.extractPagedContentUnits(page.html)}));
            }
            for (; compactIndex < compacted.length - (done ? 0 : 1); compactIndex += 1) {
                if (compactIndex < compacted.length - 1)
                    this.compactPagedPagePair(compacted[compactIndex], compacted[compactIndex + 1], measureHost, measureHtml);
                const page = this.finalizeCompactedPagedPage(compacted[compactIndex]);
                if (page)
                    compactedPages.push(page);
                // Блоки готовой страницы больше не нужны: в памяти остаётся её html
                compacted[compactIndex] = null;
            }
        };
        // Показ готовых страниц до конца разбивки: первый раз - когда среди них есть страница открытия,
        // дальше - не чаще раза в 300 мс. Общее число страниц пока оценка по доле разметки книги в готовых
        const readyPages = () => (compactPages ? compactedPages : pages);
        const restoreScan = {};
        const pageWrapperLength = this.wrapPagedMeasureHtml([]).length;
        const totalUnitsLength = (onFirstPages ? queue.reduce((sum, unit) => sum + String(unit.html || '').length, 0) : 0);
        let readyLength = 0;
        let readyLengthCount = 0;
        let shownPagesCount = 0;
        let shownPagesAt = 0;
        const showReadyPages = () => {
            const ready = readyPages();
            if (ready.length <= shownPagesCount || now() - shownPagesAt < 300)
                return;
            shownPagesAt = now();
            for (; readyLengthCount < ready.length; readyLengthCount += 1)
                readyLength += Math.max(0, String(ready[readyLengthCount].html || '').length - pageWrapperLength);
            this.pagedPagesEstimatedTotal = Math.max(ready.length, Math.round(ready.length * totalUnitsLength / Math.max(1, readyLength)));
            if (!shownPagesCount) {
                if (!this.showFirstPartialPagedPages(ready, restoreScan))
                    return;
                onFirstPages();
            } else {
                this.pagedPages = markRaw(ready.slice());
            }
            shownPagesCount = ready.length;
        };
        // Кадр отдаём по времени (12 мс работы): раньше - каждые 18 блоков,
        // и на быстрых блоках ожидание кадров занимало две трети разбивки
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let sliceStartedAt = now();
        const maybeYield = async(index) => {
            if (index <= 0 || now() - sliceStartedAt < 12)
                return;
            if (jobId && jobId !== this.pagedBuildJobId)
                return;
            const dynamicTotalUnits = Math.max(totalUnits, queue.length || 1, index + 1);
            if (onFirstPages)
                showReadyPages();
            const percent = Math.min(92, Math.max(1, Math.round((index / dynamicTotalUnits) * 92)));
            buildProgressPercent = Math.max(buildProgressPercent, percent);
            this.pagedBuildProgressPercent = buildProgressPercent;
            this.loadingMessage = `${this.uiText.loadingPages} ${buildProgressPercent}%`;
            await this.waitForAnimationFrames(1);
            // Читалку увели с экрана (keep-alive): лист вне документа и замеры нулевые - ждём возвращения,
            // иначе вся остальная книга легла бы на одну страницу
            while (
                !readerPaging.isPagedStageCurrent(this.getPagedStageRect().height, this.pageMinHeight)
                && !this.pagedBuildNeedsRefresh
                && !(jobId && jobId !== this.pagedBuildJobId)
            )
                await this.waitForAnimationFrames(1);
            sliceStartedAt = now();
        };
        const storePartialLayout = (nextIndex = 0) => {
            if (!layoutCacheKey || buildSourceKey !== this.readerSourceKey)
                return;
            this.storePagedLayoutCacheEntry(layoutCacheKey, {
                type: 'partial',
                queue,
                totalUnits,
                pages,
                currentUnits,
                activeSectionId,
                currentPageSectionId,
                currentEstimatedLines,
                buildProgressPercent,
                nextIndex: Math.max(0, Math.min(queue.length, nextIndex)),
                compacted,
                compactIndex,
                compactedPages,
                fallbackRoots: Array.from(fallbackRoots.entries()),
                stats: Object.assign({}, stats, {status: 'paused'}),
            });
        };

        this.pagedBuildOwnerJobId = buildOwnerJobId;
        this.pagedBuildInProgress = true;
        this.pagedBuildNeedsRefresh = false;
        this.pagedBuildSignature = buildLayoutSignature;
        this.pagedBuildGeometrySignature = buildGeometrySignature;
        this.pagedBuildStage = 'building';
        this.pagedBuildProgressPercent = buildProgressPercent;
        this.loadingMessage = `${this.uiText.loadingPages} ${buildProgressPercent}%`;
        if (this.readerDebugEnabled)
            publishStats('building');
        if (this.compactChromePagedBuildPending)
            this.touchCompactChromeBuildActivity();

        try {
            applyUnits(currentUnits);
            for (let index = startIndex; index < queue.length; index += 1) {
                if (this.pagedBuildNeedsRefresh || (jobId && jobId !== this.pagedBuildJobId)) {
                    storePartialLayout(index);
                    return false;
                }

                const unit = queue[index];
                if (unit.sectionId)
                    activeSectionId = unit.sectionId;
                if (unit.breakBefore && currentUnits.length && !this.isCompactLayout) {
                    finalizePage();
                    currentPageSectionId = unit.sectionId || activeSectionId || '';
                }

                // Compact pages must use one exact DOM measurement strategy on
                // every pass. The canvas estimator can disagree with the live
                // mobile sheet and used to make the first and later builds differ.
                const fastInfo = this.isCompactLayout ? null : this.getFastPagedUnitInfo(unit);
                if (fastInfo && fastLineBudget > 2 && (!currentUnits.length || currentEstimatedLines > 0)) {
                    if (currentUnits.length && currentEstimatedLines + fastInfo.lines > fastLineBudget) {
                        const fitCurrentPageSplit = this.splitFastRootByLineBudget(
                            fastInfo.root,
                            unit,
                            Math.max(1, fastLineBudget - currentEstimatedLines),
                        );
                        if (fitCurrentPageSplit.length) {
                            stats.fastSplits += 1;
                            stats.generatedFastSplitUnits += fitCurrentPageSplit.length;
                            queue.splice(index, 1, ...fitCurrentPageSplit);
                            index -= 1;
                            await maybeYield(index + 1);
                            continue;
                        }

                        finalizePage();
                        currentPageSectionId = unit.sectionId || activeSectionId || '';
                    }

                    if (fastInfo.lines > fastLineBudget) {
                        const splitUnits = this.splitFastRootByLineBudget(fastInfo.root, unit, fastLineBudget);
                        if (splitUnits.length) {
                            stats.fastSplits += 1;
                            stats.generatedFastSplitUnits += splitUnits.length;
                            queue.splice(index, 1, ...splitUnits);
                            index -= 1;
                            await maybeYield(index + 1);
                            continue;
                        }
                    }

                    currentUnits = currentUnits.concat(unit.html);
                    currentEstimatedLines += fastInfo.lines;
                    stats.fastUnits += 1;
                    if (unit.sectionId && !currentPageSectionId)
                        currentPageSectionId = unit.sectionId;
                    await maybeYield(index + 1);
                    continue;
                }

                stats.domUnits += 1;
                recordFallbackRoot(unit);
                const candidateUnits = currentUnits.concat(unit.html);
                applyUnits(candidateUnits);
                // Один замер на кандидата: до второй проверки лист не меняется
                const candidateOverflows = this.doesPagedMeasureOverflow(measureHost, measureHtml);
                if (candidateOverflows && !currentUnits.length) {
                    const splitUnits = this.splitOversizedUnit(unit);
                    if (splitUnits.length) {
                        stats.domSplits += 1;
                        stats.generatedDomSplitUnits += splitUnits.length;
                        queue.splice(index, 1, ...splitUnits);
                        index -= 1;
                        applyUnits([]);
                        await maybeYield(index + 1);
                        continue;
                    }
                }

                if (candidateOverflows && currentUnits.length) {
                    const fitCurrentPageSplit = this.splitUnitToFitCurrentPage(unit, currentUnits);
                    if (fitCurrentPageSplit.length) {
                        stats.domSplits += 1;
                        stats.generatedDomSplitUnits += fitCurrentPageSplit.length;
                        queue.splice(index, 1, ...fitCurrentPageSplit);
                        index -= 1;
                        applyUnits(currentUnits);
                        await maybeYield(index + 1);
                        continue;
                    }

                    finalizePage();
                    currentPageSectionId = unit.sectionId || activeSectionId || '';
                    currentUnits = [unit.html];
                    applyUnits(currentUnits);
                    if (this.doesPagedMeasureOverflow(measureHost, measureHtml)) {
                        const splitUnits = this.splitOversizedUnit(unit);
                        if (splitUnits.length) {
                            stats.domSplits += 1;
                            stats.generatedDomSplitUnits += splitUnits.length;
                            currentUnits = [];
                            applyUnits([]);
                            queue.splice(index, 1, ...splitUnits);
                            index -= 1;
                            await maybeYield(index + 1);
                            continue;
                        }
                    }
                } else {
                    currentUnits = candidateUnits;
                    currentEstimatedLines = 0;
                    if (unit.sectionId && !currentPageSectionId)
                        currentPageSectionId = unit.sectionId;
                }

                await maybeYield(index + 1);
            }

            if (this.pagedBuildNeedsRefresh || (jobId && jobId !== this.pagedBuildJobId)) {
                storePartialLayout(queue.length);
                return false;
            }
            finalizePage();
            advanceCompactedPages(true);
            applyUnits([]);
            // Одна страница не уплотняется, книга без страниц - одна страница с исходным текстом
            const finalPages = (compactPages && pages.length >= 2) ? compactedPages : (pages.length ? pages : [{
                html: this.readerHtml || '',
                sectionId: '',
                anchorIds: this.collectPagedAnchorIdsFromUnits([this.readerHtml || ''], ''),
            }]);
            this.pagedBuildStage = 'finalizing';
            this.pagedBuildProgressPercent = 98;
            this.loadingMessage = `${this.uiText.loadingPagesFinalizing.replace('...', '')} 98%`;
            await this.waitForAnimationFrames(1);
            if (jobId && jobId !== this.pagedBuildJobId) {
                storePartialLayout(queue.length);
                return false;
            }
            this.pagedBuildStage = 'finalizing';
            this.pagedBuildProgressPercent = 99;
            this.loadingMessage = `${this.uiText.loadingPagesFinalizing.replace('...', '')} 99%`;
            await this.waitForAnimationFrames(1);
            if (jobId && jobId !== this.pagedBuildJobId) {
                storePartialLayout(queue.length);
                return false;
            }
            this.pagedBuildProgressPercent = 100;
            this.loadingMessage = `${this.uiText.loadingPagesFinalizing.replace('...', '')} 100%`;
            await this.waitForAnimationFrames(1);
            if (jobId && jobId !== this.pagedBuildJobId) {
                storePartialLayout(queue.length);
                return false;
            }
            if (
                this.pagedBuildNeedsRefresh
                || buildCalibrationKey !== this.getBottomClipCompensationGeometryKey()
                || buildLayoutSignature !== this.getPagedLayoutSignature()
                || buildGeometrySignature !== this.getPagedGeometrySignature()
            ) {
                storePartialLayout(queue.length);
                this.pagedBuildNeedsRefresh = true;
                return false;
            }
            this.pagedPages = markRaw(finalPages);
            this.currentPageIndex = Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex));
            if (this.pagedPagesPartial) {
                // Номера готовых страниц не менялись: пересчитываем только долю прочитанного по точному числу
                this.pagedPagesPartial = false;
                this.syncPagedProgress(false);
            }
            this.pagedLayoutSignature = buildLayoutSignature;
            this.pagedCommittedCalibrationKey = buildCalibrationKey;
            this.pagedCommittedCalibrationGeneration = buildOwnerJobId;
            this.pagedCommittedCalibrationAt = Date.now();
            this.resetBottomClipCalibrationSample();
            this.noteCompactChromeTotalPages();
            this.rebuildSearchResults(false);
            this.storePagedLayoutCacheEntry(layoutCacheKey, {
                type: 'complete',
                pages: finalPages,
                buildProgressPercent: 100,
                stats: Object.assign({}, stats, {status: 'done'}),
            });
            if (this.readerDebugEnabled)
                publishStats('done');
            return true;
        } finally {
            // A stale job must not reset the flags/signatures owned by a newer
            // pagination pass.
            if (this.pagedBuildOwnerJobId === buildOwnerJobId) {
                this.pagedBuildOwnerJobId = 0;
                this.pagedBuildInProgress = false;
                this.pagedBuildProgressPercent = 0;
                this.pagedBuildStage = 'idle';
                if (
                    String(this.loadingMessage || '').startsWith(this.uiText.loadingPages.replace('...', ''))
                    || String(this.loadingMessage || '').startsWith(this.uiText.loadingPagesFinalizing.replace('...', ''))
                )
                    this.loadingMessage = '';
                const completedBuildSignature = this.pagedBuildSignature;
                const completedGeometrySignature = this.pagedBuildGeometrySignature;
                this.pagedBuildSignature = '';
                this.pagedBuildGeometrySignature = '';
                const isCurrentJob = (!jobId || jobId === this.pagedBuildJobId);
                if (isCurrentJob) {
                    if (this.compactChromePagedBuildPending)
                        this.touchCompactChromeBuildActivity();
                    const refreshAlreadySatisfied = !!(
                        this.pagedBuildNeedsRefresh
                        && completedBuildSignature
                        && completedGeometrySignature
                        && completedBuildSignature === this.getPagedLayoutSignature()
                        && completedGeometrySignature === this.getPagedGeometrySignature()
                    );
                    if (refreshAlreadySatisfied) {
                        this.pagedBuildNeedsRefresh = false;
                        if (this.progressPersistPendingAfterPagedBuild) {
                            this.progressPersistPendingAfterPagedBuild = false;
                            this.$nextTick(() => this.queuePersistProgress());
                        }
                        if (this.compactChromePagedBuildPending)
                            this.scheduleCompactChromeBuildPendingClear();
                        this.$nextTick(() => this.flushPendingReaderAnchorJump());
                    } else {
                        if (this.pagedBuildNeedsRefresh) {
                            this.pagedBuildNeedsRefresh = false;
                            this.updateScrollerViewport();
                        } else {
                            if (this.progressPersistPendingAfterPagedBuild) {
                                this.progressPersistPendingAfterPagedBuild = false;
                                this.$nextTick(() => this.queuePersistProgress());
                            }
                            if (this.compactChromePagedBuildPending)
                                this.scheduleCompactChromeBuildPendingClear();
                        }
                        this.$nextTick(() => this.flushPendingReaderAnchorJump());
                    }
                }
            }
        }
    }

    getPagedOffset(target) {
        if (!this.$refs.scroller || !target)
            return 0;

        const scroller = this.$refs.scroller;
        const scrollerRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const rawOffset = Math.max(0, (
            this.isHorizontalPaged
                ? scroller.scrollLeft + (targetRect.left - scrollerRect.left)
                : scroller.scrollTop + (targetRect.top - scrollerRect.top)
        ));
        const {pageOffsets, maxScroll} = this.pagedMetrics;
        const pageIndex = Math.max(0, Math.floor(rawOffset / Math.max(1, this.pagedMetrics.pageSize)));
        const snappedOffset = (pageOffsets[pageIndex] !== undefined ? pageOffsets[pageIndex] : 0);

        return Math.max(0, Math.min(maxScroll, snappedOffset));
    }

    findPagedPageIndexByAnchor(id = '') {
        const safeId = String(id || '').trim();
        if (!safeId || !this.pagedPages.length)
            return -1;

        const directIndex = this.pagedPages.findIndex((page) => String((page && page.sectionId) || '').trim() === safeId);
        if (directIndex >= 0)
            return directIndex;

        const anchorIndex = this.pagedPages.findIndex((page) => (
            Array.isArray(page && page.anchorIds)
            && page.anchorIds.some((anchorId) => String(anchorId || '').trim() === safeId)
        ));
        if (anchorIndex >= 0)
            return anchorIndex;

        const htmlId = this.escapeHtml(safeId);
        const needles = [
            `id="${htmlId}"`,
            `id='${htmlId}'`,
            `name="${htmlId}"`,
        ];

        const htmlIndex = this.pagedPages.findIndex((page) => {
            const html = String((page && page.html) || '');
            return needles.some((needle) => html.includes(needle));
        });
        if (htmlIndex >= 0)
            return htmlIndex;

        return this.findPagedPageIndexByAnchorText(safeId);
    }

    findPagedPageIndexByTextSnippet(textSnippet = '', preferredIndex = -1) {
        if (!this.pagedPages.length)
            return -1;
        return this.scanPagedPagesForSnippet(this.pagedPages, textSnippet, preferredIndex).bestIndex;
    }

    // Страница с фрагментом, ближайшая к preferredIndex (при равенстве - первая). scan хранит, докуда
    // просмотрено: при разбивке по частям новые страницы досматриваются, а не ищутся заново
    scanPagedPagesForSnippet(pages = [], textSnippet = '', preferredIndex = -1, scan = {}) {
        if (scan.bestIndex === undefined) {
            const safeSnippet = readerTextAnchors.normalizeReaderSearchText(textSnippet).toLowerCase();
            scan.needles = (safeSnippet ? [
                safeSnippet.slice(0, 180),
                safeSnippet.slice(0, 120),
                safeSnippet.slice(0, 80),
                safeSnippet.slice(0, 48),
                safeSnippet.slice(0, 24),
            ] : []).filter((value) => value.length >= 12);
            scan.next = 0;
            scan.bestIndex = -1;
            scan.bestDistance = Infinity;
            scan.done = !scan.needles.length;
        }

        for (let index = scan.next; !scan.done && index < pages.length; index += 1) {
            scan.next = index + 1;
            const page = pages[index] || {};
            const pageText = readerTextAnchors.getHtmlReaderSearchText(page.html || '');
            if (!pageText)
                continue;
            if (!scan.needles.some((needle) => pageText.includes(needle)))
                continue;

            const distance = (preferredIndex >= 0 ? Math.abs(index - preferredIndex) : 0);
            if (scan.bestIndex < 0 || distance < scan.bestDistance) {
                scan.bestIndex = index;
                scan.bestDistance = distance;
                if (!distance)
                    scan.done = true;
            }
        }

        return scan;
    }

    // Первый показ готовых страниц: страница открытия должна быть среди них и не измениться от остальных.
    // Открытие по фрагменту текста или с начала книги; остальные способы (доля, раздел) ждут конца разбивки
    showFirstPartialPagedPages(pages = [], scan = {}) {
        const progress = this.progress || {};
        const textSnippet = String(progress.textSnippet || '').trim();
        const textOffset = Number(progress.textOffset);
        let pageIndex = -1;
        if (!this.hasReaderProgressPlace(progress)) {
            pageIndex = (this.currentPageIndex < pages.length - 1 ? this.currentPageIndex : -1);
        } else if (textSnippet && !textSnippet.startsWith('image:')) {
            const preferredIndex = Number(progress.pageIndex);
            const preferred = (Number.isFinite(preferredIndex) ? preferredIndex : -1);
            this.scanPagedPagesForSnippet(pages, textSnippet, preferred, scan);
            pageIndex = (readerPaging.isSnippetMatchFinal(pages.length, preferred, scan.bestIndex, scan.bestDistance) ? scan.bestIndex : -1);
        } else if (!textSnippet && Number.isFinite(textOffset) && textOffset >= 0) {
            const documentText = this.getReaderDocumentSearchText();
            this.scanPagedPagesForSnippet(pages, documentText.slice(textOffset, textOffset + 80), -1, scan);
            pageIndex = scan.bestIndex;
        }
        if (pageIndex < 0)
            return false;

        // Это и есть восстановление места (restoreProgress): после разбивки повторять его не нужно
        this.pagedPages = markRaw(pages.slice());
        this.pagedPagesPartial = true;
        this.restorePending = false;
        this.restoreFromSavedProgress = false;
        if (this.hasReaderProgressPlace(progress)) {
            this.pendingReflowAnchor = null;
            this.setCurrentPagedRestorePage(pageIndex, {textSnippet, textOffset});
        } else {
            this.currentPageIndex = pageIndex;
            this.syncPagedProgress(false);
        }
        return true;
    }

    findPagedPageIndexByReaderTextAnchor(textSnippet = '', textOffset = -1, preferredIndex = -1) {
        let pageIndex = -1;
        if (String(textSnippet || '').startsWith('image:'))
            pageIndex = this.findPagedPageIndexByAnchor(textSnippet);
        if (pageIndex < 0 && textSnippet)
            pageIndex = this.findPagedPageIndexByTextSnippet(textSnippet, preferredIndex);
        if (pageIndex < 0 && Number(textOffset) >= 0)
            pageIndex = this.findPagedPageIndexByTextOffset(textOffset);
        if (pageIndex < 0 && Number(textOffset) >= 0)
            pageIndex = this.findPagedPageIndexByPageStartOffset(textOffset);
        return pageIndex;
    }

    getPagedPageSearchText(index = 0) {
        const page = this.pagedPages[Math.max(0, Math.min(this.pagedPages.length - 1, Number(index || 0) || 0))] || {};
        return readerTextAnchors.getHtmlReaderSearchText(page.html || '');
    }

    getPagedTextOffsetForSnippet(textSnippet = '', pageIndex = 0) {
        const safeSnippet = readerTextAnchors.normalizeReaderSearchText(textSnippet).toLowerCase();
        if (!safeSnippet || !this.pagedPages.length)
            return -1;

        const safePageIndex = Math.max(0, Math.min(this.pagedPages.length - 1, Math.round(Number(pageIndex || 0) || 0)));
        const needles = [
            safeSnippet.slice(0, 180),
            safeSnippet.slice(0, 120),
            safeSnippet.slice(0, 80),
            safeSnippet.slice(0, 48),
            safeSnippet.slice(0, 24),
        ].filter((value) => value.length >= 12);
        if (!needles.length)
            return -1;

        const documentText = this.getReaderDocumentSearchText();
        for (const needle of needles) {
            const documentOffset = documentText.indexOf(needle);
            if (documentOffset >= 0)
                return documentOffset;
        }

        let offset = 0;
        for (let index = 0; index < safePageIndex; index += 1)
            offset += this.getPagedPageSearchText(index).length + 1;

        const pageText = this.getPagedPageSearchText(safePageIndex);
        for (const needle of needles) {
            const localOffset = pageText.indexOf(needle);
            if (localOffset >= 0)
                return offset + localOffset;
        }

        return offset;
    }

    findPagedPageIndexByTextOffset(textOffset = -1) {
        const targetOffset = Math.max(0, Math.round(Number(textOffset)));
        if (!Number.isFinite(targetOffset) || !this.pagedPages.length)
            return -1;

        const documentText = this.getReaderDocumentSearchText();
        if (documentText) {
            const targetSnippet = documentText.slice(targetOffset, targetOffset + 80);
            const pageIndex = this.findPagedPageIndexByTextSnippet(targetSnippet);
            if (pageIndex >= 0)
                return pageIndex;
        }

        let offset = 0;
        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const pageText = this.getPagedPageSearchText(index);
            const nextOffset = offset + pageText.length + 1;
            if (targetOffset < nextOffset)
                return index;
            offset = nextOffset;
        }

        return this.pagedPages.length - 1;
    }

    findPagedPageIndexByPageStartOffset(textOffset = -1) {
        const targetOffset = Math.max(0, Math.round(Number(textOffset)));
        if (!Number.isFinite(targetOffset) || !this.pagedPages.length)
            return -1;

        const pageStarts = this.getPagedPageDocumentStartOffsets();
        if (pageStarts.length) {
            let bestIndex = 0;
            let bestDistance = Infinity;
            for (let index = 0; index < pageStarts.length; index += 1) {
                const start = Number(pageStarts[index]);
                if (!Number.isFinite(start) || start < 0)
                    continue;

                const distance = Math.abs(targetOffset - start);
                if (distance < bestDistance) {
                    bestIndex = index;
                    bestDistance = distance;
                }

                if (start > targetOffset && distance > bestDistance)
                    break;
            }
            return bestIndex;
        }

        let offset = 0;
        let bestIndex = 0;
        let bestDistance = Math.abs(targetOffset);

        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const pageText = this.getPagedPageSearchText(index);
            const distance = Math.abs(targetOffset - offset);
            if (offset <= targetOffset && distance <= bestDistance) {
                bestIndex = index;
                bestDistance = distance;
            }

            const nextOffset = offset + pageText.length + 1;
            if (nextOffset > targetOffset)
                break;
            offset = nextOffset;
        }

        return bestIndex;
    }

    getPagedPageDocumentStartOffsets() {
        const documentText = this.getReaderDocumentSearchText();
        if (!documentText || !this.pagedPages.length)
            return [];

        const starts = [];
        let searchFrom = 0;
        let estimatedOffset = 0;
        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const pageText = this.getPagedPageSearchText(index);
            if (!pageText) {
                starts.push(starts.length ? starts[starts.length - 1] : estimatedOffset);
                continue;
            }

            const needles = [
                pageText.slice(0, 160),
                pageText.slice(0, 100),
                pageText.slice(0, 60),
                pageText.slice(0, 32),
            ].filter(value => value.length >= 12);

            let foundAt = -1;
            for (const needle of needles) {
                foundAt = documentText.indexOf(needle, Math.max(0, searchFrom - 12));
                if (foundAt >= 0)
                    break;
            }

            if (foundAt < 0)
                foundAt = Math.max(searchFrom, estimatedOffset);

            starts.push(foundAt);
            searchFrom = foundAt + 1;
            estimatedOffset = Math.max(estimatedOffset, foundAt + pageText.length + 1);
        }

        return starts;
    }

    findPagedPageIndexByAnchorText(id = '') {
        const safeId = String(id || '').trim();
        if (!safeId || typeof document === 'undefined')
            return -1;

        const sourceHost = readerTextAnchors.parseInertHtml(this.readerHtml).content;
        const target = sourceHost.querySelector(`#${this.escapeCssId(safeId)}`)
            || Array.from(sourceHost.querySelectorAll('[name]')).find((node) => node.getAttribute('name') === safeId);
        if (!target)
            return -1;

        const targetText = readerTextAnchors.normalizeReaderSearchText(target.textContent || '');
        if (!targetText)
            return -1;

        const textNeedles = [
            targetText.slice(0, 180),
            targetText.slice(0, 120),
            targetText.slice(0, 80),
        ].map((value) => String(value || '').trim()).filter((value) => value.length >= 24);
        if (!textNeedles.length)
            return -1;

        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const pageText = readerTextAnchors.normalizeReaderSearchText(this.getPagedPageText(this.pagedPages[index]));
            if (textNeedles.some((needle) => pageText.includes(needle)))
                return index;
        }

        return -1;
    }
}
