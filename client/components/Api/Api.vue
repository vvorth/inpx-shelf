<template>
    <div>
        <q-dialog :model-value="busyDialogVisible && !onLoginPage" no-route-dismiss no-esc-dismiss no-backdrop-dismiss>
            <div class="busy-card" role="status" aria-live="polite">
                <div class="busy-eyebrow">
                    {{ $t('api.theLibraryIsUpdating') }}
                </div>
                <div class="busy-title">
                    {{ mainMessage || $t('api.theServerIsPreparing') }}
                </div>
                <div class="busy-hint">
                    {{ $t('api.theServerIsReading') }}
                </div>
                <q-linear-progress rounded size="8px" :value="progress" :indeterminate="!progress" color="primary" />
                <div class="busy-meta">
                    <span class="busy-job">{{ jobMessage }}</span>
                    <span v-if="progress" class="busy-percent">{{ (progress*100).toFixed(0) }}%</span>
                </div>
            </div>
        </q-dialog>

        <div v-if="connectionState" class="connection-status" :class="{'connection-status--ok': connectionState === 'restored'}" role="status" aria-live="polite">
            <q-spinner v-if="connectionState === 'lost'" size="14px" />
            <q-icon v-else name="la la-check" size="16px" />
            {{ connectionState === 'lost' ? $t('api.connectionLost') : $t('api.connectionRestored') }}
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

//import _ from 'lodash';

import {call} from './apiConnection';
import apiRoutes from '../../../shared/apiRoutes.js';
import * as utils from '../../share/utils';
import LockQueue from '../../../server/core/LockQueue';
import packageJson from '../../../package.json';
import {t, tm, getLang} from '../../share/i18n';
import {isConnectionError, canRetryRequest, reconnectDelay} from '../../share/connection';

