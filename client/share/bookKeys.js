//Клавиши для списков книг на странице: J/K переходят по книгам, Enter открывает (это ссылки),
//A добавляет в список, E на странице автора раскрывает или сворачивает группы. event.code, а не key: клавиши работают и в русской раскладке
import {isExternalOnly} from './discovery';

//у каждой книги во всех трёх видах BookCollection ровно одна такая ссылка, в порядке books
const linkSelector = '.book-card, .wide-card-title, .row-title';

//code нажатой клавиши, если это клавиша страницы: без модификаторов, не в поле ввода и не в открытом окне
export function pageKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        return '';
    const target = event.target;
    const tag = (target && target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (target && target.isContentEditable))
        return '';
    //открыто окно книги или списков
    if (document.querySelector('.q-dialog'))
        return '';
    return event.code;
}

//collections - компоненты BookCollection страницы (их может быть несколько, например группы на странице автора)
export function onBookKey(event, collections) {
    if (!['KeyJ', 'KeyK', 'KeyA'].includes(pageKey(event)))
        return;

    //порядок ссылок - как на экране; refs из v-for порядок не гарантируют
    const items = [];
    for (const collection of collections.filter(Boolean)) {
        collection.$el.querySelectorAll(linkSelector).forEach((link, index) => {
            items.push({link, collection, book: collection.books[index]});
        });
    }
    items.sort((a, b) => (a.link.compareDocumentPosition(b.link) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const index = items.findIndex(item => item.link === document.activeElement);

    if (event.code === 'KeyA') {
        const item = items[index];
        if (item && item.book && item.collection.signedIn && !isExternalOnly(item.book)) {
            event.preventDefault();
            item.collection.openLists(item.book);
        }
        return;
    }

    if (!items.length)
        return;
    event.preventDefault();
    const next = (index < 0 ? 0 : Math.min(Math.max(index + (event.code === 'KeyJ' ? 1 : -1), 0), items.length - 1));
    const link = items[next].link;
    link.focus({preventScroll: true});
    //center, чтобы ссылку не закрыла липкая верхняя панель
    link.scrollIntoView({block: 'center'});
}
