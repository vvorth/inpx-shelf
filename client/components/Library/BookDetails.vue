<template>
    <section class="book-section">
        <div class="card-head">
            <h2 class="card-title">
                {{ $t('bookDetails.details') }}
            </h2>
            <q-btn v-if="canEdit" flat dense no-caps color="primary" icon="la la-edit" @click="openEditor">
                {{ $t('bookDetails.editDetails') }}
            </q-btn>
        </div>

        <nav class="tabs" :aria-label="$t('bookDetails.details')">
            <button v-for="item in tabs" :key="item.name" type="button" class="tab" :class="{'is-active': tab === item.name}" @click="selectTab(item.name)">
                {{ item.label }}<span v-if="item.count" class="tab-count num">{{ item.count }}</span>
            </button>
        </nav>
        <div v-if="loading" class="card-hint">
            {{ $t('bookDetails.readingTheBookFile') }}
        </div>

        <div v-if="tab === 'about'" class="details-body">
            <blockquote v-if="epigraph.length" class="details-epigraph">
                <p v-for="(line, index) in epigraph" :key="index">
                    {{ line }}
                </p>
                <footer v-if="annotationMeta.epigraphAuthor">
                    {{ annotationMeta.epigraphAuthor }}
                </footer>
            </blockquote>
            <dl v-if="statRows.length" class="details-meta">
                <template v-for="item in statRows" :key="item.label">
                    <dt>{{ item.label }}</dt>
                    <dd class="num">
                        {{ item.value }}
                    </dd>
                </template>
            </dl>
            <div v-for="group in fb2" :key="group.name" class="details-group">
                <h3 class="details-group-title">
                    {{ $tm(group.label) }}
                </h3>
                <dl class="details-meta">
                    <template v-for="item in group.value" :key="item.name">
                        <dt>{{ $tm(item.label) }}</dt>
                        <dd v-html="item.value" />
                    </template>
                </dl>
            </div>
        </div>

        <ol v-else-if="tab === 'contents'" class="details-body details-contents">
            <li v-for="(item, index) in contents" :key="index" :style="{paddingLeft: `${item.level * 18}px`}">
                {{ item.title }}
            </li>
        </ol>

        <div v-else-if="tab === 'author'" class="details-body">
            <div v-if="authorInfoLoading" class="card-hint">
                {{ $t('common.loadingAuthorInformation') }}
            </div>
            <div v-else-if="authorInfo" class="details-author">
                <img v-if="authorInfo.photo" :src="authorInfo.photo" class="details-author-photo" alt="" />
                <div class="details-prose" v-html="authorInfoHtml" />
            </div>
            <div v-else class="card-hint">
                {{ $t('bookInfo.noAuthorInformationFound') }}
            </div>
        </div>

        <div v-else-if="tab === 'reviews'" class="details-body details-reviews">
            <article v-for="(review, index) in reviews" :key="index" class="details-review">
                <header>
                    <b>{{ review.name }}</b><span v-if="review.time" class="card-hint">{{ review.time }}</span>
                </header>
                <p>{{ review.text }}</p>
            </article>
        </div>

        <div v-else-if="tab === 'images'" class="details-body details-images">
            <img v-for="image in images" :key="image.id" :src="image.src" alt="" />
        </div>

        <div v-else-if="tab === 'file'" class="details-body">
            <div v-for="group in inpx" :key="group.name" class="details-group">
                <h3 class="details-group-title">
                    {{ group.label }}
                </h3>
                <dl class="details-meta">
                    <template v-for="item in group.value" :key="item.name">
                        <dt>{{ item.label }}</dt>
                        <dd v-html="item.value" />
                    </template>
                </dl>
            </div>
        </div>

        <q-dialog v-model="editorVisible">
            <div class="details-editor">
                <h2 class="card-title">
                    {{ $t('bookInfo.editMetadata') }}
                </h2>
                <div class="card-hint">
                    {{ $t('bookInfo.localOverrideSavedTop') }}
                </div>
                <q-input v-model="form.title" outlined dense :label="$t('common.title')" />
                <q-input v-model="form.author" outlined dense :label="$t('common.authors')" />
                <q-input v-model="form.series" outlined dense :label="$t('common.series')" />
                <q-input v-model.number="form.serno" outlined dense type="number" :label="$t('bookInfo.numberSeries')" />
                <div class="card-actions details-editor-actions">
                    <q-btn flat no-caps @click="editorVisible = false">
                        {{ $t('common.cancel') }}
                    </q-btn>
                    <q-btn color="primary" unelevated no-caps :loading="saving" @click="save">
                        {{ $t('common.save') }}
                    </q-btn>
                </div>
            </div>
        </q-dialog>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import Fb2Parser from '../../../server/core/fb2/Fb2Parser';