//сессия профиля раньше дублировалась в этих ключах; теперь только в настройках (vuex), ключи читаем один раз для переноса
//повторы чтения после обрыва связи: паузы 1, 2, 4, 8 с
const maxRequestRetries = 4;
const legacyProfileSessionKey = 'inpx-web-profile-session';
const legacyProfileLoginHistoryKey = 'inpx-web-profile-login-history';
const componentOptions = {
    components: {
    },
    watch: {
        modelValue(newValue) {
            this.accessGranted = newValue;
        },
        accessGranted(newValue) {
            this.$emit('update:modelValue', newValue);
        }
    },
};
class Api {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };
    accessGranted = false;

    busyDialogVisible = false;
    mainMessage = '';
    jobMessage = '';
    //jsonMessage = '';
    progress = 0;
    profileLoginPromise = null;
    loginPageRequest = null;
    //'' - связь есть, 'lost' - потеряна, идёт переподключение, 'restored' - только что восстановлена
    connectionState = '';

    created() {
        this.commit = this.$store.commit;
        this.lock = new LockQueue();

        this.migrateLegacyProfileSession();
    }

    mounted() {
        if (!this.isStandaloneReaderLab)
            this.updateConfig();//no await

        //после сна телефона или смены сети связи может не быть: проверяем заранее, а не на первом действии
        this.onResume = () => this.checkConnection();
        document.addEventListener('visibilitychange', this.onResume);
        window.addEventListener('online', this.onResume);
    }

    beforeUnmount() {
        document.removeEventListener('visibilitychange', this.onResume);
        window.removeEventListener('online', this.onResume);
        clearTimeout(this.restoredTimer);
    }

    //язык - в каждом запросе, токен CSRF - в каждом изменении (POST); профиль сервер знает по cookie сессии
    authHeaders(action) {
        const headers = {'X-Ui-Lang': getLang()};
        const csrfToken = this.$store.state.config.csrfToken;
        if (csrfToken && !apiRoutes.isRead(action))
            headers['X-CSRF-Token'] = csrfToken;
        return headers;
    }

    //Проверка связи - GET api/ping с коротким ожиданием; вторая попытка - на случай единичного сбоя сети
    async probeConnection() {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await call('test', {}, {timeoutSecs: 5, headers: this.authHeaders('test')});
                return true;
            } catch (e) {
                //пробуем ещё раз или сообщаем о потере связи
            }
        }
        return false;
    }

    async checkConnection() {
        if (document.hidden || this.isStandaloneReaderLab)
            return;
        if (await this.probeConnection())
            this.connectionRestored();
        else
            this.connectionLost();
    }

    connectionLost() {
        clearTimeout(this.restoredTimer);
        if (this.connectionState === 'lost')
            return;
        this.connectionState = 'lost';
        this.reconnect();//no await
    }

    //в скрытой вкладке не переподключаемся: при возврате проверит checkConnection
    async reconnect() {
        for (let attempt = 0; this.connectionState === 'lost'; attempt++) {
            await utils.sleep(reconnectDelay(attempt));
            if (this.connectionState === 'lost' && !document.hidden && await this.probeConnection())
                this.connectionRestored();
        }
    }

    connectionRestored() {
        if (this.connectionState !== 'lost')
            return;
        this.connectionState = 'restored';
        clearTimeout(this.restoredTimer);
        this.restoredTimer = setTimeout(() => {
            if (this.connectionState === 'restored')
                this.connectionState = '';
        }, 3000);
    }

    get isStandaloneReaderLab() {
        const route = (this.$router && this.$router.currentRoute && this.$router.currentRoute.value)
            ? this.$router.currentRoute.value
            : this.$route;
        return String((route && route.path) || '').startsWith('/reader-lab');
    }

    migrateLegacyProfileSession() {
        try {
            const raw = localStorage.getItem(legacyProfileSessionKey);
            if (raw) {
                const parsed = JSON.parse(raw) || {};
                const currentUserId = String(parsed.currentUserId || '').trim();
                if (!this.settings.currentUserId && currentUserId)
                    this.commit('setSettings', {currentUserId});
            }
        } catch (e) {
            //испорченную запись просто удаляем
        }
        try {
            localStorage.removeItem(legacyProfileSessionKey);
            localStorage.removeItem(legacyProfileLoginHistoryKey);
        } catch (e) {
            //без localStorage переносить нечего
        }
    }

    async updateConfig(options = {}) {
        try {
            const config = await this.getConfig();
            config.webAppVersion = packageJson.version;
            this.commit('setConfig', config);
            if (config.profileLoginRequired && !config.profileAuthorized) {
                if (options.skipProfileLogin)
                    return;
                if (!this.profileLoginPromise) {
                    this.profileLoginPromise = this.showProfileLoginDialog('', {required: true});
                    try {
                        await this.profileLoginPromise;
                    } finally {
                        this.profileLoginPromise = null;
                    }
                } else {
                    await this.profileLoginPromise;
                }
                return;
            }
            const selectedUserId = String(this.settings.currentUserId || '').trim();
            //Без выбранного профиля - гость (анонимный профиль), если он есть
            const preferredProfile = Array.isArray(config.userProfiles)
                ? (
                    config.userProfiles.find((profile) => profile && profile.anonymousProfile)
                    || config.userProfiles.find((profile) => profile && !profile.anonymousProfile && !profile.isAdmin)
                    || config.userProfiles.find((profile) => profile && !profile.anonymousProfile)
                    || null
                )
                : null;
            if (config.profileAuthorized && config.currentUserId && this.settings.currentUserId !== config.currentUserId)
                this.commit('setSettings', {currentUserId: config.currentUserId});
            else if (!selectedUserId)
                this.commit('setSettings', {currentUserId: (preferredProfile && preferredProfile.id) || config.currentUserId || ''});
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    get settings() {
        return this.$store.state.settings;
    }

    //вход не требует БД: окно перестройки не закрывает страницу входа, покажется после неё
    get onLoginPage() {
        return this.$route.path === '/login';
    }

    async showBusyDialog() {
        try {
            await this.lock.get();//заход только один раз, остальные ждут закрытия диалога
        } catch (e) {
            return;
        }

        this.mainMessage = '';
        this.jobMessage = '';
        this.busyDialogVisible = true;
        try {
            while (1) {// eslint-disable-line
                const server = await call('get-worker-state', {workerId: 'server_state'}, {timeoutSecs: 4, headers: this.authHeaders('get-worker-state')});
                if (server.error)
                    throw new Error(server.error);

                if (server.state != 'normal') {
                    this.mainMessage = tm(server.serverMessage);
                    if (server.job == 'load inpx') {
                        this.jobMessage = `${tm(server.jobMessage)} (${server.recsLoaded}): ${server.fileName}`;
                    } else {
                        this.jobMessage = tm(server.jobMessage);
                    }

                    //this.jsonMessage = server;

                    //БД библиотеки строится одним шагом: прогресс сервера и есть общий
                    this.progress = Math.max(0, Math.min(1, Number(server.progress) || 0));
                } else {
                    break;
                }

                await utils.sleep(300);
            }
            //конфиг, полученный во время сборки, был без БД библиотеки
            this.updateConfig();//no await
        } finally {
            this.busyDialogVisible = false;
            this.lock.errAll();
            this.lock.ret();
        }
    }

    //Файл для импорта - телом POST api/<action>, параметры - в query; ждём без ограничения: файл может быть большим
    async upload(action, file, query = {}) {
        for (let attempt = 0; ; attempt++) {
            const result = await call(action, query, {headers: this.authHeaders(action), body: file});
            //токен CSRF устарел (новая сессия): берём свежий и пробуем ещё раз
            if (result.error === 'bad_csrf_token' && !attempt) {
                await this.updateConfig();
                continue;
            }
            if (result.error)
                throw new Error(result.error);
            return result;
        }
    }

    //Ответ с {error} разбирается по значению error, а не по коду статуса
    async request(params, timeoutSecs = 10, options = {}) {
        const {action, ...actionParams} = params;
        let retries = 0;
        while (1) {// eslint-disable-line
            try {
                //заголовки - на каждой попытке: после входа или обновления конфига они другие
                const response = await call(action, actionParams, {timeoutSecs, headers: this.authHeaders(action)});
                this.connectionRestored();

                if (response && response.error == 'need_profile_login') {
                    if (options.suppressProfileLogin)
                        throw new Error('need_profile_login');
                    if (this.profileLoginPromise) {
                        await this.profileLoginPromise;
                    } else {
                        this.profileLoginPromise = this.showProfileLoginDialog('', {required: !!this.$store.state.config.profileLoginRequired});
                        try {
                            await this.profileLoginPromise;
                        } finally {
                            this.profileLoginPromise = null;
                        }
                    }
                } else if (response && response.error == 'server_busy') {
                    this.accessGranted = true;
                    await this.showBusyDialog();
                } else if (response && response.error == 'bad_csrf_token') {
                    await this.updateConfig({skipProfileLogin: !!this.profileLoginPromise});
                } else {
                    this.accessGranted = true;
                    if (response.error) {
                        throw new Error(response.error);
                    }

                    return response;
                }

                retries = 0;
            } catch(e) {
                if (isConnectionError(e))
                    this.connectionLost();
                //изменения не повторяем: читатель видит ошибку и решает сам
                if (!canRetryRequest(params.action, e) || retries >= maxRequestRetries)
                    throw e;
                await utils.sleep(reconnectDelay(retries++));
            }
        }
    }

    async getAuthorBooksByName(author, query = {}) {
        return await this.request({action: 'get-author-book-list', authorId: 0, author, query}, 60);
    }

    async getAuthorInfo(authorId, author) {
        return await this.request({action: 'get-author-info', authorId, author}, 120);
    }

    async getSeriesBookList(series, query = {}) {
        return await this.request({action: 'get-series-book-list', series, query});
    }

    async getGenreTree() {
        return await this.request({action: 'get-genre-tree'});
    }

    async getDiscoveryShelves(options = {}) {
        return await this.request(Object.assign({action: 'get-discovery-shelves'}, options || {}), 300);
    }

    async updateDiscoveryPreferences(preferences = {}) {
        return await this.request({action: 'update-discovery-preferences', preferences}, 120);
    }

    async recordDiscoveryEvents(events = []) {
        return await this.request({action: 'record-discovery-events', events}, 120);
    }

    async updateSharedDiscoveryConfig(discovery = {}) {
        return await this.request({action: 'update-shared-discovery-config', discovery}, 120);
    }

    async updateAdminIntegrations(integrations = {}) {
        return await this.request({action: 'update-admin-integrations', integrations}, 120);
    }

    async testAdminIntegration(kind) {
        return await this.request({action: 'test-admin-integration', kind}, 120);
    }

    async updateAdminOpds(opds = {}) {
        return await this.request({action: 'update-admin-opds', opds}, 120);
    }

    async updateAdminGuestAccess(guestAccess = false) {
        return await this.request({action: 'update-admin-guest-access', guestAccess}, 120);
    }

    async getAdminDashboard() {
        return await this.request({action: 'get-admin-dashboard'}, 120);
    }

    async getAdminDashboardMetrics() {
        return await this.request({action: 'get-admin-dashboard-metrics'}, 120);
    }

    async getAdminEvents(options = {}) {
        return await this.request({action: 'get-admin-events', options}, 120);
    }

    async updateAdminEventLog(options = {}) {
        return await this.request({action: 'update-admin-event-log', options}, 120);
    }

    async addAdminTestEvent(level = 'warn') {
        return await this.request({action: 'add-admin-test-event', level}, 120);
    }

    async updateAdminLibrarySources(sources = []) {
        return await this.request({action: 'update-admin-library-sources', sources}, 120);
    }

    async adminDiagnoseLibrarySource(source) {
        return await this.request({action: 'admin-diagnose-library-source', source}, 300);
    }

    async getRemoteAccess() {
        return await this.request({action: 'get-remote-access'});
    }

    async createRemoteAccess(access) {
        return await this.request({action: 'create-remote-access', access});
    }

    async updateRemoteAccess(access) {
        return await this.request({action: 'update-remote-access', access});
    }

    async deleteRemoteAccess(id) {
        return await this.request({action: 'delete-remote-access', id});
    }

    async updateAdminCache(cache = {}) {
        return await this.request({action: 'update-admin-cache', cache}, 120);
    }

    async adminCleanCache(kind = 'all') {
        return await this.request({action: 'admin-clean-cache', kind}, 300);
    }

    async adminCleanBrokenCovers() {
        return await this.request({action: 'admin-clean-broken-covers'}, 300);
    }

    async adminRebuildCover(bookUid) {
        return await this.request({action: 'admin-rebuild-cover', bookUid}, 300);
    }

    async adminReindex() {
        return await this.request({action: 'admin-reindex'}, 120);
    }

    async exportAdminSettings() {
        return await this.request({action: 'export-admin-settings'}, 120);
    }

    async importAdminSettings(file) {
        return await this.upload('import-admin-settings', file);
    }

    //scope: '' - полный бэкап, 'author-names' - только английские имена авторов
    async createAdminBackup(scope = '') {
        return await this.request({action: 'create-admin-backup', scope}, 300);
    }

    async importAdminBackup(file, scope = '') {
        return await this.upload('import-admin-backup', file, {scope});
    }

    async updateBookMetadata(bookUid, metadata = {}) {
        return await this.request({action: 'update-book-metadata', bookUid, metadata}, 120);
    }

    async getBookLink(bookUid) {
        return await this.request({action: 'get-book-link', bookUid}, 120);
    }

    async catalogSearch(params = {}) {
        return await this.request(Object.assign({action: 'catalog-search'}, params), 60);
    }

    async getAuthorAliases(author) {
        return await this.request({action: 'get-author-aliases', author}, 20);
    }

    //table: 'author-names' или 'work-titles'
    async adminAuthorNamesStatus(table = 'author-names') {
        return await this.request({action: 'admin-author-names-status', table}, 30);
    }

    async adminAuthorNamesUpdate(table = 'author-names') {
        return await this.request({action: 'admin-author-names-update', table}, 30);
    }

    async catalogNames(kind, q, offset = 0, limit = 50) {
        return await this.request({action: 'catalog-names', kind, q, offset, limit}, 30);
    }

    async catalogSuggest(q) {
        return await this.request({action: 'catalog-suggest', q}, 20);
    }

    async getBook(bookUid) {
        return await this.request({action: 'get-book', bookUid}, 60);
    }

    async getBookStates(bookUids = []) {
        return await this.request({action: 'get-book-states', bookUids}, 60);
    }

    //fetchRemote - скачать книгу удалённой библиотеки ради описания
    async getBookInfo(bookUid, {fetchRemote = false} = {}) {
        return await this.request({action: 'get-book-info', bookUid, fetchRemote}, 120);
    }

    async getReaderState(bookUid, options = {}) {
        return await this.request({action: 'get-reader-state', bookUid}, 120, options);
    }

    async getUserReadingLibrary(options = {}, requestOptions = {}) {
        return await this.request({action: 'get-user-reading-library', options}, 120, requestOptions);
    }

    async getReadingStats() {
        return await this.request({action: 'get-reading-stats'}, 120);
    }

    async updateReaderProgress(bookUid, progress = {}, options = {}) {
        return await this.request({action: 'update-reader-progress', bookUid, progress}, 120, options);
    }

    //всё о книгах в профиле: прогресс, закладки, история, места в своих списках
    async forgetBooks(bookUids) {
        return await this.request({action: 'forget-books', bookUids}, 120);
    }

    async clearReaderProgress() {
        return await this.request({action: 'clear-reader-progress'}, 120);
    }

    async updateReaderPreferences(preferences = {}, options = {}) {
        return await this.request({action: 'update-reader-preferences', preferences}, 120, options);
    }

    async addReaderBookmark(bookUid, bookmark = {}) {
        return await this.request({action: 'add-reader-bookmark', bookUid, bookmark}, 120);
    }

    async deleteReaderBookmark(bookUid, bookmarkId) {
        return await this.request({action: 'delete-reader-bookmark', bookUid, bookmarkId}, 120);
    }

    async getReadingLists(bookUid = '') {
        return await this.request({action: 'get-reading-lists', bookUid}, 120);
    }

    async loginUserProfile(login, password) {
        return await this.request({action: 'login-user-profile', login, password}, 120);
    }

    async logoutUserProfile() {
        return await this.request({action: 'logout-user-profile'}, 120);
    }

    async createUserProfile(profile) {
        return await this.request({action: 'create-user-profile', profile}, 120);
    }

    async updateUserProfile(targetUserId, profile) {
        return await this.request({action: 'update-user-profile', targetUserId, profile}, 120);
    }

    async deleteUserProfile(targetUserId) {
        return await this.request({action: 'delete-user-profile', targetUserId}, 120);
    }

    //«Читаю сейчас» в виде списка: {count, books}; hidden - скрытые книги
    async getReadingNow(hidden = false) {
        return await this.request({action: 'get-reading-now', hidden}, 120);
    }

    async getReadingList(listId) {
        return await this.request({action: 'get-reading-list', listId}, 120);
    }

    async createReadingListWithVisibility(name, visibility = 'private') {
        return await this.request({action: 'create-reading-list', name, visibility}, 120);
    }

    //patch: name и/или visibility
    async updateReadingList(listId, patch) {
        return await this.request(Object.assign({action: 'update-reading-list', listId}, patch), 120);
    }

    async deleteReadingList(listId) {
        return await this.request({action: 'delete-reading-list', listId}, 120);
    }

    async getKoboDevices() {
        return await this.request({action: 'get-kobo-devices'}, 60);
    }

    async createKoboDevice(device) {
        return await this.request({action: 'create-kobo-device', device}, 60);
    }

    async updateKoboDevice(deviceId, device) {
        return await this.request({action: 'update-kobo-device', deviceId, device}, 60);
    }

    async regenerateKoboDeviceToken(deviceId) {
        return await this.request({action: 'regenerate-kobo-device-token', deviceId}, 60);
    }

    async resetKoboDevice(deviceId) {
        return await this.request({action: 'reset-kobo-device', deviceId}, 60);
    }

    async refreshKoboDevice(deviceId) {
        return await this.request({action: 'refresh-kobo-device', deviceId}, 60);
    }

    async deleteKoboDevice(deviceId) {
        return await this.request({action: 'delete-kobo-device', deviceId}, 60);
    }

    async setOpdsPassword(password = '') {
        return await this.request({action: 'set-opds-password', password}, 60);
    }

    async createKosyncPassword() {
        return await this.request({action: 'create-kosync-password'}, 60);
    }

    async exportReadingLists() {
        return await this.request({action: 'export-reading-lists'}, 120);
    }

    async importReadingLists(file) {
        return await this.upload('import-reading-lists', file);
    }

    //замена недоступной книги в списках, прогрессе и закладках читателя
    async replaceListedBook(fromUid, toUid) {
        return await this.request({action: 'replace-listed-book', bookUid: fromUid, toUid}, 120);
    }

    async updateReadingListBook(listId, bookUid, enabled) {
        return await this.request({action: (enabled ? 'add-reading-list-book' : 'remove-reading-list-book'), listId, bookUid}, 120);
    }

    async setBookRead(bookUid, read = true) {
        return await this.request({action: (read ? 'mark-book-read' : 'unmark-book-read'), bookUid}, 120);
    }

    async markReaderBooksRead(bookUids = [], read = true) {
        return await this.request({action: 'mark-reader-books-read', bookUids, read}, 120);
    }

    async markSeriesRead(series, read = true) {
        return await this.request({action: 'mark-series-read', series, read}, 120);
    }

    async addSeriesToReadingList(listId, series) {
        return await this.request({action: 'add-series-to-reading-list', listId, series}, 120);
    }

    async sendBookTelegram(bookUid, format = '') {
        return await this.request({action: 'send-book-telegram', bookUid, format}, 300);
    }

    async sendBookEmail(bookUid, format = '') {
        return await this.request({action: 'send-book-email', bookUid, format}, 300);
    }

    async getConfig() {
        return await this.request({action: 'get-config'});
    }

    //Вход в профиль: в читалке - диалогом поверх книги, в остальном приложении - страницей /login.
    async showProfileLoginDialog(prefillLogin = '', opts = {}) {
        const route = this.$router.currentRoute.value || {};
        if (route.path === '/reader' || opts.dialog === true)
            return await this.showProfileLoginPrompt(prefillLogin, opts);

        return await this.requestLoginPage(prefillLogin, opts);
    }

    requestLoginPage(prefillLogin = '', opts = {}) {
        if (!this.loginPageRequest) {
            let resolve, reject;
            const promise = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.loginPageRequest = {promise, resolve, reject, required: opts.required === true};
        }

        const route = this.$router.currentRoute.value || {};
        if (route.path !== '/login') {
            const query = {redirect: route.fullPath || '/'};
            if (prefillLogin)
                query.login = prefillLogin;
            this.$router.push({path: '/login', query});
        }

        return this.loginPageRequest.promise;
    }

    get loginRequired() {
        return !!(this.$store.state.config.profileLoginRequired && !this.$store.state.config.profileAuthorized);
    }

    cancelLoginPage() {
        const request = this.loginPageRequest;
        if (!request || request.required)
            return;

        this.loginPageRequest = null;
        request.reject(new Error(t('common.profileLoginCancelled')));
    }

    async completeProfileLogin(result) {
        this.commit('setSettings', {currentUserId: result.userId});
        await this.updateConfig();

        const request = this.loginPageRequest;
        this.loginPageRequest = null;
        if (request)
            request.resolve(result);

        return result;
    }

    //Профиль без пароля или гость: выбирается без входа.
    async selectOpenProfile(userId = '') {
        if (this.$store.state.config.profileAuthorized) {
            try {
                await this.logoutUserProfile();
            } catch (e) {
                // Ignore stale profile session cleanup errors while switching profiles.
            }
        }

        this.commit('setSettings', {currentUserId: String(userId || '')});
        await this.updateConfig();

        const request = this.loginPageRequest;
        this.loginPageRequest = null;
        if (request)
            request.resolve({userId: String(userId || '')});
    }

    async signOutProfile() {
        try {
            await this.logoutUserProfile();
        } catch (e) {
            // Ignore stale profile session cleanup errors during sign out.
        }

        const guest = (this.$store.state.config.userProfiles || []).find(profile => profile && profile.anonymousProfile);
        this.commit('setSettings', {currentUserId: (guest ? guest.id : '')});
        await this.updateConfig();
    }

    async showProfileLoginPrompt(prefillLogin = '', opts = {}) {
        const config = this.$store.state.config || {};
        const selectedUserId = String(this.settings.currentUserId || '').trim();
        const selectedProfile = Array.isArray(config.userProfiles)
            ? config.userProfiles.find((profile) => profile && profile.id === selectedUserId)
            : null;
        const current = selectedProfile || config.currentUserProfile || {};
        const dialogOpts = {
            dialogClass: opts.dialogClass || '',
            dialogStyle: opts.dialogStyle || null,
        };
        let result;
        let login = prefillLogin || current.login || '';
        while (!result) {
            const loginPrompt = await this.$root.stdDialog.profileLogin(
                t('api.enterProfileLoginPassword'),
                t('api.profileLogin'),
                Object.assign({}, dialogOpts, {
                    login,
                    noCancel: opts.required === true,
                    noEscDismiss: opts.required === true,
                    noBackdropDismiss: opts.required === true,
                }),
            );
            if (!loginPrompt || loginPrompt === false)
                throw new Error(t('common.profileLoginCancelled'));
            login = String(loginPrompt.login || '').trim();
            try {
                result = await this.loginUserProfile(login, String(loginPrompt.password || ''));
            } catch (error) {
                if (!opts.required)
                    throw error;
                await this.$root.stdDialog.alert(error.message, t('api.loginError'));
            }
        }
        return await this.completeProfileLogin(result);
    }
}

export default vueComponent(Api);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.connection-status {
    position: fixed;
    bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    z-index: 5000;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 24px);
    padding: 8px 14px;
    border-radius: 99px;
    background: var(--app-text);
    color: var(--app-surface);
    box-shadow: var(--app-shadow);
    font-size: 13px;
    white-space: nowrap;
    transform: translateX(-50%);
    pointer-events: none;
}

.connection-status > * {
    flex: none;
}

.connection-status--ok {
    background: var(--app-primary);
    color: var(--app-on-primary);
}

/* над нижней панелью вкладок */
@media (max-width: 899px) {
    .connection-status {
        bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    }
}

.busy-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(440px, 92vw);
    padding: 22px 24px;
    border-radius: 10px;
    background: var(--app-surface);
    color: var(--app-text);
    box-shadow: var(--app-shadow);
}

.busy-eyebrow {
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.busy-title {
    font-family: var(--app-font-serif);
    font-size: 19px;
    font-weight: 600;
}

.busy-hint {
    color: var(--app-muted);
    font-size: 13px;
    line-height: 1.45;
}

.busy-meta {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    color: var(--app-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
}

.busy-job {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
