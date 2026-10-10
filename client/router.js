import { createRouter, createWebHashHistory } from 'vue-router';

const Reader = () => import('./components/Reader/Reader.vue');
const ReaderLab = () => import('./components/Reader/ReaderLab.vue');
const HomePage = () => import('./components/Library/HomePage.vue');
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
const discoveryPaths = ['/for-you', '/newest', '/popular', '/bestsellers'];

//Старые адреса каталога (/author?author=..., /books?genre=...) ведут в новый поиск.
//«=Имя» в старом поиске означало точное совпадение - такие ссылки открывают страницу автора или серии.
function legacyCatalog(to) {
    const query = to.query || {};
    const exact = value => (String(value || '').startsWith('=') ? String(value).substring(1) : '');
    //имя передаётся как есть: vue-router сам кодирует путь
    if (exact(query.author))
        return {path: `/author/${exact(query.author)}`, query: {}};
    if (exact(query.series))
        return {path: `/series/${exact(query.series)}`, query: {}};

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
    {path: '/', component: HomePage, meta: {section: 'home'}, beforeEnter: to => (Object.keys(to.query).length ? legacyCatalog(to) : true)},
    ...['/author', '/series', '/title', '/books', '/extended'].map(path => ({path, redirect: legacyCatalog})),
    {path: '/search', component: SearchPage, meta: {section: 'library'}},
    {path: '/book/:uid', component: BookPage, meta: {section: 'library'}},
    {path: '/author/:name', component: AuthorPage, meta: {section: 'library'}},
    {path: '/series/:name', component: SeriesPage, meta: {section: 'library'}},
    ...discoveryPaths.map(path => ({path, component: DiscoveryPage, meta: {section: 'library'}})),
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

export default createRouter({
    history: createWebHashHistory(),
    routes
});