const {escapeHtml, safeHtml} = require('../../../shared/safeHtml');
import {t, getLocale, formatDateTime} from '../../share/i18n';
import {isAdmin} from '../../share/session';
import {genreName} from '../../share/genres';
import {bookUid} from '../../share/bookActions';

const componentOptions = {
    emits: ['updated'],
    watch: {
        bookInfo() {
            this.parse();
        },
    },
};

//Подробности книги на её странице: сведения FB2, содержание, об авторе, отзывы, иллюстрации, файл
class BookDetails {
    _options = componentOptions;
    _props = {
        book: {type: Object, required: true},
        bookInfo: {type: Object, default: null},
        loading: Boolean,
    };

    tab = '';
    picked = false;
    fb2 = [];
    contents = [];
    images = [];
    authorInfo = null;
    authorInfoLoading = false;
    authorInfoTried = false;
    editorVisible = false;
    saving = false;
    form = {};

    created() {
        this.api = this.$root.api;
        this.parse();
    }

    get canEdit() {
        return isAdmin(this.$store.state.config) && !!bookUid(this.book);
    }

    get info() {
        return this.bookInfo || {};
    }

    get annotationMeta() {
        return this.info.annotationMeta || {};
    }

    get epigraph() {
        return this.annotationMeta.epigraph || [];
    }

    get reviews() {
        return Array.isArray(this.info.reviews) ? this.info.reviews : [];
    }

    get statRows() {
        const stats = this.annotationMeta.stats;
        if (!stats)
            return [];
        const int = value => Number(value || 0).toLocaleString(getLocale());
        const rows = [];
        if (stats.letters)
            rows.push({label: t('bookInfo.letters'), value: int(stats.letters)});
        if (stats.words)
            rows.push({label: t('bookInfo.words'), value: int(stats.words)});
        if (stats.pages)
            rows.push({label: t('bookInfo.pages'), value: String(stats.pages).replace('.', ',')});
        if (stats.images)
            rows.push({label: t('bookInfo.images'), value: int(stats.images)});
        return rows;
    }

    get tabs() {
        const tabs = [];
        if (this.fb2.length || this.statRows.length || this.epigraph.length)
            tabs.push({name: 'about', label: t('bookDetails.aboutTheBook')});
        if (this.contents.length)
            tabs.push({name: 'contents', label: t('common.contents')});
        if (this.book.author)
            tabs.push({name: 'author', label: t('common.aboutAuthor')});
        if (this.reviews.length)
            tabs.push({name: 'reviews', label: t('bookDetails.reviews'), count: this.reviews.length});
        if (this.images.length)
            tabs.push({name: 'images', label: t('bookInfo.illustrations'), count: this.images.length});
        tabs.push({name: 'file', label: t('opds.file')});
        return tabs;
    }

    get authorInfoHtml() {
        return safeHtml((this.authorInfo && this.authorInfo.html) || '');
    }

    selectTab(name) {
        this.tab = name;
        this.picked = true;
        if (name === 'author')
            this.loadAuthorInfo();
    }

    genreNames(value) {
        return String(value || '').split(',').map(code => code.trim()).filter(Boolean).map(code => escapeHtml(genreName(code))).join(', ');
    }

    //ключевые слова ведут в поиск
    keywordLinks(value) {
        return String(value || '').split(/[;,]/).map(item => item.trim()).filter(Boolean)
            .map(item => `<a href="#/search?q=${encodeURIComponent(item)}">${escapeHtml(item)}</a>`)
            .join(', ');
    }

