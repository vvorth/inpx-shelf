import { createRouter, createWebHashHistory } from 'vue-router';

import { authorRoute, seriesRoute } from './share/bookActions';

const Reader = () => import('./components/Reader/Reader.vue');
const ReaderLab = () => import('./components/Reader/ReaderLab.vue');
const SearchPage = () => import('./components/Library/SearchPage.vue');
const DiscoveryPage = () => import('./components/Library/DiscoveryPage.vue');
const BookPage = () => import('./components/Library/BookPage.vue');
const AuthorPage = () => import('./components/Library/AuthorPage.vue');
const SeriesPage = () => import('./components/Library/SeriesPage.vue');
const LoginPage = () => import('./components/Login/LoginPage.vue');
const ListsPage = () => import('./components/Lists/ListsPage.vue');
const MePage = () => import('./components/Me/MePage.vue');
const AdminPage = () => import('./components/Admin/AdminPage.vue');

//bare: страница без меню приложения (читалка, вход)

//Старые адреса каталога (/author?author=..., /books?genre=...) ведут в новый поиск.
//«=Имя» в старом поиске означало точное совпадение - такие ссылки открывают страницу автора или серии.
export function legacyCatalog(to) {
    const query = to.query || {};
    const exact = value => (String(value || '').startsWith('=') ? String(value).substring(1) : '');
    //path разбирается как адрес и не кодируется: имя с / ? # % ломает его без encodeURIComponent
    if (exact(query.author))
        return {path: authorRoute(exact(query.author)), query: {}};
    if (exact(query.series))
        return {path: seriesRoute(exact(query.series)), query: {}};

    const result = {};
    const text = [query.author, query.series, query.title].map(value => String(value || '').replace(/^[=*#~]/, '').trim()).filter(Boolean);
    if (text.length)
        result.q = text.join(' ');
    for (const field of ['genre', 'lang', 'ext', 'librate']) {
        if (query[field])
            result[field] = String(query[field]);
    }
    if (to.path === '/author' && !query.series && !query.title)
        result.tab = 'authors';
    else if (to.path === '/series' && !query.author && !query.title)
        result.tab = 'series';
    return {path: '/search', query: result};
}

const routes = [
    //старые ссылки вида /#/?author=... открывали каталог
    //главная - персональные подборки (бывшая «Для вас»)
    {path: '/', component: DiscoveryPage, meta: {section: 'home'}, beforeEnter: to => (Object.keys(to.query).length ? legacyCatalog(to) : true)},
    ...['/for-you', '/newest', '/popular'].map(path => ({path, redirect: '/'})),
    ...['/author', '/series', '/title', '/books', '/extended'].map(path => ({path, redirect: legacyCatalog})),
    {path: '/search', component: SearchPage, meta: {section: 'library'}},
    {path: '/book/:uid', component: BookPage, meta: {section: 'library'}},
    {path: '/author/:name', component: AuthorPage, meta: {section: 'library'}},
    {path: '/series/:name', component: SeriesPage, meta: {section: 'library'}},
    {path: '/bestsellers', component: DiscoveryPage, meta: {section: 'library'}},
    {path: '/lists', component: ListsPage, meta: {section: 'lists'}},
    {path: '/me', redirect: '/me/account'},
    {path: '/me/:section', component: MePage, meta: {section: 'me'}},
    {path: '/admin', redirect: '/admin/overview'},
    {path: '/admin/:section', component: AdminPage, meta: {section: 'admin'}},
    {path: '/login', component: LoginPage, meta: {bare: true}},
    {path: '/reader', component: Reader, meta: {bare: true}},
    {path: '/reader-lab', component: ReaderLab, meta: {bare: true}},
    {path: '/:pathMatch(.*)*', redirect: '/'},
];

//Страницы прокручиваются в своём .page, а не в окне, и keep-alive при возврате сбрасывает прокрутку,
//поэтому положение запоминается для каждой записи истории и восстанавливается по «Назад» и «Вперёд».
//Обработчик popstate ставится до создания роутера: роутер завершает переход внутри своего обработчика.
let historyMove = false;
window.addEventListener('popstate', () => {
    historyMove = true;
});

const router = createRouter({
    history: createWebHashHistory(),
    routes
});

const scrollPositions = new Map();
const scrollKey = () => `${(window.history.state || {}).position}|${router.currentRoute.value.fullPath}`;

document.addEventListener('scroll', (event) => {
    //прокрутка книги в окне поверх страницы не трогает положение самой страницы
    if (event.target.classList && event.target.classList.contains('page') && !event.target.closest('.q-dialog'))
        scrollPositions.set(scrollKey(), event.target.scrollTop);
}, true);

//Книга, открытая из приложения, показывается окном поверх текущей страницы: адрес страницы
//получает ?book=<uid>, поэтому страница под окном остаётся на своём маршруте, а «Назад» закрывает окно.
//Прямая ссылка, новая вкладка, переход со страницы книги и «Назад»/«Вперёд» открывают обычную страницу книги.
export function bookDialogUid(route) {
    return (route.meta && route.meta.bare ? '' : String(route.query.book || ''));
}

function withoutBook(route) {
    const query = Object.assign({}, route.query);
    delete query.book;
    return {path: route.path, query, hash: route.hash};
}

export function closeBookDialog() {
    const current = router.currentRoute.value;
    const target = withoutBook(current);
    //окно открыто переходом с этой же страницы - закрываем шагом назад по истории, иначе убираем ?book
    if ((window.history.state || {}).back === router.resolve(target).fullPath)
        router.back();
    else
        router.replace(target);
}

export function pageFullPath(route) {
    return router.resolve(withoutBook(route)).fullPath;
}

router.beforeEach((to, from) => {
    if (!to.path.startsWith('/book/') || historyMove || !from.matched.length || from.path.startsWith('/book/') || (from.meta && from.meta.bare))
        return true;
    return Object.assign(withoutBook(from), {query: Object.assign(withoutBook(from).query, {book: to.params.uid})});
});

router.afterEach((to, from, failure) => {
    const restore = historyMove;
    historyMove = false;
    const top = scrollPositions.get(scrollKey());
    if (failure || !restore || !top)
        return;

    //страница может ещё догружать книги: пробуем, пока высоты не хватит, но не дольше 2 с
    const started = Date.now();
    const apply = () => {
        const page = document.querySelector('.page');
        if (page)
            page.scrollTop = top;
        if ((!page || page.scrollTop < top - 1) && Date.now() - started < 2000)
            requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
});

export default router;
