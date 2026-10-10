import { createRouter, createWebHashHistory } from 'vue-router';

const Search = () => import('./components/Search/Search.vue');
const Reader = () => import('./components/Reader/Reader.vue');
const ReaderLab = () => import('./components/Reader/ReaderLab.vue');
const LoginPage = () => import('./components/Login/LoginPage.vue');
const ListsPage = () => import('./components/Lists/ListsPage.vue');
const MePage = () => import('./components/Me/MePage.vue');
const AdminPage = () => import('./components/Admin/AdminPage.vue');

//bare: страница без меню приложения (читалка, вход)
const searchPaths = ['/', '/author', '/series', '/title', '/books', '/for-you', '/newest', '/popular', '/bestsellers', '/extended'];

const routes = [
    ...searchPaths.map(path => ({path, component: Search, meta: {section: 'library'}})),
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