    formatSize(size) {
        const kb = size / 1024;
        return (kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`);
    }

    get inpx() {
        const book = this.book;
        const groups = [
            {name: 'file', label: t('bookInfo.fileInformation'), value: [
                {name: 'folder', label: t('bookInfo.archive'), value: escapeHtml(book.folder || '')},
                {name: 'file', label: t('bookInfo.fileArchive'), value: (book.file ? escapeHtml(`${book.file}.${book.ext}`) : '')},
                {name: 'size', label: t('common.size'), value: (book.size ? `${this.formatSize(book.size)} (${Number(book.size).toLocaleString(getLocale())} Bytes)` : '')},
                {name: 'date', label: t('bookInfo.added'), value: (book.date ? escapeHtml(formatDateTime(book.date, {year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC'}) || book.date) : '')},
                {name: 'del', label: t('bookInfo.deleted'), value: (book.del ? t('common.yes') : '')},
                {name: 'libid', label: 'LibId', value: escapeHtml(String(book.libid || ''))},
                {name: 'insno', label: 'InsideNo', value: escapeHtml(String(book.insno || ''))},
            ]},
            {name: 'title', label: t('bookInfo.generalInformation'), value: [
                {name: 'genre', label: t('common.genre'), value: this.genreNames(book.genre)},
                {name: 'lang', label: t('bookInfo.bookLanguage'), value: escapeHtml(book.lang || '')},
                {name: 'keywords', label: t('common.keywords'), value: this.keywordLinks(book.keywords)},
            ]},
        ];
        return groups
            .map(group => Object.assign({}, group, {value: group.value.filter(item => item.value)}))
            .filter(group => group.value.length);
    }

    parse() {
        this.fb2 = [];
        this.contents = [];
        this.images = [];
        this.authorInfo = this.info.authorInfo || null;
        this.authorInfoTried = false;

        if (this.info.fb2) {
            try {
                const parser = new Fb2Parser(this.info.fb2);
                const infoObj = parser.bookInfo();
                this.images = this.extractImages(parser);
                this.fb2 = parser.bookInfoList(infoObj, {
                    valueToString: (value, nodePath, origVTS) => {
                        if (nodePath == 'documentInfo/historyHtml' && value)
                            return this.fb2Html(value);
                        if ((nodePath == 'titleInfo/genre' || nodePath == 'srcTitleInfo/genre') && value)
                            return this.genreNames(value);
                        if ((nodePath == 'titleInfo/keywords' || nodePath == 'srcTitleInfo/keywords') && value)
                            return this.keywordLinks(value);
                        const text = origVTS(value, nodePath);
                        return (text ? escapeHtml(text) : text);
                    },
                });
                this.contents = this.info.contents || [];
            } catch (e) {
                //повреждённый FB2: остаются сведения из INPX
            }
        }

        //пока файл книги не прочитан, открыта вкладка «Файл»: её данные уже есть
        if (!this.picked || !this.tabs.some(item => item.name === this.tab))
            this.tab = (this.bookInfo ? this.tabs[0].name : 'file');
    }

    async loadAuthorInfo() {
        if (this.authorInfo || this.authorInfoTried)
            return;
        const firstAuthor = String(this.book.author || '').split(',').map(item => item.trim()).filter(Boolean)[0];
        if (!firstAuthor)
            return;
        this.authorInfoTried = true;
        this.authorInfoLoading = true;
        try {
            const response = await this.api.getAuthorInfo(0, firstAuthor);
            this.authorInfo = (response && response.authorInfo) || null;
        } catch (e) {
            this.authorInfo = null;
        } finally {
            this.authorInfoLoading = false;
        }
    }

    extractImages(parser) {
        const result = [];
        const coverNode = parser.$$('/description/title-info/coverpage/image');
        let coverId = '';
        if (coverNode && coverNode.count) {
            const href = (coverNode.attrs() || {})[`${parser.xlinkNS}:href`];
            if (href)
                coverId = (href[0] == '#' ? href.substring(1) : href);
        }

        for (const node of parser.$$array('/binary')) {
            const attrs = node.attrs() || {};
            let type = String(attrs['content-type'] || '').toLowerCase();
            if (type == 'image/jpg' || type == 'application/octet-stream')
                type = 'image/jpeg';
            const base64 = node.text();
            if (!attrs.id || !base64 || !type.startsWith('image/') || attrs.id === coverId)
                continue;
            result.push({id: attrs.id, src: `data:${type};base64,${base64}`});
        }
        return result.slice(0, 18);
    }

    //Разметка истории документа FB2 очищается как любой HTML библиотеки; картинки FB2 возвращаются своими <img>
    fb2Html(html = '') {
        const ids = [];
        const marked = String(html).replace(/[]/g, '')
            .replace(/<image\b[^>]*href=["']#([^"']+)["'][^>]*\/?>/gi, (match, id) => `${ids.push(id) - 1}`);
        const imageMap = new Map(this.images.map(item => [String(item.id), item.src]));
        return safeHtml(marked).replace(/(\d+)/g, (match, index) => {
            const src = imageMap.get(String(ids[index]));
            return (src && /^data:image\/[\w.+-]+;base64,[\w+/=\s]+$/.test(src) ? `<img src="${src}" alt="">` : '');
        });
    }

    openEditor() {
        this.form = {
            title: String(this.book.title || ''),
            author: String(this.book.author || ''),
            series: String(this.book.series || ''),
            serno: this.book.serno || '',
        };
        this.editorVisible = true;
    }

    async save() {
        this.saving = true;
        try {
            await this.api.updateBookMetadata(bookUid(this.book), this.form);
            this.$emit('updated', {
                title: String(this.form.title || '').trim(),
                author: String(this.form.author || '').trim(),
                series: String(this.form.series || '').trim(),
                serno: this.form.serno || '',
                metadataOverridden: true,
            });
            this.editorVisible = false;
            this.$root.notify.success(t('bookInfo.metadataSaved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.saving = false;
        }
    }
}

export default vueComponent(BookDetails);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.details-body {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 820px;
}

.details-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.details-group-title {
    margin: 0;
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.details-meta {
    display: grid;
    grid-template-columns: minmax(120px, auto) minmax(0, 1fr);
    gap: 4px 16px;
    margin: 0;
    font-size: 13px;
}

.details-meta dt {
    color: var(--app-muted);
}

.details-meta dd {
    margin: 0;
    overflow-wrap: anywhere;
}

.details-meta dd :deep(p) {
    margin: 0 0 0.4em;
}

.details-meta dd :deep(img),
.details-prose :deep(img) {
    max-width: 100%;
}

.details-epigraph {
    margin: 0;
    padding-left: 14px;
    border-left: 3px solid var(--app-border);
    font-family: var(--app-font-serif);
    font-style: italic;
}

.details-epigraph p {
    margin: 0;
}

.details-epigraph footer {
    margin-top: 4px;
    color: var(--app-muted);
    font-style: normal;
    font-size: 13px;
}

.details-contents {
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 14px;
}

.details-author {
    display: flex;
    align-items: flex-start;
    gap: 18px;
}

.details-author-photo {
    width: 140px;
    flex: none;
    border-radius: var(--app-radius);
}

.details-prose {
    min-width: 0;
    max-width: 68ch;
    line-height: 1.55;
}

.details-reviews {
    gap: 12px;
}

.details-review {
    padding: 12px 14px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.details-review header {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: baseline;
}

.details-review p {
    margin: 6px 0 0;
    white-space: pre-line;
    line-height: 1.5;
}

.details-images {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
}

.details-images img {
    width: 100%;
    border-radius: 6px;
    background: var(--app-surface-3);
}

.details-editor {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(480px, 94vw);
    padding: 18px 20px;
    border-radius: 10px;
    background: var(--app-surface);
    color: var(--app-text);
}

.details-editor-actions {
    justify-content: flex-end;
}

@media (max-width: 600px) {
    .details-author {
        flex-direction: column;
    }

    .details-meta {
        grid-template-columns: minmax(0, 1fr);
    }

    .details-meta dd {
        margin-bottom: 6px;
    }
}
</style>
